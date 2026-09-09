using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace WindowsAgent;

internal static class NativeMethods
{
    internal const int SW_RESTORE = 9;
    internal const uint WM_CLOSE = 0x0010;
    internal const uint WM_NCHITTEST = 0x0084;
    internal const uint WM_MOUSEACTIVATE = 0x0021;
    internal const uint GW_OWNER = 4;
    internal const uint GA_ROOT = 2;
    internal const int GWL_STYLE = -16;
    internal const long WS_POPUP = 0x80000000L;
    internal const int HTTRANSPARENT = -1;
    internal const int MA_NOACTIVATE = 3;
    internal const uint MOUSEEVENTF_MOVE = 0x0001;
    internal const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    internal const uint MOUSEEVENTF_LEFTUP = 0x0004;
    internal const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    internal const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    internal const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    internal const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    internal const uint MOUSEEVENTF_WHEEL = 0x0800;
    internal const uint KEYEVENTF_KEYUP = 0x0002;
    internal const uint KEYEVENTF_UNICODE = 0x0004;
    internal const uint PW_RENDERFULLCONTENT = 0x00000002;
    internal const int SM_XVIRTUALSCREEN = 76;
    internal const int SM_YVIRTUALSCREEN = 77;
    internal const int SM_CXVIRTUALSCREEN = 78;
    internal const int SM_CYVIRTUALSCREEN = 79;

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width => Math.Max(0, Right - Left);
        public int Height => Math.Max(0, Bottom - Top);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Vk;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion Data;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", EntryPoint = "IsWindowVisible", SetLastError = true)]
    private static extern bool IsWindowVisibleNative(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, Input[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern short VkKeyScan(char character);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint MapVirtualKey(uint code, uint mapType);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDc);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hDc, uint flags);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiAwarenessContext);

    private static readonly IntPtr DpiAwarenessContextPerMonitorV2 = new(-4);

    internal static void EnablePerMonitorDpiAwareness()
    {
        try { _ = SetProcessDpiAwarenessContext(DpiAwarenessContextPerMonitorV2); }
        catch { /* Older Windows builds simply keep the process default. */ }
    }

    internal static IReadOnlyList<IntPtr> EnumerateTopLevelWindows()
    {
        var result = new List<IntPtr>();
        var foreground = GetForegroundWindow();
        EnumWindows((hWnd, _) =>
        {
            // A transient native/Qt popup can be the real foreground target
            // while IsWindowVisible briefly reports false. Always surface the
            // foreground HWND so callers can diagnose and bind that state.
            if (IsWindow(hWnd) && (IsWindowVisibleNative(hWnd) || hWnd == foreground))
            {
                result.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    internal static bool IsWindowVisible(IntPtr hWnd) => IsWindowVisibleNative(hWnd);

    internal static bool IsWindowHandle(IntPtr hWnd) => hWnd != IntPtr.Zero && IsWindow(hWnd);

    internal static IntPtr GetForegroundWindowHandle() => GetForegroundWindow();

    internal static bool TryGetWindowRect(IntPtr hWnd, out Rect rect) => GetWindowRect(hWnd, out rect);

    internal static bool IsMinimized(IntPtr hWnd) => IsIconic(hWnd);

    internal static bool IsForegroundWindow(IntPtr hWnd) => GetForegroundWindow() == hWnd;

    internal static bool IsForegroundWindowOrOwnedPopup(IntPtr hWnd)
        => GetForegroundRelationship(hWnd).Related;

    internal static ForegroundRelationship GetForegroundRelationship(IntPtr hWnd)
    {
        var foreground = GetForegroundWindow();
        if (foreground == hWnd)
        {
            return new ForegroundRelationship(true, "target", foreground, GetProcessId(foreground));
        }

        // Menus, autocomplete lists, and native combo drop-downs are commonly
        // separate owned top-level windows. Keep their owner chain bounded so a
        // malformed/native cycle cannot stall an Agent action.
        var current = foreground;
        for (var depth = 0; depth < 16 && current != IntPtr.Zero; depth++)
        {
            current = GetWindow(current, GW_OWNER);
            if (current == hWnd)
            {
                return new ForegroundRelationship(true, "owned_popup", foreground, GetProcessId(foreground));
            }
        }

        // Qt and some Chromium-hosted applications expose menus as ownerless
        // WS_POPUP HWNDs. Bind only a same-process popup that spatially
        // intersects the requested parent; a second ordinary top-level window
        // in the same process must not silently become the target.
        var targetProcessId = GetProcessId(hWnd);
        var foregroundProcessId = GetProcessId(foreground);
        if (foreground != IntPtr.Zero && targetProcessId != 0 && targetProcessId == foregroundProcessId &&
            IsOwnerlessTransientPopupForTarget(hWnd, foreground))
        {
            return new ForegroundRelationship(true, "same_process_popup", foreground, foregroundProcessId);
        }

        return new ForegroundRelationship(false, "unrelated", foreground, foregroundProcessId);
    }

    private static bool IsOwnerlessTransientPopupForTarget(IntPtr target, IntPtr candidate)
    {
        if (candidate == IntPtr.Zero || GetWindow(candidate, GW_OWNER) != IntPtr.Zero ||
            !TryGetWindowRect(target, out var targetRect) ||
            !TryGetWindowRect(candidate, out var candidateRect))
        {
            return false;
        }

        var overlapWidth = Math.Max(0, Math.Min(targetRect.Right, candidateRect.Right) - Math.Max(targetRect.Left, candidateRect.Left));
        var overlapHeight = Math.Max(0, Math.Min(targetRect.Bottom, candidateRect.Bottom) - Math.Max(targetRect.Top, candidateRect.Top));
        if (overlapWidth == 0 || overlapHeight == 0) return false;

        var className = GetClassNameValue(candidate);
        if (className.Contains("popup", StringComparison.OrdinalIgnoreCase) ||
            className.Contains("menu", StringComparison.OrdinalIgnoreCase) ||
            className.Contains("tooltip", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var style = GetWindowLongPtr(candidate, GWL_STYLE).ToInt64();
        if ((style & WS_POPUP) == 0) return false;

        // Qt can put WS_POPUP on ordinary ownerless application windows. Do
        // not let a second large overlapping window in the same process stand
        // in for the explicitly selected target. A transient dropdown/menu is
        // bounded relative to its parent and mostly overlaps that parent.
        var targetArea = (long)Math.Max(0, targetRect.Width) * Math.Max(0, targetRect.Height);
        var candidateArea = (long)Math.Max(0, candidateRect.Width) * Math.Max(0, candidateRect.Height);
        var overlapArea = (long)overlapWidth * overlapHeight;
        return targetArea > 0 && candidateArea > 0 &&
               candidateArea * 4 <= targetArea * 3 &&
               overlapArea * 2 >= candidateArea;
    }

    internal static bool RequestCloseWindow(IntPtr hWnd)
    {
        return IsWindow(hWnd) && PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    internal static string GetWindowTitle(IntPtr hWnd)
    {
        var buffer = new StringBuilder(2048);
        _ = GetWindowText(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    internal static string GetClassNameValue(IntPtr hWnd)
    {
        var buffer = new StringBuilder(512);
        _ = GetClassName(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    internal static uint GetProcessId(IntPtr hWnd)
    {
        _ = GetWindowThreadProcessId(hWnd, out var processId);
        return processId;
    }

    internal static string GetProcessName(IntPtr hWnd)
    {
        var processId = GetProcessId(hWnd);
        if (processId == 0)
        {
            return string.Empty;
        }

        try
        {
            using var process = Process.GetProcessById((int)processId);
            return process.ProcessName;
        }
        catch
        {
            return string.Empty;
        }
    }

    internal static bool ActivateWindow(IntPtr hWnd)
    {
        if (!IsWindow(hWnd))
        {
            return false;
        }

        if (IsIconic(hWnd))
        {
            _ = ShowWindow(hWnd, SW_RESTORE);
        }
        _ = BringWindowToTop(hWnd);
        _ = SetForegroundWindow(hWnd);
        if (WaitForExactForeground(hWnd, 8))
        {
            return true;
        }

        if (TrySetForegroundWindowWithAttachedInput(hWnd) && WaitForExactForeground(hWnd, 8))
        {
            return true;
        }

        // A real keyboard transition releases Windows' foreground-lock
        // timeout without moving the pointer or typing into the application.
        // Use it only after both normal activation paths failed.
        try
        {
            Send(new[] { VirtualKey(0x12, false), VirtualKey(0x12, true) }); // ALT
        }
        catch
        {
            // Activation still gets one final bounded attempt below.
        }
        return TrySetForegroundWindowWithAttachedInput(hWnd) && WaitForExactForeground(hWnd, 12);
    }

    internal static bool RestoreForegroundWindow(IntPtr hWnd)
    {
        if (!IsWindow(hWnd))
        {
            return false;
        }

        if (IsIconic(hWnd))
        {
            _ = ShowWindow(hWnd, SW_RESTORE);
        }

        _ = BringWindowToTop(hWnd);
        _ = SetForegroundWindow(hWnd);
        if (!IsForegroundWindow(hWnd))
        {
            _ = TrySetForegroundWindowWithAttachedInput(hWnd);
        }
        // Some Qt focus transitions complete asynchronously after the target
        // action. Give restoration one bounded second before reporting a
        // failure that can otherwise become a false negative moments later.
        for (var attempt = 0; attempt < 40; attempt++)
        {
            if (IsForegroundWindow(hWnd))
            {
                return true;
            }
            Thread.Sleep(25);
        }
        return IsForegroundWindow(hWnd);
    }

    private static bool TrySetForegroundWindowWithAttachedInput(IntPtr hWnd)
    {
        if (!IsWindow(hWnd))
        {
            return false;
        }

        // Windows deliberately limits foreground stealing. Temporarily share
        // the current foreground input queue so SetForegroundWindow follows
        // the same cooperative path as normal task switching, then detach
        // immediately. This does not cross integrity levels or security
        // desktops and is only used for the explicitly selected target.
        var foreground = GetForegroundWindow();
        var foregroundThread = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, out _);
        var targetThread = GetWindowThreadProcessId(hWnd, out _);
        var currentThread = GetCurrentThreadId();
        var attachedForeground = foregroundThread != 0 && foregroundThread != currentThread &&
                                 AttachThreadInput(currentThread, foregroundThread, true);
        var attachedTarget = targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread &&
                             AttachThreadInput(currentThread, targetThread, true);
        try
        {
            _ = BringWindowToTop(hWnd);
            _ = SetForegroundWindow(hWnd);
            _ = SetFocus(hWnd);
        }
        finally
        {
            if (attachedTarget)
            {
                _ = AttachThreadInput(currentThread, targetThread, false);
            }
            if (attachedForeground)
            {
                _ = AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
        return IsForegroundWindow(hWnd);
    }

    private static bool WaitForExactForeground(IntPtr hWnd, int attempts)
    {
        for (var attempt = 0; attempt < attempts; attempt++)
        {
            if (IsForegroundWindow(hWnd)) return true;
            Thread.Sleep(25);
        }
        return IsForegroundWindow(hWnd);
    }

    internal static uint GetDpi(IntPtr hWnd)
    {
        try
        {
            var dpi = GetDpiForWindow(hWnd);
            return dpi == 0 ? 96u : dpi;
        }
        catch
        {
            return 96;
        }
    }

    internal static object GetVirtualScreen()
    {
        return new
        {
            x = GetSystemMetrics(SM_XVIRTUALSCREEN),
            y = GetSystemMetrics(SM_YVIRTUALSCREEN),
            width = GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height = GetSystemMetrics(SM_CYVIRTUALSCREEN)
        };
    }

    internal static void ClickScreen(int x, int y, string button = "left", int clickCount = 1)
    {
        if (clickCount < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(clickCount), "clickCount must be at least 1.");
        }
        var original = TryGetCursorPosition();
        try
        {
            MoveCursor(x, y);
            var (down, up) = button.ToLowerInvariant() switch
            {
                "right" or "r" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle" or "m" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                "left" or "l" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                _ => throw new ArgumentException($"Unsupported mouse button '{button}'.", nameof(button))
            };

            var inputs = new List<Input>(Math.Max(2, clickCount * 2));
            for (var i = 0; i < clickCount; i++)
            {
                inputs.Add(Mouse(down));
                inputs.Add(Mouse(up));
            }
            Send(inputs);
        }
        finally
        {
            // Coordinate fallback briefly uses the OS cursor to deliver the
            // event, then returns it to the user's original position. The
            // activity overlay's synthetic cursor remains the only persistent
            // visual indicator of the agent action.
            RestoreCursorPosition(original);
        }
    }

    internal static void MoveCursor(int x, int y)
    {
        if (!SetCursorPos(x, y))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to move the mouse cursor.");
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out Point point);

    internal static void Scroll(int x, int y, int amount)
    {
        var original = TryGetCursorPosition();
        try
        {
            MoveCursor(x, y);
            Send(new[]
            {
                Mouse(MOUSEEVENTF_WHEEL, unchecked((uint)amount))
            });
        }
        finally
        {
            RestoreCursorPosition(original);
        }
    }

    private static System.Drawing.Point? TryGetCursorPosition()
    {
        return GetCursorPos(out var point) ? new System.Drawing.Point(point.X, point.Y) : null;
    }

    private static void RestoreCursorPosition(System.Drawing.Point? point)
    {
        if (point is System.Drawing.Point original)
        {
            _ = SetCursorPos(original.X, original.Y);
        }
    }

    internal static string TypeText(string text, bool useClipboardForUnicode = true)
    {
        if (text is null)
        {
            throw new ArgumentNullException(nameof(text));
        }

        if (text.Length == 0)
        {
            return "send_input";
        }

        // VK_PACKET is lossless in standard edit controls, but some Qt and
        // custom-rendered controls drop or duplicate packet characters. A
        // temporary Unicode clipboard paste follows the same path a user would
        // use in those controls. The previous clipboard object is restored in
        // memory and is never logged or persisted by DeskPilot.
        if (useClipboardForUnicode && text.Any(character => character > 0x7f))
        {
            PasteUnicodeText(text);
            return "clipboard_paste";
        }

        var inputs = new List<Input>(text.Length * 2);
        foreach (var character in text)
        {
            // KEYEVENTF_UNICODE consumes UTF-16 code units. Sending both halves
            // of a surrogate pair preserves emoji and other non-BMP characters.
            inputs.Add(UnicodeKey(character, false));
            inputs.Add(UnicodeKey(character, true));
        }
        Send(inputs);
        return "send_input";
    }

    private static void PasteUnicodeText(string text)
    {
        Exception? failure = null;
        var worker = new Thread(() =>
        {
            System.Windows.IDataObject? previous = null;
            var replacementSequence = 0u;
            var replacementInstalled = false;
            try
            {
                previous = RetryClipboard(() => System.Windows.Clipboard.GetDataObject());
                RetryClipboard(() => System.Windows.Clipboard.SetText(text, System.Windows.TextDataFormat.UnicodeText));
                replacementSequence = GetClipboardSequenceNumber();
                replacementInstalled = true;
                PressKey("CTRL+V");
                // SendInput only queues the key chord. Keep the replacement on
                // the clipboard until the foreground control has consumed it.
                Thread.Sleep(150);
            }
            catch (Exception ex)
            {
                failure = ex;
            }
            finally
            {
                try
                {
                    // Do not overwrite a clipboard value that another actor
                    // deliberately installed while the paste was in flight.
                    if (replacementInstalled && GetClipboardSequenceNumber() == replacementSequence)
                    {
                        if (previous is null)
                        {
                            RetryClipboard(System.Windows.Clipboard.Clear);
                        }
                        else
                        {
                            RetryClipboard(() => System.Windows.Clipboard.SetDataObject(previous, true));
                        }
                    }
                }
                catch (Exception ex)
                {
                    failure ??= ex;
                }
            }
        })
        {
            IsBackground = true,
            Name = "DeskPilot clipboard paste"
        };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
        if (!worker.Join(TimeSpan.FromSeconds(10)))
        {
            throw new TimeoutException("The Unicode clipboard paste did not complete within 10 seconds.");
        }
        if (failure is not null)
        {
            throw new InvalidOperationException("Unicode clipboard paste failed.", failure);
        }
    }

    private static T RetryClipboard<T>(Func<T> action)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return action();
            }
            catch (Exception ex) when (attempt < 7 && ex is COMException or ExternalException)
            {
                Thread.Sleep(25 * (attempt + 1));
            }
        }
    }

    private static void RetryClipboard(Action action)
    {
        _ = RetryClipboard(() =>
        {
            action();
            return true;
        });
    }

    internal static void PressKey(string chord)
    {
        var keys = ParseKeyChord(chord);
        var inputs = new List<Input>(keys.Length * 2);
        foreach (var key in keys)
        {
            inputs.Add(VirtualKey(key, false));
        }
        for (var i = keys.Length - 1; i >= 0; i--)
        {
            inputs.Add(VirtualKey(keys[i], true));
        }
        Send(inputs);
    }

    internal static ushort[] ParseKeyChord(string chord)
    {
        if (string.IsNullOrWhiteSpace(chord))
        {
            throw new ArgumentException("A key is required.", nameof(chord));
        }

        // Keep empty entries so malformed chords such as "CTRL+", "+A", or
        // "CTRL++A" cannot silently turn into a different key sequence.
        var parts = chord.Split('+', StringSplitOptions.TrimEntries);
        if (parts.Length == 0 || parts.Any(string.IsNullOrWhiteSpace))
        {
            throw new ArgumentException("A key chord may not contain an empty key.", nameof(chord));
        }

        return parts.Select(ParseVirtualKey).ToArray();
    }

    internal static ushort ParseVirtualKey(string value)
    {
        var key = value.Trim();
        if (key.Length == 1)
        {
            var scan = VkKeyScan(key[0]);
            if (scan != -1)
            {
                return (ushort)(scan & 0xff);
            }
        }

        var normalized = key.Replace("-", string.Empty, StringComparison.Ordinal).Replace("_", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        return normalized switch
        {
            "CTRL" or "CONTROL" or "CONTROLLEFT" or "CONTROLRIGHT" or "CTRLLEFT" or "CTRLRIGHT" => 0x11,
            "SHIFT" or "SHIFTLEFT" or "SHIFTRIGHT" => 0x10,
            "ALT" or "MENU" or "ALTT" or "ALTLEFT" or "ALTRIGHT" => 0x12,
            "WIN" or "WINDOWS" or "META" or "SUPER" => 0x5b,
            "ENTER" or "RETURN" => 0x0d,
            "TAB" => 0x09,
            "ESC" or "ESCAPE" => 0x1b,
            "BACKSPACE" or "BACK" => 0x08,
            "SPACE" => 0x20,
            "LEFT" or "ARROWLEFT" => 0x25,
            "UP" or "ARROWUP" => 0x26,
            "RIGHT" or "ARROWRIGHT" => 0x27,
            "DOWN" or "ARROWDOWN" => 0x28,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" or "PGUP" => 0x21,
            "PAGEDOWN" or "PGDN" => 0x22,
            "DELETE" or "DEL" => 0x2e,
            "INSERT" or "INS" => 0x2d,
            "F1" => 0x70,
            "F2" => 0x71,
            "F3" => 0x72,
            "F4" => 0x73,
            "F5" => 0x74,
            "F6" => 0x75,
            "F7" => 0x76,
            "F8" => 0x77,
            "F9" => 0x78,
            "F10" => 0x79,
            "F11" => 0x7a,
            "F12" => 0x7b,
            _ when normalized.StartsWith("0X", StringComparison.Ordinal) && ushort.TryParse(normalized[2..], System.Globalization.NumberStyles.HexNumber, null, out var hex) => hex,
            _ => throw new ArgumentException($"Unsupported key '{value}'.", nameof(value))
        };
    }

    internal static CaptureResult CaptureWindow(IntPtr hWnd, string? requestedPath = null, bool preferForegroundScreenCopy = false)
    {
        if (!TryGetWindowRect(hWnd, out var rect) || rect.Width <= 0 || rect.Height <= 0)
        {
            throw new AgentException("WINDOW_CAPTURE_UNAVAILABLE", "The target window has no captureable bounds.", true);
        }

        var targetProcessId = GetProcessId(hWnd);
        var targetClassName = GetClassNameValue(hWnd);
        var targetVisible = IsWindowVisibleNative(hWnd);
        var relationship = GetForegroundRelationship(hWnd);
        if (!targetVisible)
        {
            throw new AgentException("WINDOW_CAPTURE_UNTRUSTED", "The target window is not visible; on-screen pixels cannot be attributed to it.", true,
                CaptureDetails(hWnd, rect, relationship, 0, 0, Array.Empty<object>()));
        }

        var directory = Path.Combine(Path.GetTempPath(), "win-agent");
        Directory.CreateDirectory(directory);
        var path = string.IsNullOrWhiteSpace(requestedPath)
            ? Path.Combine(directory, $"capture-{DateTime.UtcNow:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}.png")
            : Path.GetFullPath(requestedPath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        using var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
        var captured = false;
        var captureLayer = "gdi_capture";
        var blankPrintWindow = false;
        var sampleCount = 0;
        var relatedSampleCount = 0;
        object[] unrelatedSamples = Array.Empty<object>();
        using (var graphics = Graphics.FromImage(bitmap))
        {
            if (preferForegroundScreenCopy && relationship.Related)
            {
                (sampleCount, relatedSampleCount, unrelatedSamples) = InspectScreenOwnership(hWnd, rect);
                if (unrelatedSamples.Length > 0 || relatedSampleCount != sampleCount)
                {
                    throw new AgentException("WINDOW_CAPTURE_UNTRUSTED", "Unrelated windows cover sampled pixels inside the requested target.", true,
                        CaptureDetails(hWnd, rect, relationship, sampleCount, relatedSampleCount, unrelatedSamples));
                }
                graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.Width, rect.Height), CopyPixelOperation.SourceCopy);
                captured = true;
                captureLayer = "screen_copy_foreground_verified";
            }
            else
            {
                var dc = graphics.GetHdc();
                try
                {
                    captured = PrintWindow(hWnd, dc, PW_RENDERFULLCONTENT);
                }
                finally
                {
                    graphics.ReleaseHdc(dc);
                }

                blankPrintWindow = captured && LooksUniform(bitmap);
                if (!captured)
                {
                    throw new AgentException("WINDOW_CAPTURE_FAILED", "PrintWindow did not capture the requested window.", true,
                        CaptureDetails(hWnd, rect, relationship, 0, 0, Array.Empty<object>()));
                }
                if (blankPrintWindow && relationship.Related)
                {
                    (sampleCount, relatedSampleCount, unrelatedSamples) = InspectScreenOwnership(hWnd, rect);
                    if (unrelatedSamples.Length > 0 || relatedSampleCount != sampleCount)
                    {
                        throw new AgentException("WINDOW_CAPTURE_UNTRUSTED", "PrintWindow was blank and unrelated windows cover the on-screen fallback.", true,
                            CaptureDetails(hWnd, rect, relationship, sampleCount, relatedSampleCount, unrelatedSamples));
                    }
                    graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.Width, rect.Height), CopyPixelOperation.SourceCopy);
                    captureLayer = "screen_copy_after_blank_printwindow_verified";
                }
                else if (blankPrintWindow)
                {
                    throw new AgentException("WINDOW_CAPTURE_EMPTY", "PrintWindow returned an empty-looking frame while the target was not foreground.", true,
                        CaptureDetails(hWnd, rect, relationship, 0, 0, Array.Empty<object>()));
                }
            }
        }

        var afterRelationship = GetForegroundRelationship(hWnd);
        if (!IsWindow(hWnd) || GetProcessId(hWnd) != targetProcessId ||
            !string.Equals(GetClassNameValue(hWnd), targetClassName, StringComparison.Ordinal) ||
            !TryGetWindowRect(hWnd, out var afterRect) || !RectsEqual(rect, afterRect) ||
            (captureLayer.StartsWith("screen_copy", StringComparison.Ordinal) && !afterRelationship.Related))
        {
            throw new AgentException("WINDOW_IDENTITY_MISMATCH", "The target window identity or foreground relationship changed during capture.", true,
                CaptureDetails(hWnd, rect, afterRelationship, sampleCount, relatedSampleCount, unrelatedSamples));
        }

        bitmap.Save(path, ImageFormat.Png);
        return new CaptureResult(path, captureLayer, blankPrintWindow, true, relationship.Kind, relationship.ForegroundHandle.ToInt64(),
            relationship.ForegroundProcessId, sampleCount, relatedSampleCount);
    }

    private static (int SampleCount, int RelatedSampleCount, object[] UnrelatedSamples) InspectScreenOwnership(IntPtr target, Rect rect)
    {
        var targetProcessId = GetProcessId(target);
        var unrelated = new List<object>();
        var related = 0;
        var sampleCount = 0;
        var xFractions = new[] { 0.08, 0.5, 0.92 };
        var yFractions = new[] { 0.08, 0.5, 0.92 };
        foreach (var yFraction in yFractions)
        {
            foreach (var xFraction in xFractions)
            {
                var x = rect.Left + Math.Clamp((int)Math.Round((rect.Width - 1) * xFraction), 0, rect.Width - 1);
                var y = rect.Top + Math.Clamp((int)Math.Round((rect.Height - 1) * yFraction), 0, rect.Height - 1);
                sampleCount++;
                var hit = WindowFromPoint(new Point { X = x, Y = y });
                var root = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, GA_ROOT);
                if (root == IntPtr.Zero) root = hit;
                var processId = GetProcessId(root);
                // DeskPilot's non-activating overlay is in this process and is
                // excluded from capture. Treat it as transparent for ownership.
                if (root == target || processId == targetProcessId || processId == (uint)Environment.ProcessId)
                {
                    related++;
                    continue;
                }
                unrelated.Add(new
                {
                    x,
                    y,
                    handle = root.ToInt64(),
                    process_id = processId,
                    process_name = GetProcessName(root),
                    title = GetWindowTitle(root),
                    class_name = GetClassNameValue(root)
                });
            }
        }
        return (sampleCount, related, unrelated.ToArray());
    }

    private static object CaptureDetails(IntPtr target, Rect rect, ForegroundRelationship relationship, int sampleCount, int relatedSampleCount, object[] unrelatedSamples)
        => new
        {
            target_handle = target.ToInt64(),
            target_process_id = GetProcessId(target),
            target_process_name = GetProcessName(target),
            target_class_name = GetClassNameValue(target),
            target_visible = IsWindowVisibleNative(target),
            target_bounds = new { x = rect.Left, y = rect.Top, width = rect.Width, height = rect.Height },
            foreground_handle = relationship.ForegroundHandle.ToInt64(),
            foreground_process_id = relationship.ForegroundProcessId,
            foreground_relation = relationship.Kind,
            sample_count = sampleCount,
            related_sample_count = relatedSampleCount,
            unrelated_samples = unrelatedSamples
        };

    private static bool RectsEqual(Rect left, Rect right)
        => left.Left == right.Left && left.Top == right.Top && left.Right == right.Right && left.Bottom == right.Bottom;

    private static bool LooksUniform(Bitmap bitmap)
    {
        if (bitmap.Width < 8 || bitmap.Height < 8) return false;

        var first = bitmap.GetPixel(0, 0);
        var maxDelta = 0;
        for (var y = 0; y < 8; y++)
        {
            var sampleY = y * (bitmap.Height - 1) / 7;
            for (var x = 0; x < 8; x++)
            {
                var sampleX = x * (bitmap.Width - 1) / 7;
                var pixel = bitmap.GetPixel(sampleX, sampleY);
                maxDelta = Math.Max(maxDelta, Math.Abs(pixel.R - first.R));
                maxDelta = Math.Max(maxDelta, Math.Abs(pixel.G - first.G));
                maxDelta = Math.Max(maxDelta, Math.Abs(pixel.B - first.B));
                maxDelta = Math.Max(maxDelta, Math.Abs(pixel.A - first.A));
                if (maxDelta > 2) return false;
            }
        }

        return true;
    }

    internal sealed record ForegroundRelationship(bool Related, string Kind, IntPtr ForegroundHandle, uint ForegroundProcessId);

    internal sealed record CaptureResult(
        string Path,
        string Layer,
        bool BlankPrintWindow,
        bool Trusted,
        string ForegroundRelation,
        long ForegroundHandle,
        uint ForegroundProcessId,
        int OwnershipSampleCount,
        int RelatedOwnershipSampleCount);

    private static Input Mouse(uint flags, uint data = 0)
    {
        return new Input
        {
            Type = 0,
            Data = new InputUnion
            {
                Mouse = new MouseInput { Flags = flags, MouseData = data }
            }
        };
    }

    private static Input UnicodeKey(char character, bool keyUp)
    {
        return new Input
        {
            Type = 1,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    Scan = character,
                    Flags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0)
                }
            }
        };
    }

    private static Input VirtualKey(ushort key, bool keyUp)
    {
        return new Input
        {
            Type = 1,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    Vk = key,
                    Scan = (ushort)MapVirtualKey(key, 0),
                    Flags = keyUp ? KEYEVENTF_KEYUP : 0
                }
            }
        };
    }

    private static void Send(IReadOnlyList<Input> inputs)
    {
        if (inputs.Count == 0)
        {
            return;
        }

        var native = inputs.ToArray();
        var sent = SendInput((uint)native.Length, native, Marshal.SizeOf<Input>());
        if (sent != native.Length)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"SendInput sent {sent} of {native.Length} events.");
        }
    }
}
