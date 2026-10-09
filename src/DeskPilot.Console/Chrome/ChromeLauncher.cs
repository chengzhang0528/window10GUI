using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using DeskPilot.Console.Settings;

namespace DeskPilot.Console.Chrome;

public sealed class ChromeLauncher
{
    private readonly AppSettings _settings;
    private Process? _chromeProcess;

    public ChromeLauncher(AppSettings settings)
    {
        _settings = settings;
    }

    public bool IsRunning => _chromeProcess is { HasExited: false };

    public int DebugPort => _settings.ChromeDebugPort;

    public string? ChromeWindowTitle { get; private set; }

    public async Task LaunchAsync(CancellationToken cancellationToken = default)
    {
        if (IsRunning)
            return;

        // 如果端口已在监听，说明已有调试实例，直接复用
        if (await IsDebugPortListeningAsync(cancellationToken).ConfigureAwait(false))
        {
            ChromeWindowTitle = "Chrome (已连接)";
            return;
        }

        var chromePath = ResolveChromePath();
        if (chromePath == null)
            throw new InvalidOperationException("未找到 Chrome 浏览器，请在设置中指定 Chrome 路径。");

        // 使用独立的 user-data-dir，不影响用户日常 Chrome
        var userDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DeskPilot", "ChromeProfile");
        Directory.CreateDirectory(userDir);

        var args = $"--remote-debugging-port={_settings.ChromeDebugPort} --user-data-dir=\"{userDir}\" --no-first-run --no-default-browser-check";

        _chromeProcess = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = chromePath,
                Arguments = args,
                UseShellExecute = false
            }
        };
        if (!_chromeProcess.Start())
            throw new InvalidOperationException("Chrome 进程启动失败。");

        // 首次创建独立 profile 可能较慢，最多等待 15 秒。
        var startupTimer = Stopwatch.StartNew();
        while (startupTimer.Elapsed < TimeSpan.FromSeconds(15))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await IsDebugPortListeningAsync(cancellationToken).ConfigureAwait(false))
            {
                ChromeWindowTitle = "Chrome (DeskPilot)";
                return;
            }

            var remaining = TimeSpan.FromSeconds(15) - startupTimer.Elapsed;
            if (remaining > TimeSpan.Zero)
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(500, remaining.TotalMilliseconds)), cancellationToken)
                    .ConfigureAwait(false);
        }

        throw new InvalidOperationException($"Chrome 调试端口 {_settings.ChromeDebugPort} 在 15 秒内未就绪。");
    }

    public void Stop()
    {
        if (_chromeProcess is { HasExited: false })
        {
            try { _chromeProcess.Kill(entireProcessTree: true); }
            catch { /* best-effort */ }
            _chromeProcess.Dispose();
            _chromeProcess = null;
        }
    }

    private string? ResolveChromePath()
    {
        if (!string.IsNullOrEmpty(_settings.ChromePath) && File.Exists(_settings.ChromePath))
            return _settings.ChromePath;

        var candidates = new[]
        {
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Google", "Chrome", "Application", "chrome.exe")
        };

        return candidates.FirstOrDefault(File.Exists);
    }

    private async Task<bool> IsDebugPortListeningAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync("127.0.0.1", _settings.ChromeDebugPort, cancellationToken)
                .AsTask()
                .WaitAsync(TimeSpan.FromSeconds(1), cancellationToken)
                .ConfigureAwait(false);
            return client.Connected;
        }
        catch (Exception ex) when (ex is SocketException or TimeoutException)
        {
            return false;
        }
    }
}
