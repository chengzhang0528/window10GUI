using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace WindowsAgent;

/// <summary>
/// Small, dependency-free Chrome DevTools Protocol client.  It is deliberately
/// kept inside the CLI so an agent never has to install a browser extension,
/// start a local service, or make a network request outside the machine.
/// </summary>
internal sealed class ChromeCdpProvider : IDisposable
{
    private const string ManagedEndpointFileName = "DeskPilotDevToolsEndpoint";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMilliseconds(900) };
    private readonly object _gate = new();
    private ClientWebSocket? _socket;
    private string? _endpoint;
    private string? _targetId;
    private string? _profileMode;
    private string? _managedProfileDir;
    private Process? _managedProcess;
    private readonly HashSet<string> _inflightRequests = new(StringComparer.Ordinal);
    private readonly List<DocumentNavigationEvent> _documentNavigations = new();
    private int _commandId;
    private bool _disposed;
    private CancellationTokenSource _cancelSignal = new();
    private int _cancelRequested;

    internal bool IsConnected => _socket?.State == WebSocketState.Open;
    internal int? ManagedProcessId => _managedProcess is { HasExited: false } ? _managedProcess.Id : null;
    internal string? CurrentTargetId => _targetId;

    internal void ResetCancellation()
    {
        // A cancelled activity ends its lease before a later activity can
        // begin. Keep the old source alive for an in-flight Call and swap in
        // a fresh source for the next lease.
        _cancelSignal = new CancellationTokenSource();
        Volatile.Write(ref _cancelRequested, 0);
    }

    internal void CancelCurrentOperation()
    {
        Volatile.Write(ref _cancelRequested, 1);
        try { _cancelSignal.Cancel(); } catch (ObjectDisposedException) { }
    }

    internal ChromeUserPause? GetUserPause()
    {
        if (!IsConnected) return null;
        var pageStatus = ReadPageStatus();
        return pageStatus.State is "login_required" or "risk_challenge"
            ? new ChromeUserPause(pageStatus.State, pageStatus.PauseReason, pageStatus.Url, pageStatus.Title, ManagedProcessId)
            : null;
    }

    internal object Ensure(JsonElement parameters)
    {
        ThrowIfDisposed();
        if (IsConnected)
        {
            return Describe();
        }

        var profileMode = (GetOptionalString(parameters, "profile_mode", "profile-mode") ?? "auto").Trim().ToLowerInvariant();
        if (profileMode is not ("auto" or "current" or "managed"))
        {
            throw new AgentException("INVALID_ARGUMENT", "profile_mode must be auto, current, or managed.", false);
        }
        var requestedEndpoint = GetOptionalString(parameters, "endpoint", "cdp_endpoint", "cdp-endpoint");
        var requestedPort = GetOptionalPort(parameters, "port", "remote_debugging_port", "remote-debugging-port");
        var hasExplicitEndpoint = requestedEndpoint is not null || requestedPort is not null;
        if (hasExplicitEndpoint && TryAttach(requestedEndpoint, requestedPort))
        {
            _profileMode = _managedProcess is null ? "existing_debug_session" : "managed";
            return Describe();
        }

        if (!hasExplicitEndpoint && profileMode is not "managed" && TryAttach(null, null))
        {
            _profileMode = "existing_debug_session";
            return Describe();
        }

        if (!hasExplicitEndpoint && profileMode is not "current")
        {
            var reusableProfile = GetManagedUserDataDir(parameters);
            var reusableEndpoint = TryReadDevToolsEndpoint(reusableProfile);
            if (reusableEndpoint is not null && TryAttach(reusableEndpoint, null))
            {
                _managedProfileDir = reusableProfile;
                _profileMode = "managed";
                return Describe();
            }
        }

        if (!GetBool(parameters, true, "auto_start", "auto-start"))
        {
            throw new AgentException(
                "CHROME_CDP_UNAVAILABLE",
                "No Chrome DevTools endpoint was found. Set auto_start=true to let the CLI start a managed Chrome instance.",
                true,
                new { endpoint = requestedEndpoint, port = requestedPort });
        }

        var startupTimeout = GetTimeout(parameters, 15000);
        if (profileMode is not "managed" && TryStartCurrentProfile(parameters, requestedPort, startupTimeout))
        {
            _profileMode = "current";
            return Describe();
        }
        if (profileMode == "current")
        {
            throw new AgentException("CHROME_CURRENT_PROFILE_UNAVAILABLE", "The current Chrome profile could not be restarted with CDP enabled.", true,
                new { profile_mode = profileMode, user_data_dir = GetCurrentUserDataDir(parameters) });
        }

        StartManagedChrome(parameters, requestedPort, startupTimeout);
        var attachDeadline = Stopwatch.StartNew();
        while (!TryAttach(_endpoint, null) && attachDeadline.Elapsed < TimeSpan.FromMilliseconds(startupTimeout))
        {
            Thread.Sleep(150);
        }
        if (!IsConnected)
        {
            throw new AgentException("CHROME_CDP_UNAVAILABLE", "Chrome started but its DevTools endpoint did not become available.", true,
                new { endpoint = _endpoint, process_id = _managedProcess?.Id });
        }

        _profileMode = "managed";
        return Describe();
    }

    private bool TryStartCurrentProfile(JsonElement parameters, int? requestedPort, int startupTimeout)
    {
        // A current-profile probe is intentionally short. Recent Chrome
        // versions may reject remote debugging for the default profile; do not
        // consume the entire workflow deadline before falling back to the
        // managed CDP profile.
        var probeTimeout = Math.Min(startupTimeout, 8000);
        var profile = GetCurrentUserDataDir(parameters);
        if (string.IsNullOrWhiteSpace(profile)) return false;
        var running = GetRunningChromeProcesses();
        if (running.Count > 0 && !RequestCloseChrome(running, probeTimeout)) return false;

        try
        {
            Directory.CreateDirectory(profile);
            var chrome = FindChromeExecutable();
            if (chrome is null) return false;
            var port = requestedPort ?? GetFreePort();
            var start = CreateChromeStartInfo(chrome, profile, port, parameters, restoreSession: true);
            _managedProcess = Process.Start(start);
            if (_managedProcess is null) return false;
            _ = DrainProcessStreamAsync(_managedProcess.StandardOutput);
            _ = DrainProcessStreamAsync(_managedProcess.StandardError);
            _endpoint = $"http://127.0.0.1:{port}";
            var deadline = Stopwatch.StartNew();
            while (deadline.ElapsedMilliseconds < probeTimeout)
            {
                if (_managedProcess.HasExited) return false;
                if (CanReadEndpoint(_endpoint))
                {
                    var attachDeadline = Stopwatch.StartNew();
                    while (!TryAttach(_endpoint, null) && attachDeadline.ElapsedMilliseconds < probeTimeout)
                    {
                        Thread.Sleep(150);
                    }
                    return IsConnected;
                }
                Thread.Sleep(150);
            }
        }
        catch
        {
            Disconnect();
        }
        return false;
    }

    private static string GetCurrentUserDataDir(JsonElement parameters)
    {
        return GetOptionalString(parameters, "current_user_data_dir", "current-user-data-dir", "user_data_dir", "user-data-dir") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "User Data");
    }

    private static List<Process> GetRunningChromeProcesses()
    {
        try { return Process.GetProcessesByName("chrome").ToList(); }
        catch { return new List<Process>(); }
    }

    private static bool RequestCloseChrome(IReadOnlyList<Process> processes, int timeout)
    {
        var ids = processes.Select(process =>
        {
            try { return process.Id; } catch { return 0; }
        }).Where(id => id > 0).ToHashSet();
        var windows = NativeMethods.EnumerateTopLevelWindows()
            .Where(handle => ids.Contains((int)NativeMethods.GetProcessId(handle)))
            .ToArray();
        foreach (var window in windows) _ = NativeMethods.RequestCloseWindow(window);
        var deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < Math.Min(timeout, 10000))
        {
            if (!GetRunningChromeProcesses().Any(process =>
            {
                try { return ids.Contains(process.Id); } catch { return false; }
            })) return true;
            Thread.Sleep(100);
        }
        return !GetRunningChromeProcesses().Any(process =>
        {
            try { return ids.Contains(process.Id); } catch { return false; }
        });
    }

    internal object Targets(JsonElement parameters)
    {
        Ensure(parameters);
        List<ChromeTarget> targets;
        try
        {
            targets = GetTargets(_endpoint!);
        }
        catch (Exception ex)
        {
            throw new AgentException("CHROME_CDP_UNAVAILABLE", $"Unable to read the Chrome target list: {ex.Message}", true,
                new { endpoint = _endpoint });
        }
        return new
        {
            endpoint = _endpoint,
            profile_mode = _profileMode,
            managed_profile = _managedProfileDir,
            targets = targets.Select(target => new
            {
                target_id = target.Id,
                type = target.Type,
                title = target.Title,
                url = target.Url,
                attached = string.Equals(target.Id, _targetId, StringComparison.Ordinal)
            }).ToArray()
        };
    }

    internal object Attach(JsonElement parameters)
    {
        Ensure(parameters);
        var targetId = GetOptionalString(parameters, "target_id", "target-id", "id");
        var urlContains = GetOptionalString(parameters, "url_contains", "url-contains");
        var titleContains = GetOptionalString(parameters, "title_contains", "title-contains");
        if (string.IsNullOrWhiteSpace(targetId) && string.IsNullOrWhiteSpace(urlContains) && string.IsNullOrWhiteSpace(titleContains))
        {
            throw new AgentException("INVALID_ARGUMENT", "chrome.attach requires target_id, url_contains, or title_contains.", false);
        }

        List<ChromeTarget> matches;
        try
        {
            matches = GetTargets(_endpoint!).Where(target =>
                string.Equals(target.Type, "page", StringComparison.OrdinalIgnoreCase) &&
                (string.IsNullOrWhiteSpace(targetId) || string.Equals(target.Id, targetId, StringComparison.Ordinal)) &&
                (string.IsNullOrWhiteSpace(urlContains) || target.Url.Contains(urlContains, StringComparison.OrdinalIgnoreCase)) &&
                (string.IsNullOrWhiteSpace(titleContains) || target.Title.Contains(titleContains, StringComparison.OrdinalIgnoreCase))).ToList();
        }
        catch (Exception ex)
        {
            throw new AgentException("CHROME_CDP_UNAVAILABLE", $"Unable to select a Chrome target: {ex.Message}", true,
                new { endpoint = _endpoint });
        }

        if (matches.Count == 0)
        {
            throw new AgentException("CHROME_TARGET_NOT_FOUND", "No Chrome page target matched the supplied criteria.", true,
                new { target_id = targetId, url_contains = urlContains, title_contains = titleContains });
        }
        if (matches.Count > 1)
        {
            throw new AgentException("AMBIGUOUS_CHROME_TARGET", "More than one Chrome page target matched; pass target_id.", false,
                new { target_ids = matches.Select(target => target.Id).ToArray() });
        }

        var target = matches[0];
        if (!string.Equals(target.Id, _targetId, StringComparison.Ordinal))
        {
            Disconnect();
            Connect(_endpoint!, target);
        }
        _ = PrepareForInteraction();
        return Describe();
    }

    internal ChromeInteractionTarget PrepareForInteraction()
    {
        ThrowIfDisposed();
        if (!IsConnected || string.IsNullOrWhiteSpace(_targetId))
        {
            throw new AgentException("CHROME_CDP_DISCONNECTED", "No Chrome page target is attached.", true);
        }

        Call("Page.bringToFront", new { }, 5000);
        var pageStatus = ReadPageStatus(2000);
        var (browserWindowId, windowBounds) = TryGetBrowserWindowForTarget();
        return ToInteractionTarget(pageStatus, browserWindowId, windowBounds);
    }

    internal ChromeInteractionTarget ReadInteractionTarget()
    {
        ThrowIfDisposed();
        if (!IsConnected || string.IsNullOrWhiteSpace(_targetId))
        {
            throw new AgentException("CHROME_CDP_DISCONNECTED", "No Chrome page target is attached.", true);
        }

        var pageStatus = ReadPageStatus(2000);
        var (browserWindowId, windowBounds) = TryGetBrowserWindowForTarget();
        return ToInteractionTarget(pageStatus, browserWindowId, windowBounds);
    }

    private ChromeInteractionTarget ToInteractionTarget(PageStatus pageStatus, int? browserWindowId, ChromeWindowBounds? windowBounds)
    {
        return new ChromeInteractionTarget(
            _targetId!,
            pageStatus.Url,
            pageStatus.Title,
            ManagedProcessId,
            pageStatus.ReadyState,
            pageStatus.VisibilityState,
            pageStatus.BodyTextLength,
            pageStatus.ActionableCount,
            pageStatus.State,
            pageStatus.PauseReason,
            browserWindowId,
            windowBounds);
    }

    private (int? BrowserWindowId, ChromeWindowBounds? Bounds) TryGetBrowserWindowForTarget()
    {
        try
        {
            var result = Call("Browser.getWindowForTarget", new { targetId = _targetId }, 2000);
            var windowId = result.TryGetProperty("windowId", out var windowIdElement) && windowIdElement.TryGetInt32(out var parsedWindowId)
                ? parsedWindowId
                : (int?)null;
            if (!result.TryGetProperty("bounds", out var bounds) || bounds.ValueKind != JsonValueKind.Object)
            {
                return (windowId, null);
            }
            return (windowId, new ChromeWindowBounds(
                GetJsonNumber(bounds, "left"),
                GetJsonNumber(bounds, "top"),
                GetJsonNumber(bounds, "width"),
                GetJsonNumber(bounds, "height")));
        }
        catch
        {
            // Older Chromium builds may not expose Browser.* on a page
            // websocket. Title/process/foreground checks remain available,
            // but window_binding.verified will not claim bounds evidence.
            return (null, null);
        }
    }

    internal object Diagnose()
    {
        ThrowIfDisposed();
        var executable = FindChromeExecutable();
        var defaultManagedProfile = GetDefaultManagedUserDataDir();
        var persistedManagedEndpoint = TryReadDevToolsEndpoint(defaultManagedProfile);
        var candidates = new[] { _endpoint, persistedManagedEndpoint }
            .Where(endpoint => !string.IsNullOrWhiteSpace(endpoint))
            .Concat(EnumerateEndpoints(null, null))
            .Where(endpoint => !string.IsNullOrWhiteSpace(endpoint))
            .Select(endpoint => endpoint!.TrimEnd('/'))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var probes = new List<object>();
        foreach (var endpoint in candidates)
        {
            try
            {
                var version = GetJson(endpoint + "/json/version", 150);
                var targets = GetTargets(endpoint, 150);
                probes.Add(new
                {
                    endpoint,
                    available = true,
                    browser = GetJsonString(version, "Browser"),
                    protocol_version = GetJsonString(version, "Protocol-Version"),
                    page_targets = targets.Count(target => string.Equals(target.Type, "page", StringComparison.OrdinalIgnoreCase)),
                    target_count = targets.Count
                });
                break;
            }
            catch
            {
                probes.Add(new { endpoint, available = false, error_code = "CHROME_CDP_UNAVAILABLE", retryable = true });
            }
        }

        var availableProbe = probes.FirstOrDefault(probe =>
            probe.GetType().GetProperty("available")?.GetValue(probe) is true);
        var status = availableProbe is not null
            ? "available"
            : executable is not null ? "degraded" : "unavailable";
        return new
        {
            status,
            executable,
            connected = IsConnected,
            endpoint = _endpoint,
            managed_profile = defaultManagedProfile,
            persisted_managed_endpoint = persistedManagedEndpoint,
            profile_mode = _profileMode,
            probes
        };
    }

    internal object Navigate(JsonElement parameters)
    {
        Ensure(parameters);
        _ = PrepareForInteraction();
        var url = GetRequiredString(parameters, "url");
        var timeout = GetTimeout(parameters, 30000);
        var requestedWaitUntil = GetOptionalString(parameters, "wait_until", "wait-until");
        var waitUntil = requestedWaitUntil ?? "domcontentloaded";
        if (waitUntil is not ("domcontentloaded" or "load" or "complete" or "network_idle" or "network-idle"))
        {
            throw new AgentException("INVALID_ARGUMENT", "wait_until must be domcontentloaded, load, complete, or network_idle.", false);
        }

        var readySelector = GetOptionalString(parameters, "ready_selector", "ready-selector");
        var readyExpression = GetOptionalString(parameters, "ready_expression", "ready-expression", "ready_predicate", "ready-predicate");
        if (string.IsNullOrWhiteSpace(readySelector)) readySelector = null;
        if (string.IsNullOrWhiteSpace(readyExpression)) readyExpression = null;
        var readyStableMs = Math.Clamp(GetInt(parameters, 0, "ready_stable_ms", "ready-stable-ms"), 0, timeout);

        var started = Stopwatch.StartNew();
        lock (_inflightRequests) _inflightRequests.Clear();
        lock (_documentNavigations) _documentNavigations.Clear();
        var navigation = Call("Page.navigate", new { url }, timeout);
        if (navigation.TryGetProperty("errorText", out var errorText) && errorText.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(errorText.GetString()))
        {
            throw new AgentException("CHROME_NAVIGATION_FAILED", errorText.GetString()!, true,
                new { stage = "navigation", url, elapsed_ms = started.ElapsedMilliseconds, timeout_ms = timeout });
        }
        var frameId = navigation.TryGetProperty("frameId", out var frame) ? frame.GetString() : null;
        var remaining = Math.Max(1, timeout - (int)Math.Min(int.MaxValue, started.ElapsedMilliseconds));
        if (readySelector is not null || readyExpression is not null)
        {
            // A semantic condition is authoritative for dynamic pages. Unless
            // the caller explicitly requested a technical state, do not make
            // DOMContentLoaded a hidden prerequisite: some pages expose usable
            // controls while analytics keep the parser lifecycle open.
            if (requestedWaitUntil is not null)
            {
                WaitForReady(waitUntil, remaining, stableMs: GetInt(parameters, 450, "network_idle_ms", "network-idle-ms"));
                remaining = Math.Max(1, timeout - (int)Math.Min(int.MaxValue, started.ElapsedMilliseconds));
            }
            WaitForSemanticCondition(readySelector, readyExpression, remaining, readyStableMs, "navigation_condition");
        }
        else
        {
            WaitForReady(waitUntil, remaining, stableMs: GetInt(parameters, 450, "network_idle_ms", "network-idle-ms"));
        }
        var summary = EvaluateValue("({url:location.href,title:document.title,ready_state:document.readyState})", Math.Clamp(timeout - (int)Math.Min(int.MaxValue, started.ElapsedMilliseconds), 1, 5000));
        var pageStatus = ReadPageStatus();
        ThrowIfPageUnavailable(
            pageStatus,
            "navigation_result",
            started.ElapsedMilliseconds,
            timeout,
            readySelector,
            readyExpression,
            TryGetElementCount(readySelector),
            waitUntil);
        return new
        {
            url = GetObjectString(summary, "url"),
            title = GetObjectString(summary, "title"),
            ready_state = GetObjectString(summary, "ready_state"),
            frame_id = frameId,
            target_id = _targetId,
            wait_until = waitUntil,
            ready_selector = readySelector,
            ready_expression = readyExpression,
            visibility_state = pageStatus.VisibilityState,
            body_text_length = pageStatus.BodyTextLength,
            actionable_count = pageStatus.ActionableCount,
            page_state = pageStatus.State,
            pause_reason = pageStatus.PauseReason,
            navigation_trace = GetDocumentNavigationTrace(),
            elapsed_ms = started.ElapsedMilliseconds
        };
    }

    internal object Wait(JsonElement parameters)
    {
        Ensure(parameters);
        var selector = GetOptionalString(parameters, "selector", "css");
        var expression = GetOptionalString(parameters, "expression", "predicate", "script");
        if (string.IsNullOrWhiteSpace(selector) && string.IsNullOrWhiteSpace(expression))
        {
            throw new AgentException("INVALID_ARGUMENT", "chrome.wait requires selector or expression.", false);
        }

        var timeout = GetTimeout(parameters, 30000);
        var stableMs = Math.Clamp(GetInt(parameters, 0, "stable_ms", "stable-ms"), 0, timeout);
        var started = Stopwatch.StartNew();
        var elapsed = WaitForSemanticCondition(selector, expression, timeout, stableMs, "semantic_condition");
        var pageStatus = ReadPageStatus(Math.Min(5000, Math.Max(1, timeout - (int)elapsed)));
        return new
        {
            matched = true,
            target_id = _targetId,
            elapsed_ms = elapsed,
            selector,
            expression,
            ready_state = pageStatus.ReadyState,
            visibility_state = pageStatus.VisibilityState,
            body_text_length = pageStatus.BodyTextLength,
            actionable_count = pageStatus.ActionableCount,
            page_state = pageStatus.State,
            pause_reason = pageStatus.PauseReason
        };
    }

    internal object Evaluate(JsonElement parameters)
    {
        Ensure(parameters);
        var expression = GetRequiredString(parameters, "expression", "script", "code");
        var timeout = GetTimeout(parameters, 30000);
        var value = EvaluateValue(expression, timeout);
        var pageStatus = ReadPageStatus(Math.Min(5000, timeout));
        return new
        {
            value,
            target_id = _targetId,
            url = pageStatus.Url,
            title = pageStatus.Title,
            ready_state = pageStatus.ReadyState,
            visibility_state = pageStatus.VisibilityState,
            body_text_length = pageStatus.BodyTextLength,
            actionable_count = pageStatus.ActionableCount,
            page_state = pageStatus.State,
            pause_reason = pageStatus.PauseReason
        };
    }

    internal object Fill(JsonElement parameters)
    {
        Ensure(parameters);
        var selector = GetRequiredString(parameters, "selector", "css");
        var value = GetPresentString(parameters, "value", "text");
        var timeout = GetTimeout(parameters, 30000);
        ThrowIfPageUnavailable(ReadPageStatus(Math.Min(2000, timeout)), "interaction", 0, timeout, selector);
        if (value.Length > 100_000)
        {
            throw new AgentException("INPUT_TOO_LARGE", "Text input exceeds the 100,000 UTF-16 code-unit limit.", false);
        }

        var script = "(() => {" +
            $"const el=document.querySelector({JsString(selector)});" +
            "if (!el) return { found:false };" +
            "el.scrollIntoView({block:'center',inline:'center'}); el.focus();" +
            $"const value={JsString(value)};" +
            "const proto=Object.getPrototypeOf(el);" +
            "const descriptor=proto && Object.getOwnPropertyDescriptor(proto,'value');" +
            "if (descriptor && descriptor.set) descriptor.set.call(el,value); else el.value=value;" +
            "el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));" +
            "el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));" +
            "return {found:true,value:String(el.value),tag:el.tagName.toLowerCase()}; })()";
        var result = EvaluateValue(script, timeout);
        if (result.ValueKind != JsonValueKind.Object || !result.TryGetProperty("found", out var found) || found.ValueKind != JsonValueKind.True)
        {
            throw new AgentException("CHROME_ELEMENT_NOT_FOUND", "No page element matched the supplied selector.", true, new { selector });
        }
        var actual = result.TryGetProperty("value", out var actualValue) ? actualValue.GetString() : null;
        if (!string.Equals(actual, value, StringComparison.Ordinal))
        {
            throw new AgentException("CHROME_VALUE_NOT_VERIFIED", "The page did not expose the requested value after input events.", true,
                new { selector, expected_length = value.Length, actual_length = actual?.Length ?? 0 });
        }
        return new { target_id = _targetId, selector, value = actual, verified = true };
    }

    internal object Click(JsonElement parameters)
    {
        Ensure(parameters);
        var selector = GetRequiredString(parameters, "selector", "css");
        var timeout = GetTimeout(parameters, 30000);
        ThrowIfPageUnavailable(ReadPageStatus(Math.Min(2000, timeout)), "interaction", 0, timeout, selector);
        var script = "(() => {" +
            $"const el=document.querySelector({JsString(selector)});" +
            "if (!el) return {found:false};" +
            "el.scrollIntoView({block:'center',inline:'center'});" +
            "const r=el.getBoundingClientRect(); const s=getComputedStyle(el);" +
            "const visible=r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';" +
            "return {found:true,visible,disabled:Boolean(el.disabled),x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,tag:el.tagName.toLowerCase(),text:(el.innerText || el.value || '').slice(0,200)}; })()";
        var result = EvaluateValue(script, timeout);
        if (result.ValueKind != JsonValueKind.Object || !result.TryGetProperty("found", out var found) || found.ValueKind != JsonValueKind.True)
        {
            throw new AgentException("CHROME_ELEMENT_NOT_FOUND", "No page element matched the supplied selector.", true, new { selector });
        }
        if (!result.TryGetProperty("visible", out var visible) || visible.ValueKind != JsonValueKind.True)
        {
            throw new AgentException("CHROME_ELEMENT_NOT_ACTIONABLE", "The matched page element is not visible in the viewport.", true, new { selector });
        }
        if (result.TryGetProperty("disabled", out var disabled) && disabled.ValueKind == JsonValueKind.True)
        {
            throw new AgentException("CHROME_ELEMENT_NOT_ACTIONABLE", "The matched page element is disabled.", true, new { selector });
        }
        var x = result.GetProperty("x").GetDouble();
        var y = result.GetProperty("y").GetDouble();
        Call("Input.dispatchMouseEvent", new { type = "mouseMoved", x, y }, timeout);
        Call("Input.dispatchMouseEvent", new { type = "mousePressed", x, y, button = "left", clickCount = 1 }, timeout);
        Call("Input.dispatchMouseEvent", new { type = "mouseReleased", x, y, button = "left", clickCount = 1 }, timeout);
        return new { target_id = _targetId, selector, clicked = true, execution_layer = "cdp_input", result };
    }

    /// <summary>
    /// Resolves a page element's viewport center for the activity trace. CDP
    /// coordinates are CSS pixels; the caller maps them to the live top-level
    /// HWND's physical screen rectangle before drawing the synthetic pointer.
    /// </summary>
    internal ClickPoint? TryResolveClickPoint(JsonElement parameters)
    {
        try
        {
            Ensure(parameters);
            var selector = GetRequiredString(parameters, "selector", "css");
            var timeout = GetTimeout(parameters, 2000);
            ThrowIfPageUnavailable(ReadPageStatus(Math.Min(1000, timeout)), "interaction", 0, timeout, selector);
            var script = "(() => {" +
                $"const el=document.querySelector({JsString(selector)});" +
                "if (!el) return {found:false};" +
                "el.scrollIntoView({block:'center',inline:'center'});" +
                "const r=el.getBoundingClientRect(); const s=getComputedStyle(el);" +
                "const visible=r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';" +
                "return {found:true,visible,x:r.left+r.width/2,y:r.top+r.height/2,innerWidth:window.innerWidth,innerHeight:window.innerHeight,outerWidth:window.outerWidth,outerHeight:window.outerHeight}; })()";
            var result = EvaluateValue(script, timeout);
            if (result.ValueKind != JsonValueKind.Object ||
                !result.TryGetProperty("found", out var found) || found.ValueKind != JsonValueKind.True ||
                !result.TryGetProperty("visible", out var visible) || visible.ValueKind != JsonValueKind.True)
            {
                return null;
            }

            return new ClickPoint(
                result.GetProperty("x").GetDouble(),
                result.GetProperty("y").GetDouble(),
                result.GetProperty("innerWidth").GetDouble(),
                result.GetProperty("innerHeight").GetDouble(),
                result.GetProperty("outerWidth").GetDouble(),
                result.GetProperty("outerHeight").GetDouble());
        }
        catch
        {
            return null;
        }
    }

    internal object Select(JsonElement parameters)
    {
        Ensure(parameters);
        var selector = GetRequiredString(parameters, "selector", "css");
        var requested = GetPresentString(parameters, "value", "text", "label");
        var timeout = GetTimeout(parameters, 30000);
        ThrowIfPageUnavailable(ReadPageStatus(Math.Min(2000, timeout)), "interaction", 0, timeout, selector);
        var script = "(() => {" +
            $"const el=document.querySelector({JsString(selector)});" +
            "if (!el) return {found:false};" +
            "if (el.tagName.toLowerCase() !== 'select') return {found:true,supported:false};" +
            $"const wanted={JsString(requested)};" +
            "const option=Array.from(el.options).find(item=>String(item.value)===wanted || String(item.text).trim()===wanted || String(item.value).toLowerCase()===wanted.toLowerCase() || String(item.text).trim().toLowerCase()===wanted.toLowerCase());" +
            "if (!option) return {found:true,supported:true,selected:false};" +
            "el.value=option.value; el.dispatchEvent(new Event('input',{bubbles:true,composed:true})); el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));" +
            "return {found:true,supported:true,selected:true,value:String(el.value),text:String(option.text).trim()}; })()";
        var result = EvaluateValue(script, timeout);
        if (result.ValueKind != JsonValueKind.Object || !result.TryGetProperty("found", out var found) || found.ValueKind != JsonValueKind.True)
        {
            throw new AgentException("CHROME_ELEMENT_NOT_FOUND", "No page element matched the supplied selector.", true, new { selector });
        }
        if (result.TryGetProperty("supported", out var supported) && supported.ValueKind == JsonValueKind.False)
        {
            throw new AgentException("CHROME_ELEMENT_NOT_SELECTABLE", "The matched page element is not a select control.", false, new { selector });
        }
        if (!result.TryGetProperty("selected", out var selected) || selected.ValueKind != JsonValueKind.True)
        {
            throw new AgentException("CHROME_OPTION_NOT_FOUND", "No option matched the supplied value or label.", true, new { selector, requested });
        }
        var actual = result.TryGetProperty("value", out var actualValue) ? actualValue.GetString() : null;
        var text = result.TryGetProperty("text", out var actualText) ? actualText.GetString() : null;
        if (!string.Equals(actual, requested, StringComparison.OrdinalIgnoreCase) && !string.Equals(text, requested, StringComparison.OrdinalIgnoreCase))
        {
            throw new AgentException("CHROME_SELECTION_NOT_VERIFIED", "The page did not expose the requested option after change events.", true,
                new { selector, requested, actual, text });
        }
        return new { target_id = _targetId, selector, value = actual, text, verified = true };
    }

    internal object Query(JsonElement parameters)
    {
        Ensure(parameters);
        var selector = GetRequiredString(parameters, "selector", "css");
        var limit = Math.Clamp(GetInt(parameters, 100, "limit", "max_results", "max-results"), 1, 1000);
        var script = $"Array.from(document.querySelectorAll({JsString(selector)})).slice(0,{limit}).map((el,index)=>({{index,tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||'').trim().slice(0,1000),value:'value' in el ? String(el.value ?? '') : null,checked:'checked' in el ? Boolean(el.checked) : null,disabled:Boolean(el.disabled)}}))";
        var value = EvaluateValue(script, GetTimeout(parameters, 30000));
        return new { target_id = _targetId, selector, count = value.ValueKind == JsonValueKind.Array ? value.GetArrayLength() : 0, elements = value };
    }

    private void WaitForReady(string waitUntil, int timeout, int stableMs)
    {
        var started = Stopwatch.StartNew();
        var stableSince = -1L;
        while (started.ElapsedMilliseconds < timeout)
        {
            var remaining = Math.Max(1, timeout - (int)Math.Min(int.MaxValue, started.ElapsedMilliseconds));
            var pageStatus = ReadPageStatus(Math.Min(5000, remaining));
            ThrowIfPageUnavailable(pageStatus, "page_ready", started.ElapsedMilliseconds, timeout, wait_until: waitUntil);
            var readyState = pageStatus.ReadyState;
            var matched = waitUntil switch
            {
                "domcontentloaded" => readyState is "interactive" or "complete" || pageStatus.State == "usable",
                "load" or "complete" => readyState == "complete",
                "network_idle" or "network-idle" => readyState == "complete" && InflightRequestCount == 0,
                _ => false
            };
            if (matched)
            {
                stableSince = stableSince < 0 ? started.ElapsedMilliseconds : stableSince;
                if (waitUntil is not ("network_idle" or "network-idle") || started.ElapsedMilliseconds - stableSince >= stableMs)
                {
                    return;
                }
            }
            else
            {
                stableSince = -1;
            }
            Thread.Sleep(100);
        }
        throw new AgentException("CHROME_PAGE_LOAD_TIMEOUT", "Chrome did not reach the requested page readiness state before the timeout.", true,
            PageDiagnostics("page_ready", started.ElapsedMilliseconds, timeout, wait_until: waitUntil));
    }

    private long WaitForSemanticCondition(string? selector, string? expression, int timeout, int stableMs, string stage)
    {
        var started = Stopwatch.StartNew();
        var stableSince = -1L;
        var nextPageStateProbe = 0L;
        while (started.ElapsedMilliseconds < timeout)
        {
            var selectorCondition = selector is null
                ? "true"
                : $"Boolean(document.querySelector({JsonSerializer.Serialize(selector, JsonOptions)}))";
            var expressionCondition = expression is null ? "true" : $"Boolean(({expression}))";
            var remaining = Math.Max(1, timeout - (int)Math.Min(int.MaxValue, started.ElapsedMilliseconds));
            var ready = IsTrue($"Boolean(({selectorCondition}) && ({expressionCondition}))", Math.Min(5000, remaining));
            if (ready)
            {
                stableSince = stableSince < 0 ? started.ElapsedMilliseconds : stableSince;
                if (started.ElapsedMilliseconds - stableSince >= stableMs)
                {
                    var pageStatus = ReadPageStatus(Math.Min(2000, remaining));
                    ThrowIfPageUnavailable(pageStatus, stage, started.ElapsedMilliseconds, timeout, selector, expression,
                        TryGetElementCount(selector));
                    return started.ElapsedMilliseconds;
                }
            }
            else
            {
                stableSince = -1;
                if (started.ElapsedMilliseconds >= nextPageStateProbe)
                {
                    var pageStatus = ReadPageStatus(Math.Min(2000, remaining));
                    ThrowIfPageUnavailable(pageStatus, stage, started.ElapsedMilliseconds, timeout, selector, expression,
                        TryGetElementCount(selector));
                    nextPageStateProbe = started.ElapsedMilliseconds + 500;
                }
            }
            Thread.Sleep(100);
        }

        throw new AgentException("CHROME_WAIT_TIMEOUT", "The page condition was not satisfied before the timeout.", true,
            PageDiagnostics(stage, started.ElapsedMilliseconds, timeout, selector, expression,
                TryGetElementCount(selector)));
    }

    private object PageDiagnostics(string stage, long elapsedMs, int timeoutMs, string? selector = null, string? expression = null,
        int? matchedCount = null, string? wait_until = null)
    {
        var pageStatus = ReadPageStatus();
        return new
        {
            stage,
            selector,
            expression,
            wait_until,
            target_id = _targetId,
            url = pageStatus.Url,
            title = pageStatus.Title,
            ready_state = pageStatus.ReadyState,
            visibility_state = pageStatus.VisibilityState,
            body_text_length = pageStatus.BodyTextLength,
            actionable_count = pageStatus.ActionableCount,
            page_state = pageStatus.State,
            pause_reason = pageStatus.PauseReason,
            matched_count = matchedCount,
            inflight_requests = InflightRequestCount,
            navigation_trace = GetDocumentNavigationTrace(),
            elapsed_ms = elapsedMs,
            timeout_ms = timeoutMs
        };
    }

    private void ThrowIfPageUnavailable(
        PageStatus pageStatus,
        string stage,
        long elapsedMs,
        int timeoutMs,
        string? selector = null,
        string? expression = null,
        int? matchedCount = null,
        string? wait_until = null)
    {
        if (pageStatus.State is "login_required" or "risk_challenge")
        {
            throw new AgentException(
                "CHROME_USER_ATTENTION_REQUIRED",
                "Chrome is waiting for the user to complete login or verification.",
                true,
                PageDiagnostics("user_attention", elapsedMs, timeoutMs, selector, expression, matchedCount, wait_until));
        }

        if (pageStatus.State == "access_blocked")
        {
            throw new AgentException(
                "CHROME_PAGE_BLOCKED",
                "The page reports that access or the requested operation is temporarily blocked.",
                true,
                PageDiagnostics(stage, elapsedMs, timeoutMs, selector, expression, matchedCount, wait_until));
        }
    }

    private PageStatus ReadPageStatus(int timeout = 500)
    {
        try
        {
            var snapshot = EvaluateValue("(() => {" +
                "const visible=el=>{try{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}catch{return false;}};" +
                "const text=(document.body?.innerText||'').trim();" +
                "const actionable=Array.from(document.querySelectorAll('input,button,select,textarea,a[href],[role=button],[contenteditable=true]')).filter(visible);" +
                "const passwords=Array.from(document.querySelectorAll('input[type=password],input[autocomplete=current-password]')).filter(visible);" +
                "const challenges=Array.from(document.querySelectorAll('[id*=captcha i],[class*=captcha i],[id*=challenge i],[class*=challenge i],iframe[src*=captcha i],iframe[src*=challenge i]')).filter(visible);" +
                "const viewportArea=Math.max(1,innerWidth*innerHeight);" +
                "const loginSurfaces=Array.from(document.querySelectorAll('dialog,[role=dialog],[aria-modal=true],iframe[src*=login i],iframe[src*=passport i],[id*=login i],[class*=login i]')).filter(visible).filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),loginText=/(登录|log[ -]?in|sign[ -]?in)/i.test(el.innerText||el.getAttribute('aria-label')||'');return el.tagName==='IFRAME'||el.tagName==='DIALOG'||el.getAttribute('role')==='dialog'||el.getAttribute('aria-modal')==='true'||(loginText&&((s.position==='fixed'&&r.width*r.height>=viewportArea*.03)||r.width*r.height>=viewportArea*.2));});" +
                "return {url:location.href,title:document.title,ready_state:document.readyState,visibility_state:document.visibilityState,body_text:text.slice(0,4096),body_text_length:text.length,actionable_count:actionable.length,password_count:passwords.length,challenge_count:challenges.length,login_surface_count:loginSurfaces.length};})()", timeout);
            var url = GetObjectString(snapshot, "url");
            var title = GetObjectString(snapshot, "title");
            var readyState = GetObjectString(snapshot, "ready_state");
            var visibilityState = GetObjectString(snapshot, "visibility_state");
            var bodyText = GetObjectString(snapshot, "body_text") ?? string.Empty;
            var bodyTextLength = GetObjectInt(snapshot, "body_text_length");
            var actionableCount = GetObjectInt(snapshot, "actionable_count");
            var passwordCount = GetObjectInt(snapshot, "password_count");
            var challengeCount = GetObjectInt(snapshot, "challenge_count");
            var loginSurfaceCount = GetObjectInt(snapshot, "login_surface_count");
            var (state, pauseReason) = ClassifyPageState(url, title, readyState, bodyText, bodyTextLength, actionableCount, passwordCount, challengeCount, loginSurfaceCount);
            return new PageStatus(url, title, readyState, visibilityState, bodyTextLength, actionableCount, state, pauseReason);
        }
        catch (AgentException ex) when (ex.Code == "ACTIVITY_CANCELLED")
        {
            throw;
        }
        catch
        {
            return new PageStatus(null, null, null, null, 0, 0, "loading", null);
        }
    }

    private static (string State, string? PauseReason) ClassifyPageState(
        string? url,
        string? title,
        string? readyState,
        string bodyText,
        int bodyTextLength,
        int actionableCount,
        int passwordCount,
        int challengeCount,
        int loginSurfaceCount)
    {
        var normalizedUrl = url ?? string.Empty;
        var normalizedTitle = title ?? string.Empty;
        var normalizedText = bodyText.ToLowerInvariant();
        if (challengeCount > 0 ||
            normalizedUrl.Contains("captcha", StringComparison.OrdinalIgnoreCase) ||
            normalizedUrl.Contains("challenge", StringComparison.OrdinalIgnoreCase) ||
            normalizedUrl.Contains("risk_handler", StringComparison.OrdinalIgnoreCase) ||
            normalizedTitle.Contains("安全验证", StringComparison.OrdinalIgnoreCase) ||
            normalizedTitle.Contains("风险验证", StringComparison.OrdinalIgnoreCase) ||
            normalizedTitle.Contains("验证码", StringComparison.OrdinalIgnoreCase) ||
            normalizedTitle.Contains("verification", StringComparison.OrdinalIgnoreCase) ||
            (challengeCount > 0 && (normalizedText.Contains("安全验证", StringComparison.Ordinal) ||
                                    normalizedText.Contains("请完成验证", StringComparison.Ordinal) ||
                                    normalizedText.Contains("滑动验证", StringComparison.Ordinal) ||
                                    normalizedText.Contains("security verification", StringComparison.Ordinal))))
        {
            return ("risk_challenge", "risk_challenge_requires_user");
        }

        if (normalizedText.Contains("too many requests", StringComparison.Ordinal) ||
            normalizedText.Contains("rate limit", StringComparison.Ordinal) ||
            normalizedText.Contains("access denied", StringComparison.Ordinal) ||
            normalizedText.Contains("unusual traffic", StringComparison.Ordinal) ||
            normalizedText.Contains("temporarily blocked", StringComparison.Ordinal) ||
            normalizedText.Contains("temporarily unavailable", StringComparison.Ordinal) ||
            Regex.IsMatch(normalizedText, "(?:访问|请求|操作).{0,12}(?:频繁|过于频繁).{0,30}(?:无法|稍后|重试)", RegexOptions.CultureInvariant | RegexOptions.Singleline) ||
            Regex.IsMatch(normalizedText, "(?:无法|暂时无法).{0,20}(?:访问|搜索|操作).{0,30}(?:稍后|重试)", RegexOptions.CultureInvariant | RegexOptions.Singleline))
        {
            return ("access_blocked", "site_access_blocked");
        }

        if (passwordCount > 0 ||
            normalizedUrl.Contains("passport.", StringComparison.OrdinalIgnoreCase) ||
            normalizedUrl.Contains("/login", StringComparison.OrdinalIgnoreCase) ||
            normalizedUrl.Contains("/signin", StringComparison.OrdinalIgnoreCase) ||
            normalizedTitle.Contains("欢迎登录", StringComparison.OrdinalIgnoreCase) ||
            normalizedTitle.Contains("sign in", StringComparison.OrdinalIgnoreCase) ||
            (loginSurfaceCount > 0 && (normalizedText.Contains("请登录", StringComparison.Ordinal) ||
                                       normalizedText.Contains("密码登录", StringComparison.Ordinal) ||
                                       normalizedText.Contains("短信登录", StringComparison.Ordinal) ||
                                       normalizedText.Contains("log in", StringComparison.Ordinal) ||
                                       normalizedText.Contains("sign in", StringComparison.Ordinal))))
        {
            return ("login_required", "login_requires_user");
        }

        return (readyState != "loading" || actionableCount > 0 || bodyTextLength > 0 ? "usable" : "loading", null);
    }

    private int? TryGetElementCount(string? selector)
    {
        if (string.IsNullOrWhiteSpace(selector)) return null;
        try
        {
            var value = EvaluateValue($"document.querySelectorAll({JsString(selector)}).length", 500);
            return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var count) ? count : null;
        }
        catch
        {
            return null;
        }
    }

    private JsonElement EvaluateValue(string expression, int timeout)
    {
        var result = Call("Runtime.evaluate", new
        {
            expression,
            awaitPromise = true,
            returnByValue = true,
            userGesture = true,
            replMode = false
        }, timeout);
        if (result.TryGetProperty("exceptionDetails", out var exceptionDetails))
        {
            var description = exceptionDetails.TryGetProperty("text", out var text) ? text.GetString() : null;
            if (exceptionDetails.TryGetProperty("exception", out var exception) && exception.TryGetProperty("description", out var exceptionDescription))
            {
                description = exceptionDescription.GetString() ?? description;
            }
            throw new AgentException("CHROME_SCRIPT_EXCEPTION", description ?? "The page script raised an exception.", false);
        }
        if (!result.TryGetProperty("result", out var remoteObject))
        {
            throw new AgentException("CHROME_SCRIPT_EXCEPTION", "Chrome returned no script result.", true);
        }
        if (remoteObject.TryGetProperty("value", out var value)) return value.Clone();
        if (remoteObject.TryGetProperty("unserializableValue", out var unserializable))
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(unserializable.GetString(), JsonOptions));
            return document.RootElement.Clone();
        }
        return JsonDocument.Parse("null").RootElement.Clone();
    }

    private bool IsTrue(string expression, int timeout = 5000)
    {
        try
        {
            var value = EvaluateValue(expression, timeout);
            return value.ValueKind == JsonValueKind.True;
        }
        catch (AgentException ex) when (ex.Code == "CHROME_SCRIPT_EXCEPTION")
        {
            return false;
        }
    }

    private string GetPageString(string expression, int timeout = 5000)
    {
        var value = EvaluateValue(expression, timeout);
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.ToString();
    }

    private string? TryGetPageString(string expression, int timeout = 5000)
    {
        try { return GetPageString(expression, timeout); } catch { return null; }
    }

    private static string? GetObjectString(JsonElement value, string property)
    {
        return value.ValueKind == JsonValueKind.Object && value.TryGetProperty(property, out var item) && item.ValueKind == JsonValueKind.String
            ? item.GetString()
            : null;
    }

    private static int GetObjectInt(JsonElement value, string property)
    {
        return value.ValueKind == JsonValueKind.Object && value.TryGetProperty(property, out var item) && item.TryGetInt32(out var number)
            ? number
            : 0;
    }

    private object Describe()
    {
        var pageStatus = ReadPageStatus();
        return new
        {
            connected = IsConnected,
            endpoint = _endpoint,
            target_id = _targetId,
            profile_mode = _profileMode,
            managed_profile = _managedProfileDir,
            managed_process_id = _managedProcess is { HasExited: false } ? _managedProcess.Id : (int?)null,
            url = pageStatus.Url,
            title = pageStatus.Title,
            ready_state = pageStatus.ReadyState,
            visibility_state = pageStatus.VisibilityState,
            body_text_length = pageStatus.BodyTextLength,
            actionable_count = pageStatus.ActionableCount,
            page_state = pageStatus.State,
            pause_reason = pageStatus.PauseReason
        };
    }

    private bool TryAttach(string? endpoint, int? requestedPort)
    {
        foreach (var candidate in EnumerateEndpoints(endpoint, requestedPort))
        {
            try
            {
                var version = GetJson(candidate + "/json/version");
                if (!version.TryGetProperty("webSocketDebuggerUrl", out var websocketElement) ||
                    websocketElement.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(websocketElement.GetString())) continue;
                var target = GetTargets(candidate).FirstOrDefault(item => item.Type == "page");
                if (target is null || string.IsNullOrWhiteSpace(target.WebSocketUrl)) continue;
                Connect(candidate, target);
                return true;
            }
            catch
            {
                Disconnect();
            }
        }
        return false;
    }

    private void Connect(string endpoint, ChromeTarget target)
    {
        var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        socket.ConnectAsync(new Uri(target.WebSocketUrl), cts.Token).GetAwaiter().GetResult();
        _socket = socket;
        _endpoint = endpoint;
        _targetId = target.Id;
        Call("Page.enable", new { }, 5000);
        Call("Runtime.enable", new { }, 5000);
        Call("Network.enable", new { }, 5000);
    }

    private JsonElement Call(string method, object parameters, int timeout)
    {
        var socket = _socket;
        if (socket is null || socket.State != WebSocketState.Open)
        {
            throw new AgentException("CHROME_CDP_DISCONNECTED", "The Chrome DevTools connection is no longer open.", true);
        }
        lock (_gate)
        {
            var id = Interlocked.Increment(ref _commandId);
            var payload = JsonSerializer.Serialize(new { id, method, @params = parameters }, JsonOptions);
            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Clamp(timeout, 1, 120000)));
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, _cancelSignal.Token);
            var bytes = Encoding.UTF8.GetBytes(payload);
            try
            {
                socket.SendAsync(bytes, WebSocketMessageType.Text, true, linked.Token).GetAwaiter().GetResult();
            }
            catch (OperationCanceledException) when (Volatile.Read(ref _cancelRequested) != 0)
            {
                throw new AgentException("ACTIVITY_CANCELLED", "The Chrome operation was cancelled by the caller.", false);
            }
            var buffer = new byte[128 * 1024];
            using var message = new MemoryStream();
            while (true)
            {
                WebSocketReceiveResult received;
                try
                {
                    received = socket.ReceiveAsync(buffer, linked.Token).GetAwaiter().GetResult();
                }
                catch (OperationCanceledException) when (Volatile.Read(ref _cancelRequested) != 0)
                {
                    throw new AgentException("ACTIVITY_CANCELLED", "The Chrome operation was cancelled by the caller.", false);
                }
                if (received.MessageType == WebSocketMessageType.Close)
                {
                    Disconnect();
                    throw new AgentException("CHROME_CDP_DISCONNECTED", "Chrome closed the DevTools connection.", true);
                }
                message.Write(buffer, 0, received.Count);
                if (!received.EndOfMessage) continue;
                using var document = JsonDocument.Parse(message.ToArray());
                var root = document.RootElement;
                if (!root.TryGetProperty("id", out var responseId))
                {
                    HandleEvent(root);
                    message.SetLength(0);
                    continue;
                }
                if (responseId.GetInt32() != id)
                {
                    message.SetLength(0);
                    continue;
                }
                if (root.TryGetProperty("error", out var error))
                {
                    var text = error.TryGetProperty("message", out var errorMessage) ? errorMessage.GetString() : "Chrome DevTools command failed.";
                    throw new AgentException("CHROME_CDP_ERROR", text ?? "Chrome DevTools command failed.", true, new { method, error });
                }
                return root.TryGetProperty("result", out var result) ? result.Clone() : JsonDocument.Parse("{}").RootElement.Clone();
            }
        }
    }

    private void StartManagedChrome(JsonElement parameters, int? requestedPort, int startupTimeout)
    {
        var chrome = FindChromeExecutable();
        if (chrome is null)
        {
            throw new AgentException("CHROME_NOT_INSTALLED", "Google Chrome was not found in the standard Windows installation locations.", false);
        }
        // Chromium deliberately exposes navigator.webdriver when launched
        // with --remote-debugging-port=0. Allocate a non-zero loopback port
        // ourselves so a managed browser retains ordinary browser semantics
        // without forcing callers onto a fixed, collision-prone port.
        var port = requestedPort ?? GetFreePort();
        var profile = GetManagedUserDataDir(parameters);
        _managedProfileDir = profile;
        try
        {
            Directory.CreateDirectory(profile);
            var endpointFile = Path.Combine(profile, ManagedEndpointFileName);
            if (File.Exists(endpointFile)) File.Delete(endpointFile);
        }
        catch (Exception ex)
        {
            throw new AgentException("CHROME_PROFILE_FAILED", $"Unable to create the managed Chrome profile: {ex.Message}", false,
                new { profile });
        }
        var start = CreateChromeStartInfo(chrome, profile, port, parameters, restoreSession: false);
        try
        {
            _managedProcess = Process.Start(start) ?? throw new AgentException("CHROME_LAUNCH_FAILED", "Unable to start Chrome.", true);
            _ = DrainProcessStreamAsync(_managedProcess.StandardOutput);
            _ = DrainProcessStreamAsync(_managedProcess.StandardError);
        }
        catch (AgentException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new AgentException("CHROME_LAUNCH_FAILED", $"Unable to start Chrome: {ex.Message}", true, new { executable = chrome });
        }
        _endpoint = $"http://127.0.0.1:{port}";
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromMilliseconds(startupTimeout))
        {
            if (_managedProcess.HasExited)
            {
                throw new AgentException("CHROME_LAUNCH_FAILED", "The managed Chrome process exited before DevTools became ready.", true,
                    new { process_id = _managedProcess.Id, exit_code = _managedProcess.ExitCode });
            }
            if (CanReadEndpoint(_endpoint))
            {
                TryWriteManagedEndpoint(profile, _endpoint);
                return;
            }
            Thread.Sleep(150);
        }
        throw new AgentException("CHROME_LAUNCH_TIMEOUT", "Chrome did not expose DevTools before the startup timeout.", true,
            new { endpoint = _endpoint, process_id = _managedProcess.Id });
    }

    private static ProcessStartInfo CreateChromeStartInfo(string chrome, string profile, int port, JsonElement parameters, bool restoreSession)
    {
        var start = new ProcessStartInfo
        {
            FileName = chrome,
            UseShellExecute = false,
            CreateNoWindow = false,
            WorkingDirectory = Path.GetDirectoryName(chrome) ?? Environment.CurrentDirectory
        };
        // Chrome is a GUI child, but its inherited stdout/stderr must never
        // contaminate the helper's machine-readable NDJSON protocol.
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.ArgumentList.Add($"--remote-debugging-port={port}");
        start.ArgumentList.Add("--remote-allow-origins=*");
        start.ArgumentList.Add($"--user-data-dir={profile}");
        start.ArgumentList.Add("--no-first-run");
        start.ArgumentList.Add("--no-default-browser-check");
        // Managed Chrome must keep rendering while DeskPilot briefly restores
        // the user's original foreground window between interactions. Force
        // renderer accessibility for GUI fallback and suppress stale crash
        // restore UI from a previous helper/process termination.
        start.ArgumentList.Add("--force-renderer-accessibility");
        start.ArgumentList.Add("--disable-background-timer-throttling");
        start.ArgumentList.Add("--disable-backgrounding-occluded-windows");
        start.ArgumentList.Add("--disable-renderer-backgrounding");
        start.ArgumentList.Add("--disable-session-crashed-bubble");
        start.ArgumentList.Add("--hide-crash-restore-bubble");
        start.ArgumentList.Add("--noerrdialogs");
        if (restoreSession) start.ArgumentList.Add("--restore-last-session");
        var startupUrl = GetOptionalString(parameters, "url", "startup_url", "startup-url");
        if (!string.IsNullOrWhiteSpace(startupUrl)) start.ArgumentList.Add(startupUrl);
        return start;
    }

    private bool CanReadEndpoint(string endpoint)
    {
        try
        {
            _ = GetJson(endpoint + "/json/version");
            return true;
        }
        catch { return false; }
    }

    private static string GetManagedUserDataDir(JsonElement parameters)
    {
        return GetOptionalString(parameters, "user_data_dir", "user-data-dir") ??
            GetDefaultManagedUserDataDir();
    }

    private static string GetDefaultManagedUserDataDir() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WindowsAgent", "ChromeProfile");

    private static string? TryReadDevToolsEndpoint(string profile)
    {
        try
        {
            var managedEndpointFile = Path.Combine(profile, ManagedEndpointFileName);
            if (File.Exists(managedEndpointFile))
            {
                var managedEndpoint = File.ReadLines(managedEndpointFile).FirstOrDefault()?.Trim();
                if (Uri.TryCreate(managedEndpoint, UriKind.Absolute, out var endpointUri) &&
                    endpointUri.Scheme == Uri.UriSchemeHttp && endpointUri.IsLoopback && endpointUri.Port is >= 1 and <= 65535)
                {
                    return managedEndpoint!.TrimEnd('/');
                }
            }

            var file = Path.Combine(profile, "DevToolsActivePort");
            if (!File.Exists(file)) return null;
            var firstLine = File.ReadLines(file).FirstOrDefault();
            return int.TryParse(firstLine, out var port) && port is >= 1 and <= 65535
                ? $"http://127.0.0.1:{port}"
                : null;
        }
        catch
        {
            return null;
        }
    }

    private static void TryWriteManagedEndpoint(string profile, string endpoint)
    {
        try
        {
            File.WriteAllText(Path.Combine(profile, ManagedEndpointFileName), endpoint, Encoding.UTF8);
        }
        catch
        {
            // Endpoint persistence is an optimization for a later helper.
            // The current session already has a verified live endpoint.
        }
    }

    private static async Task DrainProcessStreamAsync(StreamReader reader)
    {
        try
        {
            while (await reader.ReadLineAsync().ConfigureAwait(false) is not null) { }
        }
        catch
        {
            // Chrome shutdown is expected during helper cleanup.
        }
    }

    private JsonElement GetJson(string url) => GetJson(url, 900);

    private JsonElement GetJson(string url, int timeoutMs)
    {
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Clamp(timeoutMs, 1, 900)));
        using var response = _http.GetAsync(url, cancellation.Token).GetAwaiter().GetResult();
        response.EnsureSuccessStatusCode();
        using var stream = response.Content.ReadAsStream();
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    }

    private List<ChromeTarget> GetTargets(string endpoint, int timeoutMs = 900)
    {
        var root = GetJson(endpoint + "/json/list", timeoutMs);
        if (root.ValueKind != JsonValueKind.Array) return new List<ChromeTarget>();
        return root.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object).Select(item => new ChromeTarget(
            GetJsonString(item, "id") ?? string.Empty,
            GetJsonString(item, "type") ?? string.Empty,
            GetJsonString(item, "title") ?? string.Empty,
            GetJsonString(item, "url") ?? string.Empty,
            GetJsonString(item, "webSocketDebuggerUrl") ?? string.Empty)).Where(item => item.Id.Length > 0).ToList();
    }

    private static IEnumerable<string> EnumerateEndpoints(string? endpoint, int? requestedPort)
    {
        if (!string.IsNullOrWhiteSpace(endpoint))
        {
            yield return endpoint.TrimEnd('/');
            yield break;
        }
        if (requestedPort is int port)
        {
            yield return $"http://127.0.0.1:{port}";
            yield break;
        }
        for (var candidate = 9222; candidate <= 9232; candidate++) yield return $"http://127.0.0.1:{candidate}";
    }

    private static string? FindChromeExecutable()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
        };
        foreach (var root in roots.Where(path => !string.IsNullOrWhiteSpace(path)))
        {
            var candidate = Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static int GetFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private void Disconnect()
    {
        var socket = _socket;
        _socket = null;
        lock (_inflightRequests) _inflightRequests.Clear();
        try { socket?.Dispose(); } catch { }
    }

    private int InflightRequestCount
    {
        get { lock (_inflightRequests) return _inflightRequests.Count; }
    }

    private DocumentNavigationEvent[] GetDocumentNavigationTrace()
    {
        lock (_documentNavigations) return _documentNavigations.ToArray();
    }

    private void HandleEvent(JsonElement root)
    {
        if (!root.TryGetProperty("method", out var methodElement) || methodElement.ValueKind != JsonValueKind.String) return;
        var method = methodElement.GetString();
        if (!root.TryGetProperty("params", out var parameters) || parameters.ValueKind != JsonValueKind.Object) return;
        if (method == "Network.requestWillBeSent" && parameters.TryGetProperty("requestId", out var requestId) &&
            requestId.ValueKind == JsonValueKind.String && parameters.TryGetProperty("type", out var type) &&
            type.ValueKind == JsonValueKind.String && type.GetString() is not ("WebSocket" or "EventSource"))
        {
            lock (_inflightRequests) _inflightRequests.Add(requestId.GetString()!);
            if (type.GetString() == "Document" && parameters.TryGetProperty("request", out var request) &&
                request.ValueKind == JsonValueKind.Object)
            {
                var requestUrl = GetJsonString(request, "url");
                string? redirectFrom = null;
                int? redirectStatus = null;
                if (parameters.TryGetProperty("redirectResponse", out var redirect) && redirect.ValueKind == JsonValueKind.Object)
                {
                    redirectFrom = GetJsonString(redirect, "url");
                    if (redirect.TryGetProperty("status", out var status) && status.TryGetInt32(out var parsedStatus)) redirectStatus = parsedStatus;
                }

                string? initiatorType = null;
                string? initiatorUrl = null;
                int? initiatorLine = null;
                if (parameters.TryGetProperty("initiator", out var initiator) && initiator.ValueKind == JsonValueKind.Object)
                {
                    initiatorType = GetJsonString(initiator, "type");
                    if (initiator.TryGetProperty("stack", out var stack) && stack.ValueKind == JsonValueKind.Object &&
                        stack.TryGetProperty("callFrames", out var callFrames) && callFrames.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var frame in callFrames.EnumerateArray())
                        {
                            if (frame.ValueKind != JsonValueKind.Object) continue;
                            var frameUrl = GetJsonString(frame, "url");
                            if (string.IsNullOrWhiteSpace(frameUrl)) continue;
                            initiatorUrl = frameUrl;
                            if (frame.TryGetProperty("lineNumber", out var line) && line.TryGetInt32(out var parsedLine)) initiatorLine = parsedLine;
                            break;
                        }
                    }
                }

                lock (_documentNavigations)
                {
                    _documentNavigations.Add(new DocumentNavigationEvent(requestUrl, redirectFrom, redirectStatus, initiatorType, initiatorUrl, initiatorLine));
                    if (_documentNavigations.Count > 16) _documentNavigations.RemoveAt(0);
                }
            }
        }
        else if (method is "Network.loadingFinished" or "Network.loadingFailed" &&
                 parameters.TryGetProperty("requestId", out var finishedId) && finishedId.ValueKind == JsonValueKind.String)
        {
            lock (_inflightRequests) _inflightRequests.Remove(finishedId.GetString()!);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _cancelSignal.Cancel(); } catch { }
        try { _cancelSignal.Dispose(); } catch { }
        Disconnect();
        _http.Dispose();
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(ChromeCdpProvider));
    }

    private static string? GetJsonString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }

    private static double? GetJsonNumber(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)
            ? number
            : null;
    }

    private static string JsString(string value) => JsonSerializer.Serialize(value, JsonOptions);

    private static string GetRequiredString(JsonElement element, params string[] names)
    {
        var value = GetOptionalString(element, names);
        if (string.IsNullOrWhiteSpace(value)) throw new AgentException("INVALID_ARGUMENT", $"{names[0]} is required.", false);
        return value;
    }

    private static string? GetOptionalString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!element.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.String) return value.GetString();
            if (value.ValueKind != JsonValueKind.Null) throw new AgentException("INVALID_ARGUMENT", $"{name} must be a string.", false);
        }
        return null;
    }

    private static string GetPresentString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!element.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.String) return value.GetString() ?? string.Empty;
            throw new AgentException("INVALID_ARGUMENT", $"{name} must be a string.", false);
        }
        throw new AgentException("INVALID_ARGUMENT", $"{names[0]} is required.", false);
    }

    private static bool GetBool(JsonElement element, bool fallback, params string[] names)
    {
        foreach (var name in names)
        {
            if (!element.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.True) return true;
            if (value.ValueKind == JsonValueKind.False) return false;
            if (value.ValueKind == JsonValueKind.String && bool.TryParse(value.GetString(), out var parsed)) return parsed;
            throw new AgentException("INVALID_ARGUMENT", $"{name} must be a boolean.", false);
        }
        return fallback;
    }

    private static int GetInt(JsonElement element, int fallback, params string[] names)
    {
        foreach (var name in names)
        {
            if (!element.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)) return number;
            if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out number)) return number;
            throw new AgentException("INVALID_ARGUMENT", $"{name} must be an integer.", false);
        }
        return fallback;
    }

    private static int GetTimeout(JsonElement element, int fallback)
    {
        return Math.Clamp(GetInt(element, fallback, "timeout", "timeout_ms", "timeout-ms"), 1, 120000);
    }

    private static int? GetOptionalPort(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!element.TryGetProperty(name, out var value)) continue;
            var port = value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
                ? number
                : value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out number) ? number : -1;
            if (port is < 1 or > 65535) throw new AgentException("INVALID_ARGUMENT", $"{name} must be a TCP port between 1 and 65535.", false);
            return port;
        }
        return null;
    }

    private sealed record PageStatus(
        string? Url,
        string? Title,
        string? ReadyState,
        string? VisibilityState,
        int BodyTextLength,
        int ActionableCount,
        string State,
        string? PauseReason);

    private sealed record ChromeTarget(string Id, string Type, string Title, string Url, string WebSocketUrl);

    private sealed record DocumentNavigationEvent(
        [property: JsonPropertyName("url")] string? Url,
        [property: JsonPropertyName("redirect_from")] string? RedirectFrom,
        [property: JsonPropertyName("redirect_status")] int? RedirectStatus,
        [property: JsonPropertyName("initiator_type")] string? InitiatorType,
        [property: JsonPropertyName("initiator_url")] string? InitiatorUrl,
        [property: JsonPropertyName("initiator_line")] int? InitiatorLine);
}

internal sealed record ChromeInteractionTarget(
    string TargetId,
    string? Url,
    string? Title,
    int? ProcessId,
    string? ReadyState,
    string? VisibilityState,
    int BodyTextLength,
    int ActionableCount,
    string PageState,
    string? PauseReason,
    int? BrowserWindowId,
    ChromeWindowBounds? WindowBounds);

internal sealed record ChromeWindowBounds(double? Left, double? Top, double? Width, double? Height);

internal sealed record ClickPoint(
    double X,
    double Y,
    double InnerWidth,
    double InnerHeight,
    double OuterWidth,
    double OuterHeight);

internal sealed record ChromeUserPause(
    [property: JsonPropertyName("state")]
    string State,
    [property: JsonPropertyName("reason")]
    string? Reason,
    [property: JsonPropertyName("url")]
    string? Url,
    [property: JsonPropertyName("title")]
    string? Title,
    [property: JsonPropertyName("process_id")]
    int? ProcessId,
    [property: JsonPropertyName("window_id")]
    string? WindowId = null,
    [property: JsonPropertyName("foreground_preserved")]
    bool ForegroundPreserved = false);
