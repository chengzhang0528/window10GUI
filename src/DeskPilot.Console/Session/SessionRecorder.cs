using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using DeskPilot.Console.Settings;

namespace DeskPilot.Console.Session;

public sealed class SessionRecorder : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    private static readonly string[] SensitiveKeyFragments =
    [
        "api_key", "apikey", "authorization", "token", "password", "passwd",
        "secret", "cookie", "credential", "private_key"
    ];

    private static readonly Regex ApiKeyPattern = new(
        @"\bsk-[A-Za-z0-9_-]{12,}\b",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex BearerPattern = new(
        @"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex NamedSecretPattern = new(
        """(?i)\b(api[_-]?key|authorization|token|password|passwd|secret|cookie|credential|private[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)""",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly object _sync = new();
    private readonly StreamWriter _writer;
    private long _sequence;
    private bool _disposed;

    public SessionRecorder()
    {
        SessionId = $"{DateTime.Now:HHmmss}-{Guid.NewGuid():N}"[..15];
        var dayDirectory = Path.Combine(SessionsRoot, DateTime.Now.ToString("yyyy-MM-dd"));
        Directory.CreateDirectory(dayDirectory);
        SessionFilePath = Path.Combine(dayDirectory, $"session-{SessionId}.ndjson");
        var stream = new FileStream(SessionFilePath, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        _writer = new StreamWriter(stream) { AutoFlush = true };
        Record("session.started", "application", "success", "DeskPilot 会话开始");
    }

    public static string SessionsRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "DeskPilot", "sessions");

    public string SessionId { get; }

    public string SessionFilePath { get; }

    public void Record(
        string kind,
        string source,
        string status,
        string? summary = null,
        string? method = null,
        object? parameters = null,
        object? result = null,
        long? durationMs = null)
    {
        lock (_sync)
        {
            if (_disposed)
                return;

            var entry = new JsonObject
            {
                ["version"] = 1,
                ["sequence"] = ++_sequence,
                ["timestamp"] = DateTimeOffset.Now.ToString("O"),
                ["sessionId"] = SessionId,
                ["kind"] = kind,
                ["source"] = source,
                ["status"] = status
            };
            if (!string.IsNullOrWhiteSpace(summary))
                entry["summary"] = RedactText(summary);
            if (!string.IsNullOrWhiteSpace(method))
                entry["method"] = method;
            if (parameters != null)
                entry["params"] = Sanitize(parameters);
            if (result != null)
                entry["result"] = Sanitize(result);
            if (durationMs.HasValue)
                entry["durationMs"] = durationMs.Value;

            _writer.WriteLine(entry.ToJsonString(JsonOptions));
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
                return;

            Record("session.ended", "application", "success", "DeskPilot 会话结束");
            _disposed = true;
            _writer.Dispose();
        }
    }

    private static JsonNode? Sanitize(object value)
    {
        var node = JsonSerializer.SerializeToNode(value, JsonOptions);
        RedactNode(node, null);
        return node;
    }

    private static void RedactNode(JsonNode? node, string? propertyName)
    {
        if (node == null)
            return;

        if (IsSensitiveKey(propertyName))
        {
            if (node.Parent is JsonObject parent && propertyName != null)
                parent[propertyName] = "***REDACTED***";
            return;
        }

        if (node is JsonObject obj)
        {
            var selector = obj["selector"] is JsonValue selectorValue &&
                           selectorValue.TryGetValue<string>(out var selectorText)
                ? selectorText
                : null;
            if (!string.IsNullOrWhiteSpace(selector) && IsSensitiveText(selector) && obj.ContainsKey("value"))
                obj["value"] = "***REDACTED***";

            foreach (var pair in obj.ToArray())
                RedactNode(pair.Value, pair.Key);
        }
        else if (node is JsonArray array)
        {
            foreach (var item in array)
                RedactNode(item, null);
        }
        else if (node is JsonValue value && value.TryGetValue<string>(out var text))
        {
            var redacted = RedactText(text);
            if (!string.Equals(text, redacted, StringComparison.Ordinal) && node.Parent is JsonArray parentArray)
            {
                var index = parentArray.IndexOf(node);
                parentArray[index] = redacted;
            }
            else if (!string.Equals(text, redacted, StringComparison.Ordinal) &&
                     node.Parent is JsonObject parentObject && propertyName != null)
            {
                parentObject[propertyName] = redacted;
            }
        }
    }

    private static bool IsSensitiveKey(string? key) =>
        !string.IsNullOrWhiteSpace(key) &&
        SensitiveKeyFragments.Any(fragment => key.Contains(fragment, StringComparison.OrdinalIgnoreCase));

    private static bool IsSensitiveText(string text) =>
        SensitiveKeyFragments.Any(fragment => text.Contains(fragment, StringComparison.OrdinalIgnoreCase));

    public static string RedactSensitiveText(string text)
    {
        var result = RedactJsonLines(text);
        result = ApiKeyPattern.Replace(result, "sk-***REDACTED***");
        result = BearerPattern.Replace(result, "Bearer ***REDACTED***");
        result = NamedSecretPattern.Replace(result, match => $"{match.Groups[1].Value}{match.Groups[2].Value}***REDACTED***");

        var password = ReadCredentialVariable(CredentialStore.PasswordVariable);
        var account = ReadCredentialVariable(CredentialStore.AccountVariable);
        if (!string.IsNullOrEmpty(password))
            result = result.Replace(password, "***REDACTED***", StringComparison.Ordinal);
        if (!string.IsNullOrWhiteSpace(account))
            result = result.Replace(account, "***REDACTED***", StringComparison.OrdinalIgnoreCase);

        return result;
    }

    private static string RedactText(string text) => RedactSensitiveText(text);

    private static string? ReadCredentialVariable(string name) =>
        Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Process) ??
        Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);

    private static string RedactJsonLines(string text)
    {
        var lines = text.ReplaceLineEndings("\n").Split('\n');
        for (var index = 0; index < lines.Length; index++)
            lines[index] = RedactEmbeddedJson(lines[index]);
        return string.Join(Environment.NewLine, lines);
    }

    private static string RedactEmbeddedJson(string line)
    {
        var start = line.IndexOf('{');
        var end = line.LastIndexOf('}');
        if (start < 0 || end <= start)
            return line;

        var candidate = line[start..(end + 1)];
        try
        {
            var node = JsonNode.Parse(candidate);
            RedactNode(node, null);
            return line[..start] + node!.ToJsonString(JsonOptions) + line[(end + 1)..];
        }
        catch (JsonException)
        {
            return line;
        }
    }
}
