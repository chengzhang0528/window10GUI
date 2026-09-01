using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Text.Json.Serialization;
using System.Windows.Automation;
using WpfRect = System.Windows.Rect;

namespace WindowsAgent;

internal sealed class AutomationEngine
{
    private readonly SessionState _session = new();
    private readonly object _lifecycleGate = new();
    private int _activeCommandCount;
    private int _cancelRequested;

    internal void Shutdown()
    {
        lock (_lifecycleGate)
        {
            try
            {
                _ = Close();
            }
            catch
            {
                // Shutdown is a best-effort cleanup path. The coordinator
                // itself remains idempotent and will hide the overlay if Close
                // failed.
                _session.Activity.Dispose();
            }
            finally
            {
                _session.Chrome.Dispose();
            }
        }
    }

    internal void ReserveCommand()
    {
        // The host queues normal requests in input order. Count a request at
        // admission time, not only when its continuation starts, so an
        // out-of-band cancel cannot mistake a queued command for an idle
        // session and let it run after the stop boundary.
        Interlocked.Increment(ref _activeCommandCount);
    }

    internal object Execute(string method, JsonElement parameters)
    {
        return ExecuteCommand(method, parameters, commandReserved: false);
    }

    internal object ExecuteReserved(string method, JsonElement parameters)
    {
        return ExecuteCommand(method, parameters, commandReserved: true);
    }

    private object ExecuteCommand(string method, JsonElement parameters, bool commandReserved)
    {
        if (!commandReserved)
        {
            Interlocked.Increment(ref _activeCommandCount);
        }
        try
        {
            lock (_lifecycleGate)
            {
                try
                {
                    return ExecuteUnsafe(method, parameters);
                }
                catch (AgentException ex)
                {
                    // A user-attention pause is a resumable state, not a
                    // failed operation. Preserve it when the bounded command
                    // reports its structured pause error. Cancellation is a
                    // separate terminal state as well: the command's error
                    // envelope is still returned, but the persistent panel
                    // must not turn a user stop into an operation failure.
                    if (ex.Code == "ACTIVITY_CANCELLED" || IsCancellationRequested)
                    {
                        _session.Activity.SetStatus("cancelled");
                    }
                    else if (ShouldPersistFailureStatus(method) &&
                             (!IsChromeMethod(method) || !string.Equals(_session.Activity.Status().Status, "paused", StringComparison.Ordinal)))
                    {
                        _session.Activity.SetStatus("failed", ex.Code);
                    }
                    throw;
                }
                catch
                {
                    _session.Activity.SetStatus("failed");
                    throw;
                }
                finally
                {
                    if (IsCancellationRequested && method is not ("interaction.cancel" or "interaction.end" or "interaction.status" or "close"))
                    {
                        try
                        {
                            _ = _session.Activity.ForceEnd();
                            InvalidateObservationState();
                            ResetCancellationIfIdle();
                        }
                        catch { }
                    }
                }
            }
        }
        finally
        {
            var remainingCommands = Interlocked.Decrement(ref _activeCommandCount);
            if (remainingCommands == 0 && IsCancellationRequested && !string.Equals(method, "close", StringComparison.Ordinal))
            {
                // interaction.status/end are intentionally allowed through a
                // cancellation boundary, so they do not reach the normal
                // ForceEnd cleanup block. Clear a stop flag that survived to
                // the end of the admitted queue before a genuinely new
                // request is accepted.
                lock (_lifecycleGate)
                {
                    if (Volatile.Read(ref _activeCommandCount) == 0)
                    {
                        ResetCancellation();
                    }
                }
            }
        }
    }

    /// <summary>
    /// Fast, out-of-band cancellation path used by the helper request loop.
    /// It deliberately does not take the lifecycle lock: a long-running
    /// command must be able to observe cancellation while that lock is held.
    /// </summary>
    internal object RequestCancellation(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            throw new AgentException("INVALID_ARGUMENT", "interaction.cancel params must be an object.", false);
        }

        var requestedId = GetString(parameters, "interaction_id", "interaction-id", "id");
        var activeId = _session.Activity.InteractionId;
        if (!string.IsNullOrWhiteSpace(requestedId) &&
            _session.Activity.IsActive && !string.Equals(requestedId, activeId, StringComparison.Ordinal))
        {
            throw new AgentException("INTERACTION_ID_MISMATCH", "The interaction_id does not match the active interaction.", false);
        }
        if (!string.IsNullOrWhiteSpace(requestedId) &&
            !_session.Activity.IsActive && Volatile.Read(ref _activeCommandCount) == 0 &&
            !string.Equals(requestedId, _session.Activity.LastInteractionId, StringComparison.Ordinal))
        {
            throw new AgentException("INTERACTION_ID_MISMATCH", "The interaction_id does not match the last interaction.", false);
        }

        if (Volatile.Read(ref _activeCommandCount) == 0)
        {
            lock (_lifecycleGate)
            {
                var hadActiveInteraction = _session.Activity.IsActive;
                var interaction = _session.Activity.Leave();
                if (!interaction.Active) InvalidateObservationState();
                if (hadActiveInteraction)
                {
                    _session.Activity.SetStatus("cancelled");
                }
                ResetCancellation();
                return new { cancellation_requested = false, status = "ended", interaction = MergeActivityBoundary(interaction) };
            }
        }

