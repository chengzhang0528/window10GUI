using System.Drawing;
using System.Text.Json.Serialization;

namespace WindowsAgent;

/// <summary>
/// Owns one visible live-desktop activity lease and its session-scoped status
/// panel. The lease captures the foreground window before the first agent
/// operation, never activates the overlay itself, and restores that window
/// only when the outer lease ends. A Chrome login/risk pause can explicitly
/// replace restoration with a validated user-attention foreground window.
/// </summary>
internal sealed class DesktopActivityCoordinator : IDisposable
{
    private readonly DesktopActivityOverlay _overlay = new();
    private readonly object _traceGate = new();
    private System.Threading.Timer? _traceDelayTimer;
    private long _traceGeneration;
    private ForegroundSnapshot? _originalWindow;
    private ActivityResult? _lastCompletion;
    private DateTimeOffset _startedAt;
    private string _label = "AGENT 操作中";
    private string? _interactionId;
    private int _depth;
    private bool _overlayRequested;
    private bool _overlayVisible;
    private bool _statusPanelVisible;
    private string _status = "idle";
    private string _statusPanelLabel = "AGENT 等待下一步";
    private bool _actionTraceRequested;
    private bool _actionTraceVisible;
    private Point? _pendingActionPoint;
    private string? _currentAction;
    private bool _restoreOriginalWindow;
    private bool _preserveForeground;
    private ForegroundSnapshot? _preservedWindow;
    private string? _preservationError;
    private bool _disposed;

    internal bool IsActive => _depth > 0;
    internal bool ActionTraceRequested => _actionTraceRequested;
    internal string? InteractionId => _interactionId;
    internal string? LastInteractionId => _lastCompletion?.InteractionId;
    internal string CurrentLabel => _label;

    private const string IdleStatus = "idle";
    private const string RunningStatus = "running";

    internal ActivityResult Enter(string? label, bool showOverlay, bool restoreOriginalWindow, bool overlayRequired = false, bool showActionTrace = false)
    {
        if (_disposed)
        {
            return Failure("ACTIVITY_DISPOSED", "The desktop activity coordinator has been disposed.");
        }

        var started = _depth == 0;
        if (started)
        {
            _originalWindow = CaptureForegroundWindow();
            _startedAt = DateTimeOffset.UtcNow;
            _label = NormalizeLabel(label);
            _interactionId = $"int_{Guid.NewGuid():N}";
            _overlayRequested = showOverlay;
            _actionTraceRequested = showOverlay && showActionTrace;
            _actionTraceVisible = false;
            _currentAction = null;
            _status = RunningStatus;
            _statusPanelLabel = _label;
            _restoreOriginalWindow = restoreOriginalWindow;
            _depth = 1;
            if (showOverlay)
            {
                _overlayVisible = _overlay.TryShow(_label);
                _statusPanelVisible = _overlayVisible;
                if (!_overlayVisible && overlayRequired)
                {
                    var error = _overlay.LastError ?? "The activity overlay could not be displayed.";
                    try { _ = _overlay.TryHide(); } catch { }
                    ResetActiveState();
                    return Failure("ACTIVITY_OVERLAY_REQUIRED", error);
                }
            }
            else
            {
                _statusPanelVisible = false;
                try { _ = _overlay.TryHide(); } catch { }
            }
        }
        else
        {
            // Nested leases are retained for internal callers. Public batch
            // calls join an explicit interaction instead of creating a nested
            // lease, so label/restoration options cannot leak across scopes.
            var previousRestore = _restoreOriginalWindow;
            var previousOverlayRequested = _overlayRequested;
            var previousOverlayVisible = _overlayVisible;
            var previousStatusPanelVisible = _statusPanelVisible;
            var previousActionTraceRequested = _actionTraceRequested;
            _depth++;
            _restoreOriginalWindow |= restoreOriginalWindow;
            _actionTraceRequested |= showOverlay && showActionTrace;
            if (showOverlay)
            {
                _overlayRequested = true;
                _status = RunningStatus;
                _statusPanelLabel = _label;
                if (!_overlayVisible || !_statusPanelVisible)
                {
                    _overlayVisible = _overlay.TryShow(NormalizeLabel(label));
                    _statusPanelVisible = _overlayVisible;
                    if (!_overlayVisible && overlayRequired)
                    {
                        var error = _overlay.LastError ?? "The activity overlay could not be displayed.";
                        try { _ = _overlay.TryHide(); } catch { }
                        _depth--;
                        _restoreOriginalWindow = previousRestore;
                        _overlayRequested = previousOverlayRequested;
                        _overlayVisible = previousOverlayVisible;
                        _statusPanelVisible = previousStatusPanelVisible;
                        _actionTraceRequested = previousActionTraceRequested;
                        return Failure("ACTIVITY_OVERLAY_REQUIRED", error);
                    }
                }
            }
        }

        return BuildResult(started: started);
    }

