using System.Diagnostics;
using System.Collections.Concurrent;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace WindowsAgent;

internal static class Program
{
    private const int MaxRequestBytes = 8 * 1024 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    [STAThread]
    private static int Main(string[] args)
    {
        var utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        // Pipes carry the machine-readable protocol as UTF-8. A Windows
        // console or pseudoconsole, however, already exposes its active code
        // page through Console.InputEncoding/OutputEncoding. Overriding that
        // encoding corrupts non-ASCII labels before JSON parsing (for example,
        // Chinese activity text becomes U+FFFD when driven through a PTY).
        if (Console.IsInputRedirected)
        {
            Console.InputEncoding = utf8NoBom;
        }
        if (Console.IsOutputRedirected)
        {
            Console.OutputEncoding = utf8NoBom;
        }
        NativeMethods.EnablePerMonitorDpiAwareness();

        try
        {
            if (args.Length > 0 && string.Equals(args[0], "--host", StringComparison.OrdinalIgnoreCase))
            {
                return RunHost(args);
            }

            if (args.Length > 0 && string.Equals(args[0], "exec", StringComparison.OrdinalIgnoreCase))
            {
                return RunExec(args[1..]);
            }

            var request = CliCommandParser.ToRequest(args);
            using var client = new HostClient();
            var response = client.Send(request);
            return WriteResponse(response, streamMode: false);
        }
        catch (Exception ex)
        {
            // The one-shot CLI is still a machine-readable Agent entrypoint.
            // Keep failures on stdout just like successful responses and the
            // NDJSON stream; stderr remains reserved for human diagnostics.
            var error = Envelope.Failure("local_cli_error", ex.Message, false, Guid.NewGuid().ToString("N"));
            Console.WriteLine(JsonSerializer.Serialize(error, JsonOptions));
            return 1;
        }
    }