        Volatile.Write(ref _cancelRequested, 1);
        _session.Chrome.CancelCurrentOperation();
        return new
        {
            cancellation_requested = true,
            status = "cancellation_requested",
            interaction_id = activeId,
            note = _session.Activity.IsActive
                ? "The active command will stop at its next action or wait boundary."
                : "The queued command was marked for cancellation before it acquired the activity lease."
        };
    }

    private bool IsCancellationRequested => Volatile.Read(ref _cancelRequested) != 0;

    private static bool ShouldPersistFailureStatus(string method)
    {
        // These methods validate or manage the lifecycle rather than
        // performing the leased desktop operation. A rejected control-plane
        // request (for example, an end with the wrong interaction id) must
        // not turn an otherwise-running interaction into "failed". Batch and
        // workflow execution classify their own step failures before they
        // throw, so the outer command boundary must not overwrite that state.
        return method is not ("interaction.begin" or "interaction.end" or "interaction.cancel" or "interaction.status" or "actions.batch" or "workflow.run");
    }

    private void ResetCancellation()
    {
        Volatile.Write(ref _cancelRequested, 0);
        _session.Chrome.ResetCancellation();
    }

    private void ResetCancellationIfIdle()
    {
        // Keep a stop request visible to commands that were already queued
        // before the cancel arrived. A later, truly new command can start
        // once the queue drains and the flag is reset.
        if (Volatile.Read(ref _activeCommandCount) <= 1)
        {
            ResetCancellation();
        }
    }

    private void ThrowIfCancellationRequested()
    {
        if (IsCancellationRequested)
        {
            throw new AgentException("ACTIVITY_CANCELLED", "The agent activity was cancelled by the caller.", false,
                new { cancellation_requested = true, interaction_id = _session.Activity.InteractionId });
        }
    }

    private long TraceAction(string method, JsonElement parameters, WindowEntry? preparedChromeWindow = null)
    {
        var label = GetString(parameters, "action_label", "action-label", "display_label", "display-label") ?? method switch
        {
            "input.click" or "input.double_click" or "input.right_click" => "点击目标",
            "input.type" or "ui.set_value" => "填写字段",
            "input.key" or "input.hotkey" => "按下按键",
            "input.scroll" => "滚动页面",
            "messages.observe" => "读取可见消息",
            "ui.click" or "ui.invoke" => "点击控件",
            "ui.select" => "选择选项",
            "windows.activate" => "切换窗口",
            "chrome.navigate" => "打开页面",
            "chrome.fill" => "填写网页字段",
            "chrome.click" => "点击网页控件",
            "chrome.evaluate" => "执行网页脚本",
            "chrome.wait" or "wait.window" or "wait.element" => "等待目标出现",
            _ => "观察电脑状态"
        };

        System.Drawing.Point? point = null;
        try
        {
            if (method is "input.click" or "input.double_click" or "input.right_click" or "input.scroll")
            {
                point = TryResolveWindowPoint(parameters, includeCoordinates: true);
            }
            else if (method is "ui.click" or "ui.invoke" or "ui.set_value" or "ui.select")
            {
                point = TryResolveElementPoint(parameters);
            }
            else if (method == "windows.activate" || method is "input.type" or "input.key" or "input.hotkey")
            {
                point = TryResolveWindowPoint(parameters, includeCoordinates: false);
            }
            else if (method is "ui.find" or "ui.find_all" or "ui.get" or "ui.tree" or "observe" or "windows.find" or "windows.list")
            {
                point = TryResolveWindowPoint(parameters, includeCoordinates: false);
            }
            else if (method == "chrome.click" && preparedChromeWindow is not null)
            {
                point = TryResolveChromeClickPoint(parameters, preparedChromeWindow);
            }
            else if (method.StartsWith("chrome.", StringComparison.Ordinal))
            {
                point = TryResolveChromeWindowPoint();
            }
            else if (method.StartsWith("wait.", StringComparison.Ordinal) || method.StartsWith("screen.", StringComparison.Ordinal))
            {
                point = TryResolveWindowPoint(parameters, includeCoordinates: false);
            }
            else
            {
                point = TryResolveWindowPoint(parameters, includeCoordinates: false);
            }
        }
        catch
        {
            // The trace is diagnostic only and must never turn an otherwise
            // valid action into a failure when a target is transient.
        }

        point ??= TryResolveWindowPoint(parameters, includeCoordinates: false);
        return _session.Activity.BeginActionTrace(label, point);
    }

    private System.Drawing.Point? TryResolveChromeClickPoint(JsonElement parameters, WindowEntry window)
    {
        try
        {
            if (!NativeMethods.TryGetWindowRect(window.Handle, out var rect)) return null;
            var click = _session.Chrome.TryResolveClickPoint(parameters);
            if (click is null || click.InnerWidth <= 0 || click.InnerHeight <= 0 || click.OuterWidth <= 0 || click.OuterHeight <= 0)
            {
                return null;
            }

            // CDP reports viewport/outer dimensions in CSS pixels while the
            // overlay and Win32 input use physical screen pixels.  Derive the
            // scale from the live HWND bounds so mixed-DPI monitors and a
            // browser zoom level do not move the trace to the window center.
            var scaleX = rect.Width / click.OuterWidth;
            var scaleY = rect.Height / click.OuterHeight;
            var chromeLeft = Math.Max(0d, (click.OuterWidth - click.InnerWidth) / 2d);
            var chromeTop = Math.Max(0d, click.OuterHeight - click.InnerHeight);
            var screenX = rect.Left + (chromeLeft + click.X) * scaleX;
            var screenY = rect.Top + (chromeTop + click.Y) * scaleY;
            return new System.Drawing.Point((int)Math.Round(screenX), (int)Math.Round(screenY));
        }
        catch
        {
            return null;
        }
    }

    private System.Drawing.Point? TryResolveElementPoint(JsonElement parameters)
    {
        var id = GetString(parameters, "element_id", "element-id", "element");
        if (string.IsNullOrWhiteSpace(id) || !_session.Elements.TryGetValue(id, out var entry)) return null;
        var bounds = SafeBounds(entry.Element);
        return bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0
            ? null
            : new System.Drawing.Point((int)Math.Round(bounds.Left + bounds.Width / 2), (int)Math.Round(bounds.Top + bounds.Height / 2));
    }

    private System.Drawing.Point? TryResolveWindowPoint(JsonElement parameters, bool includeCoordinates)
    {
        WindowEntry? window = null;
        var id = GetString(parameters, "window_id", "window-id", "window");
        if (!string.IsNullOrWhiteSpace(id) && _session.Windows.TryGetValue(id, out var known)) window = known;
        if (window is null)
        {
            var handle = NativeMethods.GetForegroundWindowHandle();
            window = _session.Windows.Values.FirstOrDefault(item => item.Handle == handle);
            if (window is null && NativeMethods.TryGetWindowRect(handle, out var foregroundRect))
            {
                return new System.Drawing.Point(foregroundRect.Left + Math.Max(1, foregroundRect.Width / 2), foregroundRect.Top + Math.Max(1, foregroundRect.Height / 2));
            }
        }
        if (window is null || !NativeMethods.TryGetWindowRect(window.Handle, out var rect)) return null;

        if (includeCoordinates)
        {
            var x = GetInt(parameters, int.MinValue, "x");
            var y = GetInt(parameters, int.MinValue, "y");
            if (x != int.MinValue && y != int.MinValue)
            {
                return new System.Drawing.Point(rect.Left + x, rect.Top + y);
            }
        }
        return new System.Drawing.Point(rect.Left + Math.Max(1, rect.Width / 2), rect.Top + Math.Max(1, rect.Height / 2));
    }

    private System.Drawing.Point? TryResolveChromeWindowPoint()
    {
        var window = ListWindowEntries().FirstOrDefault(item => item.ProcessName.Contains("chrome", StringComparison.OrdinalIgnoreCase));
        if (window is null || !NativeMethods.TryGetWindowRect(window.Handle, out var rect)) return null;
        return new System.Drawing.Point(rect.Left + Math.Max(1, rect.Width / 2), rect.Top + Math.Max(1, rect.Height / 2));
    }

    private object ExecuteUnsafe(string method, JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            throw new AgentException("INVALID_ARGUMENT", "params must be a JSON object.", false);
        }

        if (IsCancellationRequested && method is not ("actions.batch" or "workflow.run" or "interaction.cancel" or "interaction.end" or "interaction.status" or "close"))
        {
            ThrowIfCancellationRequested();
        }

        if (string.Equals(method, "actions.batch", StringComparison.Ordinal))
        {
            return ExecuteBatch(parameters);
        }

        if (string.Equals(method, "workflow.run", StringComparison.Ordinal))
        {
            return ExecuteWorkflow(parameters);
        }

        if (string.Equals(method, "interaction.begin", StringComparison.Ordinal))
        {
            return BeginInteraction(parameters);
        }

        if (string.Equals(method, "interaction.end", StringComparison.Ordinal) ||
            string.Equals(method, "interaction.cancel", StringComparison.Ordinal))
        {
            return EndInteraction(parameters);
        }

        if (string.Equals(method, "interaction.status", StringComparison.Ordinal))
        {
            return _session.Activity.Status();
        }

        if (!RequiresActivityCue(method) || _session.Activity.IsActive || ConfirmationWouldBlock(parameters))
        {
            return ExecuteCoreWithPause(method, parameters, out _);
        }

        var showOverlay = GetBool(parameters, true, "show_overlay", "show-overlay", "activity_overlay", "activity-overlay");
        var showActionTrace = GetBool(parameters, false, "show_action_trace", "show-action-trace", "visualize_actions", "visualize-actions", "action_trace", "action-trace");
        // Read/observe calls can return live session references. Restoring the
        // user's window immediately after those calls would force the next
        // action to reactivate the target and invalidate the references. The
        // caller can still opt in explicitly; grouped batches/interactions
        // restore by default at their single end boundary.
        var restoreDefault = DefaultRestoreOriginalWindow(method);
        var overlayRequired = GetBool(parameters, false, "overlay_required", "overlay-required", "require_overlay", "require-overlay");
        if (overlayRequired && !showOverlay)
        {
            throw new AgentException("INVALID_ARGUMENT", "overlay_required requires show_overlay=true.", false);
        }
        var activity = _session.Activity.Enter(
            GetString(parameters, "activity_label", "activity-label", "label") ?? "AGENT 操作中",
            showOverlay,
            GetBool(parameters, restoreDefault, "restore_original_window", "restore-original-window", "restore_window", "restore-window"),
            overlayRequired,
            showActionTrace);
        if (!activity.Active)
        {
            throw new AgentException(activity.ErrorCode ?? "ACTIVITY_START_FAILED", activity.ErrorMessage ?? "Unable to start desktop activity.", true);
        }
        ChromeUserPause? pause = null;
        try
        {
            return ExecuteCoreWithPause(method, parameters, out pause);
        }
        catch when (IsMutationMethod(method))
        {
            // SendInput/UIA may have partially crossed the OS mutation
            // boundary before reporting an error. Never leave an element or
            // coordinate token available for a follow-up retry.
            InvalidateObservationState();
            throw;
        }
        finally
        {
            var completion = _session.Activity.Leave();
            if (!completion.Active && completion.RestorationAttempted)
            {
                // A restored foreground window can rebuild the target UIA
                // provider. Never return a post-action observation as if it
                // were still safe to use after this lease boundary.
                InvalidateObservationState();
            }
            if (pause is not null)
            {
                _session.Activity.SetStatus("paused");
            }
        }
    }

    private object ExecuteCore(string method, JsonElement parameters)
    {
        return method switch
        {
            "capabilities" => Capabilities(),
            "doctor" => Doctor(),
            "windows.list" => ListWindows(),
            "windows.find" => FindWindows(parameters),
            "windows.activate" => ActivateWindow(parameters),
            "windows.info" => WindowInfo(parameters),
            "observe" => Observe(parameters),
            "ui.tree" => UiTree(parameters),
            "ui.find" => UiFind(parameters),
            "ui.find_all" => UiFind(parameters),
            "ui.get" => UiGet(parameters),
            "ui.invoke" => UiInvoke(parameters),
            "ui.click" => UiClick(parameters),
            "ui.set_value" => UiSetValue(parameters),
            "ui.select" => UiSelect(parameters),
            "input.click" => InputClick(parameters),
            "input.double_click" => InputClick(parameters, 2),
            "input.right_click" => InputClick(parameters, 1, "right"),
            "input.type" => InputType(parameters),
            "input.key" => InputKey(parameters),
            "input.hotkey" => InputKey(parameters),
            "input.scroll" => InputScroll(parameters),
            "screen.capture" => ScreenCapture(parameters),
            "screen.capture_window" => ScreenCapture(parameters),
            "messages.observe" => ObserveMessages(parameters),
            "wait.window" => WaitWindow(parameters),
            "wait.element" => WaitElement(parameters),
            "chrome.ensure" => _session.Chrome.Ensure(parameters),
            "chrome.targets" => _session.Chrome.Targets(parameters),
            "chrome.attach" => _session.Chrome.Attach(parameters),
            "chrome.navigate" => _session.Chrome.Navigate(parameters),
            "chrome.wait" => _session.Chrome.Wait(parameters),
            "chrome.evaluate" => _session.Chrome.Evaluate(parameters),
            "chrome.fill" => _session.Chrome.Fill(parameters),
            "chrome.select" => _session.Chrome.Select(parameters),
            "chrome.click" => _session.Chrome.Click(parameters),
            "chrome.query" => _session.Chrome.Query(parameters),
            "close" => Close(),
            "schema" => Schema(parameters),
            _ => throw new AgentException("UNKNOWN_METHOD", $"Unknown method '{method}'.", false)
        };
    }

    private object ExecuteCoreWithPause(string method, JsonElement parameters, out ChromeUserPause? pause)
    {
        // close is a lifecycle escape hatch and must always be allowed to
        // drain a pending cancellation; otherwise the cancellation guard
        // below would prevent the very cleanup command that disposes the
        // overlay and Chrome provider.
        if (!string.Equals(method, "close", StringComparison.Ordinal))
        {
            ThrowIfCancellationRequested();
        }
        WindowEntry? chromeWindow = null;
        if (RequiresInteractiveChromeWindow(method))
        {
            chromeWindow = PrepareChromeInteractionWindow(parameters);
        }
        var actionTrace = TraceAction(method, parameters, chromeWindow);
        try
        {
            var result = ExecuteCore(method, parameters);
            if (IsChromeMethod(method) && method != "chrome.targets")
            {
                // A click or script can open/select another tab without
                // changing the top-level HWND. Re-bring the attached target
                // to the front before claiming target_id <-> window_id is
                // verified; an HWND-only check would otherwise bind the
                // result to whichever tab happened to become visible.
                chromeWindow = ActivateCurrentChromeWindow();
            }
            if (!string.Equals(method, "close", StringComparison.Ordinal))
            {
                ThrowIfCancellationRequested();
            }
            return chromeWindow is null ? result : AddChromeWindowBinding(result, chromeWindow);
        }
        finally
        {
            _session.Activity.EndActionTrace(actionTrace);
            // A login page can also surface through a bounded navigation or
            // semantic-wait error. Inspect it on both success and failure so
            // cleanup never returns focus to the unrelated original window.
            pause = IsChromeMethod(method) ? PreserveChromeUserAttention() : null;
        }
    }

    private object AddChromeWindowBinding(object result, WindowEntry window)
    {
        var node = JsonNode.Parse(JsonSerializer.Serialize(result, Program.Options)) as JsonObject ?? new JsonObject();
        window = RefreshWindow(window);
        var target = _session.Chrome.ReadInteractionTarget();
        for (var attempt = 0; attempt < 5 && target.VisibilityState == "hidden"; attempt++)
        {
            Thread.Sleep(50);
            target = _session.Chrome.ReadInteractionTarget();
        }
        if (node.ContainsKey("url")) node["url"] = target.Url;
        if (node.ContainsKey("title")) node["title"] = target.Title;
        if (node.ContainsKey("ready_state")) node["ready_state"] = target.ReadyState;
        if (node.ContainsKey("visibility_state")) node["visibility_state"] = target.VisibilityState;
        if (node.ContainsKey("body_text_length")) node["body_text_length"] = target.BodyTextLength;
        if (node.ContainsKey("actionable_count")) node["actionable_count"] = target.ActionableCount;
        if (node.ContainsKey("page_state")) node["page_state"] = target.PageState;
        if (node.ContainsKey("pause_reason")) node["pause_reason"] = target.PauseReason;

        var boundsDistance = GetChromeWindowBoundsDistance(window, target.WindowBounds);
        var boundsVerified = boundsDistance is not null && boundsDistance <= 160;
        var titleVerified = !string.IsNullOrWhiteSpace(target.Title) &&
                            window.Title.Contains(target.Title, StringComparison.OrdinalIgnoreCase);
        var processVerified = target.ProcessId is int processId && window.ProcessId == (uint)processId;
        var targetVisible = string.Equals(target.VisibilityState, "visible", StringComparison.OrdinalIgnoreCase);
        var windowIdentityVerified = target.WindowBounds is not null
            ? boundsVerified
            : titleVerified && processVerified;
        var verified = NativeMethods.IsForegroundWindow(window.Handle) && targetVisible &&
                       windowIdentityVerified;
        node["window"] = JsonSerializer.SerializeToNode(ToWindowDto(window), Program.Options);
        node["window_binding"] = JsonSerializer.SerializeToNode(new
        {
            verified,
            target_id = target.TargetId,
            window_id = window.Id,
            process_id = window.ProcessId,
            browser_window_id = target.BrowserWindowId,
            target_visibility_state = target.VisibilityState,
            bounds_distance = boundsDistance
        }, Program.Options);
        return SerializeNodeToElement(node);
    }

    private ChromeUserPause? PreserveChromeUserAttention()
    {
        try
        {
            var pause = _session.Chrome.GetUserPause();
            if (pause is null) return null;

            var window = FindChromeWindowForPause(pause);
            if (window is null)
            {
                // Keep the pause explicit even if the browser has no
                // discoverable top-level window (for example, a renderer-only
                // or headless target). The activity completion then reports
                // why the original window had to be restored.
                _ = _session.Activity.PreserveForeground(IntPtr.Zero);
                return pause;
            }

            var preserved = _session.Activity.PreserveForeground(window.Handle);
            return pause with { WindowId = window.Id, ForegroundPreserved = preserved };
        }
        catch
        {
            // Never mask the original Chrome operation error with a best-
            // effort attention/focus diagnostic failure.
            return null;
        }
    }

    private WindowEntry? FindChromeWindowForPause(ChromeUserPause pause)
    {
        var candidates = ListWindowEntries()
            // Include minimized windows: a login page may be waiting behind
            // the user's work, and PreserveForeground will restore it before
            // making it the foreground attention target.
            .Where(window => ProcessMatches(window.ProcessName, "chrome") &&
                             window.Bounds.Width > 0 && window.Bounds.Height > 0)
            .ToList();
        if (candidates.Count == 0) return null;

        if (pause.ProcessId is int processId)
        {
            var processMatches = candidates.Where(window => window.ProcessId == (uint)processId).ToList();
            if (processMatches.Count > 0) candidates = processMatches;
        }

        if (!string.IsNullOrWhiteSpace(pause.Title))
        {
            var titleMatches = candidates
                .Where(window => window.Title.Contains(pause.Title, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (titleMatches.Count > 0) candidates = titleMatches;
        }

        return candidates
            .OrderByDescending(window => NativeMethods.IsForegroundWindow(window.Handle))
            .ThenByDescending(window => window.Bounds.Width * window.Bounds.Height)
            .FirstOrDefault();
    }

    private static bool IsChromeMethod(string method)
    {
        return method is "chrome.ensure" or "chrome.targets" or "chrome.attach" or "chrome.navigate" or "chrome.wait" or
            "chrome.evaluate" or "chrome.fill" or "chrome.select" or "chrome.click" or "chrome.query";
    }

    private static bool RequiresInteractiveChromeWindow(string method)
    {
        return method is "chrome.navigate" or "chrome.wait" or "chrome.evaluate" or
            "chrome.fill" or "chrome.select" or "chrome.click" or "chrome.query";
    }

    private WindowEntry PrepareChromeInteractionWindow(JsonElement parameters)
    {
        _session.Chrome.Ensure(parameters);
        var target = _session.Chrome.PrepareForInteraction();
        return ActivateCurrentChromeWindow(target);
    }

    private WindowEntry ActivateCurrentChromeWindow()
    {
        var target = _session.Chrome.PrepareForInteraction();
        return ActivateCurrentChromeWindow(target);
    }

    private WindowEntry ActivateCurrentChromeWindow(ChromeInteractionTarget target)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 5000)
        {
            var candidates = ListWindowEntries()
                .Where(window => ProcessMatches(window.ProcessName, "chrome") &&
                                 window.Bounds.Width > 0 && window.Bounds.Height > 0)
                .ToList();
            if (target.ProcessId is int processId)
            {
                var processMatches = candidates.Where(window => window.ProcessId == (uint)processId).ToList();
                if (processMatches.Count > 0) candidates = processMatches;
            }
            if (!string.IsNullOrWhiteSpace(target.Title))
            {
                var titleMatches = candidates
                    .Where(window => window.Title.Contains(target.Title, StringComparison.OrdinalIgnoreCase))
                    .ToList();
                if (titleMatches.Count > 0) candidates = titleMatches;
            }

            var boundsMatches = candidates
                .Select(candidate => new { Window = candidate, Distance = GetChromeWindowBoundsDistance(candidate, target.WindowBounds) })
                .Where(candidate => candidate.Distance is not null && candidate.Distance <= 160)
                .OrderBy(candidate => candidate.Distance)
                .Select(candidate => candidate.Window)
                .ToList();
            if (boundsMatches.Count > 0) candidates = boundsMatches;

            var window = candidates
                .OrderByDescending(candidate => NativeMethods.IsForegroundWindow(candidate.Handle))
                .ThenByDescending(candidate => candidate.Bounds.Width * candidate.Bounds.Height)
                .FirstOrDefault();
            if (window is not null) return EnsureUsableWindow(window);
            Thread.Sleep(100);
        }

        throw new AgentException("CHROME_WINDOW_NOT_FOUND", "The attached Chrome page target has no interactive top-level window.", true,
            new { target_id = target.TargetId, target.Url, target.Title, process_id = target.ProcessId });
    }

    private static double? GetChromeWindowBoundsDistance(WindowEntry window, ChromeWindowBounds? targetBounds)
    {
        if (targetBounds?.Left is not double left || targetBounds.Top is not double top ||
            targetBounds.Width is not double width || targetBounds.Height is not double height ||
            width <= 0 || height <= 0)
        {
            return null;
        }

        var dpiScale = 96d / Math.Max(1u, NativeMethods.GetDpi(window.Handle));
        var raw = Math.Abs(window.Bounds.Left - left) + Math.Abs(window.Bounds.Top - top) +
                  Math.Abs(window.Bounds.Width - width) + Math.Abs(window.Bounds.Height - height);
        var scaled = Math.Abs(window.Bounds.Left * dpiScale - left) + Math.Abs(window.Bounds.Top * dpiScale - top) +
                     Math.Abs(window.Bounds.Width * dpiScale - width) + Math.Abs(window.Bounds.Height * dpiScale - height);
        return Math.Min(raw, scaled);
    }

    private static bool RequiresActivityCue(string method)
    {
        return method switch
        {
            "windows.activate" or
            "observe" or
            "ui.tree" or
            "ui.find" or
            "ui.find_all" or
            "ui.get" or
            "ui.invoke" or
            "ui.click" or
            "ui.set_value" or
            "ui.select" or
            "input.click" or
            "input.double_click" or
            "input.right_click" or
            "input.type" or
            "input.key" or
            "input.hotkey" or
            "input.scroll" or
            "screen.capture" or
            "screen.capture_window" or
            "messages.observe" or
            "wait.element" or
            "chrome.ensure" or
            "chrome.targets" or
            "chrome.attach" or
            "chrome.navigate" or
            "chrome.wait" or
            "chrome.evaluate" or
            "chrome.fill" or
            "chrome.select" or
            "chrome.click" or
            "chrome.query" => true,
            _ => false
        };
    }

    private static bool DefaultRestoreOriginalWindow(string method)
    {
        // Calls that return short-lived observation, element, or screenshot
        // references keep their target in front by default so the next
        // request can consume those references without an extra activation.
        // A caller that wants a standalone read to restore focus can pass
        // restore_original_window=true; grouped batches/interactions restore
        // once at their single end boundary.
        return method is not ("windows.activate" or "observe" or "ui.tree" or "ui.find" or "ui.find_all" or "ui.get" or
            "screen.capture" or "screen.capture_window" or "messages.observe" or "wait.element");
    }

    private static bool ConfirmationWouldBlock(JsonElement parameters)
    {
        return GetBool(parameters, false, "require_confirmation", "require-confirmation") &&
               !GetBool(parameters, false, "confirmed", "confirm");
    }

    private object Capabilities()
    {
        return new
        {
            protocol_version = "1",
            product = "Windows Agent CLI",
            platform = "windows",
            runtime = Environment.Version.ToString(),
            commands = new[]
            {
                "capabilities", "doctor", "schema", "observe",
                "windows.list", "windows.find", "windows.activate", "windows.info",
                "ui.tree", "ui.find", "ui.find_all", "ui.get", "ui.invoke", "ui.click", "ui.set_value", "ui.select",
                "input.click", "input.double_click", "input.right_click", "input.type", "input.key", "input.hotkey", "input.scroll",
                "screen.capture", "screen.capture_window", "messages.observe", "wait.window", "wait.element",
                "chrome.ensure", "chrome.targets", "chrome.attach", "chrome.navigate", "chrome.wait", "chrome.evaluate", "chrome.fill", "chrome.select", "chrome.click", "chrome.query",
                "workflow.run",
                "actions.batch", "interaction.begin", "interaction.end", "interaction.cancel", "interaction.status"
            },
            execution_layers = new[] { "cdp_runtime", "cdp_dom", "uia_pattern", "uia_input", "uia_clipboard_paste", "clipboard_paste", "win32", "gdi_capture", "screen_copy", "windows_media_ocr_offline", "coordinate", "activity_overlay" },
            providers = new
            {
                cdp = "first_class_page_provider",
                gui = "first_class_desktop_provider",
                desktop_text = "offline_positioned_text_and_geometry_only_message_candidates",
                routing = "per_step_or_mixed_workflow"
            },
            activity = new
            {
                overlay = "non_activating_static_layered_frame_with_2000ms_sliding_idle_hide",
                status_panel = "session_scoped_non_activating_label",
                action_trace = "optional_synthetic_pointer_and_target_highlight_without_moving_the_real_cursor",
                cancellation = "out_of_band_cooperative_stop_at_action_or_wait_boundaries",
                restoration = "best_effort_original_foreground_window_unless_user_attention_pause",
                batching = "ordered_non_atomic_fail_fast_by_default"
            }
        };
    }

    private object Doctor()
    {
        var screen = NativeMethods.GetVirtualScreen();
        var rootAvailable = false;
        string? rootError = null;
        try
        {
            _ = AutomationElement.RootElement.Current.Name;
            rootAvailable = true;
        }
        catch (Exception ex)
        {
            rootError = ex.Message;
        }

        var windows = ListWindowEntries();
        return new
        {
            ok = true,
            os = Environment.OSVersion.VersionString,
            framework = Environment.Version.ToString(),
            architecture = Environment.Is64BitProcess ? "x64" : "x86",
            interactive_desktop = Environment.UserInteractive,
            session_id = _session.Id,
            process_id = Environment.ProcessId,
            windows_session_id = Process.GetCurrentProcess().SessionId,
            ui_automation = new { available = rootAvailable, error = rootError },
            visible_windows = windows.Count,
            capture = new { backend = "PrintWindow/GDI + verified foreground screen-copy", available = true, trust = "target_identity_and_screen_ownership_checked" },
            desktop_text = OfflineTextRecognition.Diagnose(),
            input = new { backend = "SendInput", available = true },
            activity = _session.Activity.Status(),
            chrome = _session.Chrome.Diagnose(),
            dpi = new { default_dpi = 96 },
            virtual_screen = screen
        };
    }

    private object ListWindows()
    {
        var windows = ListWindowEntries();
        return new
        {
            windows = windows.Select(ToWindowDto).ToArray(),
            count = windows.Count
        };
    }

    private object FindWindows(JsonElement parameters)
    {
        var windows = FindWindowEntries(parameters);
        return new
        {
            windows = windows.Select(ToWindowDto).ToArray(),
            count = windows.Count
        };
    }

    private List<WindowEntry> FindWindowEntries(JsonElement parameters)
    {
        var title = GetString(parameters, "title", "title_contains", "title-contains");
        var exactTitle = GetString(parameters, "title_exact", "title-exact");
        var process = GetString(parameters, "process", "process_name", "process-name", "app");
        var className = GetString(parameters, "class_name", "class-name", "class");
        return ListWindowEntries().Where(window =>
            (string.IsNullOrWhiteSpace(title) || window.Title.Contains(title, StringComparison.OrdinalIgnoreCase)) &&
            (string.IsNullOrWhiteSpace(exactTitle) || string.Equals(window.Title, exactTitle, StringComparison.OrdinalIgnoreCase)) &&
            (string.IsNullOrWhiteSpace(process) || ProcessMatches(window.ProcessName, process)) &&
            (string.IsNullOrWhiteSpace(className) || string.Equals(window.ClassName, className, StringComparison.OrdinalIgnoreCase))).ToList();
    }

    private static bool ProcessMatches(string actual, string requested)
    {
        var normalized = Path.GetFileNameWithoutExtension(requested.Trim());
        return string.Equals(actual, normalized, StringComparison.OrdinalIgnoreCase) ||
               string.Equals(actual, requested.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    private object ActivateWindow(JsonElement parameters)
    {
        var window = RequireWindow(parameters);
        // Foreground changes can invalidate Chrome's renderer accessibility
        // tree even when SetForegroundWindow later reports failure.
        InvalidateObservationState();
        if (!NativeMethods.ActivateWindow(window.Handle))
        {
            throw new AgentException("WINDOW_ACTIVATION_FAILED", $"Unable to activate window '{window.Title}'.", true);
        }
        if (!WaitForForeground(window.Handle))
        {
            throw new AgentException("WINDOW_NOT_FOREGROUND", $"Window '{window.Title}' did not become the foreground window.", true);
        }

        InvalidateObservationState();
        _session.ActiveWindowId = window.Id;
        window = RefreshWindow(window);
        return new { window = ToWindowDto(window), activated = true, execution_layer = "win32" };
    }

    private object WindowInfo(JsonElement parameters)
    {
        return new { window = ToWindowDto(RequireWindow(parameters)) };
    }

    private object Observe(JsonElement parameters)
    {
        var window = EnsureUsableWindow(RequireWindow(parameters));
        var includeScreenshot = GetBool(parameters, true, "include_screenshot", "include-screenshot", "screenshot");
        var includeText = GetBool(parameters, true, "include_text", "include-text", "text");
        var depth = Math.Clamp(GetInt(parameters, 4, "depth"), 0, 12);
        var maxNodes = Math.Clamp(GetInt(parameters, 250, "max_nodes", "max-nodes"), 1, 5000);
        return CreateObservation(window, includeScreenshot, includeText, depth, maxNodes);
    }

    private object UiTree(JsonElement parameters)
    {
        var window = EnsureUsableWindow(RequireWindow(parameters));
        var depth = Math.Clamp(GetInt(parameters, 4, "depth"), 0, 12);
        var maxNodes = Math.Clamp(GetInt(parameters, 250, "max_nodes", "max-nodes"), 1, 5000);
        return CreateObservation(window, false, true, depth, maxNodes);
    }

    private object UiFind(JsonElement parameters)
    {
        var window = EnsureUsableWindow(RequireWindow(parameters));
        var observationId = NewObservationId();
        var matches = FindElements(window, parameters, 2000);
        RegisterObservation(observationId, window);
        _session.CurrentObservationId = observationId;
        var elements = matches.Select(element => ElementDto(RegisterElement(element, window, observationId))).ToArray();
        return new
        {
            observation_id = observationId,
            window = ToWindowDto(window),
            elements,
            count = elements.Length,
            unique = elements.Length == 1
        };
    }

    private object UiGet(JsonElement parameters)
    {
        var entry = RequireElement(parameters);
        var sensitive = SafeIsPassword(entry.Element);
        return new
        {
            observation_id = entry.ObservationId,
            element = ElementDto(entry),
            value = sensitive ? null : TryGetValue(entry.Element),
            text = sensitive ? null : TryGetText(entry.Element),
            selection = TryGetSelection(entry.Element),
            toggle_state = TryGetToggleState(entry.Element)
        };
    }

    private object UiInvoke(JsonElement parameters)
    {
        RequireConfirmationIfRequested(parameters, "ui.invoke");
        var entry = RequireElement(parameters);
        EnsureUsableWindow(entry.Window);
        EnsureElementActionable(entry);
        _session.Activity.UpdateActionTracePoint(TryResolveElementPoint(parameters));
        var layer = "uia_pattern";
        var toggleStateBefore = TryGetToggleState(entry.Element);
        try
        {
            if (entry.Element.TryGetCurrentPattern(InvokePattern.Pattern, out var pattern))
            {
                ((InvokePattern)pattern).Invoke();
            }
            else if (entry.Element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
            {
                ((TogglePattern)pattern).Toggle();
            }
            else
            {
                ClickElement(entry);
                layer = "coordinate";
            }
        }
        catch (ElementNotAvailableException)
        {
            throw new AgentException("ELEMENT_NOT_AVAILABLE", "The UI element became unavailable while invoking the action.", true);
        }

        var toggleStateAfter = TryGetToggleState(entry.Element);
        if (toggleStateBefore is not null && string.Equals(toggleStateBefore, toggleStateAfter, StringComparison.Ordinal))
        {
            for (var attempt = 0; attempt < 10 && string.Equals(toggleStateBefore, toggleStateAfter, StringComparison.Ordinal); attempt++)
            {
                Thread.Sleep(50);
                toggleStateAfter = TryGetToggleState(entry.Element);
            }
        }

        return CompleteAction(entry.Window, layer, parameters, new
        {
            element = ElementDto(entry),
            invoked = true,
            toggle_state_before = toggleStateBefore,
            toggle_state_after = toggleStateAfter
        });
    }

    private object UiClick(JsonElement parameters)
    {
        RequireConfirmationIfRequested(parameters, "ui.click");
        var entry = RequireElement(parameters);
        EnsureUsableWindow(entry.Window);
        EnsureElementActionable(entry);
        _session.Activity.UpdateActionTracePoint(TryResolveElementPoint(parameters));
        var layer = "uia_pattern";
        try
        {
            if (entry.Element.TryGetCurrentPattern(InvokePattern.Pattern, out var pattern) && IsInvokeLike(entry.Element))
            {
                ((InvokePattern)pattern).Invoke();
            }
            else
            {
                ClickElement(entry);
                layer = "coordinate";
            }
        }
        catch (ElementNotAvailableException)
        {
            throw new AgentException("ELEMENT_NOT_AVAILABLE", "The UI element became unavailable while clicking the action.", true);
        }

        return CompleteAction(entry.Window, layer, parameters, new { element = ElementDto(entry), clicked = true });
    }

    private object UiSetValue(JsonElement parameters)
    {
        RequireConfirmationIfRequested(parameters, "ui.set_value");
        var value = GetPresentString(parameters, "value", "text");
        ValidateInputText(value);
        var entry = RequireElement(parameters);
        EnsureUsableWindow(entry.Window);
        EnsureElementActionable(entry);
        _session.Activity.UpdateActionTracePoint(TryResolveElementPoint(parameters));
        if (SafeIsPassword(entry.Element))
        {
            throw new AgentException("SENSITIVE_INPUT_BLOCKED", "Password or secret fields must be entered manually.", false);
        }
        var layer = "uia_pattern";
        try
        {
            if (entry.Element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern))
            {
                if (((ValuePattern)pattern).Current.IsReadOnly)
                {
                    throw new AgentException("ELEMENT_NOT_EDITABLE", "The target value is read-only.", false);
                }
                try
                {
                    ((ValuePattern)pattern).SetValue(value);
                }
                catch (Exception ex) when (ex is not ElementNotAvailableException)
                {
                    // A provider can advertise ValuePattern but reject SetValue
                    // (Chrome is a common example). Fall back to real keyboard input.
                    if (!SafeEnabled(entry.Element))
                    {
                        throw;
                    }
                    FocusElement(entry);
                    NativeMethods.PressKey("CTRL+A");
                    layer = NativeMethods.TypeText(value) == "clipboard_paste" ? "uia_clipboard_paste" : "uia_input";
                }
            }
            else
            {
                FocusElement(entry);
                NativeMethods.PressKey("CTRL+A");
                layer = NativeMethods.TypeText(value) == "clipboard_paste" ? "uia_clipboard_paste" : "uia_input";
            }
        }
        catch (ElementNotAvailableException)
        {
            throw new AgentException("ELEMENT_NOT_AVAILABLE", "The UI element became unavailable while setting its value.", true);
        }

        return CompleteAction(entry.Window, layer, parameters, new { element = ElementDto(entry), value });
    }

    private object UiSelect(JsonElement parameters)
    {
        RequireConfirmationIfRequested(parameters, "ui.select");
        var entry = RequireElement(parameters);
        EnsureUsableWindow(entry.Window);
        EnsureElementActionable(entry);
        _session.Activity.UpdateActionTracePoint(TryResolveElementPoint(parameters));
        var requestedValue = GetString(parameters, "value", "option", "text");
        var layer = "uia_pattern";
        var selected = false;
        try
        {
            if (entry.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var pattern))
            {
                ((SelectionItemPattern)pattern).Select();
                selected = string.IsNullOrWhiteSpace(requestedValue) || SelectionMatches(entry.Element, requestedValue);
            }
            else if (!string.IsNullOrWhiteSpace(requestedValue) && entry.Element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern))
            {
                try
                {
                    ((ValuePattern)valuePattern).SetValue(requestedValue);
                    selected = SelectionMatches(entry.Element, requestedValue);
                }
                catch
                {
                    selected = false;
                }
            }

            if (!selected && !string.IsNullOrWhiteSpace(requestedValue))
            {
                // Native HTML select providers often expose ValuePattern but do
                // not implement SetValue. Focus + literal typing follows the
                // same user-visible selection path and works across Chrome/Edge.
                try
                {
                    if (entry.Element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expandPattern))
                    {
                        ((ExpandCollapsePattern)expandPattern).Expand();
                    }
                }
                catch { }
                FocusElement(entry);
                _ = NativeMethods.TypeText(requestedValue, useClipboardForUnicode: false);
                NativeMethods.PressKey("ENTER");
                selected = SelectionMatches(entry.Element, requestedValue);
                if (!selected)
                {
                    // Some providers expose the option only after a click.
                    ClickElement(entry);
                    _ = NativeMethods.TypeText(requestedValue, useClipboardForUnicode: false);
                    NativeMethods.PressKey("ENTER");
                    selected = SelectionMatches(entry.Element, requestedValue);
                }
                layer = "uia_input";
            }
            else if (!selected)
            {
                ClickElement(entry);
                layer = "coordinate";
                selected = true;
            }
        }
        catch (ElementNotAvailableException)
        {
            throw new AgentException("ELEMENT_NOT_AVAILABLE", "The UI element became unavailable while selecting an option.", true);
        }

        if (!selected)
        {
            throw new AgentException("SELECTION_FAILED", $"The target did not select '{requestedValue}'.", true);
        }

        return CompleteAction(entry.Window, layer, parameters, new { element = ElementDto(entry), selected = true, value = TryGetValue(entry.Element) });
    }

    private object InputClick(JsonElement parameters, int clickCount = 1, string button = "left")
    {
        RequireConfirmationIfRequested(parameters, "input.click");
        if (clickCount == 1 && string.Equals(button, "left", StringComparison.OrdinalIgnoreCase))
        {
            button = GetString(parameters, "button", "mouse_button", "mouse-button") ?? button;
        }
        if (!button.Equals("left", StringComparison.OrdinalIgnoreCase) && !button.Equals("right", StringComparison.OrdinalIgnoreCase) && !button.Equals("middle", StringComparison.OrdinalIgnoreCase))
        {
            throw new AgentException("INVALID_ARGUMENT", $"Unsupported mouse button '{button}'.", false);
        }
        var x = GetInt(parameters, int.MinValue, "x");
        var y = GetInt(parameters, int.MinValue, "y");
        if (x == int.MinValue || y == int.MinValue)
        {
            throw new AgentException("INVALID_ARGUMENT", "input.click requires x and y.", false);
        }

        var window = EnsureUsableWindow(RequireWindow(parameters));
        if (!NativeMethods.TryGetWindowRect(window.Handle, out var rect))
        {
            throw new AgentException("WINDOW_NOT_FOUND", "The target window bounds are unavailable.", true);
        }
        ValidateCoordinateReference(parameters, window, rect);
        if (x < 0 || y < 0 || x >= rect.Width || y >= rect.Height)
        {
            throw new AgentException("COORDINATE_OUT_OF_BOUNDS", $"Point ({x},{y}) is outside the window bounds {rect.Width}x{rect.Height}.", false);
        }
        _session.Activity.UpdateActionTracePoint(new System.Drawing.Point(rect.Left + x, rect.Top + y));
        NativeMethods.ClickScreen(rect.Left + x, rect.Top + y, button, clickCount);
        return CompleteWindowAction(window, "coordinate", parameters, new { x, y, button, click_count = clickCount });
    }

    private object InputType(JsonElement parameters)
    {
        RequireConfirmationIfRequested(parameters, "input.type");
        // Whitespace-only text is still meaningful input (for example, a
        // search/query field that intentionally receives spaces). Require the
        // property to be present, but do not apply the key-style
        // IsNullOrWhiteSpace validation here.
        var text = GetPresentString(parameters, "text", "value");
        ValidateInputText(text);
        var window = EnsureUsableWindow(RequireWindow(parameters));
        EnsureFocusedInputSafe(window);
        var layer = NativeMethods.TypeText(text);
        return CompleteWindowAction(window, layer, parameters, new { text_length = text.Length });
    }

    private object InputKey(JsonElement parameters)
    {
        RequireConfirmationIfRequested(parameters, "input.key");
        var key = GetRequiredString(parameters, "key", "keys");
        try
        {
            // Validate the complete chord before activating a target window so
            // malformed input cannot cause a visible focus change.
            _ = NativeMethods.ParseKeyChord(key);
            var window = EnsureUsableWindow(RequireWindow(parameters));
            NativeMethods.PressKey(key);
            return CompleteWindowAction(window, "send_input", parameters, new { key });
        }
        catch (ArgumentException ex)
        {
            // Parse/validation failures are caller errors, not an uncertain
            // input boundary. Keep the public protocol stable instead of
            // leaking the native ArgumentException as INTERNAL_ERROR.
            throw new AgentException("INVALID_ARGUMENT", ex.Message, false);
        }
    }

    private object InputScroll(JsonElement parameters)
    {
        RequireConfirmationIfRequested(parameters, "input.scroll");
        var x = GetInt(parameters, 20, "x");
        var y = GetInt(parameters, 20, "y");
        var amount = GetInt(parameters, -600, "amount", "scroll_y", "scroll-y");
        var window = EnsureUsableWindow(RequireWindow(parameters));
        if (!NativeMethods.TryGetWindowRect(window.Handle, out var rect))
        {
            throw new AgentException("WINDOW_NOT_FOUND", "The target window bounds are unavailable.", true);
        }
        ValidateCoordinateReference(parameters, window, rect);
        if (x < 0 || y < 0 || x >= rect.Width || y >= rect.Height)
        {
            throw new AgentException("COORDINATE_OUT_OF_BOUNDS", $"Point ({x},{y}) is outside the window bounds {rect.Width}x{rect.Height}.", false);
        }
        _session.Activity.UpdateActionTracePoint(new System.Drawing.Point(rect.Left + x, rect.Top + y));
        NativeMethods.Scroll(rect.Left + x, rect.Top + y, amount);
        return CompleteWindowAction(window, "send_input", parameters, new { x, y, amount });
    }

    private object ScreenCapture(JsonElement parameters)
    {
        var window = EnsureUsableWindow(RequireWindow(parameters));
        var requested = GetString(parameters, "path", "output", "output_path", "output-path");
        // A foreground window can own visible menus, autocomplete lists, and
        // other popup surfaces that PrintWindow does not composite into the
        // parent HWND. Capture the actual on-screen pixels while the explicitly
        // selected target is foreground; background windows still use GDI so
        // another application's pixels are never attributed to the target.
        var capture = _session.Activity.CaptureWithoutOverlay(() => NativeMethods.CaptureWindow(window.Handle, requested,
            preferForegroundScreenCopy: true));
        var path = capture.Path;
        // Register generated captures before any metadata read can fail so a
        // later exception cannot orphan the temporary file.
        TrackOwnedCapture(path, requested);
        var info = new FileInfo(path);
        TrimCaches();
        var screenshotId = $"shot_{++_session.ScreenshotCounter:0000}";
        var bounds = window.Bounds;
        _session.Screenshots[screenshotId] = new ScreenshotEntry(screenshotId, null, window.Handle, bounds, path);
        _session.LatestScreenshotByWindow[window.Handle] = screenshotId;
        return new
        {
            window = ToWindowDto(window),
            screenshot = new
            {
                screenshot_id = screenshotId,
                path,
                mime_type = "image/png",
                size = info.Length,
                width = bounds.Width,
                height = bounds.Height,
                origin = new { x = bounds.Left, y = bounds.Top },
                dpi = NativeMethods.GetDpi(window.Handle),
                capture_layer = capture.Layer,
                blank_printwindow = capture.BlankPrintWindow,
                trusted = capture.Trusted,
                foreground_relation = capture.ForegroundRelation,
                foreground_handle = capture.ForegroundHandle,
                foreground_process_id = capture.ForegroundProcessId,
                ownership_samples = new { total = capture.OwnershipSampleCount, related = capture.RelatedOwnershipSampleCount }
            }
        };
    }

    private object ObserveMessages(JsonElement parameters)
    {
        var window = EnsureUsableWindow(RequireWindow(parameters));
        var requested = GetString(parameters, "path", "output", "output_path", "output-path");
        var capture = _session.Activity.CaptureWithoutOverlay(() => NativeMethods.CaptureWindow(window.Handle, requested, preferForegroundScreenCopy: true));
        var path = capture.Path;
        TrackOwnedCapture(path, requested);
        var info = new FileInfo(path);
        TrimCaches();
        var screenshotId = $"shot_{++_session.ScreenshotCounter:0000}";
        var bounds = window.Bounds;
        _session.Screenshots[screenshotId] = new ScreenshotEntry(screenshotId, null, window.Handle, bounds, path);
        _session.LatestScreenshotByWindow[window.Handle] = screenshotId;

        var fullRegion = new TextBounds(0, 0, bounds.Width, bounds.Height);
        var identityRegion = ReadTextRegion(parameters, fullRegion, "identity_region", "identity-region", "context_region", "context-region");
        var contentRegion = ReadTextRegion(parameters, fullRegion, "content_region", "content-region", "message_region", "message-region");
        // Identity titles and message bodies have materially different font
        // sizes. Infer the title from the native-scale full layout (cropping
        // can remove the context Windows OCR needs), while cropping and scaling
        // the caller-owned content region for small CJK chat text. The provider
        // caps scaling to Windows OCR limits and maps all bounds back.
        var identityRecognition = OfflineTextRecognition.Recognize(path, null, 1d);
        var contentRecognition = OfflineTextRecognition.Recognize(path, contentRegion, 3d);
        var includeTextBlocks = GetBool(parameters, false, "include_text_blocks", "include-text-blocks", "include_blocks", "include-blocks");
        var includeWords = GetBool(parameters, false, "include_words", "include-words");
        var identityBlocks = identityRecognition.Blocks.Where(block => CenterInside(block.Bounds, identityRegion)).ToArray();
        var contentBlocks = contentRecognition.Blocks.Where(block => CenterInside(block.Bounds, contentRegion)).ToArray();
        var expectedIdentity = GetStringArray(parameters, "expected_identity", "expected-identity", "expected_context", "expected-context");
        var identityText = string.Join("\n", identityBlocks.Select(block => block.Text));
        var matchMode = (GetString(parameters, "identity_match", "identity-match", "context_match", "context-match") ?? "all").Trim().ToLowerInvariant();
        if (matchMode is not ("all" or "any"))
        {
            throw new AgentException("INVALID_ARGUMENT", "identity_match must be 'all' or 'any'.", false);
        }
        var matchedTerms = expectedIdentity.Where(expected => ContainsIdentity(identityText, expected)).ToArray();
        var identityMatched = expectedIdentity.Length == 0 ||
            (matchMode == "all" ? matchedTerms.Length == expectedIdentity.Length : matchedTerms.Length > 0);

        var screenshot = new
        {
            screenshot_id = screenshotId,
            path,
            mime_type = "image/png",
            size = info.Length,
            width = bounds.Width,
            height = bounds.Height,
            origin = new { x = bounds.Left, y = bounds.Top },
            dpi = NativeMethods.GetDpi(window.Handle),
            capture_layer = capture.Layer,
            blank_printwindow = capture.BlankPrintWindow,
            trusted = capture.Trusted,
            foreground_relation = capture.ForegroundRelation,
            foreground_handle = capture.ForegroundHandle,
            foreground_process_id = capture.ForegroundProcessId,
            ownership_samples = new { total = capture.OwnershipSampleCount, related = capture.RelatedOwnershipSampleCount }
        };

        if (!identityMatched)
        {
            throw new AgentException("CONTEXT_IDENTITY_MISMATCH", "The visible text does not match the caller-supplied conversation identity.", true,
                new
                {
                    window = ToWindowDto(window),
                    screenshot,
                    expected = expectedIdentity,
                    matched = matchedTerms,
                    match_mode = matchMode,
                    observed_text = Truncate(identityText, 4000),
                    identity_region = BoundsDto(identityRegion)
                });
        }

        var candidates = contentBlocks
            .OrderBy(block => block.Bounds.Y)
            .ThenBy(block => block.Bounds.X)
            .Select((block, index) =>
            {
                var side = GetConversationSide(block.Bounds, contentRegion);
                return new
                {
                    candidate_id = $"msg_{index + 1:0000}",
                    sequence = index + 1,
                    text = block.Text,
                    side,
                    role_hint = side switch { "left" => "incoming", "right" => "outgoing", _ => "system_or_unknown" },
                    bounds = BoundsDto(block.Bounds),
                    source_block_id = block.Id
                };
            })
            .ToArray();

        return new
        {
            window = ToWindowDto(window),
            screenshot,
            recognition = new
            {
                backend = contentRecognition.Backend,
                language = contentRecognition.Language,
                offline = true,
                identity = new { text = identityText, blocks = includeTextBlocks ? identityBlocks.Select(block => TextBlockDto(block, includeWords)).ToArray() : null },
                content = new { text = string.Join("\n", contentBlocks.Select(block => block.Text)), blocks = includeTextBlocks ? contentBlocks.Select(block => TextBlockDto(block, includeWords)).ToArray() : null }
            },
            context_identity = new
            {
                expected = expectedIdentity,
                matched = identityMatched,
                matched_terms = matchedTerms,
                match_mode = matchMode,
                observed_text = identityText,
                region = BoundsDto(identityRegion)
            },
            message_candidates = candidates,
            message_region = BoundsDto(contentRegion),
            count = candidates.Length
        };
    }

    private static object TextBlockDto(TextBlock block, bool includeWords) => new
    {
        block_id = block.Id,
        text = block.Text,
        bounds = BoundsDto(block.Bounds),
        words = includeWords ? block.Words.Select(word => new { text = word.Text, bounds = BoundsDto(word.Bounds) }).ToArray() : null
    };

    private static object BoundsDto(TextBounds bounds)
        => new { x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height };

    private static bool CenterInside(TextBounds block, TextBounds region)
        => block.CenterX >= region.X && block.CenterX < region.Right &&
           block.CenterY >= region.Y && block.CenterY < region.Bottom;

    private static string GetConversationSide(TextBounds block, TextBounds region)
    {
        var relative = (block.CenterX - region.X) / (double)Math.Max(1, region.Width);
        if (relative < 0.44) return "left";
        if (relative > 0.56) return "right";
        return "center";
    }

    private static TextBounds ReadTextRegion(JsonElement parameters, TextBounds fallback, params string[] names)
    {
        foreach (var name in names)
        {
            if (!parameters.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind != JsonValueKind.Object)
            {
                throw new AgentException("INVALID_ARGUMENT", $"{name} must be an object with x, y, width, and height.", false);
            }
            var x = Math.Clamp(GetInt(value, 0, "x"), 0, Math.Max(0, fallback.Width - 1));
            var y = Math.Clamp(GetInt(value, 0, "y"), 0, Math.Max(0, fallback.Height - 1));
            var width = Math.Clamp(GetInt(value, fallback.Width - x, "width"), 1, Math.Max(1, fallback.Width - x));
            var height = Math.Clamp(GetInt(value, fallback.Height - y, "height"), 1, Math.Max(1, fallback.Height - y));
            return new TextBounds(x, y, width, height);
        }
        return fallback;
    }

    private static string[] GetStringArray(JsonElement parameters, params string[] names)
    {
        foreach (var name in names)
        {
            if (!parameters.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.String)
            {
                var text = value.GetString()?.Trim();
                return string.IsNullOrWhiteSpace(text) ? Array.Empty<string>() : new[] { text };
            }
            if (value.ValueKind != JsonValueKind.Array)
            {
                throw new AgentException("INVALID_ARGUMENT", $"{name} must be a string or string array.", false);
            }
            var result = new List<string>();
            foreach (var item in value.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String)
                {
                    throw new AgentException("INVALID_ARGUMENT", $"{name} must contain only strings.", false);
                }
                var text = item.GetString()?.Trim();
                if (!string.IsNullOrWhiteSpace(text)) result.Add(text);
            }
            return result.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }
        return Array.Empty<string>();
    }

    private static string Truncate(string value, int maxLength)
        => value.Length <= maxLength ? value : value[..maxLength];

    private static bool ContainsIdentity(string observed, string expected)
    {
        var observedNormalized = NormalizeIdentity(observed);
        var expectedNormalized = NormalizeIdentity(expected);
        if (expectedNormalized.Length == 0) return true;
        if (observedNormalized.Contains(expectedNormalized, StringComparison.OrdinalIgnoreCase)) return true;
        if (expectedNormalized.Length < 4) return false;

        // Windows OCR can confuse one glyph in a stable title (for example
        // digit 0 and letter D). Permit a small edit distance only inside a
        // same-length title window; this stays much stricter than matching a
        // process name or accepting any conversation in the same app.
        var maxDistance = Math.Clamp((int)Math.Ceiling(expectedNormalized.Length * 0.15), 1, 2);
        var minLength = Math.Max(1, expectedNormalized.Length - maxDistance);
        var maxLength = Math.Min(observedNormalized.Length, expectedNormalized.Length + maxDistance);
        for (var length = minLength; length <= maxLength; length++)
        {
            for (var start = 0; start + length <= observedNormalized.Length; start++)
            {
                if (EditDistanceWithin(observedNormalized.AsSpan(start, length), expectedNormalized.AsSpan(), maxDistance))
                {
                    return true;
                }
            }
        }
        return false;
    }

    private static string NormalizeIdentity(string value)
        => new(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    private static bool EditDistanceWithin(ReadOnlySpan<char> left, ReadOnlySpan<char> right, int limit)
    {
        if (Math.Abs(left.Length - right.Length) > limit) return false;
        var previous = new int[right.Length + 1];
        var current = new int[right.Length + 1];
        for (var column = 0; column <= right.Length; column++) previous[column] = column;
        for (var row = 1; row <= left.Length; row++)
        {
            current[0] = row;
            var rowMinimum = current[0];
            for (var column = 1; column <= right.Length; column++)
            {
                var cost = left[row - 1] == right[column - 1] ? 0 : 1;
                current[column] = Math.Min(
                    Math.Min(current[column - 1] + 1, previous[column] + 1),
                    previous[column - 1] + cost);
                rowMinimum = Math.Min(rowMinimum, current[column]);
            }
            if (rowMinimum > limit) return false;
            (previous, current) = (current, previous);
        }
        return previous[right.Length] <= limit;
    }

    private object WaitWindow(JsonElement parameters)
    {
        var timeout = Math.Clamp(GetInt(parameters, 5000, "timeout", "timeout_ms", "timeout-ms"), 1, 120000);
        var stopwatch = Stopwatch.StartNew();
        var lastMatchCount = 0;
        while (stopwatch.ElapsedMilliseconds < timeout)
        {
            ThrowIfCancellationRequested();
            var matches = FindWindowEntries(parameters);
            lastMatchCount = matches.Count;
            if (matches.Count > 0)
            {
                return new { matched = true, elapsed_ms = stopwatch.ElapsedMilliseconds, windows = matches.Select(ToWindowDto).ToArray() };
            }
            Thread.Sleep(100);
        }
        throw new AgentException("WAIT_TIMEOUT", "No window matched before the timeout.", true,
            new { stage = "window_match", matched = false, elapsed_ms = stopwatch.ElapsedMilliseconds, timeout_ms = timeout,
                last_match_count = lastMatchCount, windows = Array.Empty<object>() });
    }

    private object WaitElement(JsonElement parameters)
    {
        var timeout = Math.Clamp(GetInt(parameters, 5000, "timeout", "timeout_ms", "timeout-ms"), 1, 120000);
        var window = EnsureUsableWindow(RequireWindow(parameters));
        var stopwatch = Stopwatch.StartNew();
        var lastMatchCount = 0;
        var transientErrorCount = 0;
        string? lastTransientErrorCode = null;
        while (stopwatch.ElapsedMilliseconds < timeout)
        {
            ThrowIfCancellationRequested();
            List<AutomationElement> matches;
            try
            {
                matches = FindElements(window, parameters, 100);
            }
            catch (AgentException ex) when (ex.Retryable)
            {
                // Chrome and other dynamic applications commonly replace their
                // accessibility subtree while navigating. A wait owns that
                // transient period, so keep polling until a match or its budget
                // is exhausted instead of failing the whole workflow immediately.
                transientErrorCount++;
                lastTransientErrorCode = ex.Code;
                Thread.Sleep(100);
                continue;
            }
            lastMatchCount = matches.Count;
            if (matches.Count > 0)
            {
                var observationId = NewObservationId();
                RegisterObservation(observationId, window);
                _session.CurrentObservationId = observationId;
                var elements = matches.Select(element => ElementDto(RegisterElement(element, window, observationId))).ToArray();
                return new { matched = true, elapsed_ms = stopwatch.ElapsedMilliseconds, observation_id = observationId, elements };
            }
            Thread.Sleep(100);
        }
        throw new AgentException("WAIT_TIMEOUT", "No UI element matched before the timeout.", true,
            new { stage = "element_match", matched = false, elapsed_ms = stopwatch.ElapsedMilliseconds, timeout_ms = timeout,
                window_id = window.Id, last_match_count = lastMatchCount, transient_error_count = transientErrorCount,
                last_transient_error_code = lastTransientErrorCode, elements = Array.Empty<object>() });
    }

    private object Schema(JsonElement parameters)
    {
        var command = GetString(parameters, "command", "method");
        var common = new
        {
            protocol_version = "1",
            required = new[] { "method", "params" },
            envelope = new { ok = "boolean", request_id = "string", result = "object", error = "object" }
        };
        if (string.IsNullOrWhiteSpace(command))
        {
            return new { common, methods = Capabilities() };
        }
        return new { common, method = command, note = "Use --help or capabilities for the current command catalog." };
    }

    private object BeginInteraction(JsonElement parameters)
    {
        RequireObjectParameters(parameters, "interaction.begin");
        if (_session.Activity.IsActive)
        {
            throw new AgentException("INTERACTION_ALREADY_ACTIVE", "An interaction is already active in this session.", false);
        }

        var label = GetString(parameters, "activity_label", "activity-label", "label") ?? "AGENT 操作中";
        var showOverlay = GetBool(parameters, true, "show_overlay", "show-overlay", "activity_overlay", "activity-overlay");
        var showActionTrace = GetBool(parameters, false, "show_action_trace", "show-action-trace", "visualize_actions", "visualize-actions", "action_trace", "action-trace");
        var restoreOriginal = GetBool(parameters, true, "restore_original_window", "restore-original-window", "restore_window", "restore-window");
        var overlayRequired = GetBool(parameters, false, "overlay_required", "overlay-required", "require_overlay", "require-overlay");
        if (overlayRequired && !showOverlay)
        {
            throw new AgentException("INVALID_ARGUMENT", "overlay_required requires show_overlay=true.", false);
        }
        // A new activity boundary makes all references obtained before it
        // intentionally stale: focus and monitor state may change while the
        // agent owns the visible desktop cue.
        InvalidateObservationState();
        var activity = _session.Activity.Enter(label, showOverlay, restoreOriginal, overlayRequired, showActionTrace);
        if (!activity.Active)
        {
            throw new AgentException(activity.ErrorCode ?? "ACTIVITY_START_FAILED", activity.ErrorMessage ?? "Unable to start desktop activity.", true);
        }

        return new { interaction = activity };
    }

    private object EndInteraction(JsonElement parameters)
    {
        RequireObjectParameters(parameters, "interaction.end");
        var requestedId = GetString(parameters, "interaction_id", "interaction-id", "id");
        if (!string.IsNullOrWhiteSpace(requestedId) &&
            ((_session.Activity.IsActive && !string.Equals(requestedId, _session.Activity.InteractionId, StringComparison.Ordinal)) ||
             (!_session.Activity.IsActive && !string.Equals(requestedId, _session.Activity.LastInteractionId, StringComparison.Ordinal))))
        {
            throw new AgentException("INTERACTION_ID_MISMATCH", "The interaction_id does not match the active or last interaction.", false);
        }

        var interaction = _session.Activity.Leave();
        if (!interaction.Active)
        {
            InvalidateObservationState();
        }
        return new { interaction };
    }

    private object ExecuteBatch(JsonElement parameters)
    {
        var specs = ParseBatchSpecs(parameters);
        // Validate batch-level activity options even for an empty batch so
        // malformed requests cannot bypass the normal batch contract.
        var showOverlay = GetBool(parameters, true, "show_overlay", "show-overlay", "activity_overlay", "activity-overlay");
        var showActionTrace = GetBool(parameters, false, "show_action_trace", "show-action-trace", "visualize_actions", "visualize-actions", "action_trace", "action-trace");
        var restoreOriginal = GetBool(parameters, true, "restore_original_window", "restore-original-window", "restore_window", "restore-window");
        var overlayRequired = GetBool(parameters, false, "overlay_required", "overlay-required", "require_overlay", "require-overlay");
        if (overlayRequired && !showOverlay)
        {
            throw new AgentException("INVALID_ARGUMENT", "overlay_required requires show_overlay=true.", false);
        }

        if (specs.Count == 0)
        {
            return new
            {
                status = "completed",
                steps = Array.Empty<object>(),
                activity = _session.Activity.Status(),
                duration_ms = 0L
            };
        }

        ValidateBatchSpecs(specs);
        var stopOnError = GetStopOnError(parameters);
        var timeoutMs = Math.Clamp(GetInt(parameters, 120000, "timeout", "timeout_ms", "timeout-ms"), 1, 120000);
        var label = GetString(parameters, "activity_label", "activity-label", "label") ?? "AGENT 操作中";
        // An explicit interaction already owns the cue and its restoration
        // policy. A batch joins that lease rather than nesting another one.
        // A batch is the agent's visible activity boundary even when every
        // step is a read (for example windows.list followed by a decision).
        // Start the lease whenever the caller requested the cue; otherwise a
        // successful overlay_required=true batch could silently execute with
        // no overlay at all.
        var needsActivity = !_session.Activity.IsActive && (showOverlay || specs.Any(spec => RequiresActivityCue(spec.Method)));
        var startedAt = Stopwatch.StartNew();
        var stepResults = new List<BatchStepResult>(specs.Count);
        var resultByStep = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        ActivityResult? activityResult = null;
        BatchStepSpec? firstFailedStep = null;
        Exception? firstFailure = null;
        var mutationFailure = false;
        var mutationOccurred = false;
        var refsInvalidated = false;
        var stepStarted = false;
        var nonMutationFailureSeen = false;
        ChromeUserPause? userPause = null;
        var cancelled = false;
        BatchStepSpec? cancellationStep = null;

        if (needsActivity)
        {
            if (!IsCancellationRequested) ResetCancellation();
            var activity = _session.Activity.Enter(label, showOverlay, restoreOriginal, overlayRequired, showActionTrace);
            if (!activity.Active)
            {
                throw new AgentException(activity.ErrorCode ?? "ACTIVITY_START_FAILED", activity.ErrorMessage ?? "Unable to start desktop activity.", true);
            }
        }

        try
        {
            for (var index = 0; index < specs.Count; index++)
            {
                var spec = specs[index];
                if (IsCancellationRequested)
                {
                    cancelled = true;
                    cancellationStep = spec;
                    stepResults.Add(BatchStepResult.Cancelled(spec.StepId, spec.Method, null));
                    break;
                }
                if (startedAt.ElapsedMilliseconds >= timeoutMs)
                {
                    var timeout = new AgentException("BATCH_TIMEOUT", "The batch deadline expired before this step started.", true);
                    firstFailedStep ??= spec;
                    firstFailure ??= timeout;
                    stepResults.Add(BatchStepResult.NotStarted(spec.StepId, spec.Method, timeout));
                    break;
                }

                JsonElement resolvedParameters;
                try
                {
                    resolvedParameters = ResolveBatchReferences(spec.Parameters, resultByStep, specs, index);
                }
                catch (Exception ex)
                {
                    firstFailedStep ??= spec;
                    firstFailure ??= ex;
                    stepResults.Add(BatchStepResult.NotStarted(spec.StepId, spec.Method, ex));
                    break;
                }

                if (!stopOnError && nonMutationFailureSeen && IsMutationMethod(spec.Method))
                {
                    var blocked = new AgentException(
                        "BATCH_STOPPED_AFTER_FAILURE",
                        "A mutating step cannot continue after a prior non-mutating batch step failed.",
                        false);
                    firstFailedStep ??= spec;
                    firstFailure ??= blocked;
                    stepResults.Add(BatchStepResult.NotStarted(spec.StepId, spec.Method, blocked));
                    break;
                }

                stepStarted = true;
                ChromeUserPause? stepPause = null;
                try
                {
                    var childResult = ExecuteCoreWithPause(
                        spec.Method,
                        ClampBatchStepTimeout(spec.Method, resolvedParameters, timeoutMs, startedAt),
                        out stepPause);
                    var serialized = SerializeToElement(childResult);
                    if (startedAt.ElapsedMilliseconds > timeoutMs)
                    {
                        var timeout = new AgentException("BATCH_TIMEOUT", "The batch deadline was exceeded while this step was running.", true);
                        firstFailedStep ??= spec;
                        firstFailure ??= timeout;
                        if (IsMutationMethod(spec.Method))
                        {
                            mutationOccurred = true;
                            mutationFailure = true;
                            refsInvalidated = true;
                            InvalidateObservationState();
                        }
                        stepResults.Add(BatchStepResult.TimedOut(spec.StepId, spec.Method, serialized, timeout));
                        break;
                    }
                    resultByStep[spec.StepId] = serialized;
                    stepResults.Add(BatchStepResult.Succeeded(spec.StepId, spec.Method, childResult));
                    if (IsMutationMethod(spec.Method))
                    {
                        // CompleteAction/CompleteWindowAction invalidate the
                        // session observation generation after a successful
                        // write or activation as well.
                        refsInvalidated = true;
                        mutationOccurred = true;
                    }
                    if (stepPause is not null)
                    {
                        // Login/risk pages are a user-attention boundary. The
                        // command itself succeeded, but later steps must not
                        // race the user's interactive sign-in or verification.
                        userPause = stepPause;
                        break;
                    }
                }
                catch (Exception ex)
                {
                    if (IsCancellationRequested || (ex is AgentException cancelledAgent && cancelledAgent.Code == "ACTIVITY_CANCELLED"))
                    {
                        cancelled = true;
                        cancellationStep = spec;
                        var cancelledMutation = MutationMayHaveRun(spec.Method, ex);
                        if (cancelledMutation)
                        {
                            InvalidateObservationState();
                            refsInvalidated = true;
                            mutationOccurred = true;
                        }
                        stepResults.Add(BatchStepResult.Cancelled(spec.StepId, spec.Method, ex, cancelledMutation));
                        break;
                    }
                    if (stepPause is not null)
                    {
                        // The page is waiting for the user even though the
                        // bounded command failed (for example, a selector
                        // wait timed out on a login page). Preserve the
                        // original error in the step for diagnosis, but make
                        // the batch a resumable user-attention pause.
                        stepResults.Add(BatchStepResult.Failed(spec.StepId, spec.Method, ex, mutationMayHaveRun: false));
                        userPause = stepPause;
                        break;
                    }
                    // A failed UI/input operation may have crossed the OS
                    // mutation boundary. Do not leave stale element references
                    // available for a later step or an automatic retry.
                    var mutation = MutationMayHaveRun(spec.Method, ex);
                    if (mutation)
                    {
                        InvalidateObservationState();
                        refsInvalidated = true;
                        mutationOccurred = true;
                    }
                    else
                    {
                        nonMutationFailureSeen = true;
                    }
                    firstFailedStep ??= spec;
                    firstFailure ??= ex;
                    mutationFailure |= mutation;
                    stepResults.Add(BatchStepResult.Failed(spec.StepId, spec.Method, ex, mutation));
                    // Continuing after a mutation error would send more input
                    // with an unknown UI state. Continue is therefore limited
                    // to independent, non-mutating observations.
                    if (stopOnError || mutation)
                    {
                        break;
                    }
                }
            }
        }
        finally
        {
            if (cancelled || IsCancellationRequested)
            {
                // Cancellation owns the cleanup boundary even when this
                // batch joined an explicit interaction. The user should not
                // be left with an active overlay after pressing stop.
                activityResult = _session.Activity.ForceEnd();
                InvalidateObservationState();
                ResetCancellationIfIdle();
            }
            else if (needsActivity)
            {
                activityResult = _session.Activity.Leave();
                if (!activityResult.Active && activityResult.RestorationAttempted)
                {
                    // Returning focus can rebuild a browser accessibility tree;
                    // references returned by this batch must not look reusable
                    // after the lease has ended.
                    InvalidateObservationState();
                }
            }
        }

        if (cancelled)
        {
            _session.Activity.SetStatus("cancelled");
            return new
            {
                status = "cancelled",
                cancelled_step = cancellationStep?.StepId,
                steps = stepResults,
                pause = userPause,
                activity = MergeActivityBoundary(activityResult),
                duration_ms = startedAt.ElapsedMilliseconds,
                refs_invalidated = refsInvalidated,
                note = "No later batch step was started; an already-sent input cannot be undone."
            };
        }

        if (firstFailure is not null)
        {
            var status = mutationFailure ? "unknown" : (!stepStarted ? "not_started" : "partial");
            var retryable = !mutationOccurred && firstFailure is AgentException agent && agent.Retryable;
            var causeCode = firstFailure is AgentException firstAgent ? firstAgent.Code : "INTERNAL_ERROR";
            var topLevelCode = mutationFailure
                ? "BATCH_OUTCOME_UNKNOWN"
                : causeCode is "BATCH_TIMEOUT" or "BATCH_REF_INVALID" or "BATCH_STOPPED_AFTER_FAILURE"
                    ? causeCode
                    : "BATCH_STEP_FAILED";
            _session.Activity.SetStatus("failed", causeCode);
            var details = new
            {
                status,
                failed_step = firstFailedStep?.StepId,
                cause_code = causeCode,
                steps = stepResults,
                activity = MergeActivityBoundary(activityResult),
                duration_ms = startedAt.ElapsedMilliseconds,
                refs_invalidated = refsInvalidated
            };
            throw new AgentException(topLevelCode, firstFailure.Message, retryable, details);
        }

        if (userPause is not null)
        {
            _session.Activity.SetStatus("paused");
        }

        return new
        {
            status = userPause is null ? "completed" : "paused",
            steps = stepResults,
            pause = userPause,
            activity = MergeActivityBoundary(activityResult),
            duration_ms = startedAt.ElapsedMilliseconds
        };
    }

    private ActivityResult MergeActivityBoundary(ActivityResult? boundary)
    {
        var current = _session.Activity.Status();
        if (boundary is null)
        {
            return current;
        }

        // Keep the lifecycle metadata from Leave/ForceEnd (ended, restoration,
        // and overlay_was_visible), while taking the post-boundary status
        // fields that may have been classified immediately afterwards.
        return boundary with
        {
            Status = current.Status,
            OverlayVisible = current.OverlayVisible,
            StatusPanelVisible = current.StatusPanelVisible,
            StatusPanelLabel = current.StatusPanelLabel,
            ActionTraceVisible = current.ActionTraceVisible
        };
    }

    private object ExecuteWorkflow(JsonElement parameters)
    {
        // workflow.run is the script-friendly spelling of actions.batch. It
        // intentionally shares the same deadline, reference resolver, one
        // overlay lease, and foreground restoration path. Agents can therefore
        // send one NDJSON request containing browser DOM operations and native
        // UI operations without paying a round trip for every step.
        var result = ExecuteBatch(parameters);
        var serialized = SerializeToElement(result);
        var status = serialized.TryGetProperty("status", out var statusValue) && statusValue.ValueKind == JsonValueKind.String
            ? statusValue.GetString() ?? "completed"
            : "completed";
        return new { workflow = status, result };
    }

    private static List<BatchStepSpec> ParseBatchSpecs(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            throw new AgentException("INVALID_ARGUMENT", "actions.batch requires an actions array.", false);
        }

        var hasActions = parameters.TryGetProperty("actions", out var actionsValue);
        var hasSteps = parameters.TryGetProperty("steps", out var stepsValue);
        if (hasActions && hasSteps)
        {
            throw new AgentException("BATCH_INVALID_ARGUMENT", "Provide either actions or steps, not both.", false);
        }
        if ((!hasActions && !hasSteps) || (hasActions ? actionsValue : stepsValue).ValueKind != JsonValueKind.Array)
        {
            throw new AgentException("INVALID_ARGUMENT", "actions.batch requires an actions array.", false);
        }
        var actions = hasActions ? actionsValue : stepsValue;

        if (actions.GetArrayLength() > 32)
        {
            throw new AgentException("BATCH_TOO_LARGE", "actions.batch supports at most 32 steps.", false);
        }

        var specs = new List<BatchStepSpec>(actions.GetArrayLength());
        var usedIds = new HashSet<string>(StringComparer.Ordinal);
        var index = 0;
        foreach (var action in actions.EnumerateArray())
        {
            if (action.ValueKind != JsonValueKind.Object)
            {
                throw new AgentException("BATCH_INVALID_STEP", $"Step {index + 1} must be an object.", false);
            }

            var stepIdElement = action.TryGetProperty("step_id", out var snakeStepId)
                ? snakeStepId
                : action.TryGetProperty("step-id", out var kebabStepId) ? kebabStepId : default;
            if (stepIdElement.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.String))
            {
                throw new AgentException("BATCH_INVALID_STEP", $"Step {index + 1} step_id must be a string.", false);
            }
            var stepId = stepIdElement.ValueKind == JsonValueKind.String ? stepIdElement.GetString() : null;
            stepId = string.IsNullOrWhiteSpace(stepId) ? $"step_{index + 1:00}" : stepId.Trim();
            if (!IsValidBatchIdentifier(stepId))
            {
                throw new AgentException("BATCH_INVALID_STEP", $"Step id '{stepId}' contains unsupported characters.", false);
            }
            if (!usedIds.Add(stepId))
            {
                throw new AgentException("BATCH_DUPLICATE_STEP", $"Step id '{stepId}' is duplicated.", false);
            }

            var methodElement = action.TryGetProperty("method", out var namedMethod)
                ? namedMethod
                : action.TryGetProperty("op", out var opElement) ? opElement : default;
            if (methodElement.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.String))
            {
                throw new AgentException("BATCH_INVALID_STEP", $"Step '{stepId}' method must be a string.", false);
            }
            var method = methodElement.ValueKind == JsonValueKind.String ? methodElement.GetString() : null;
            if (string.IsNullOrWhiteSpace(method))
            {
                throw new AgentException("BATCH_INVALID_STEP", $"Step '{stepId}' must contain method.", false);
            }

            var childParameters = action.TryGetProperty("params", out var paramsElement)
                ? paramsElement.Clone()
                : action.TryGetProperty("parameters", out var parametersElement)
                    ? parametersElement.Clone()
                    : EmptyObject();
            if (childParameters.ValueKind != JsonValueKind.Object)
            {
                throw new AgentException("BATCH_INVALID_STEP", $"Step '{stepId}' params must be an object.", false);
            }
            specs.Add(new BatchStepSpec(stepId, method.Trim(), childParameters, index));
            index++;
        }
        return specs;
    }

    private static void ValidateBatchSpecs(IReadOnlyList<BatchStepSpec> specs)
    {
        var positions = specs.ToDictionary(spec => spec.StepId, spec => spec.Index, StringComparer.Ordinal);
        var missingConfirmation = new List<string>();
        for (var index = 0; index < specs.Count; index++)
        {
            var spec = specs[index];
            if (!IsKnownCoreMethod(spec.Method) || spec.Method is "actions.batch" or "interaction.begin" or "interaction.end" or "interaction.cancel" or "close")
            {
                throw new AgentException("BATCH_METHOD_NOT_ALLOWED", $"Method '{spec.Method}' cannot be used as a batch step.", false);
            }

            ValidateBatchReferences(spec.Parameters, positions, index);
            if (IsConfirmationMethod(spec.Method) && ConfirmationWouldBlock(spec.Parameters))
            {
                missingConfirmation.Add(spec.StepId);
            }
        }

        if (missingConfirmation.Count > 0)
        {
            throw new AgentException(
                "NEED_USER_CONFIRMATION",
                "One or more batch steps require explicit confirmation.",
                false,
                new { missing_steps = missingConfirmation.ToArray(), no_steps_executed = true });
        }
    }

    private static bool IsKnownCoreMethod(string method)
    {
        return method is
            "capabilities" or "doctor" or "schema" or "observe" or
            "windows.list" or "windows.find" or "windows.activate" or "windows.info" or
            "ui.tree" or "ui.find" or "ui.find_all" or "ui.get" or "ui.invoke" or "ui.click" or "ui.set_value" or "ui.select" or
            "input.click" or "input.double_click" or "input.right_click" or "input.type" or "input.key" or "input.hotkey" or "input.scroll" or
            "screen.capture" or "screen.capture_window" or "messages.observe" or "wait.window" or "wait.element" or
            "chrome.ensure" or "chrome.targets" or "chrome.attach" or "chrome.navigate" or "chrome.wait" or "chrome.evaluate" or "chrome.fill" or "chrome.select" or "chrome.click" or "chrome.query";
    }

    private static bool IsConfirmationMethod(string method)
    {
        return method is "ui.invoke" or "ui.click" or "ui.set_value" or "ui.select" or
            "input.click" or "input.double_click" or "input.right_click" or "input.type" or "input.key" or "input.hotkey" or "input.scroll";
    }

    private static bool IsMutationMethod(string method)
    {
        return method is "windows.activate" or "ui.invoke" or "ui.click" or "ui.set_value" or "ui.select" or
            "input.click" or "input.double_click" or "input.right_click" or "input.type" or "input.key" or "input.hotkey" or "input.scroll" or
            "chrome.ensure" or "chrome.attach" or "chrome.navigate" or "chrome.evaluate" or "chrome.fill" or "chrome.select" or "chrome.click";
    }

    private static bool MutationMayHaveRun(string method, Exception exception)
    {
        if (!IsMutationMethod(method)) return false;
        if (exception is not AgentException agent) return true;

        if (agent.Code == "WINDOW_NOT_FOREGROUND")
        {
            // windows.activate is itself the mutation. A foreground timeout
            // can occur after SetForegroundWindow has already succeeded, so
            // that method remains unknown; input actions fail before their
            // key/mouse payload is sent and can be reported deterministically.
            return string.Equals(method, "windows.activate", StringComparison.Ordinal);
        }

        // These failures are raised before a UIA/User32/SendInput mutation is
        // attempted. Keeping them retryable/read-only lets on_error=continue
        // report the validation failure without claiming an unknown desktop
        // state. Failures not on this allowlist remain conservatively unknown.
        return agent.Code is not (
            "INVALID_ARGUMENT" or
            "NEED_USER_CONFIRMATION" or
            "WINDOW_NOT_FOUND" or
            "AMBIGUOUS_WINDOW" or
            "WINDOW_NOT_INTERACTIVE" or
            "ELEMENT_NOT_FOUND" or
            "AMBIGUOUS_ELEMENT" or
            "ELEMENT_NOT_ENABLED" or
            "ELEMENT_NOT_EDITABLE" or
            "ELEMENT_NOT_VISIBLE" or
            "SENSITIVE_INPUT_BLOCKED" or
            "OBSERVATION_REQUIRED" or
            "STALE_OBSERVATION" or
            "STALE_SCREENSHOT" or
            "COORDINATE_OUT_OF_BOUNDS" or
            "FOCUS_FAILED" or
            "UIA_UNAVAILABLE" or
            "UIA_QUERY_FAILED" or
            "INPUT_TOO_LARGE");
    }

    private static bool GetStopOnError(JsonElement parameters)
    {
        if (parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty("on_error", out var onError))
        {
            if (onError.ValueKind != JsonValueKind.String)
            {
                throw new AgentException("INVALID_ARGUMENT", "on_error must be 'stop' or 'continue'.", false);
            }
            return onError.GetString()?.Trim().ToLowerInvariant() switch
            {
                "stop" or "stop_on_error" => true,
                "continue" => false,
                _ => throw new AgentException("INVALID_ARGUMENT", "on_error must be 'stop' or 'continue'.", false)
            };
        }
        return GetBool(parameters, true, "stop_on_error", "stop-on-error");
    }

    private static void ValidateBatchReferences(JsonElement value, IReadOnlyDictionary<string, int> positions, int currentIndex)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            if (value.TryGetProperty("$ref", out var reference))
            {
                if (value.EnumerateObject().Count() != 1 || reference.ValueKind != JsonValueKind.String)
                {
                    throw new AgentException("BATCH_REF_INVALID", "A $ref object may not contain other properties.", false);
                }
                var text = reference.GetString();
                if (!TryParseBatchReference(text, out var sourceId, out _)
                    || !positions.TryGetValue(sourceId, out var sourceIndex)
                    || sourceIndex >= currentIndex)
                {
                    throw new AgentException("BATCH_REF_INVALID", "Batch references must point to a prior step.", false);
                }
                return;
            }
            foreach (var property in value.EnumerateObject())
            {
                ValidateBatchReferences(property.Value, positions, currentIndex);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                ValidateBatchReferences(item, positions, currentIndex);
            }
        }
    }

    private static JsonElement ResolveBatchReferences(JsonElement value, IReadOnlyDictionary<string, JsonElement> resultByStep, IReadOnlyList<BatchStepSpec> specs, int currentIndex)
    {
        var node = JsonNode.Parse(value.GetRawText()) ?? throw new AgentException("BATCH_REF_INVALID", "Unable to parse batch parameters.", false);
        var resolved = ResolveBatchNode(node, resultByStep, specs, currentIndex);
        using var document = JsonDocument.Parse(resolved?.ToJsonString() ?? "null");
        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw new AgentException("BATCH_REF_INVALID", "Resolved step params must remain an object.", false);
        }
        return document.RootElement.Clone();
    }

    private static JsonNode? ResolveBatchNode(JsonNode node, IReadOnlyDictionary<string, JsonElement> resultByStep, IReadOnlyList<BatchStepSpec> specs, int currentIndex)
    {
        if (node is JsonObject objectNode)
        {
            if (objectNode.Count == 1 && objectNode.TryGetPropertyValue("$ref", out var referenceNode))
            {
                var reference = referenceNode?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(reference))
                {
                    throw new AgentException("BATCH_REF_INVALID", "A batch $ref must be a non-empty string.", false);
                }
                return ResolveReferenceNode(objectNode, resultByStep, specs, currentIndex);
            }

            foreach (var property in objectNode.ToArray())
            {
                if (property.Value is null) continue;
                var replacement = ResolveBatchNode(property.Value, resultByStep, specs, currentIndex);
                // JsonNode refuses to assign a node that already belongs to
                // this object. Only write the property when recursion actually
                // replaced the child (for example, a $ref).
                if (!ReferenceEquals(replacement, property.Value))
                {
                    objectNode[property.Key] = replacement;
                }
            }
            return objectNode;
        }
        if (node is JsonArray arrayNode)
        {
            for (var i = 0; i < arrayNode.Count; i++)
            {
                var child = arrayNode[i];
                if (child is null) continue;
                var replacement = ResolveBatchNode(child, resultByStep, specs, currentIndex);
                if (!ReferenceEquals(replacement, child))
                {
                    arrayNode[i] = replacement;
                }
            }
            return arrayNode;
        }
        return node;
    }

    private static JsonNode? ResolveReferenceNode(JsonObject referenceObject, IReadOnlyDictionary<string, JsonElement> resultByStep, IReadOnlyList<BatchStepSpec> specs, int currentIndex)
    {
        var reference = referenceObject["$ref"]?.GetValue<string>();
        if (!TryParseBatchReference(reference, out var sourceId, out var path))
        {
            throw new AgentException("BATCH_REF_INVALID", "Batch references must use '<step>.result' followed by optional fields or array indexes.", false);
        }
        var sourceIndex = specs.FirstOrDefault(spec => string.Equals(spec.StepId, sourceId, StringComparison.Ordinal))?.Index ?? -1;
        if (sourceIndex < 0 || sourceIndex >= currentIndex || !resultByStep.TryGetValue(sourceId, out var source))
        {
            throw new AgentException("BATCH_REF_INVALID", "A batch $ref must point to a completed prior step.", false);
        }
        return ResolveJsonPath(source, path);
    }

    private static JsonNode? ResolveJsonPath(JsonElement source, string path)
    {
        if (!TryParseBatchPath(path, out var parts))
        {
            throw new AgentException("BATCH_REF_INVALID", "Batch references must use '<step>.result' followed by optional fields or array indexes.", false);
        }

        JsonNode? current = JsonNode.Parse(source.GetRawText());
        foreach (var part in parts.Skip(1))
        {
            if (current is JsonObject objectNode && objectNode.TryGetPropertyValue(part, out var property))
            {
                current = property;
            }
            else if (current is JsonArray arrayNode && int.TryParse(part, out var index) && index >= 0 && index < arrayNode.Count)
            {
                current = arrayNode[index];
            }
            else
            {
                throw new AgentException("BATCH_REF_INVALID", $"Batch reference path '{path}' was not found.", false);
            }
        }
        return current?.DeepClone();
    }

    private static bool IsValidBatchIdentifier(string value)
    {
        return value.Length is > 0 and <= 64 && Regex.IsMatch(value, "^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant);
    }

    private static bool TryParseBatchReference(string? reference, out string sourceId, out string path)
    {
        sourceId = string.Empty;
        path = string.Empty;
        if (string.IsNullOrWhiteSpace(reference)) return false;
        var separator = reference.IndexOf(".result", StringComparison.Ordinal);
        if (separator <= 0) return false;
        sourceId = reference[..separator];
        if (!IsValidBatchIdentifier(sourceId)) return false;
        path = reference[(separator + 1)..];
        return TryParseBatchPath(path, out _);
    }

    private static bool TryParseBatchPath(string path, out string[] parts)
    {
        parts = Array.Empty<string>();
        if (!path.StartsWith("result", StringComparison.Ordinal)) return false;
        var tokens = new List<string> { "result" };
        var index = "result".Length;
        while (index < path.Length)
        {
            if (path[index] == '.')
            {
                var start = ++index;
                while (index < path.Length && path[index] is not ('.' or '[')) index++;
                if (start == index || !IsValidBatchIdentifier(path[start..index])) return false;
                tokens.Add(path[start..index]);
                continue;
            }
            if (path[index] == '[')
            {
                var end = path.IndexOf(']', index + 1);
                if (end < 0 || end == index + 1 || !int.TryParse(path[(index + 1)..end], out var arrayIndex) || arrayIndex < 0) return false;
                tokens.Add(arrayIndex.ToString(System.Globalization.CultureInfo.InvariantCulture));
                index = end + 1;
                continue;
            }
            return false;
        }
        parts = tokens.ToArray();
        return true;
    }

    private static JsonElement ClampBatchStepTimeout(string method, JsonElement parameters, int batchTimeoutMs, Stopwatch startedAt)
    {
        if (method is not ("wait.window" or "wait.element" or "chrome.ensure" or "chrome.attach" or "chrome.navigate" or "chrome.wait" or
            "chrome.evaluate" or "chrome.fill" or "chrome.select" or "chrome.click" or "chrome.query") || parameters.ValueKind != JsonValueKind.Object)
        {
            return parameters;
        }

        var remaining = Math.Max(1, batchTimeoutMs - (int)Math.Min(int.MaxValue, startedAt.ElapsedMilliseconds));
        var requested = GetInt(parameters, remaining, "timeout", "timeout_ms", "timeout-ms");
        var effective = Math.Clamp(Math.Min(requested, remaining), 1, 120000);
        var node = JsonNode.Parse(parameters.GetRawText()) as JsonObject ?? new JsonObject();
        node.Remove("timeout");
        node.Remove("timeout-ms");
        node["timeout_ms"] = effective;
        return SerializeNodeToElement(node);
    }

    private static JsonElement SerializeNodeToElement(JsonNode node)
    {
        using var document = JsonDocument.Parse(node.ToJsonString());
        return document.RootElement.Clone();
    }

    private static JsonElement SerializeToElement(object value)
    {
        var json = JsonSerializer.Serialize(value, Program.Options);
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static JsonElement EmptyObject()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    private object Close()
    {
        ActivityResult? activity = null;
        var cleanupErrors = new List<string>();
        try
        {
            activity = _session.Activity.ForceEnd();
        }
        catch (Exception ex)
        {
            cleanupErrors.Add($"ACTIVITY_END_FAILED: {ex.Message}");
        }
        finally
        {
            foreach (var path in _session.OwnedCapturePaths.ToArray())
            {
                try
                {
                    if (File.Exists(path)) File.Delete(path);
                }
                catch (Exception ex)
                {
                    cleanupErrors.Add($"CAPTURE_DELETE_FAILED: {ex.Message}");
                }
            }
            _session.OwnedCapturePaths.Clear();
            InvalidateObservationState();
            _session.Screenshots.Clear();
            _session.Windows.Clear();
            _session.WindowByHandle.Clear();
            try
            {
                _session.Activity.Dispose();
                activity = _session.Activity.Status();
            }
            catch (Exception ex)
            {
                cleanupErrors.Add($"ACTIVITY_DISPOSE_FAILED: {ex.Message}");
            }
            try
            {
                _session.Chrome.Dispose();
            }
            catch (Exception ex)
            {
                cleanupErrors.Add($"CHROME_DISPOSE_FAILED: {ex.Message}");
            }
        }
        return new { closed = true, session_id = _session.Id, activity, cleanup_errors = cleanupErrors.ToArray() };
    }

    private void TrackOwnedCapture(string path, string? requestedPath)
    {
        if (string.IsNullOrWhiteSpace(requestedPath))
        {
            _session.OwnedCapturePaths.Add(path);
        }
        else
        {
            // A caller-supplied path is caller-owned even if it happens to
            // reuse a path that was previously generated by this session.
            _session.OwnedCapturePaths.Remove(path);
        }
    }

    private object CreateObservation(WindowEntry window, bool includeScreenshot, bool includeText, int depth, int maxNodes)
    {
        window = EnsureUsableWindow(window);
        // Every observation starts a new reference generation. The screenshot
        // entry remains session-owned for eviction/close cleanup, but its
        // coordinate token must not survive this boundary.
        _session.LatestScreenshotByWindow.Clear();
        var bounds = window.Bounds;
        var observationId = NewObservationId();
        var treeResult = includeText
            ? BuildTree(EnsureUiElement(window), window, observationId, depth, maxNodes)
            : new TreeBuildResult(Array.Empty<object>(), false);
        IReadOnlyList<object> nodes = treeResult.Nodes;
        var focused = includeText ? TryGetFocusedElement(window) : null;
        var screenshots = new List<object>();
        if (includeScreenshot)
        {
            var capture = _session.Activity.CaptureWithoutOverlay(() => NativeMethods.CaptureWindow(window.Handle,
                preferForegroundScreenCopy: true));
            var path = capture.Path;
            TrackOwnedCapture(path, null);
            var info = new FileInfo(path);
            TrimCaches();
            var screenshotId = $"shot_{++_session.ScreenshotCounter:0000}";
            _session.Screenshots[screenshotId] = new ScreenshotEntry(screenshotId, observationId, window.Handle, bounds, path);
            _session.LatestScreenshotByWindow[window.Handle] = screenshotId;
            screenshots.Add(new
            {
                screenshot_id = screenshotId,
                path,
                mime_type = "image/png",
                width = bounds.Width,
                height = bounds.Height,
                size = info.Length,
                capture_layer = capture.Layer,
                blank_printwindow = capture.BlankPrintWindow,
                trusted = capture.Trusted,
                foreground_relation = capture.ForegroundRelation,
                foreground_handle = capture.ForegroundHandle,
                foreground_process_id = capture.ForegroundProcessId,
                ownership_samples = new { total = capture.OwnershipSampleCount, related = capture.RelatedOwnershipSampleCount }
            });
        }

        _session.Observations[observationId] = new ObservationEntry(observationId, window.Handle, bounds);
        _session.LatestObservationByWindow[window.Handle] = observationId;
        _session.CurrentObservationId = observationId;

        return new
        {
            observation_id = observationId,
            session_id = _session.Id,
            window = ToWindowDto(window),
            accessibility = includeText ? new { tree = nodes, tree_truncated = treeResult.Truncated, focused_element = focused } : null,
            screenshots,
            dpi = NativeMethods.GetDpi(window.Handle),
            virtual_screen = NativeMethods.GetVirtualScreen(),
            created_at = DateTimeOffset.UtcNow
        };
    }

    private TreeBuildResult BuildTree(AutomationElement root, WindowEntry window, string observationId, int depth, int maxNodes)
    {
        var result = new List<object>();
        var queue = new Queue<(AutomationElement Element, string? ParentId, int Depth)>();
        var truncated = false;
        queue.Enqueue((root, null, 0));
        while (queue.Count > 0 && result.Count < maxNodes)
        {
            var item = queue.Dequeue();
            var entry = RegisterElement(item.Element, window, observationId);
            result.Add(new
            {
                element_id = entry.ElementId,
                parent_id = item.ParentId,
                depth = item.Depth,
                name = SafeName(item.Element),
                automation_id = SafeAutomationId(item.Element),
                class_name = SafeClassName(item.Element),
                control_type = SafeControlType(item.Element),
                enabled = SafeEnabled(item.Element),
                visible = !SafeOffscreen(item.Element),
                focused = SafeHasFocus(item.Element),
                bounds = ToBounds(SafeBounds(item.Element)),
                patterns = GetPatterns(item.Element)
            });

            if (item.Depth >= depth)
            {
                continue;
            }

            try
            {
                foreach (AutomationElement child in item.Element.FindAll(TreeScope.Children, Condition.TrueCondition))
                {
                    if (result.Count + queue.Count >= maxNodes)
                    {
                        truncated = true;
                        break;
                    }
                    queue.Enqueue((child, entry.ElementId, item.Depth + 1));
                }
            }
            catch
            {
                // A provider can reject a subtree while the rest of the tree remains usable.
            }
        }
        // A full queue means there are nodes that were discovered but could
        // not be emitted because maxNodes was reached. If the queue is empty,
        // exactly maxNodes may still be the complete tree and must not be
        // reported as truncated.
        truncated |= queue.Count > 0;
        return new TreeBuildResult(result, truncated);
    }

    private List<AutomationElement> FindElements(WindowEntry window, JsonElement parameters, int limit)
    {
        var name = GetString(parameters, "name");
        var nameContains = GetString(parameters, "name_contains", "name-contains", "title_contains", "title-contains", "text_contains", "text-contains");
        var automationId = GetString(parameters, "automation_id", "automation-id");
        var className = GetString(parameters, "class_name", "class-name", "class");
        var controlType = GetString(parameters, "control_type", "control-type", "type");
        var enabled = GetNullableBool(parameters, "enabled");
        var visible = GetNullableBool(parameters, "visible");

        Condition condition = Condition.TrueCondition;
        var conditions = new List<Condition>();
        if (!string.IsNullOrWhiteSpace(name)) conditions.Add(new PropertyCondition(AutomationElement.NameProperty, name));
        if (!string.IsNullOrWhiteSpace(automationId)) conditions.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
        if (!string.IsNullOrWhiteSpace(className)) conditions.Add(new PropertyCondition(AutomationElement.ClassNameProperty, className));
        var type = ParseControlType(controlType);
        if (!string.IsNullOrWhiteSpace(controlType) && type is null)
        {
            throw new AgentException("INVALID_ARGUMENT", $"Unknown control_type '{controlType}'.", false);
        }
        if (type is not null) conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, type));
        if (enabled.HasValue) conditions.Add(new PropertyCondition(AutomationElement.IsEnabledProperty, enabled.Value));
        if (visible.HasValue) conditions.Add(new PropertyCondition(AutomationElement.IsOffscreenProperty, !visible.Value));
        if (conditions.Count == 1) condition = conditions[0];
        else if (conditions.Count > 1) condition = new AndCondition(conditions.ToArray());

        var result = new List<AutomationElement>();
        var root = EnsureUiElement(window);
        try
        {
            foreach (AutomationElement element in root.FindAll(TreeScope.Descendants, condition))
            {
                if (!MatchesText(element, nameContains)) continue;
                if (result.Count >= limit) break;
                result.Add(element);
            }
        }
        catch (ElementNotAvailableException)
        {
            throw new AgentException("ELEMENT_NOT_AVAILABLE", "The window's UI tree changed while searching.", true);
        }
        catch (Exception ex)
        {
            throw new AgentException("UIA_QUERY_FAILED", ex.Message, true);
        }
        return result;
    }

    private WindowEntry RequireWindow(JsonElement parameters)
    {
        var id = GetString(parameters, "window_id", "window-id", "window");
        if (!string.IsNullOrWhiteSpace(id))
        {
            if (_session.Windows.TryGetValue(id, out var known) && IsWindowIdentityCurrent(known) && NativeMethods.TryGetWindowRect(known.Handle, out _))
            {
                return RefreshWindow(known);
            }

            if (_session.Windows.TryGetValue(id, out known))
            {
                RemoveWindowEntry(known);
                InvalidateObservationState();
            }
            _ = ListWindowEntries();
            if (_session.Windows.TryGetValue(id, out known) && IsWindowIdentityCurrent(known) && NativeMethods.TryGetWindowRect(known.Handle, out _))
            {
                return RefreshWindow(known);
            }
            throw new AgentException("WINDOW_NOT_FOUND", $"Window '{id}' was not found in this session.", true);
        }

        var matches = FindWindowEntries(parameters);
        if (matches.Count == 0)
        {
            throw new AgentException("WINDOW_NOT_FOUND", "No window matched the supplied title/process/class criteria.", true);
        }
        if (matches.Count > 1)
        {
            var foreground = matches.Where(window => NativeMethods.IsForegroundWindow(window.Handle)).ToList();
            if (foreground.Count == 1)
            {
                return RefreshWindow(foreground[0]);
            }

            var requestedIndex = GetInt(parameters, -1, "window_index", "window-index", "index");
            if (requestedIndex >= 0 && requestedIndex < matches.Count)
            {
                return RefreshWindow(matches[requestedIndex]);
            }

            throw new AgentException("AMBIGUOUS_WINDOW", "More than one window matched; pass window_id or window_index.", false);
        }
        return RefreshWindow(matches[0]);
    }

    private ElementEntry RequireElement(JsonElement parameters)
    {
        var id = GetString(parameters, "element_id", "element-id", "element");
        if (string.IsNullOrWhiteSpace(id))
        {
            var window = EnsureUsableWindow(RequireWindow(parameters));
            var matches = FindElements(window, parameters, 20);
            if (matches.Count == 0)
            {
                throw new AgentException("ELEMENT_NOT_FOUND", "No element matched the supplied selector.", true);
            }
            if (matches.Count > 1 && !GetBool(parameters, false, "first", "allow_first", "allow-first"))
            {
                throw new AgentException("AMBIGUOUS_ELEMENT", "More than one element matched; pass element_id or first=true.", false);
            }
            var observationId = NewObservationId();
            RegisterObservation(observationId, window);
            _session.CurrentObservationId = observationId;
            return RegisterElement(matches[0], window, observationId);
        }

        if (!_session.Elements.TryGetValue(id, out var entry))
        {
            throw new AgentException("ELEMENT_NOT_FOUND", "element_id is unknown or expired.", true);
        }
        // Activation can invalidate the complete UI tree (notably Chrome's
        // renderer accessibility tree), so perform it before token checks.
        EnsureUsableWindow(entry.Window);
        var requestedObservation = GetString(parameters, "observation_id", "observation-id", "observation");
        if ((!string.IsNullOrWhiteSpace(requestedObservation) && !string.Equals(requestedObservation, entry.ObservationId, StringComparison.Ordinal)) ||
            !string.Equals(_session.CurrentObservationId, entry.ObservationId, StringComparison.Ordinal))
        {
            throw new AgentException("STALE_OBSERVATION", "The element belongs to an older observation; observe or find it again.", true);
        }
        if (_session.Observations.TryGetValue(entry.ObservationId, out var observation) &&
            (!NativeMethods.TryGetWindowRect(entry.Window.Handle, out var currentBounds) || !SameBounds(observation.Bounds, currentBounds)))
        {
            throw new AgentException("STALE_OBSERVATION", "The target window moved or changed size; find the element again.", true);
        }
        try
        {
            _ = entry.Element.Current.Name;
        }
        catch (ElementNotAvailableException)
        {
            if (TryRefreshElement(entry))
            {
                return entry;
            }
            throw new AgentException("ELEMENT_NOT_AVAILABLE", "The UI element is no longer available in the current accessibility tree.", true);
        }
        return entry;
    }

    private object CompleteAction(WindowEntry window, string layer, JsonElement parameters, object data)
    {
        var verify = GetBool(parameters, false, "verify", "observe_after", "observe-after");
        object? after = null;
        object? verificationError = null;
        if (verify)
        {
            try
            {
                after = CreateObservation(window, false, true, 3, 150);
            }
            catch (Exception ex)
            {
                InvalidateObservationState();
                verificationError = new { code = "POST_ACTION_OBSERVE_FAILED", message = ex.Message };
            }
        }
        else
        {
            InvalidateObservationState();
        }
        return new
        {
            data,
            execution = new { layer, duration_ms = 0 },
            verification = new { requested = verify, observed = after is not null, verified = false, after_observation = after, error = verificationError }
        };
    }

    private object CompleteWindowAction(WindowEntry window, string layer, JsonElement parameters, object data)
    {
        var verify = GetBool(parameters, false, "verify", "observe_after", "observe-after");
        object? after = null;
        object? verificationError = null;
        if (verify)
        {
            try
            {
                after = CreateObservation(window, false, true, 3, 150);
            }
            catch (Exception ex)
            {
                InvalidateObservationState();
                verificationError = new { code = "POST_ACTION_OBSERVE_FAILED", message = ex.Message };
            }
        }
        else
        {
            InvalidateObservationState();
        }
        return new
        {
            data,
            execution = new { layer, duration_ms = 0 },
            verification = new { requested = verify, observed = after is not null, verified = false, after_observation = after, error = verificationError }
        };
    }

    private WindowEntry EnsureUsableWindow(WindowEntry window)
    {
        if (!IsWindowIdentityCurrent(window))
        {
            throw new AgentException("WINDOW_NOT_FOUND", $"Window '{window.Id}' no longer refers to the same desktop window.", true);
        }

        var needsActivation = false;
        if (!NativeMethods.TryGetWindowRect(window.Handle, out var rect) || rect.Width <= 0 || rect.Height <= 0 || NativeMethods.IsMinimized(window.Handle))
        {
            needsActivation = true;
        }
        else if (!NativeMethods.IsForegroundWindowOrOwnedPopup(window.Handle))
        {
            // Input is always directed at the explicitly selected window. Bring it
            // to the foreground before sending keys or coordinates.
            needsActivation = true;
        }

        if (needsActivation)
        {
            InvalidateObservationState();
            if (!NativeMethods.ActivateWindow(window.Handle))
            {
                throw new AgentException("WINDOW_ACTIVATION_FAILED", $"Unable to bring window '{window.Title}' to the foreground.", true);
            }
        }

        window = RefreshWindow(window);
        if (NativeMethods.IsMinimized(window.Handle) || window.Bounds.Width <= 0 || window.Bounds.Height <= 0)
        {
            throw new AgentException("WINDOW_NOT_INTERACTIVE", $"Window '{window.Title}' did not become interactive after activation.", true);
        }
        if (!WaitForForegroundOrOwnedPopup(window.Handle))
        {
            throw new AgentException("WINDOW_NOT_FOREGROUND", $"Window '{window.Title}' did not become the foreground window.", true);
        }
        _session.ActiveWindowId = window.Id;
        return window;
    }

    private static bool WaitForForeground(IntPtr handle)
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            if (NativeMethods.IsForegroundWindow(handle)) return true;
            Thread.Sleep(25);
        }
        return NativeMethods.IsForegroundWindow(handle);
    }

    private static bool WaitForForegroundOrOwnedPopup(IntPtr handle)
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            if (NativeMethods.IsForegroundWindowOrOwnedPopup(handle)) return true;
            Thread.Sleep(25);
        }
        return NativeMethods.IsForegroundWindowOrOwnedPopup(handle);
    }

    private void InvalidateObservationState()
    {
        _session.Elements.Clear();
        _session.Observations.Clear();
        // Screenshot IDs become stale with the latest-map reset below, but
        // session-owned files must remain readable until cache eviction or
        // session close. Clearing the entries here would orphan those files
        // from the eviction path and leak them during a long-lived session.
        _session.LatestObservationByWindow.Clear();
        _session.LatestScreenshotByWindow.Clear();
        _session.CurrentObservationId = null;
    }

    private static AutomationElement EnsureUiElement(WindowEntry window)
    {
        if (!window.UiAutomationAvailable)
        {
            try
            {
                window.Element = AutomationElement.FromHandle(window.Handle);
                window.UiAutomationAvailable = true;
            }
            catch (Exception ex)
            {
                throw new AgentException("UIA_UNAVAILABLE", $"Window '{window.Title}' does not expose UI Automation: {ex.Message}", true);
            }
        }

        try
        {
            _ = window.Element.Current.Name;
            return window.Element;
        }
        catch (ElementNotAvailableException)
        {
            try
            {
                window.Element = AutomationElement.FromHandle(window.Handle);
                return window.Element;
            }
            catch (Exception ex)
            {
                throw new AgentException("UIA_UNAVAILABLE", $"Window '{window.Title}' UI Automation provider is unavailable: {ex.Message}", true);
            }
        }
    }

    private static WpfRect SafeBounds(AutomationElement element)
    {
        try { return element.Current.BoundingRectangle; }
        catch { return WpfRect.Empty; }
    }

    private static bool MatchesText(AutomationElement element, string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return true;
        return SafeName(element).Contains(text, StringComparison.OrdinalIgnoreCase) ||
               (TryGetText(element)?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false) ||
               (TryGetValue(element)?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false);
    }

    private static bool ValueMatches(string? actual, string expected)
    {
        if (string.IsNullOrWhiteSpace(actual)) return false;
        return string.Equals(actual.Trim(), expected.Trim(), StringComparison.OrdinalIgnoreCase) ||
               actual.Trim().Replace(" ", string.Empty, StringComparison.Ordinal).Equals(expected.Trim().Replace(" ", string.Empty, StringComparison.Ordinal), StringComparison.OrdinalIgnoreCase);
    }

    private static bool SelectionMatches(AutomationElement element, string expected)
    {
        // UIA providers (especially Chromium) may publish the new selection
        // asynchronously and may expose either the option value or its display
        // name. Give the provider a short settle window and accept either form.
        for (var attempt = 0; attempt < 8; attempt++)
        {
            if (ValueMatches(TryGetValue(element), expected) || ValueMatches(SafeName(element), expected))
            {
                return true;
            }

            try
            {
                if (element.TryGetCurrentPattern(SelectionPattern.Pattern, out var selectionPattern))
                {
                    foreach (var selected in ((SelectionPattern)selectionPattern).Current.GetSelection())
                    {
                        if (ValueMatches(TryGetValue(selected), expected) || ValueMatches(SafeName(selected), expected))
                        {
                            return true;
                        }
                    }
                }
            }
            catch { }

            if (attempt < 7) Thread.Sleep(25);
        }

        return false;
    }

    private static string? TryGetToggleState(AutomationElement element)
    {
        try
        {
            if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out var pattern)) return null;
            return ((TogglePattern)pattern).Current.ToggleState switch
            {
                ToggleState.On => "on",
                ToggleState.Off => "off",
                ToggleState.Indeterminate => "indeterminate",
                _ => null
            };
        }
        catch
        {
            return null;
        }
    }

    private void ValidateCoordinateReference(JsonElement parameters, WindowEntry window, NativeMethods.Rect currentBounds)
    {
        var observationId = GetString(parameters, "observation_id", "observation-id", "observation");
        var screenshotId = GetString(parameters, "screenshot_id", "screenshot-id", "screenshot");
        var allowUnobserved = GetBool(parameters, false, "allow_unobserved", "allow-unobserved");
        if (string.IsNullOrWhiteSpace(observationId) && string.IsNullOrWhiteSpace(screenshotId))
        {
            if (!allowUnobserved)
            {
                throw new AgentException("OBSERVATION_REQUIRED", "Coordinate actions require observation_id or screenshot_id from a fresh observe call.", false);
            }
            return;
        }

        if (!string.IsNullOrWhiteSpace(observationId))
        {
            if (!_session.Observations.TryGetValue(observationId, out var observation) ||
                (!_session.LatestObservationByWindow.TryGetValue(window.Handle, out var latestObservation) || !string.Equals(latestObservation, observationId, StringComparison.Ordinal)) ||
                observation.Handle != window.Handle || !SameBounds(observation.Bounds, currentBounds))
            {
                throw new AgentException("STALE_OBSERVATION", "The coordinate reference is stale; observe the target window again.", true);
            }
        }

        if (!string.IsNullOrWhiteSpace(screenshotId))
        {
            if (!_session.Screenshots.TryGetValue(screenshotId, out var screenshot) ||
                (!_session.LatestScreenshotByWindow.TryGetValue(window.Handle, out var latestScreenshot) || !string.Equals(latestScreenshot, screenshotId, StringComparison.Ordinal)) ||
                screenshot.Handle != window.Handle || !SameBounds(screenshot.Bounds, currentBounds) ||
                (!string.IsNullOrWhiteSpace(observationId) && !string.Equals(screenshot.ObservationId, observationId, StringComparison.Ordinal)))
            {
                throw new AgentException("STALE_SCREENSHOT", "The screenshot reference is stale; observe the target window again.", true);
            }
        }
    }

    private static bool SameBounds(NativeMethods.Rect left, NativeMethods.Rect right)
    {
        return left.Left == right.Left && left.Top == right.Top && left.Right == right.Right && left.Bottom == right.Bottom;
    }

    private void ClickElement(ElementEntry entry)
    {
        var bounds = entry.Element.Current.BoundingRectangle;
        if (bounds.Width <= 0 || bounds.Height <= 0)
        {
            throw new AgentException("ELEMENT_NOT_VISIBLE", "The element has no visible bounds.", true);
        }
        NativeMethods.ClickScreen((int)Math.Round(bounds.Left + bounds.Width / 2), (int)Math.Round(bounds.Top + bounds.Height / 2));
    }

    private static void FocusElement(ElementEntry entry)
    {
        try
        {
            entry.Element.SetFocus();
            for (var attempt = 0; attempt < 4 && !SafeHasFocus(entry.Element); attempt++)
            {
                Thread.Sleep(15);
            }
            if (!SafeHasFocus(entry.Element))
            {
                throw new AgentException("FOCUS_FAILED", $"Unable to focus element '{SafeName(entry.Element)}'.", true);
            }
        }
        catch (AgentException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new AgentException("FOCUS_FAILED", ex.Message, true);
        }
    }

    private static void EnsureElementActionable(ElementEntry entry)
    {
        if (!SafeEnabled(entry.Element))
        {
            throw new AgentException("ELEMENT_NOT_ENABLED", $"Element '{SafeName(entry.Element)}' is disabled.", true);
        }
    }

    private static bool IsInvokeLike(AutomationElement element)
    {
        var type = SafeControlType(element);
        return type is "Button" or "Hyperlink" or "MenuItem" or "TabItem" or "ListItem" or "TreeItem" or "SplitButton";
    }

    private ElementEntry RegisterElement(AutomationElement element, WindowEntry window, string observationId)
    {
        TrimCaches();
        var id = $"el_{++_session.ElementCounter:000000}";
        var entry = new ElementEntry(id, element, window, observationId);
        _session.Elements[id] = entry;
        return entry;
    }

    private bool TryRefreshElement(ElementEntry entry)
    {
        try
        {
            var root = EnsureUiElement(entry.Window);
            var conditions = new List<Condition>();
            if (!string.IsNullOrWhiteSpace(entry.AutomationId))
            {
                conditions.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, entry.AutomationId));
            }
            if (!string.IsNullOrWhiteSpace(entry.Name))
            {
                conditions.Add(new PropertyCondition(AutomationElement.NameProperty, entry.Name));
            }
            if (!string.IsNullOrWhiteSpace(entry.ClassName))
            {
                conditions.Add(new PropertyCondition(AutomationElement.ClassNameProperty, entry.ClassName));
            }
            var controlType = ParseControlType(entry.ControlType);
            if (controlType is not null)
            {
                conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, controlType));
            }
            if (conditions.Count == 0)
            {
                return false;
            }

            var condition = conditions.Count == 1 ? conditions[0] : new AndCondition(conditions.ToArray());
            var matches = root.FindAll(TreeScope.Descendants, condition);
            if (matches.Count != 1)
            {
                return false;
            }
            entry.Element = matches[0];
            return true;
        }
        catch
        {
            return false;
        }
    }

    private string NewObservationId()
    {
        return $"obs_{++_session.ObservationCounter:000000}";
    }

    private void RegisterObservation(string observationId, WindowEntry window)
    {
        TrimCaches();
        // A new observation supersedes coordinate screenshots as well as UIA
        // element references. Keep files for session cleanup, but make their
        // IDs stale until a fresh screenshot is produced.
        _session.LatestScreenshotByWindow.Clear();
        window = RefreshWindow(window);
        if (!NativeMethods.TryGetWindowRect(window.Handle, out var bounds) || bounds.Width <= 0 || bounds.Height <= 0)
        {
            throw new AgentException("WINDOW_NOT_INTERACTIVE", "The target window has no usable bounds for this observation.", true);
        }
        _session.Observations[observationId] = new ObservationEntry(observationId, window.Handle, bounds);
        _session.LatestObservationByWindow[window.Handle] = observationId;
    }

    private void TrimCaches()
    {
        const int maxElements = 5000;
        const int maxObservations = 512;
        const int maxScreenshots = 256;
        while (_session.Elements.Count >= maxElements)
        {
            var candidate = _session.Elements.Values.FirstOrDefault(item => !string.Equals(item.ObservationId, _session.CurrentObservationId, StringComparison.Ordinal));
            if (candidate is null) break;
            _session.Elements.Remove(candidate.ElementId);
        }
        while (_session.Observations.Count >= maxObservations)
        {
            var candidate = _session.Observations.Keys.FirstOrDefault(key => !string.Equals(key, _session.CurrentObservationId, StringComparison.Ordinal));
            if (candidate is null) break;
            _session.Observations.Remove(candidate);
        }
        while (_session.Screenshots.Count >= maxScreenshots)
        {
            var candidate = _session.Screenshots.Keys.FirstOrDefault();
            if (candidate is null) break;
            if (_session.Screenshots.Remove(candidate, out var removed))
            {
                if (_session.LatestScreenshotByWindow.TryGetValue(removed.Handle, out var latest) &&
                    string.Equals(latest, removed.ScreenshotId, StringComparison.Ordinal))
                {
                    _session.LatestScreenshotByWindow.Remove(removed.Handle);
                }

                // Only delete captures created by the CLI. Explicit caller paths
                // are intentionally left untouched and are not in OwnedCapturePaths.
                if (_session.OwnedCapturePaths.Remove(removed.Path))
                {
                    try
                    {
                        if (File.Exists(removed.Path)) File.Delete(removed.Path);
                    }
                    catch
                    {
                        // Close() reports cleanup failures; cache eviction remains best effort.
                    }
                }
            }
        }
    }

    private List<WindowEntry> ListWindowEntries()
    {
        var result = new List<WindowEntry>();
        foreach (var handle in NativeMethods.EnumerateTopLevelWindows())
        {
            var title = NativeMethods.GetWindowTitle(handle);
            if (string.IsNullOrWhiteSpace(title) && handle != NativeMethods.GetForegroundWindowHandle())
            {
                continue;
            }

            AutomationElement? element = null;
            try
            {
                element = AutomationElement.FromHandle(handle);
            }
            catch
            {
                // Some windows do not expose a UIA provider; Win32 metadata is still useful.
            }

            var entry = RegisterOrRefreshWindow(handle, element, title);
            result.Add(entry);
        }

        // Closed windows must not accumulate in a long-lived helper. Keep
        // hidden/minimized windows (they may still be valid targets), but
        // remove handles that no longer exist and invalidate any references
        // tied to them.
        var removedDeadWindow = false;
        foreach (var pair in _session.WindowByHandle.ToArray())
        {
            var handle = new IntPtr(pair.Key);
            if (NativeMethods.IsWindowHandle(handle)) continue;
            RemoveWindowEntry(pair.Value);
            removedDeadWindow = true;
        }
        if (removedDeadWindow)
        {
            InvalidateObservationState();
        }
        return result;
    }

    private WindowEntry RegisterOrRefreshWindow(IntPtr handle, AutomationElement? element, string? title = null)
    {
        var key = handle.ToInt64();
        if (_session.WindowByHandle.TryGetValue(key, out var existing))
        {
            var processId = NativeMethods.GetProcessId(handle);
            var className = NativeMethods.GetClassNameValue(handle);
            if (existing.IdentityProcessId == processId &&
                string.Equals(existing.IdentityClassName, className, StringComparison.Ordinal))
            {
                if (element is not null)
                {
                    existing.Element = element;
                    existing.UiAutomationAvailable = true;
                }
                existing.Title = string.IsNullOrWhiteSpace(title) ? NativeMethods.GetWindowTitle(handle) : title;
                existing.ProcessName = NativeMethods.GetProcessName(handle);
                existing.ClassName = className;
                existing.Bounds = GetBounds(handle);
                existing.ProcessId = processId;
                return existing;
            }

            // The old HWND was recycled. Remove only the stale mapping and
            // invalidate observations before assigning a fresh window_id.
            _session.WindowByHandle.Remove(key);
            _session.Windows.Remove(existing.Id);
            InvalidateObservationState();
        }

        var currentProcessId = NativeMethods.GetProcessId(handle);
        var currentClassName = NativeMethods.GetClassNameValue(handle);
        var created = new WindowEntry(
            $"win_{++_session.WindowCounter:0000}",
            handle,
            element ?? AutomationElement.RootElement,
            string.IsNullOrWhiteSpace(title) ? NativeMethods.GetWindowTitle(handle) : title,
            NativeMethods.GetProcessName(handle),
            currentClassName,
            currentProcessId,
            GetBounds(handle));
        created.UiAutomationAvailable = element is not null;
        _session.Windows[created.Id] = created;
        _session.WindowByHandle[key] = created;
        return created;
    }

    private static WindowEntry RefreshWindow(WindowEntry entry)
    {
        entry.Title = NativeMethods.GetWindowTitle(entry.Handle);
        entry.ProcessName = NativeMethods.GetProcessName(entry.Handle);
        entry.ClassName = NativeMethods.GetClassNameValue(entry.Handle);
        entry.ProcessId = NativeMethods.GetProcessId(entry.Handle);
        entry.Bounds = GetBounds(entry.Handle);
        try
        {
            entry.Element = AutomationElement.FromHandle(entry.Handle);
            entry.UiAutomationAvailable = true;
        }
        catch
        {
            // Keep the previous provider if it is still usable.
        }
        return entry;
    }

    private static NativeMethods.Rect GetBounds(IntPtr handle)
    {
        return NativeMethods.TryGetWindowRect(handle, out var rect) ? rect : new NativeMethods.Rect();
    }

    private static bool IsWindowIdentityCurrent(WindowEntry entry)
    {
        return NativeMethods.IsWindowHandle(entry.Handle) &&
               NativeMethods.GetProcessId(entry.Handle) == entry.IdentityProcessId &&
               string.Equals(NativeMethods.GetClassNameValue(entry.Handle), entry.IdentityClassName, StringComparison.Ordinal);
    }

    private void RemoveWindowEntry(WindowEntry entry)
    {
        _session.Windows.Remove(entry.Id);
        _session.WindowByHandle.Remove(entry.Handle.ToInt64());
    }

    private static object ToWindowDto(WindowEntry entry)
    {
        var foregroundRelationship = NativeMethods.GetForegroundRelationship(entry.Handle);
        return new
        {
            window_id = entry.Id,
            title = entry.Title,
            process_name = entry.ProcessName,
            process_id = entry.ProcessId,
            class_name = entry.ClassName,
            visible = NativeMethods.IsWindowVisible(entry.Handle),
            minimized = NativeMethods.IsMinimized(entry.Handle),
            foreground = NativeMethods.IsForegroundWindow(entry.Handle),
            foreground_relation = foregroundRelationship.Kind,
            foreground_handle = foregroundRelationship.ForegroundHandle.ToInt64(),
            foreground_process_id = foregroundRelationship.ForegroundProcessId,
            bounds = ToBounds(entry.Bounds),
            dpi = NativeMethods.GetDpi(entry.Handle)
        };
    }

    private static object ElementDto(ElementEntry entry)
    {
        return new
        {
            element_id = entry.ElementId,
            observation_id = entry.ObservationId,
            window_id = entry.Window.Id,
            name = SafeName(entry.Element),
            automation_id = SafeAutomationId(entry.Element),
            control_type = SafeControlType(entry.Element),
            class_name = SafeClassName(entry.Element),
            enabled = SafeEnabled(entry.Element),
            visible = !SafeOffscreen(entry.Element),
            focused = SafeHasFocus(entry.Element),
            sensitive = SafeIsPassword(entry.Element),
            bounds = ToBounds(SafeBounds(entry.Element)),
            patterns = GetPatterns(entry.Element)
        };
    }

    private static object ToBounds(NativeMethods.Rect rect) => new { x = rect.Left, y = rect.Top, width = rect.Width, height = rect.Height };

    private static object ToBounds(WpfRect rect) => new { x = (int)Math.Round(rect.Left), y = (int)Math.Round(rect.Top), width = (int)Math.Round(rect.Width), height = (int)Math.Round(rect.Height) };

    private static string SafeName(AutomationElement element)
    {
        try { return element.Current.Name ?? string.Empty; } catch { return string.Empty; }
    }

    private static string SafeAutomationId(AutomationElement element)
    {
        try { return element.Current.AutomationId ?? string.Empty; } catch { return string.Empty; }
    }

    private static string SafeClassName(AutomationElement element)
    {
        try { return element.Current.ClassName ?? string.Empty; } catch { return string.Empty; }
    }

    private static string SafeControlType(AutomationElement element)
    {
        try
        {
            var name = element.Current.ControlType?.ProgrammaticName ?? string.Empty;
            return name.StartsWith("ControlType.", StringComparison.Ordinal) ? name[12..] : name;
        }
        catch { return string.Empty; }
    }

    private static bool SafeEnabled(AutomationElement element)
    {
        try { return element.Current.IsEnabled; } catch { return false; }
    }

    private static bool SafeOffscreen(AutomationElement element)
    {
        try { return element.Current.IsOffscreen; } catch { return true; }
    }

    private static bool SafeHasFocus(AutomationElement element)
    {
        try { return element.Current.HasKeyboardFocus; } catch { return false; }
    }

    private static bool SafeIsPassword(AutomationElement element)
    {
        try { return element.Current.IsPassword; } catch { return false; }
    }

    private static void EnsureFocusedInputSafe(WindowEntry window)
    {
        try
        {
            var focused = AutomationElement.FocusedElement;
            if (focused is null) return;

            var nativeHandle = focused.Current.NativeWindowHandle;
            // Renderer/edit controls may expose a child HWND instead of the
            // top-level target handle. Use process identity for the safety
            // decision so a password child control cannot be bypassed merely
            // because its NativeWindowHandle differs from the window handle.
            var focusedProcessId = nativeHandle != 0
                ? NativeMethods.GetProcessId(new IntPtr(nativeHandle))
                : (uint)Math.Max(0, focused.Current.ProcessId);
            if (focusedProcessId == 0 || focusedProcessId != window.ProcessId)
            {
                return;
            }

            if (SafeIsPassword(focused))
            {
                throw new AgentException("SENSITIVE_INPUT_BLOCKED", "Password or secret fields must be entered manually.", false);
            }
        }
        catch (AgentException)
        {
            throw;
        }
        catch
        {
            // Some providers do not expose a focused element. Preserve the
            // existing keyboard fallback rather than blocking unrelated text
            // input when the sensitivity signal is unavailable.
        }
    }

    private static string? TryGetValue(AutomationElement element)
    {
        if (SafeIsPassword(element)) return null;
        try
        {
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern))
            {
                return LimitText(((ValuePattern)pattern).Current.Value);
            }
        }
        catch { }
        return null;
    }

    private static string? TryGetText(AutomationElement element)
    {
        if (SafeIsPassword(element)) return null;
        try
        {
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var pattern))
            {
                // Ask UIA for only one character beyond the public limit so a
                // provider cannot allocate an unbounded document string before
                // LimitText applies the response cap.
                const int maxCharacters = 65536;
                return LimitText(((TextPattern)pattern).DocumentRange.GetText(maxCharacters + 1).TrimEnd('\r', '\n'));
            }
        }
        catch { }
        return null;
    }

    private static object? TryGetSelection(AutomationElement element)
    {
        try
        {
            if (element.TryGetCurrentPattern(SelectionPattern.Pattern, out var selectionPattern))
            {
                var items = ((SelectionPattern)selectionPattern).Current.GetSelection();
                return new
                {
                    selected_items = items.Select(item => SafeName(item)).ToArray(),
                    count = items.Length
                };
            }
            if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var itemPattern))
            {
                return new { is_selected = ((SelectionItemPattern)itemPattern).Current.IsSelected };
            }
        }
        catch { }
        return null;
    }

    private static string? LimitText(string? value)
    {
        const int maxCharacters = 65536;
        if (value is null || value.Length <= maxCharacters) return value;
        return value[..maxCharacters] + "\u2026[truncated]";
    }

    private static string? TryGetFocusedElement(WindowEntry window)
    {
        try
        {
            var focused = AutomationElement.FocusedElement;
            if (focused is null) return null;
            var handle = focused.Current.NativeWindowHandle;
            var focusedProcessId = handle != 0
                ? NativeMethods.GetProcessId(new IntPtr(handle))
                : (uint)Math.Max(0, focused.Current.ProcessId);
            if (focusedProcessId == 0 || focusedProcessId != window.ProcessId) return null;
            return $"{SafeControlType(focused)}: {SafeName(focused)}";
        }
        catch { return null; }
    }

    private static string[] GetPatterns(AutomationElement element)
    {
        try
        {
            return element.GetSupportedPatterns().Select(pattern =>
            {
                var name = pattern.ProgrammaticName;
                const string identifiersSuffix = "PatternIdentifiers.Pattern";
                if (name.EndsWith(identifiersSuffix, StringComparison.Ordinal))
                {
                    return name[..^identifiersSuffix.Length].TrimEnd('.');
                }
                const string patternSuffix = "Pattern.Pattern";
                if (name.EndsWith(patternSuffix, StringComparison.Ordinal))
                {
                    return name[..^patternSuffix.Length].TrimEnd('.');
                }
                return name.StartsWith("Pattern.", StringComparison.Ordinal) ? name[8..] : name;
            }).ToArray();
        }
        catch { return Array.Empty<string>(); }
    }

    private static ControlType? ParseControlType(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return value.Trim().ToLowerInvariant() switch
        {
            "button" => ControlType.Button,
            "edit" or "textbox" => ControlType.Edit,
            "text" => ControlType.Text,
            "document" => ControlType.Document,
            "combobox" => ControlType.ComboBox,
            "list" => ControlType.List,
            "listitem" => ControlType.ListItem,
            "menu" => ControlType.Menu,
            "menuitem" => ControlType.MenuItem,
            "tab" => ControlType.Tab,
            "tabitem" => ControlType.TabItem,
            "checkbox" => ControlType.CheckBox,
            "radiobutton" or "radio" => ControlType.RadioButton,
            "tree" => ControlType.Tree,
            "treeitem" => ControlType.TreeItem,
            "pane" => ControlType.Pane,
            "window" => ControlType.Window,
            "hyperlink" or "link" => ControlType.Hyperlink,
            _ => null
        };
    }

    private static string? GetString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value))
            {
                if (value.ValueKind == JsonValueKind.String)
                {
                    return value.GetString();
                }
                if (value.ValueKind != JsonValueKind.Null)
                {
                    throw new AgentException("INVALID_ARGUMENT", $"{name} must be a string.", false);
                }
            }
        }
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty("selector", out var selector) && selector.ValueKind == JsonValueKind.Object)
        {
            return GetString(selector, names);
        }
        return null;
    }

    private static string GetRequiredString(JsonElement element, params string[] names)
    {
        var value = GetString(element, names);
        if (string.IsNullOrWhiteSpace(value)) throw new AgentException("INVALID_ARGUMENT", $"{names[0]} is required.", false);
        return value;
    }

    private static string GetPresentString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value))
            {
                if (value.ValueKind == JsonValueKind.String) return value.GetString() ?? string.Empty;
                throw new AgentException("INVALID_ARGUMENT", $"{name} must be a string.", false);
            }
        }
        throw new AgentException("INVALID_ARGUMENT", $"{names[0]} is required.", false);
    }

    private static void ValidateInputText(string text)
    {
        if (text.Length > 100_000)
        {
            throw new AgentException("INPUT_TOO_LARGE", "Text input exceeds the 100,000 UTF-16 code-unit limit.", false);
        }
    }

    private static void RequireConfirmationIfRequested(JsonElement parameters, string action)
    {
        if (GetBool(parameters, false, "require_confirmation", "require-confirmation") &&
            !GetBool(parameters, false, "confirmed", "confirm"))
        {
            throw new AgentException("NEED_USER_CONFIRMATION", $"Action '{action}' requires explicit confirmation.", false);
        }
    }

    private static int GetInt(JsonElement element, int fallback, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value))
            {
                if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)) return number;
                if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out number)) return number;
                throw new AgentException("INVALID_ARGUMENT", $"{name} must be an integer.", false);
            }
        }
        return fallback;
    }

    private static bool GetBool(JsonElement element, bool fallback, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value))
            {
                if (value.ValueKind == JsonValueKind.True) return true;
                if (value.ValueKind == JsonValueKind.False) return false;
                if (value.ValueKind == JsonValueKind.String && bool.TryParse(value.GetString(), out var parsed)) return parsed;
                throw new AgentException("INVALID_ARGUMENT", $"{name} must be a boolean.", false);
            }
        }
        return fallback;
    }

    private static void RequireObjectParameters(JsonElement parameters, string method)
    {
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            throw new AgentException("INVALID_ARGUMENT", $"{method} params must be an object.", false);
        }
    }

    private static bool? GetNullableBool(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value))
            {
                if (value.ValueKind == JsonValueKind.True) return true;
                if (value.ValueKind == JsonValueKind.False) return false;
                if (value.ValueKind == JsonValueKind.String && bool.TryParse(value.GetString(), out var parsed)) return parsed;
                throw new AgentException("INVALID_ARGUMENT", $"{name} must be a boolean.", false);
            }
        }
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty("selector", out var selector) && selector.ValueKind == JsonValueKind.Object)
        {
            return GetNullableBool(selector, names);
        }
        return null;
    }

    private sealed class SessionState
    {
        internal string Id { get; } = $"ses_{Guid.NewGuid():N}";
        internal DesktopActivityCoordinator Activity { get; } = new();
        internal ChromeCdpProvider Chrome { get; } = new();
        internal int WindowCounter;
        internal int ElementCounter;
        internal int ObservationCounter;
        internal int ScreenshotCounter;
        internal string? ActiveWindowId;
        internal string? CurrentObservationId;
        internal Dictionary<string, WindowEntry> Windows { get; } = new(StringComparer.Ordinal);
        internal Dictionary<long, WindowEntry> WindowByHandle { get; } = new();
        internal Dictionary<string, ElementEntry> Elements { get; } = new(StringComparer.Ordinal);
        internal Dictionary<string, ObservationEntry> Observations { get; } = new(StringComparer.Ordinal);
        internal Dictionary<string, ScreenshotEntry> Screenshots { get; } = new(StringComparer.Ordinal);
        internal Dictionary<IntPtr, string> LatestObservationByWindow { get; } = new();
        internal Dictionary<IntPtr, string> LatestScreenshotByWindow { get; } = new();
        internal HashSet<string> OwnedCapturePaths { get; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed class WindowEntry
    {
        internal WindowEntry(string id, IntPtr handle, AutomationElement element, string title, string processName, string className, uint processId, NativeMethods.Rect bounds)
        {
            Id = id;
            Handle = handle;
            Element = element;
            Title = title;
            ProcessName = processName;
            ClassName = className;
            ProcessId = processId;
            Bounds = bounds;
            IdentityProcessId = processId;
            IdentityClassName = className;
        }

        internal string Id { get; }
        internal IntPtr Handle { get; }
        internal AutomationElement Element { get; set; }
        internal string Title { get; set; }
        internal string ProcessName { get; set; }
        internal string ClassName { get; set; }
        internal uint ProcessId { get; set; }
        internal NativeMethods.Rect Bounds { get; set; }
        internal bool UiAutomationAvailable { get; set; }
        // HWND values can be recycled after a window closes. Keep the
        // original PID/class as a session identity so an old window_id cannot
        // silently start targeting the replacement window.
        internal uint IdentityProcessId { get; }
        internal string IdentityClassName { get; }
    }

    private sealed class ElementEntry
    {
        internal ElementEntry(string elementId, AutomationElement element, WindowEntry window, string observationId)
        {
            ElementId = elementId;
            Element = element;
            Window = window;
            ObservationId = observationId;
            Name = SafeName(element);
            AutomationId = SafeAutomationId(element);
            ClassName = SafeClassName(element);
            ControlType = SafeControlType(element);
        }

        internal string ElementId { get; }
        internal AutomationElement Element { get; set; }
        internal WindowEntry Window { get; }
        internal string ObservationId { get; }
        internal string Name { get; }
        internal string AutomationId { get; }
        internal string ClassName { get; }
        internal string ControlType { get; }
    }
    private sealed record ObservationEntry(string ObservationId, IntPtr Handle, NativeMethods.Rect Bounds);
    private sealed record ScreenshotEntry(string ScreenshotId, string? ObservationId, IntPtr Handle, NativeMethods.Rect Bounds, string Path);
    private sealed record TreeBuildResult(IReadOnlyList<object> Nodes, bool Truncated);
    private sealed record BatchStepSpec(string StepId, string Method, JsonElement Parameters, int Index);

    private sealed class BatchStepResult
    {
        [JsonPropertyName("step_id")]
        public string StepId { get; init; } = string.Empty;
        [JsonPropertyName("method")]
        public string Method { get; init; } = string.Empty;
        [JsonPropertyName("ok")]
        public bool Ok { get; init; }
        [JsonPropertyName("result")]
        public object? Result { get; init; }
        [JsonPropertyName("error")]
        public ErrorBody? Error { get; init; }
        [JsonPropertyName("outcome")]
        public string? Outcome { get; init; }

        internal static BatchStepResult Succeeded(string stepId, string method, object result) => new()
        {
            StepId = stepId,
            Method = method,
            Ok = true,
            Result = result,
            Outcome = "completed"
        };

        internal static BatchStepResult Failed(string stepId, string method, Exception exception, bool mutationMayHaveRun) => new()
        {
            StepId = stepId,
            Method = method,
            Ok = false,
            Error = new ErrorBody
            {
                Code = exception is AgentException agent ? agent.Code : "INTERNAL_ERROR",
                Message = exception.Message,
                Retryable = exception is AgentException retryable && retryable.Retryable,
                Details = exception is AgentException withDetails ? withDetails.Details : null
            },
            Outcome = mutationMayHaveRun ? "unknown" : "failed"
        };

        internal static BatchStepResult NotStarted(string stepId, string method, Exception exception) => new()
        {
            StepId = stepId,
            Method = method,
            Ok = false,
            Error = new ErrorBody
            {
                Code = exception is AgentException agent ? agent.Code : "INTERNAL_ERROR",
                Message = exception.Message,
                Retryable = exception is AgentException retryable && retryable.Retryable,
                Details = exception is AgentException withDetails ? withDetails.Details : null
            },
            Outcome = "not_started"
        };

        internal static BatchStepResult TimedOut(string stepId, string method, JsonElement result, AgentException exception) => new()
        {
            StepId = stepId,
            Method = method,
            Ok = false,
            Result = result,
            Error = new ErrorBody
            {
                Code = exception.Code,
                Message = exception.Message,
                Retryable = exception.Retryable,
                Details = exception.Details
            },
            Outcome = "deadline_exceeded"
        };

        internal static BatchStepResult Cancelled(string stepId, string method, Exception? exception, bool mutationMayHaveRun = false) => new()
        {
            StepId = stepId,
            Method = method,
            Ok = false,
            Error = exception is null ? null : new ErrorBody
            {
                Code = exception is AgentException agent ? agent.Code : "ACTIVITY_CANCELLED",
                Message = exception.Message,
                Retryable = false,
                Details = exception is AgentException withDetails ? withDetails.Details : null
            },
            Outcome = mutationMayHaveRun ? "unknown" : "cancelled"
        };
    }
}

internal sealed class AgentException : Exception
{
    internal AgentException(string code, string message, bool retryable, object? details = null) : base(message)
    {
        Code = code;
        Retryable = retryable;
        Details = details;
    }

    internal string Code { get; }
    internal bool Retryable { get; }
    internal object? Details { get; }
}