    internal ActivityResult Leave()
    {
        if (_depth == 0)
        {
            return new ActivityResult
            {
                Active = false,
                Ended = false,
                AlreadyEnded = true,
                Status = _status,
                StatusPanelVisible = _statusPanelVisible,
                StatusPanelLabel = _statusPanelLabel,
                LastCompletion = _lastCompletion
            };
        }

        _depth--;
        if (_depth > 0)
        {
            return BuildResult(ended: false);
        }

        var original = _originalWindow;
        var interactionId = _interactionId;
        var restoreRequested = _restoreOriginalWindow;
        var preserveForeground = _preserveForeground;
        var preservedWindow = _preservedWindow;
        var overlayRequested = _overlayRequested;
        var overlayWasVisible = _overlayVisible;
        var actionTraceRequested = _actionTraceRequested;
        var actionTraceVisible = _actionTraceVisible;
        var currentAction = _currentAction;
        // TryHide clears the overlay's last error on success. Preserve a
        // startup/display error so the completed lease still explains why a
        // best-effort cue was unavailable.
        // A prior best-effort overlay failure must not bleed into a lease that
        // did not request an overlay. Capture the error only for this lease's
        // requested cue; TryHide may clear the provider's last error below.
        var overlayError = overlayRequested ? _overlay.LastError : null;
        var startedAt = _startedAt;
        var cleanupErrors = new List<string>();

        ClearPendingActionTrace();
        var preserveTerminalStatus = _status is "paused" or "cancelled" or "failed";
        if (!preserveTerminalStatus)
        {
            _status = IdleStatus;
            _statusPanelLabel = "AGENT 等待下一步";
        }
        if (_statusPanelVisible)
        {
            // Ending a lease stops the control frame and action trace, but
            // leaves the stable status panel in place for the next request.
            if (!_overlay.TrySetVisualState(_statusPanelLabel, frameVisible: false))
            {
                if (!string.IsNullOrWhiteSpace(_overlay.LastError))
                {
                    cleanupErrors.Add($"STATUS_PANEL_UPDATE_FAILED: {_overlay.LastError}");
                }
                _statusPanelVisible = false;
            }
        }
        else if (!_overlay.TryHide() && !string.IsNullOrWhiteSpace(_overlay.LastError))
        {
            cleanupErrors.Add($"OVERLAY_HIDE_FAILED: {_overlay.LastError}");
        }
        _overlayVisible = false;

        var restorationAttempted = false;
        var restored = false;
        string? restorationError = null;
        var preservedStillValid = preserveForeground && preservedWindow is not null &&
            NativeMethods.IsWindowHandle(preservedWindow.Handle) &&
            NativeMethods.GetProcessId(preservedWindow.Handle) == preservedWindow.ProcessId &&
            string.Equals(NativeMethods.GetClassNameValue(preservedWindow.Handle), preservedWindow.ClassName, StringComparison.Ordinal);
        if (preservedStillValid && !NativeMethods.IsForegroundWindow(preservedWindow!.Handle))
        {
            preservedStillValid = NativeMethods.ActivateWindow(preservedWindow.Handle) && WaitForForeground(preservedWindow.Handle);
            if (!preservedStillValid)
            {
                _preservationError ??= "The user-attention window could not remain in the foreground.";
            }
        }
        if (!preservedStillValid && preserveForeground)
        {
            _preservationError ??= "The user-attention window no longer exists or changed identity.";
            cleanupErrors.Add($"FOREGROUND_PRESERVE_FAILED: {_preservationError}");
        }

        if (!preservedStillValid && restoreRequested && original is not null)
        {
            restorationAttempted = true;
            if (!NativeMethods.IsWindowHandle(original.Handle))
            {
                restorationError = "The original foreground window no longer exists.";
            }
            else if (NativeMethods.GetProcessId(original.Handle) != original.ProcessId ||
                     !string.Equals(NativeMethods.GetClassNameValue(original.Handle), original.ClassName, StringComparison.Ordinal))
            {
                // A recycled HWND must never receive the user's focus by
                // accident. Title can legitimately change, so PID + class are
                // the stable identity checks used here.
                restorationError = "The original foreground window identity changed.";
            }
            else
            {
                restored = NativeMethods.RestoreForegroundWindow(original.Handle);
                if (!restored)
                {
                    restorationError = "The original foreground window could not be activated.";
                }
            }

            if (!restored && restorationError is not null)
            {
                cleanupErrors.Add($"FOREGROUND_RESTORE_FAILED: {restorationError}");
            }
        }

        var result = new ActivityResult
        {
            Active = false,
            Started = false,
            Ended = true,
            AlreadyEnded = false,
            Depth = 0,
            InteractionId = interactionId,
            OverlayRequested = overlayRequested,
            OverlayVisible = false,
            OverlayWasVisible = overlayWasVisible,
            Status = _status,
            StatusPanelVisible = _statusPanelVisible,
            StatusPanelLabel = _statusPanelLabel,
            ActionTraceRequested = actionTraceRequested,
            ActionTraceVisible = actionTraceVisible,
            CurrentAction = currentAction,
            OverlayError = overlayError ?? (overlayRequested ? _overlay.LastError : null),
            RestorationRequested = restoreRequested,
            RestorationAttempted = restorationAttempted,
            RestoredOriginalWindow = restored,
            ForegroundPreserved = preservedStillValid,
            PreservedWindow = preservedStillValid ? preservedWindow?.ToInfo() : null,
            PreservationError = _preservationError,
            OriginalWindow = original?.ToInfo(),
            RestorationError = restorationError,
            CleanupErrors = cleanupErrors.ToArray(),
            DurationMs = Math.Max(0, (long)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds)
        };
        _lastCompletion = result;
        ResetActiveState();
        return result;
    }

