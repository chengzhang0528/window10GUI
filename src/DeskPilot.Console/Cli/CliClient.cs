using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using DeskPilot.Console.Session;
using DeskPilot.Console.Settings;

namespace DeskPilot.Console.Cli;

public sealed class CliClient : IDisposable
{
    private readonly AppSettings _settings;
    private readonly SessionRecorder _sessionRecorder;
    private Process? _process;
    private StreamWriter? _stdin;
    private StreamReader? _stdout;
    private readonly SemaphoreSlim _requestGate = new(1, 1);
    private readonly object _lifecycleLock = new();
    private readonly object _stderrLock = new();
    private readonly Queue<string> _stderrTail = new();
    private int _requestId;
    private bool _disposed;

    public CliClient(AppSettings settings, SessionRecorder sessionRecorder)
    {
        _settings = settings;
        _sessionRecorder = sessionRecorder;
    }

    public bool IsConnected => _process is { HasExited: false };

    public void Connect()
    {
        lock (_lifecycleLock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (IsConnected)
                return;

            var cliPath = ResolveCliPath(_settings);
            if (cliPath == null)
                throw new InvalidOperationException("未找到 win-agent.exe，请在设置中指定 CLI 路径。");

            lock (_stderrLock)
                _stderrTail.Clear();

            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = cliPath,
                    Arguments = "exec --stdin --format ndjson",
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                },
                EnableRaisingEvents = true
            };
            process.ErrorDataReceived += OnErrorDataReceived;
            try
            {
                if (!process.Start())
                    throw new InvalidOperationException("win-agent.exe 进程启动失败。");

                _process = process;
                _stdin = process.StandardInput;
                _stdout = process.StandardOutput;
                process.BeginErrorReadLine();
            }
            catch
            {
                process.ErrorDataReceived -= OnErrorDataReceived;
                process.Dispose();
                throw;
            }
        }
    }

    public async Task<JsonElement> SendAsync(
        string method,
        JsonElement? params_ = null,
        CancellationToken ct = default,
        string source = "system",
        bool redactParameters = false)
    {
        await _requestGate.WaitAsync(ct).ConfigureAwait(false);
        var timer = Stopwatch.StartNew();
        var recordedParameters = redactParameters && params_ != null
            ? new { redacted = true }
            : (object?)params_;
        _sessionRecorder.Record("cli.request", source, "started", method, method, recordedParameters);
        try
        {
            EnsureConnected();

            var id = Interlocked.Increment(ref _requestId).ToString();
            var request = new Dictionary<string, object>
            {
                ["id"] = id,
                ["method"] = method
            };
            if (params_ != null)
                request["params"] = params_.Value.Deserialize<Dictionary<string, JsonElement>>()!;

            var json = JsonSerializer.Serialize(request);
            await _stdin!.WriteLineAsync(json.AsMemory(), ct).ConfigureAwait(false);
            await _stdin.FlushAsync(ct).ConfigureAwait(false);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromMinutes(2));

            string? line;
            try
            {
                line = await _stdout!.ReadLineAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                var stderr = FormatStderrTail();
                ResetConnection();
                throw new TimeoutException($"CLI 请求 {method} 在 2 分钟内未返回。{stderr}");
            }

            if (line == null)
            {
                var stderr = FormatStderrTail();
                ResetConnection();
                throw new InvalidOperationException($"CLI 会话已断开。{stderr}");
            }

            var response = JsonSerializer.Deserialize<JsonElement>(line);
            _sessionRecorder.Record("cli.response", source, "success", method, method, recordedParameters, response, timer.ElapsedMilliseconds);
            return response;
        }
        catch (Exception ex)
        {
            _sessionRecorder.Record("cli.response", source, "error", ex.Message, method, recordedParameters, null, timer.ElapsedMilliseconds);
            throw;
        }
        finally
        {
            _requestGate.Release();
        }
    }

    public async Task<JsonElement> SendBatchAsync(
        JsonElement steps,
        int timeoutMs = 60000,
        CancellationToken ct = default,
        string source = "system")
    {
        var params_ = JsonSerializer.SerializeToElement(new Dictionary<string, object>
        {
            ["timeout_ms"] = timeoutMs,
            ["show_overlay"] = true,
            ["restore_original_window"] = true,
            ["steps"] = steps.Deserialize<JsonElement>()
        });
        return await SendAsync("actions.batch", params_, ct, source).ConfigureAwait(false);
    }

    public void Dispose()
    {
        lock (_lifecycleLock)
        {
            if (_disposed)
                return;
            _disposed = true;
            DisconnectCore();
        }
    }

    private void EnsureConnected()
    {
        if (!IsConnected)
            Connect();
    }

    public static string? ResolveCliPath(AppSettings settings)
    {
        if (!string.IsNullOrWhiteSpace(settings.CliPath) && File.Exists(settings.CliPath))
            return Path.GetFullPath(settings.CliPath);

        var directCandidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "win-agent.exe"),
            Path.Combine(Environment.CurrentDirectory, "win-agent.exe")
        };
        var directMatch = directCandidates.FirstOrDefault(File.Exists);
        if (directMatch != null)
            return directMatch;

        foreach (var startDirectory in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            var repoRoot = FindRepoRoot(startDirectory);
            if (repoRoot == null)
                continue;

            var candidates = new[]
            {
                Path.Combine(repoRoot, "src", "WindowsAgent.Cli", "bin", "Release",
                    "net10.0-windows10.0.19041.0", "win-x64", "win-agent.exe"),
                Path.Combine(repoRoot, "src", "WindowsAgent.Cli", "bin", "Debug",
                    "net10.0-windows10.0.19041.0", "win-x64", "win-agent.exe"),
                Path.Combine(repoRoot, "artifacts", "win-agent", "win-agent.exe")
            };
            var match = candidates.FirstOrDefault(File.Exists);
            if (match != null)
                return match;
        }

        return null;
    }

    private static string? FindRepoRoot(string startDirectory)
    {
        var dir = new DirectoryInfo(startDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, ".git")) ||
                File.Exists(Path.Combine(dir.FullName, "AGENTS.md")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private void OnErrorDataReceived(object sender, DataReceivedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(e.Data))
            return;

        lock (_stderrLock)
        {
            _stderrTail.Enqueue(e.Data);
            while (_stderrTail.Count > 20)
                _stderrTail.Dequeue();
        }
    }

    private string FormatStderrTail()
    {
        lock (_stderrLock)
        {
            return _stderrTail.Count == 0
                ? string.Empty
                : $" CLI stderr: {string.Join(" | ", _stderrTail)}";
        }
    }

    private void ResetConnection()
    {
        lock (_lifecycleLock)
            DisconnectCore();
    }

    private void DisconnectCore()
    {
        try { _stdin?.Dispose(); } catch { }
        try { _stdout?.Dispose(); } catch { }
        _stdin = null;
        _stdout = null;

        if (_process == null)
            return;

        if (!_process.HasExited)
        {
            try { _process.Kill(entireProcessTree: true); } catch { }
        }
        _process.ErrorDataReceived -= OnErrorDataReceived;
        _process.Dispose();
        _process = null;
    }
}