    private static int RunHost(string[] args)
    {
        var parentPid = 0;
        for (var i = 1; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "--parent-pid", StringComparison.OrdinalIgnoreCase) && int.TryParse(args[i + 1], out var parsed))
            {
                parentPid = parsed;
                break;
            }
        }

        var engine = new AutomationEngine();
        if (parentPid > 0)
        {
            _ = Task.Run(() => WatchParent(parentPid, engine));
        }

        try
        {
            var pending = new List<Task>();
            var normalTail = Task.CompletedTask;
            var outputGate = new object();
            void WriteHostResponse(Envelope value)
            {
                lock (outputGate)
                {
                    Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
                    Console.Out.Flush();
                }
            }
            while (true)
            {
                var line = Console.ReadLine();
                if (line is null)
                {
                    break;
                }
                // Windows PowerShell 5.1 may prepend a UTF-8 BOM to the first
                // redirected line. Accept it so NDJSON remains shell-friendly.
                line = line.TrimStart('\uFEFF');
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }
                Envelope response;
                if (Encoding.UTF8.GetByteCount(line) > MaxRequestBytes)
                {
                    var oversizedId = TryReadId(line) ?? Guid.NewGuid().ToString("N");
                    response = Envelope.FromException(oversizedId, new AgentException("REQUEST_TOO_LARGE", "Request exceeds the 8 MiB limit.", false));
                    WriteHostResponse(response);
                    if (IsCloseRequest(line)) break;
                    continue;
                }

                var shouldClose = IsCloseRequest(line);
                try
                {
                    using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 64 });
                    var root = document.RootElement;
                    if (root.ValueKind != JsonValueKind.Object)
                    {
                        throw new AgentException("INVALID_REQUEST", "Request must be a JSON object.", false);
                    }
                    var id = root.TryGetProperty("id", out var idElement)
                        ? idElement.ValueKind is JsonValueKind.String or JsonValueKind.Number ? idElement.ToString() : throw new AgentException("INVALID_REQUEST", "id must be a string or number.", false)
                        : Guid.NewGuid().ToString("N");
                    var methodElement = root.TryGetProperty("method", out var namedMethod)
                        ? namedMethod
                        : root.TryGetProperty("op", out var opMethod) ? opMethod : default;
                    if (methodElement.ValueKind is not (JsonValueKind.String or JsonValueKind.Undefined))
                    {
                        throw new AgentException("INVALID_REQUEST", "method must be a string.", false);
                    }
                    var method = methodElement.ValueKind == JsonValueKind.String ? methodElement.GetString() : null;
                    if (string.IsNullOrWhiteSpace(method))
                    {
                        throw new AgentException("INVALID_REQUEST", "Request must contain method.", false);
                    }
                    var parameters = root.TryGetProperty("params", out var paramsElement)
                        ? paramsElement
                        : root.TryGetProperty("parameters", out var parametersElement)
                            ? parametersElement
                            : EmptyObject();
                    parameters = parameters.Clone();
                    if (string.Equals(method, "interaction.cancel", StringComparison.Ordinal))
                    {
                        // This path intentionally runs outside the normal
                        // engine lock so it can interrupt a long-running
                        // batch or Chrome wait.
                        response = Envelope.Success(id, engine.RequestCancellation(parameters));
                        WriteHostResponse(response);
                        continue;
                    }

                    var requestId = id;
                    var requestMethod = method!;
                    var requestParameters = parameters;
                    // Preserve request order for normal commands. The engine
                    // lifecycle lock provides mutual exclusion, but separately
                    // scheduled tasks can otherwise acquire it out of order;
                    // an immediate follow-up could then run before the prior
                    // interaction.end and observe the wrong lease.
                    engine.ReserveCommand();
                    var task = normalTail.ContinueWith(_ =>
                    {
                        Envelope completed;
                        try
                        {
                            completed = Envelope.Success(requestId, engine.ExecuteReserved(requestMethod, requestParameters));
                        }
                        catch (Exception ex)
                        {
                            completed = Envelope.FromException(requestId, ex);
                        }

                        WriteHostResponse(completed);
                    }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
                    normalTail = task;
                    pending.Add(task);
                    if (shouldClose) break;
                    continue;
                }
                catch (Exception ex)
                {
                    var id = TryReadId(line) ?? Guid.NewGuid().ToString("N");
                    response = Envelope.FromException(id, ex);
                }

                WriteHostResponse(response);
                if (shouldClose) break;
            }

            try { Task.WaitAll(pending.ToArray()); } catch { }
        }
        finally
        {
            engine.Shutdown();
        }
        return 0;
    }

    private static int RunExec(string[] args)
    {
        if (!args.Any(arg => string.Equals(arg, "--stdin", StringComparison.OrdinalIgnoreCase)))
        {
            Console.Error.WriteLine("Usage: win-agent exec --stdin [--format ndjson]");
            return 2;
        }

        using var client = new HostClient();
        var pending = new List<Task>();
        var normalTail = Task.CompletedTask;
        var outputGate = new object();
        while (true)
        {
            var line = Console.ReadLine();
            if (line is null) break;
            line = line.TrimStart('\uFEFF');
            if (string.IsNullOrWhiteSpace(line)) continue;

            var requestLine = line;
            var send = new Action(() =>
            {
                Envelope response;
                try
                {
                    response = client.SendRaw(requestLine);
                }
                catch (Exception ex)
                {
                    response = Envelope.Failure("local_cli_error", ex.Message, true, TryReadId(requestLine) ?? Guid.NewGuid().ToString("N"));
                }
                lock (outputGate)
                {
                    Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
                    Console.Out.Flush();
                }
            });
            // Keep normal requests in stdin order while allowing cancellation
            // to bypass this chain and reach the host immediately.
            var task = Program.IsRequestMethod(requestLine, "interaction.cancel")
                ? Task.Run(send)
                : normalTail.ContinueWith(_ => send(), CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
            if (!Program.IsRequestMethod(requestLine, "interaction.cancel"))
            {
                normalTail = task;
            }
            pending.Add(task);
            if (IsCloseRequest(line)) break;
        }
        try { Task.WaitAll(pending.ToArray()); } catch { }
        return 0;
    }

    private static int WriteResponse(Envelope response, bool streamMode)
    {
        var json = JsonSerializer.Serialize(response, JsonOptions);
        // Both success and failure envelopes are part of the stdout protocol.
        // Agents must not need to merge stdout/stderr to parse a one-shot
        // response.
        Console.WriteLine(json);
        return response.Ok ? 0 : 1;
    }

    private static void WatchParent(int parentPid, AutomationEngine engine)
    {
        try
        {
            using var parent = Process.GetProcessById(parentPid);
            parent.WaitForExit();
        }
        catch
        {
            // A missing parent is already a terminal condition; continue to
            // the same cleanup/final exit path below.
        }
        finally
        {
            try { engine.Shutdown(); } catch { }
            Environment.Exit(0);
        }
    }

    private static JsonElement EmptyObject()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    internal static string? TryReadId(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 64 });
            return document.RootElement.TryGetProperty("id", out var value) ? value.ToString() : null;
        }
        catch
        {
            return null;
        }
    }

    internal static (string Id, string Json) NormalizeRequest(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 64 });
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException("Request must be a JSON object.");
            }

            if (document.RootElement.TryGetProperty("id", out var idElement) &&
                idElement.ValueKind is JsonValueKind.String or JsonValueKind.Number &&
                !string.IsNullOrWhiteSpace(idElement.ToString()))
            {
                return (idElement.ToString(), line);
            }

            var node = JsonNode.Parse(line) as JsonObject ?? throw new InvalidOperationException("Request must be a JSON object.");
            var id = Guid.NewGuid().ToString("N");
            node["id"] = id;
            return (id, node.ToJsonString(JsonOptions));
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"Request is not valid JSON: {ex.Message}");
        }
    }

    private static bool IsCloseRequest(string line)
    {
        return IsRequestMethod(line, "close");
    }

    internal static bool IsRequestMethod(string line, string expectedMethod)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var method = root.TryGetProperty("method", out var methodElement)
                ? methodElement.GetString()
                : root.TryGetProperty("op", out var opElement) ? opElement.GetString() : null;
            return string.Equals(method, expectedMethod, StringComparison.Ordinal);
        }
        catch { return false; }
    }

    internal static JsonSerializerOptions Options => JsonOptions;
}