    internal ActivityResult ForceEnd()
    {
        if (_depth == 0)
        {
            return Leave();
        }

        _depth = 1;
        return Leave();
    }

    internal ActivityResult Status()
    {
        if (_depth == 0)
        {
            var completion = _lastCompletion;
            return (completion is null
                    ? new ActivityResult()
                    : completion with { Ended = false, AlreadyEnded = false }) with
            {
                Active = false,
                Started = false,
                Depth = 0,
                InteractionId = completion?.InteractionId,
                Status = _status,
                StatusPanelVisible = _statusPanelVisible,
                StatusPanelLabel = _statusPanelLabel,
                LastCompletion = completion
            };
        }
        return BuildResult();
    }

    /// <summary>
    /// Updates the stable, non-controlling status panel after a lease has
    /// ended. The panel is deliberately session-scoped and is destroyed only
    /// by Dispose/close, so adjacent agent requests do not create a visible
    /// blink or leave the user unsure whether the next request is pending.
    /// </summary>
    internal void SetStatus(string status, string? detail = null)
    {
        if (_disposed) return;

        _status = status switch
        {
            "running" => RunningStatus,
            "paused" => "paused",
            "cancelled" => "cancelled",
            "failed" => "failed",
            _ => IdleStatus
        };
        _statusPanelLabel = _status switch
        {
            RunningStatus => NormalizeLabel(detail) == "AGENT 等待下一步" ? "AGENT 操作中" : NormalizeLabel(detail),
            "paused" => "AGENT 等待用户处理",
            "cancelled" => "AGENT 已取消",
            "failed" => "AGENT 操作失败",
            _ => "AGENT 等待下一步"
        };

        if (_statusPanelVisible)
        {
            if (!_overlay.TrySetVisualState(_statusPanelLabel, frameVisible: _overlayVisible))
            {
                _statusPanelVisible = false;
            }
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        // End the lease before marking the coordinator disposed so the normal
        // hide/restore path is used during EOF, close, and parent death.
        try
        {
            _ = ForceEnd();
        }
        finally
        {
            _disposed = true;
            _overlay.Dispose();
            _statusPanelVisible = false;
            _overlayVisible = false;
            _status = "closed";
            _statusPanelLabel = "AGENT 已关闭";
        }
    }

    private ActivityResult BuildResult(bool started = false, bool ended = false)
    {
        return new ActivityResult
        {
            Active = _depth > 0,
            Started = started,
            Ended = ended,
            Depth = _depth,
            InteractionId = _interactionId,
            OverlayRequested = _overlayRequested,
            OverlayVisible = _overlayVisible,
            OverlayWasVisible = _overlayVisible,
            Status = _status,
            StatusPanelVisible = _statusPanelVisible,
            StatusPanelLabel = _statusPanelLabel,
            ActionTraceRequested = _actionTraceRequested,
            ActionTraceVisible = _actionTraceVisible,
            CurrentAction = _currentAction,
            OverlayError = _overlayRequested ? _overlay.LastError : null,
            RestorationRequested = _restoreOriginalWindow,
            ForegroundPreserved = _preserveForeground,
            PreservedWindow = _preservedWindow?.ToInfo(),
            PreservationError = _preservationError,
            OriginalWindow = _originalWindow?.ToInfo(),
            DurationMs = _depth > 0 ? Math.Max(0, (long)(DateTimeOffset.UtcNow - _startedAt).TotalMilliseconds) : 0
        };
    }

    private static ActivityResult Failure(string code, string message)
    {
        return new ActivityResult
        {
            Active = false,
            ErrorCode = code,
            ErrorMessage = message
        };
    }

    private static string NormalizeLabel(string? label)
    {
        if (string.IsNullOrWhiteSpace(label)) return "AGENT 操作中";
        var normalized = label.Trim();
        return normalized.Length <= 128 ? normalized : normalized[..128];
    }

    private void ResetActiveState()
    {
        ClearPendingActionTrace();
        _originalWindow = null;
        _startedAt = default;
        _label = "AGENT 操作中";
        _interactionId = null;
        _overlayRequested = false;
        _overlayVisible = false;
        _actionTraceRequested = false;
        _actionTraceVisible = false;
        _currentAction = null;
        _restoreOriginalWindow = false;
        _preserveForeground = false;
        _preservedWindow = null;
        _preservationError = null;
        _depth = 0;
    }

    internal bool PreserveForeground(IntPtr handle)
    {
        if (_disposed || _depth == 0)
        {
            return false;
        }

        if (!NativeMethods.IsWindowHandle(handle))
        {
            _preservationError = "The user-attention window no longer exists.";
            return false;
        }

        if (!NativeMethods.IsForegroundWindow(handle) && !NativeMethods.ActivateWindow(handle))
        {
            _preservationError = "The user-attention window could not be activated.";
            return false;
        }

        if (!WaitForForeground(handle))
        {
            _preservationError = "The user-attention window did not become the foreground window.";
            return false;
        }

        _preserveForeground = true;
        _preservedWindow = CaptureForegroundWindow();
        if (_preservedWindow is null)
        {
            _preservationError = "The user-attention window could not be captured after activation.";
            _preserveForeground = false;
            return false;
        }

        _preservationError = null;
        return true;
    }

    internal T CaptureWithoutOverlay<T>(Func<T> capture)
    {
        var hiddenForCapture = false;
        if ((_overlayVisible || _statusPanelVisible) && !_overlay.IsCaptureExcluded)
        {
            if (!_overlay.TryHide())
            {
                throw new AgentException("CAPTURE_OVERLAY_SUPPRESSION_FAILED", "The activity overlay could not be removed from the capture frame.", true,
                    new { overlay_error = _overlay.LastError });
            }
            hiddenForCapture = true;
        }

        try
        {
            return capture();
        }
        finally
        {
            if (hiddenForCapture)
            {
                var frameWasVisible = _overlayVisible;
                var restored = _overlay.TryShow(_statusPanelVisible ? _statusPanelLabel : _label, frameWasVisible);
                _overlayVisible = frameWasVisible && restored;
                _statusPanelVisible = restored;
                _actionTraceVisible = false;
            }
        }
    }

    internal long BeginActionTrace(string? action, Point? screenPoint, int delayMs = 300)
    {
        if (_disposed || _depth == 0 || !_actionTraceRequested || !_overlayVisible)
        {
            return 0;
        }

        var normalized = string.IsNullOrWhiteSpace(action) ? "AGENT 操作" : action.Trim();
        if (normalized.Length > 96) normalized = normalized[..96];
        lock (_traceGate)
        {
            _traceDelayTimer?.Dispose();
            var generation = ++_traceGeneration;
            _currentAction = normalized;
            _pendingActionPoint = screenPoint;
            _actionTraceVisible = false;
            _traceDelayTimer = new System.Threading.Timer(_ =>
            {
                lock (_traceGate)
                {
                    if (_disposed || generation != _traceGeneration || _depth == 0 ||
                        !_actionTraceRequested || !_overlayVisible)
                    {
                        return;
                    }
                    _actionTraceVisible = _overlay.TrySetActionTrace(_pendingActionPoint, normalized);
                }
            }, null, Math.Clamp(delayMs, 0, 5000), Timeout.Infinite);
            return generation;
        }
    }

    /// <summary>
    /// Replaces the diagnostic point after the target has been activated and
    /// its live bounds have been resolved.  Action tracing is deliberately
    /// best-effort, so this never affects the underlying action.
    /// </summary>
    internal void UpdateActionTracePoint(Point? screenPoint)
    {
        if (_disposed || _depth == 0 || !_actionTraceRequested)
        {
            return;
        }

        lock (_traceGate)
        {
            _pendingActionPoint = screenPoint;
            if (_actionTraceVisible && _overlayVisible)
            {
                _ = _overlay.TrySetActionTrace(screenPoint, _currentAction ?? "AGENT 操作");
            }
        }
    }

    internal void EndActionTrace(long generation)
    {
        if (generation == 0) return;
        lock (_traceGate)
        {
            if (generation != _traceGeneration) return;
            _traceDelayTimer?.Dispose();
            _traceDelayTimer = null;
            _traceGeneration++;
            if (_actionTraceVisible && _overlayVisible)
            {
                _ = _overlay.TrySetActionTrace(null, string.Empty);
            }
            _actionTraceVisible = false;
            _pendingActionPoint = null;
            _currentAction = null;
        }
    }

    private void ClearPendingActionTrace()
    {
        lock (_traceGate)
        {
            _traceDelayTimer?.Dispose();
            _traceDelayTimer = null;
            _traceGeneration++;
            if (_actionTraceVisible && _overlayVisible)
            {
                _ = _overlay.TrySetActionTrace(null, string.Empty);
            }
            _actionTraceVisible = false;
            _pendingActionPoint = null;
            _currentAction = null;
        }
    }

    private static ForegroundSnapshot? CaptureForegroundWindow()
    {
        var handle = NativeMethods.GetForegroundWindowHandle();
        if (!NativeMethods.IsWindowHandle(handle))
        {
            return null;
        }

        return new ForegroundSnapshot(
            handle,
            NativeMethods.GetWindowTitle(handle),
            NativeMethods.GetProcessName(handle),
            NativeMethods.GetProcessId(handle),
            NativeMethods.GetClassNameValue(handle),
            NativeMethods.IsMinimized(handle));
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

    private sealed record ForegroundSnapshot(IntPtr Handle, string Title, string ProcessName, uint ProcessId, string ClassName, bool WasMinimized)
    {
        internal ActivityWindowInfo ToInfo()
        {
            return new ActivityWindowInfo
            {
                Title = Title,
                Process = ProcessName,
                ProcessId = ProcessId,
                ClassName = ClassName,
                WasMinimized = WasMinimized,
                Exists = NativeMethods.IsWindowHandle(Handle)
            };
        }
    }
}

internal sealed record ActivityResult
{
    [JsonPropertyName("active")]
    public bool Active { get; init; }
    [JsonPropertyName("started")]
    public bool Started { get; init; }
    [JsonPropertyName("ended")]
    public bool Ended { get; init; }
    [JsonPropertyName("already_ended")]
    public bool AlreadyEnded { get; init; }
    [JsonPropertyName("depth")]
    public int Depth { get; init; }
    [JsonPropertyName("interaction_id")]
    public string? InteractionId { get; init; }
    [JsonPropertyName("overlay_requested")]
    public bool OverlayRequested { get; init; }
    [JsonPropertyName("overlay_visible")]
    public bool OverlayVisible { get; init; }
    [JsonPropertyName("overlay_was_visible")]
    public bool OverlayWasVisible { get; init; }
    [JsonPropertyName("status")]
    public string Status { get; init; } = "idle";
    [JsonPropertyName("status_panel_visible")]
    public bool StatusPanelVisible { get; init; }
    [JsonPropertyName("status_panel_label")]
    public string? StatusPanelLabel { get; init; }
    [JsonPropertyName("action_trace_requested")]
    public bool ActionTraceRequested { get; init; }
    [JsonPropertyName("action_trace_visible")]
    public bool ActionTraceVisible { get; init; }
    [JsonPropertyName("current_action")]
    public string? CurrentAction { get; init; }
    [JsonPropertyName("overlay_error")]
    public string? OverlayError { get; init; }
    [JsonPropertyName("restoration_requested")]
    public bool RestorationRequested { get; init; }
    [JsonPropertyName("restoration_attempted")]
    public bool RestorationAttempted { get; init; }
    [JsonPropertyName("restored_original_window")]
    public bool RestoredOriginalWindow { get; init; }
    [JsonPropertyName("foreground_preserved")]
    public bool ForegroundPreserved { get; init; }
    [JsonPropertyName("preserved_window")]
    public ActivityWindowInfo? PreservedWindow { get; init; }
    [JsonPropertyName("preservation_error")]
    public string? PreservationError { get; init; }
    [JsonPropertyName("original_window")]
    public ActivityWindowInfo? OriginalWindow { get; init; }
    [JsonPropertyName("restoration_error")]
    public string? RestorationError { get; init; }
    [JsonPropertyName("cleanup_errors")]
    public string[]? CleanupErrors { get; init; }
    [JsonPropertyName("duration_ms")]
    public long DurationMs { get; init; }
    [JsonPropertyName("error_code")]
    public string? ErrorCode { get; init; }
    [JsonPropertyName("error_message")]
    public string? ErrorMessage { get; init; }
    [JsonPropertyName("last_completion")]
    public ActivityResult? LastCompletion { get; init; }
}

internal sealed class ActivityWindowInfo
{
    [JsonPropertyName("title")]
    public string Title { get; init; } = string.Empty;
    [JsonPropertyName("process")]
    public string Process { get; init; } = string.Empty;
    [JsonPropertyName("process_id")]
    public uint ProcessId { get; init; }
    [JsonPropertyName("class_name")]
    public string ClassName { get; init; } = string.Empty;
    [JsonPropertyName("was_minimized")]
    public bool WasMinimized { get; init; }
    [JsonPropertyName("exists")]
    public bool Exists { get; init; }
}
