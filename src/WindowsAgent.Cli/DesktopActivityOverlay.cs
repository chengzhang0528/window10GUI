using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace WindowsAgent;

/// <summary>
/// Owns a non-activating, click-through activity cue around each monitor.
/// The control frame, stable status label and optional synthetic pointer are
/// deliberately visual only: the overlay does not dim or lock the center of
/// the desktop, never becomes the input target, and never moves the user's
/// real cursor.
/// </summary>
internal sealed class DesktopActivityOverlay : IDisposable
{
    private const int StartupTimeoutMs = 3000;
    private const int InvokeTimeoutMs = 3000;
    private const int ShutdownTimeoutMs = 2000;
    private const uint WM_APP_INVOKE = 0x8001;
    private const uint WM_QUIT = 0x0012;

    private readonly object _gate = new();
    private readonly ConcurrentQueue<UiWorkItem> _work = new();
    private readonly Dictionary<IntPtr, NativeOverlayWindow> _windows = new();
    private Thread? _thread;
    private uint _threadId;
    private TaskCompletionSource<bool>? _ready;
    private bool _disposed;
    private bool _available;
    private string? _lastError;
    private string _screenSignature = string.Empty;
    private string _label = "AGENT 操作中";

    private static readonly WndProc WindowProcedure = WindowProc;
    private static readonly string WindowClassName = $"WindowsAgent.ActivityOverlay.{Guid.NewGuid():N}";
    private static readonly ConcurrentDictionary<IntPtr, NativeOverlayWindow> WindowByHandle = new();

    internal bool IsAvailable
    {
        get
        {
            lock (_gate)
            {
                return _available;
            }
        }
    }

    internal string? LastError
    {
        get
        {
            lock (_gate)
            {
                return _lastError;
            }
        }
    }

    internal bool IsCaptureExcluded
    {
        get
        {
            lock (_gate)
            {
                return _windows.Count > 0 && _windows.Values.All(window => window.CaptureExcluded);
            }
        }
    }

    internal bool TryShow(string label) => TryShow(label, frameVisible: true);

    internal bool TryShow(string label, bool frameVisible)
    {
        lock (_gate)
        {
            if (_disposed)
            {
                _lastError = "The activity overlay has already been disposed.";
                return false;
            }

            _label = string.IsNullOrWhiteSpace(label) ? "AGENT 操作中" : label.Trim();
            if (!EnsureStartedLocked())
            {
                return false;
            }

            var shown = InvokeLocked(() =>
            {
                ReconcileMonitorsOnUiThread();
                foreach (var window in _windows.Values)
                {
                    window.Label = _label;
                    window.FrameVisible = frameVisible;
                    window.SetActionTrace(null, string.Empty);
                    window.Show();
                }
            });
            if (shown)
            {
                _lastError = null;
            }
            return shown;
        }
    }

    internal bool TrySetVisualState(string label, bool frameVisible)
    {
        lock (_gate)
        {
            if (_disposed || _threadId == 0)
            {
                return false;
            }

            _label = string.IsNullOrWhiteSpace(label) ? "AGENT 等待下一步" : label.Trim();
            var updated = InvokeLocked(() =>
            {
                ReconcileMonitorsOnUiThread();
                foreach (var window in _windows.Values)
                {
                    window.Label = _label;
                    window.FrameVisible = frameVisible;
                    window.Invalidate();
                }
            });
            if (updated)
            {
                _lastError = null;
            }
            return updated;
        }
    }