internal sealed class HostClient : IDisposable
{
    private static readonly TimeSpan ResponseTimeout = TimeSpan.FromSeconds(130);
    private const int MaxResponseBytes = 64 * 1024 * 1024;
    private readonly Process _process;
    private readonly object _writeGate = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<Envelope>> _pending = new(StringComparer.Ordinal);
    private readonly Task _responseReader;
    private volatile bool _disposed;
    private volatile bool _dead;

    internal HostClient()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = Environment.ProcessPath ?? throw new InvalidOperationException("Unable to locate the current executable."),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            StandardOutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            StandardErrorEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)
        };

        if (Path.GetFileNameWithoutExtension(startInfo.FileName).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
        {
            startInfo.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
        }
        startInfo.ArgumentList.Add("--host");
        startInfo.ArgumentList.Add("--parent-pid");
        startInfo.ArgumentList.Add(Environment.ProcessId.ToString());

        _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!_process.Start())
        {
            throw new InvalidOperationException("Unable to start the Windows Agent host.");
        }
        _ = DrainStderrAsync(_process.StandardError);
        _responseReader = Task.Run(ReadResponsesAsync);
    }

    internal Envelope Send(Request request)
    {
        var json = JsonSerializer.Serialize(request, Program.Options);
        return SendRaw(json);
    }

    internal Envelope SendRaw(string json)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(HostClient));
        if (_dead) throw new InvalidOperationException("Windows Agent host is no longer available; start a new exec session.");
        var normalized = Program.NormalizeRequest(json);
        var requestId = normalized.Id;
        var completion = new TaskCompletionSource<Envelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(requestId, completion))
        {
            throw new InvalidOperationException($"Duplicate request id '{requestId}'.");
        }
        try
        {
            lock (_writeGate)
            {
                _process.StandardInput.WriteLine(normalized.Json);
                _process.StandardInput.Flush();
            }
        }
        catch (Exception ex)
        {
            _pending.TryRemove(requestId, out _);
            _dead = true;
            TryKill();
            throw new InvalidOperationException($"Unable to write to Windows Agent host: {ex.Message}", ex);
        }
        try
        {
            return completion.Task.WaitAsync(ResponseTimeout).GetAwaiter().GetResult();
        }
        catch (TimeoutException)
        {
            _pending.TryRemove(requestId, out _);
            _dead = true;
            TryKill();
            throw new TimeoutException("Windows Agent host did not respond within 130 seconds.");
        }
        catch (Exception)
        {
            _pending.TryRemove(requestId, out _);
            throw;
        }
    }

    internal bool IsDead => _dead;

    public void Dispose()
    {
        if (_disposed) return;
        try
        {
            if (!_dead && !_process.HasExited)
            {
                try
                {
                    _ = SendRaw("{\"id\":\"close\",\"method\":\"close\",\"params\":{}}" );
                }
                catch { }
                if (!_process.HasExited)
                {
                    TryKill();
                }
            }
        }
        catch { }
        finally
        {
            _disposed = true;
            _dead = true;
            foreach (var entry in _pending.ToArray())
            {
                if (_pending.TryRemove(entry.Key, out var completion))
                {
                    completion.TrySetException(new InvalidOperationException("Windows Agent host was closed."));
                }
            }
            try { _responseReader.Wait(1000); } catch { }
            _process.Dispose();
        }
    }

    private async Task ReadResponsesAsync()
    {
        Exception? failure = null;
        try
        {
            while (true)
            {
                var line = await _process.StandardOutput.ReadLineAsync().ConfigureAwait(false);
                if (line is null) break;
                if (Encoding.UTF8.GetByteCount(line) > MaxResponseBytes)
                {
                    failure = new InvalidOperationException("Windows Agent host response exceeds the 64 MiB limit.");
                    break;
                }

                Envelope? response;
                try
                {
                    response = JsonSerializer.Deserialize<Envelope>(line, Program.Options);
                }
                catch (JsonException ex)
                {
                    failure = new InvalidOperationException($"Windows Agent host returned invalid JSON: {ex.Message}");
                    break;
                }
                if (response?.RequestId is null || !_pending.TryRemove(response.RequestId, out var completion)) continue;
                completion.TrySetResult(response);
            }
        }
        catch (Exception ex)
        {
            failure = ex;
        }

        _dead = true;
        failure ??= new InvalidOperationException("Windows Agent host exited without a response.");
        foreach (var entry in _pending.ToArray())
        {
            if (_pending.TryRemove(entry.Key, out var completion)) completion.TrySetException(failure);
        }
    }

    private void TryKill()
    {
        try
        {
            if (!_process.HasExited) _process.Kill(entireProcessTree: true);
        }
        catch { }
    }

    private static async Task DrainStderrAsync(StreamReader reader)
    {
        try
        {
            while (await reader.ReadLineAsync().ConfigureAwait(false) is not null) { }
        }
        catch { }
    }
}

internal sealed record Request(string Id, string Method, object Params);

internal sealed class Envelope
{
    public bool Ok { get; init; }
    [JsonPropertyName("request_id")]
    public string? RequestId { get; init; }
    public object? Result { get; init; }
    public ErrorBody? Error { get; init; }

    internal static Envelope Success(string id, object result) => new() { Ok = true, RequestId = id, Result = result };

    internal static Envelope Failure(string code, string message, bool retryable, string? requestId = null) => new()
    {
        Ok = false,
        RequestId = requestId,
        Error = new ErrorBody { Code = code, Message = message, Retryable = retryable }
    };

    internal static Envelope FromException(string id, Exception exception)
    {
        if (exception is AgentException agent)
        {
            return new Envelope
            {
                Ok = false,
                RequestId = id,
                Error = new ErrorBody
                {
                    Code = agent.Code,
                    Message = agent.Message,
                    Retryable = agent.Retryable,
                    Details = agent.Details
                }
            };
        }

        return new Envelope
        {
            Ok = false,
            RequestId = id,
            Error = new ErrorBody { Code = "INTERNAL_ERROR", Message = exception.Message, Retryable = true }
        };
    }
}

internal sealed class ErrorBody
{
    public string Code { get; init; } = "INTERNAL_ERROR";
    public string Message { get; init; } = string.Empty;
    public bool Retryable { get; init; }
    public object? Details { get; init; }
}

internal static class CliCommandParser
{
    internal static Request ToRequest(string[] args)
    {
        if (args.Length == 0 || args.Any(arg => arg is "--help" or "-h"))
        {
            PrintHelp();
            return new Request("help", "capabilities", new { });
        }

        var (positionals, options) = Parse(args);
        if (positionals.Count == 0)
        {
            return new Request(Guid.NewGuid().ToString("N"), "capabilities", new { });
        }

        var command = string.Join('.', positionals);
        var parameters = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var pair in options)
        {
            if (pair.Key.Equals("format", StringComparison.OrdinalIgnoreCase) || pair.Key.Equals("stdin", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            parameters[pair.Key.Replace('-', '_')] = pair.Value;
        }

        if (command is "windows.list" or "capabilities" or "doctor")
        {
            return new Request(Guid.NewGuid().ToString("N"), command, parameters);
        }

        return new Request(Guid.NewGuid().ToString("N"), command, parameters);
    }

    private static (List<string> Positionals, Dictionary<string, object?> Options) Parse(string[] args)
    {
        var positionals = new List<string>();
        var options = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                positionals.Add(arg.Replace('-', '_'));
                continue;
            }

            var key = arg[2..];
            var equals = key.IndexOf('=');
            if (equals >= 0)
            {
                var inlineValue = key[(equals + 1)..];
                key = key[..equals];
                options[key] = ParseValue(inlineValue);
            }
            else if (i + 1 < args.Length && (!args[i + 1].StartsWith("--", StringComparison.Ordinal) || IsNegativeNumber(args[i + 1])))
            {
                options[key] = ParseValue(args[++i]);
            }
            else
            {
                options[key] = true;
            }
        }
        return (positionals, options);
    }

    private static bool IsNegativeNumber(string value)
    {
        return value.Length > 1 && value[0] == '-' && (char.IsDigit(value[1]) || value[1] == '.');
    }

    private static object ParseValue(string value)
    {
        if (int.TryParse(value, out var number)) return number;
        if (bool.TryParse(value, out var boolean)) return boolean;
        return value;
    }

    private static void PrintHelp()
    {
        Console.Error.WriteLine("Windows Agent CLI");
        Console.Error.WriteLine("Usage: win-agent <domain> <command> [--key value] [--format json]");
        Console.Error.WriteLine("       win-agent exec --stdin --format ndjson");
        Console.Error.WriteLine("Domains: windows, ui, input, screen, wait");
    }
}