    internal bool TryHide()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return true;
            }

            if (_threadId == 0)
            {
                _lastError = null;
                return true;
            }

            var hidden = InvokeLocked(() =>
            {
                foreach (var window in _windows.Values)
                {
                    window.Hide();
                }
            });
            if (hidden)
            {
                _lastError = null;
            }
            return hidden;
        }
    }

    /// <summary>
    /// Updates the visual-only agent pointer. The point is in virtual-screen
    /// coordinates and is rendered by the transparent overlay; the real OS
    /// cursor is never moved and the overlay remains mouse-through.
    /// </summary>
    internal bool TrySetActionTrace(System.Drawing.Point? screenPoint, string label)
    {
        lock (_gate)
        {
            if (_disposed || _threadId == 0)
            {
                return false;
            }

            var normalized = string.IsNullOrWhiteSpace(label) ? "AGENT 操作" : label.Trim();
            if (normalized.Length > 96) normalized = normalized[..96];
            return InvokeLocked(() =>
            {
                foreach (var window in _windows.Values)
                {
                    window.SetActionTrace(screenPoint, normalized);
                }
            });
        }
    }

    public void Dispose()
    {
        Thread? thread;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            thread = _thread;
            _disposed = true;
            if (_threadId != 0)
            {
                var cleanup = new UiWorkItem(() =>
                {
                    try
                    {
                        foreach (var window in _windows.Values.ToArray())
                        {
                            try { window.Destroy(); } catch { }
                        }
                        _windows.Clear();
                    }
                    finally
                    {
                        // Always terminate the message loop, even if one
                        // malformed monitor window failed to destroy.
                        NativeMethods.PostQuitMessage(0);
                    }
                });
                _work.Enqueue(cleanup);
                if (!NativeMethods.PostThreadMessage(_threadId, WM_APP_INVOKE, IntPtr.Zero, IntPtr.Zero))
                {
                    // If the queue disappeared, ask the thread to leave its
                    // loop directly; its finally block still destroys HWNDs.
                    _ = NativeMethods.PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                }
            }
        }

        if (thread is not null && thread.IsAlive && !ReferenceEquals(Thread.CurrentThread, thread))
        {
            if (!thread.Join(ShutdownTimeoutMs) && _threadId != 0)
            {
                _ = NativeMethods.PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                _ = thread.Join(250);
            }
        }
    }

    private bool EnsureStartedLocked()
    {
        if (_available && _thread is { IsAlive: true })
        {
            return true;
        }

        if (_thread is not null)
        {
            if (_thread.IsAlive)
            {
                return false;
            }
            _thread = null;
            _threadId = 0;
            _available = false;
            _screenSignature = string.Empty;
        }

        _ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _thread = new Thread(RunMessageLoop)
        {
            IsBackground = true,
            Name = "WindowsAgent.ActivityOverlay"
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();

        try
        {
            if (!_ready.Task.Wait(StartupTimeoutMs) || !_ready.Task.Result)
            {
                _lastError ??= "The activity overlay thread did not become ready.";
                return false;
            }
            _available = true;
            return true;
        }
        catch (Exception ex)
        {
            _lastError = ex.GetBaseException().Message;
            return false;
        }
    }

    private void RunMessageLoop()
    {
        _threadId = NativeMethods.GetCurrentThreadId();
        try
        {
            if (IsDisposed())
            {
                _ready?.TrySetResult(true);
                return;
            }
            RegisterWindowClass();
            ReconcileMonitorsOnUiThread();
            if (_windows.Count == 0)
            {
                throw new InvalidOperationException("Windows did not report an interactive display.");
            }

            _ready?.TrySetResult(true);
            while (true)
            {
                var messageResult = NativeMethods.GetMessage(out var message, IntPtr.Zero, 0, 0);
                if (messageResult < 0)
                {
                    throw new InvalidOperationException($"The activity overlay message loop failed ({Marshal.GetLastWin32Error()}).");
                }
                if (messageResult == 0)
                {
                    break;
                }
                if (message.Message == WM_APP_INVOKE)
                {
                    while (_work.TryDequeue(out var work))
                    {
                        work.Run();
                    }
                    continue;
                }

                NativeMethods.TranslateMessage(ref message);
                NativeMethods.DispatchMessage(ref message);
            }
        }
        catch (Exception ex)
        {
            // EnsureStartedLocked waits on _ready while holding _gate. Signal
            // the waiter before taking that lock or a startup failure would
            // sit behind the full startup timeout.
            _ready?.TrySetException(ex);
            lock (_gate)
            {
                _lastError = ex.GetBaseException().Message;
                _available = false;
            }
            while (_work.TryDequeue(out var work))
            {
                work.Fail(ex);
            }
        }
        finally
        {
            foreach (var window in _windows.Values.ToArray())
            {
                try { window.Destroy(); } catch { }
            }
            _windows.Clear();
            lock (_gate)
            {
                _available = false;
                _threadId = 0;
                _screenSignature = string.Empty;
            }
        }
    }

    private bool IsDisposed()
    {
        // EnsureStartedLocked waits for the STA thread while holding _gate;
        // taking that lock here would deadlock startup until the timeout.
        return Volatile.Read(ref _disposed);
    }

    private void RegisterWindowClass()
    {
        var classInfo = new WNDCLASSEX
        {
            Size = (uint)Marshal.SizeOf<WNDCLASSEX>(),
            Style = 0x0001 | 0x0002, // CS_VREDRAW | CS_HREDRAW
            WindowProc = Marshal.GetFunctionPointerForDelegate(WindowProcedure),
            Instance = NativeMethods.GetModuleHandle(null),
            Cursor = NativeMethods.LoadCursor(IntPtr.Zero, (IntPtr)32512), // IDC_ARROW
            ClassName = WindowClassName
        };

        if (NativeMethods.RegisterClassEx(ref classInfo) == 0)
        {
            var error = Marshal.GetLastWin32Error();
            // A second overlay instance in this process can reuse the class.
            if (error != 1410) // ERROR_CLASS_ALREADY_EXISTS
            {
                throw new InvalidOperationException($"Unable to register activity overlay window class ({error}).");
            }
        }
    }

    private void ReconcileMonitorsOnUiThread()
    {
        var screens = Screen.AllScreens;
        var primaryName = Screen.PrimaryScreen?.DeviceName ?? string.Empty;
        var signature = string.Join("|", screens
            .OrderBy(screen => screen.DeviceName, StringComparer.OrdinalIgnoreCase)
            .Select(screen => $"{screen.DeviceName}:{screen.Bounds.Left},{screen.Bounds.Top},{screen.Bounds.Width},{screen.Bounds.Height}"))
            + $"|primary={primaryName}";
        if (string.Equals(signature, _screenSignature, StringComparison.Ordinal))
        {
            return;
        }

        foreach (var window in _windows.Values.ToArray())
        {
            window.Destroy();
        }
        _windows.Clear();

        var created = new List<NativeOverlayWindow>();
        try
        {
            foreach (var screen in screens)
            {
                var window = new NativeOverlayWindow(screen.DeviceName, screen.Bounds, string.Equals(screen.DeviceName, primaryName, StringComparison.OrdinalIgnoreCase));
                window.Create();
                created.Add(window);
                _windows[window.Handle] = window;
                WindowByHandle[window.Handle] = window;
            }
        }
        catch
        {
            foreach (var window in created)
            {
                try { window.Destroy(); } catch { }
            }
            _windows.Clear();
            throw;
        }
        _screenSignature = signature;
    }

    private bool InvokeLocked(Action action)
    {
        if (_threadId == 0)
        {
            _lastError ??= "The activity overlay message loop is unavailable.";
            _available = false;
            return false;
        }

        var work = new UiWorkItem(action);
        _work.Enqueue(work);
        if (!NativeMethods.PostThreadMessage(_threadId, WM_APP_INVOKE, IntPtr.Zero, IntPtr.Zero))
        {
            work.Cancel();
            _lastError = $"Unable to post activity overlay work ({Marshal.GetLastWin32Error()}).";
            return false;
        }

        try
        {
            if (!work.Completion.Wait(InvokeTimeoutMs))
            {
                work.Cancel();
                _lastError = "The activity overlay did not finish its UI operation in time.";
                return false;
            }
            if (work.Exception is not null)
            {
                throw work.Exception;
            }
            return true;
        }
        catch (Exception ex)
        {
            _lastError = ex.GetBaseException().Message;
            _available = false;
            return false;
        }
    }

    private static IntPtr WindowProc(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (!WindowByHandle.TryGetValue(handle, out var window))
        {
            return NativeMethods.DefWindowProc(handle, message, wParam, lParam);
        }

        try
        {
            return window.HandleMessage(message, wParam, lParam);
        }
        catch
        {
            return NativeMethods.DefWindowProc(handle, message, wParam, lParam);
        }
    }

    private sealed class UiWorkItem
    {
        private readonly Action _action;
        private int _cancelled;
        internal ManualResetEventSlim Completion { get; } = new(false);
        internal Exception? Exception { get; private set; }

        internal UiWorkItem(Action action) => _action = action;

        internal void Run()
        {
            if (Volatile.Read(ref _cancelled) != 0)
            {
                Completion.Set();
                return;
            }
            try { _action(); }
            catch (Exception ex) { Exception = ex; }
            finally { Completion.Set(); }
        }

        internal void Cancel() => Volatile.Write(ref _cancelled, 1);

        internal void Fail(Exception exception)
        {
            Exception = exception;
            Completion.Set();
        }
    }

    private sealed class NativeOverlayWindow
    {
        private const uint WM_NCCREATE = 0x0081;
        private const uint WM_PAINT = 0x000F;
        private const uint WM_ERASEBKGND = 0x0014;
        private const uint WM_TIMER = 0x0113;
        private const uint WM_NCHITTEST = 0x0084;
        private const uint WM_MOUSEACTIVATE = 0x0021;
        private const int HTTRANSPARENT = -1;
        private const int MA_NOACTIVATE = 3;
        private const int SW_SHOWNOACTIVATE = 4;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private static readonly IntPtr HWND_TOPMOST = new(-1);
        private const uint WS_POPUP = 0x80000000;
        private const uint WS_EX_LAYERED = 0x00080000;
        private const uint WS_EX_TRANSPARENT = 0x00000020;
        private const uint WS_EX_TOOLWINDOW = 0x00000080;
        private const uint WS_EX_NOACTIVATE = 0x08000000;
        private const uint WS_EX_TOPMOST = 0x00000008;
        private const uint LWA_COLORKEY = 0x00000001;
        private const uint LWA_ALPHA = 0x00000002;
        private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
        private const uint COLOR_KEY = 0x00FF00FF;
        private const UIntPtr TIMER_ID = 1;
        private const uint TIMER_INTERVAL_MS = 50;
        private const int FrameThickness = 8;
        private const int LabelMargin = 18;

        private readonly string _monitorName;
        private readonly Rectangle _bounds;
        private readonly bool _showLabel;
        private bool _frameVisible = true;
        private int _phase;
        private System.Drawing.Point? _actionPoint;
        private string _actionLabel = string.Empty;

        internal NativeOverlayWindow(string monitorName, Rectangle bounds, bool showLabel)
        {
            _monitorName = monitorName;
            _bounds = bounds;
            _showLabel = showLabel;
            Label = "AGENT 操作中";
        }

        internal IntPtr Handle { get; private set; }
        internal string Label { get; set; }
        internal bool FrameVisible
        {
            get => _frameVisible;
            set
            {
                _frameVisible = value;
                Invalidate();
            }
        }
        internal bool CaptureExcluded { get; private set; }

        internal void Invalidate()
        {
            if (Handle != IntPtr.Zero)
            {
                NativeMethods.InvalidateRect(Handle, IntPtr.Zero, false);
            }
        }

        internal void SetActionTrace(System.Drawing.Point? screenPoint, string label)
        {
            _actionPoint = screenPoint;
            _actionLabel = label;
            Invalidate();
        }

        internal void Create()
        {
            Handle = NativeMethods.CreateWindowEx(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                WindowClassName,
                string.Empty,
                WS_POPUP,
                _bounds.Left,
                _bounds.Top,
                _bounds.Width,
                _bounds.Height,
                IntPtr.Zero,
                IntPtr.Zero,
                NativeMethods.GetModuleHandle(null),
                IntPtr.Zero);
            if (Handle == IntPtr.Zero)
            {
                throw new InvalidOperationException($"Unable to create activity overlay for monitor '{_monitorName}' ({Marshal.GetLastWin32Error()}).");
            }

            WindowByHandle[Handle] = this;
            // Win10 2004+ usually supports WDA_EXCLUDEFROMCAPTURE. Some GPU/
            // layered-window combinations reject it; the coordinator then
            // hides the overlay only for the capture frame.
            CaptureExcluded = NativeMethods.SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE);
            if (!NativeMethods.SetLayeredWindowAttributes(Handle, COLOR_KEY, 224, LWA_COLORKEY | LWA_ALPHA))
            {
                var error = Marshal.GetLastWin32Error();
                WindowByHandle.TryRemove(Handle, out _);
                _ = NativeMethods.DestroyWindow(Handle);
                Handle = IntPtr.Zero;
                throw new InvalidOperationException($"Unable to configure activity overlay transparency ({error}).");
            }
            if (!NativeMethods.SetWindowPos(Handle, HWND_TOPMOST, _bounds.Left, _bounds.Top, _bounds.Width, _bounds.Height, SWP_NOACTIVATE))
            {
                var error = Marshal.GetLastWin32Error();
                WindowByHandle.TryRemove(Handle, out _);
                _ = NativeMethods.DestroyWindow(Handle);
                Handle = IntPtr.Zero;
                throw new InvalidOperationException($"Unable to position activity overlay ({error}).");
            }
            if (NativeMethods.SetTimer(Handle, TIMER_ID, TIMER_INTERVAL_MS, IntPtr.Zero) == UIntPtr.Zero)
            {
                var error = Marshal.GetLastWin32Error();
                WindowByHandle.TryRemove(Handle, out _);
                _ = NativeMethods.DestroyWindow(Handle);
                Handle = IntPtr.Zero;
                throw new InvalidOperationException($"Unable to start activity overlay animation ({error}).");
            }
        }

        internal void Show()
        {
            if (Handle == IntPtr.Zero) return;
            if (!NativeMethods.SetWindowPos(Handle, HWND_TOPMOST, _bounds.Left, _bounds.Top, _bounds.Width, _bounds.Height, SWP_NOACTIVATE | SWP_SHOWWINDOW))
            {
                throw new InvalidOperationException($"Unable to show activity overlay ({Marshal.GetLastWin32Error()}).");
            }
            NativeMethods.ShowWindow(Handle, SW_SHOWNOACTIVATE);
            if (!NativeMethods.IsWindowVisible(Handle))
            {
                throw new InvalidOperationException($"The activity overlay did not become visible ({Marshal.GetLastWin32Error()}).");
            }
            Invalidate();
        }

        internal void Hide()
        {
            if (Handle == IntPtr.Zero) return;
            NativeMethods.ShowWindow(Handle, 0); // SW_HIDE
            if (NativeMethods.IsWindowVisible(Handle))
            {
                throw new InvalidOperationException($"The activity overlay did not hide ({Marshal.GetLastWin32Error()}).");
            }
        }

        internal void Destroy()
        {
            if (Handle == IntPtr.Zero) return;
            var handle = Handle;
            try
            {
                NativeMethods.KillTimer(handle, TIMER_ID);
                WindowByHandle.TryRemove(handle, out _);
                if (!NativeMethods.DestroyWindow(handle) && NativeMethods.IsWindow(handle))
                {
                    throw new InvalidOperationException($"Unable to destroy activity overlay ({Marshal.GetLastWin32Error()}).");
                }
            }
            finally
            {
                Handle = IntPtr.Zero;
                CaptureExcluded = false;
            }
        }

        internal IntPtr HandleMessage(uint message, IntPtr wParam, IntPtr lParam)
        {
            return message switch
            {
                WM_NCCREATE => new IntPtr(1),
                WM_NCHITTEST => (IntPtr)HTTRANSPARENT,
                WM_MOUSEACTIVATE => (IntPtr)MA_NOACTIVATE,
                WM_ERASEBKGND => new IntPtr(1),
                WM_TIMER => HandleTimer(),
                WM_PAINT => HandlePaint(),
                _ => NativeMethods.DefWindowProc(Handle, message, wParam, lParam)
            };
        }

        private IntPtr HandleTimer()
        {
            if (!_frameVisible && _actionPoint is null)
            {
                // The idle panel is intentionally stable; animation belongs
                // to the active control cue and action trace only.
                return IntPtr.Zero;
            }
            _phase = (_phase + 3) % 360;
            NativeMethods.InvalidateRect(Handle, IntPtr.Zero, false);
            return IntPtr.Zero;
        }

        private IntPtr HandlePaint()
        {
            if (NativeMethods.BeginPaint(Handle, out var paint) == IntPtr.Zero)
            {
                return IntPtr.Zero;
            }

            try
            {
                using var graphics = Graphics.FromHdc(paint.Dc);
                // HDC-backed Graphics can inherit a monitor's DPI mapping.
                // Overlay window bounds and action points are physical pixels;
                // force a 1:1 pixel canvas so the synthetic pointer stays on
                // the reported screen coordinate at 125%/150% scaling.
                graphics.PageUnit = GraphicsUnit.Pixel;
                graphics.PageScale = 1f;
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                graphics.Clear(Color.Magenta);

                var first = HsvToColor((_phase + 195) % 360, 0.78, 1.0, 235);
                var second = HsvToColor((_phase + 315) % 360, 0.78, 1.0, 235);
                if (_frameVisible)
                {
                    var client = new Rectangle(0, 0, _bounds.Width, _bounds.Height);
                    var frame = new Rectangle(
                        FrameThickness / 2,
                        FrameThickness / 2,
                        Math.Max(1, client.Width - FrameThickness),
                        Math.Max(1, client.Height - FrameThickness));
                    using (var gradient = new LinearGradientBrush(frame, first, second, 25f))
                    {
                        using var glow = new Pen(Color.FromArgb(70, first), FrameThickness + 7);
                        using var pen = new Pen(gradient, FrameThickness);
                        graphics.DrawRectangle(glow, frame);
                        graphics.DrawRectangle(pen, frame);
                    }
                }

                if (_showLabel)
                {
                    DrawLabel(graphics, first, second);
                }
                DrawActionTrace(graphics, first, second);
            }
            finally
            {
                NativeMethods.EndPaint(Handle, ref paint);
            }
            return IntPtr.Zero;
        }

        private void DrawLabel(Graphics graphics, Color first, Color second)
        {
            using var font = new Font("Segoe UI", 10f, FontStyle.Bold, GraphicsUnit.Point);
            var textSize = graphics.MeasureString(Label, font);
            var width = (int)Math.Ceiling(textSize.Width) + 28;
            var height = (int)Math.Ceiling(textSize.Height) + 12;
            var bounds = new Rectangle(LabelMargin, LabelMargin, width, height);

            using var background = new SolidBrush(Color.FromArgb(210, 12, 20, 36));
            using var outline = new LinearGradientBrush(bounds, first, second, 0f);
            using var outlinePen = new Pen(outline, 2f);
            using var path = RoundedRectangle(bounds, 10);
            graphics.FillPath(background, path);
            graphics.DrawPath(outlinePen, path);
            using var textBrush = new SolidBrush(Color.White);
            graphics.DrawString(Label, font, textBrush, bounds.Left + 14, bounds.Top + 6);
        }

        private void DrawActionTrace(Graphics graphics, Color first, Color second)
        {
            if (_actionPoint is not System.Drawing.Point point || !_bounds.Contains(point)) return;

            var local = new System.Drawing.Point(point.X - _bounds.Left, point.Y - _bounds.Top);
            var pulse = 20 + (int)Math.Round(7 * (0.5 + 0.5 * Math.Sin(_phase * Math.PI / 45d)));
            using var ringPen = new Pen(Color.FromArgb(230, Color.White), 3f);
            using var glowPen = new Pen(Color.FromArgb(110, first), 8f);
            graphics.DrawEllipse(glowPen, local.X - pulse, local.Y - pulse, pulse * 2, pulse * 2);
            graphics.DrawEllipse(ringPen, local.X - pulse, local.Y - pulse, pulse * 2, pulse * 2);

            // A high-contrast synthetic pointer makes it clear that this is
            // the agent's visual trace, not the user's actual mouse cursor.
            var pointer = new[]
            {
                new System.Drawing.Point(local.X, local.Y),
                new System.Drawing.Point(local.X + 3, local.Y + 31),
                new System.Drawing.Point(local.X + 11, local.Y + 24),
                new System.Drawing.Point(local.X + 22, local.Y + 37),
                new System.Drawing.Point(local.X + 29, local.Y + 32),
                new System.Drawing.Point(local.X + 18, local.Y + 20),
                new System.Drawing.Point(local.X + 29, local.Y + 16),
                new System.Drawing.Point(local.X, local.Y)
            };
            using var pointerShadow = new SolidBrush(Color.FromArgb(190, Color.Black));
            using var pointerBrush = new SolidBrush(Color.White);
            using var pointerPen = new Pen(second, 2f);
            graphics.FillPolygon(pointerShadow, pointer.Select(p => new System.Drawing.Point(p.X + 2, p.Y + 2)).ToArray());
            graphics.FillPolygon(pointerBrush, pointer);
            graphics.DrawPolygon(pointerPen, pointer);

            if (string.IsNullOrWhiteSpace(_actionLabel)) return;
            using var font = new Font("Segoe UI", 10f, FontStyle.Bold, GraphicsUnit.Point);
            var textSize = graphics.MeasureString(_actionLabel, font);
            var width = (int)Math.Ceiling(textSize.Width) + 24;
            var height = (int)Math.Ceiling(textSize.Height) + 10;
            var left = Math.Clamp(local.X + 34, 8, Math.Max(8, _bounds.Width - width - 8));
            var top = Math.Clamp(local.Y - height - 12, 8, Math.Max(8, _bounds.Height - height - 8));
            var bounds = new Rectangle(left, top, width, height);
            using var background = new SolidBrush(Color.FromArgb(224, 12, 20, 36));
            using var outline = new LinearGradientBrush(bounds, first, second, 0f);
            using var outlinePen = new Pen(outline, 2f);
            using var path = RoundedRectangle(bounds, 8);
            graphics.FillPath(background, path);
            graphics.DrawPath(outlinePen, path);
            using var textBrush = new SolidBrush(Color.White);
            graphics.DrawString(_actionLabel, font, textBrush, bounds.Left + 12, bounds.Top + 5);
        }

        private static GraphicsPath RoundedRectangle(Rectangle rectangle, int radius)
        {
            var diameter = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static Color HsvToColor(double hue, double saturation, double value, int alpha)
        {
            var chroma = value * saturation;
            var x = chroma * (1 - Math.Abs((hue / 60d % 2) - 1));
            var match = value - chroma;
            var (r, g, b) = hue switch
            {
                < 60 => (chroma, x, 0d),
                < 120 => (x, chroma, 0d),
                < 180 => (0d, chroma, x),
                < 240 => (0d, x, chroma),
                < 300 => (x, 0d, chroma),
                _ => (chroma, 0d, x)
            };
            return Color.FromArgb(
                Math.Clamp(alpha, 0, 255),
                (int)Math.Round((r + match) * 255),
                (int)Math.Round((g + match) * 255),
                (int)Math.Round((b + match) * 255));
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate IntPtr WndProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public uint Size;
        public uint Style;
        public IntPtr WindowProc;
        public int ClsExtra;
        public int WndExtra;
        public IntPtr Instance;
        public IntPtr Icon;
        public IntPtr Cursor;
        public IntPtr Background;
        public string? MenuName;
        public string ClassName;
        public IntPtr SmallIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr HWnd;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Point;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PAINTSTRUCT
    {
        public IntPtr Dc;
        public int Erase;
        public RECT Paint;
        public int Restore;
        public int IncUpdate;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[]? Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static class NativeMethods
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern ushort RegisterClassEx(ref WNDCLASSEX classInfo);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool DestroyWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        internal static extern IntPtr DefWindowProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint colorKey, byte alpha, uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool ShowWindow(IntPtr hWnd, int command);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern UIntPtr SetTimer(IntPtr hWnd, UIntPtr eventId, uint milliseconds, IntPtr callback);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool KillTimer(IntPtr hWnd, UIntPtr eventId);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool InvalidateRect(IntPtr hWnd, IntPtr rect, bool erase);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern int GetMessage(out MSG message, IntPtr hWnd, uint minFilter, uint maxFilter);

        [DllImport("user32.dll")]
        internal static extern bool TranslateMessage(ref MSG message);

        [DllImport("user32.dll")]
        internal static extern IntPtr DispatchMessage(ref MSG message);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern IntPtr GetModuleHandle(string? moduleName);

        [DllImport("user32.dll")]
        internal static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursorName);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr BeginPaint(IntPtr hWnd, out PAINTSTRUCT paint);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool EndPaint(IntPtr hWnd, ref PAINTSTRUCT paint);

        internal static void PostQuitMessage(int exitCode)
        {
            // Calling PostQuitMessage from the overlay UI thread is safe and
            // avoids using a second window as a message-loop sentinel.
            PostThreadMessage(GetCurrentThreadId(), 0x0012, (IntPtr)exitCode, IntPtr.Zero);
        }
    }
}
