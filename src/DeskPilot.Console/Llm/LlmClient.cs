using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DeskPilot.Console.Settings;

namespace DeskPilot.Console.Llm;

public sealed class LlmClient
{
    private const int MaxTransientRetries = 3;
    private readonly AppSettings _settings;
    private readonly HttpClient _http;

    public LlmClient(AppSettings settings)
    {
        _settings = settings;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(120) };
    }

    public static string NormalizeBaseUrl(string baseUrl)
    {
        var normalized = baseUrl.Trim().TrimEnd('/');
        if (normalized.Length == 0)
            return normalized;

        return normalized.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)
            ? normalized
            : normalized + "/v1";
    }

    public static async Task<IReadOnlyList<string>> GetAvailableModelsAsync(
        string baseUrl,
        string apiKey,
        CancellationToken ct = default)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var request = new HttpRequestMessage(HttpMethod.Get,
            NormalizeBaseUrl(baseUrl) + "/models");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"服务返回 HTTP {(int)response.StatusCode} ({response.ReasonPhrase})。");

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var document = JsonSerializer.Deserialize<JsonElement>(body);
        if (!document.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("服务响应中没有 OpenAI 兼容的模型列表。");

        var models = data.EnumerateArray()
            .Select(item => item.TryGetProperty("id", out var id) ? id.GetString() : null)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(id => id, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (models.Length == 0)
            throw new InvalidOperationException("服务返回的模型列表为空。");

        return models;
    }

    public async Task<string> ChatAsync(string userMessage, List<ChatMessage> history, CancellationToken ct = default)
    {
        var messages = new List<Dictionary<string, string>>();
        messages.Add(new() { ["role"] = "system", ["content"] = PromptBuilder.SystemPrompt });
        foreach (var h in history)
            messages.Add(new() { ["role"] = h.Role, ["content"] = h.Content });
        messages.Add(new() { ["role"] = "user", ["content"] = userMessage });

        var tools = PromptBuilder.BuildTools();
        var payload = new Dictionary<string, object>
        {
            ["model"] = _settings.LlmModel,
            ["messages"] = messages,
            ["tools"] = tools,
            ["tool_choice"] = "auto",
            ["stream"] = true
        };

        var json = JsonSerializer.Serialize(payload);
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _settings.LlmApiKey);

        var url = NormalizeBaseUrl(_settings.LlmBaseUrl) + "/chat/completions";
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        using var response = await SendWithTransientRetryAsync(request, ct).ConfigureAwait(false);

        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream);
        var textContent = new StringBuilder();
        var toolArguments = new StringBuilder();
        string? toolName = null;

        while (await reader.ReadLineAsync(ct).ConfigureAwait(false) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                continue;

            var data = line[5..].TrimStart();
            if (data == "[DONE]")
                break;
            if (data.Length == 0)
                continue;

            var chunk = JsonSerializer.Deserialize<JsonElement>(data);
            if (chunk.TryGetProperty("error", out var error))
            {
                var message = error.TryGetProperty("message", out var errorMessage)
                    ? errorMessage.GetString()
                    : null;
                throw new InvalidOperationException(message ?? "LLM 流式响应失败。");
            }

            if (!chunk.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0)
                continue;

            var choice = choices[0];
            if (!choice.TryGetProperty("delta", out var delta))
                continue;

            if (delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
                textContent.Append(content.GetString());

            if (!delta.TryGetProperty("tool_calls", out var toolCalls) || toolCalls.ValueKind != JsonValueKind.Array)
                continue;

            foreach (var toolCall in toolCalls.EnumerateArray())
            {
                if (!toolCall.TryGetProperty("function", out var function))
                    continue;
                if (function.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String)
                    toolName ??= name.GetString();
                if (function.TryGetProperty("arguments", out var arguments) && arguments.ValueKind == JsonValueKind.String)
                    toolArguments.Append(arguments.GetString());
            }
        }

        if (string.Equals(toolName, "bash", StringComparison.Ordinal) && toolArguments.Length > 0)
        {
            var args = JsonSerializer.Deserialize<JsonElement>(toolArguments.ToString());
            if (args.TryGetProperty("command", out var command))
                return $"__TOOL_CALL__{command.GetString()}";
        }

        return textContent.ToString();
    }

    private async Task<HttpResponseMessage> SendWithTransientRetryAsync(
        HttpRequestMessage request,
        CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            // HttpRequestMessage 不能安全地重复发送，复制请求以便 503 时重试。
            using var retryRequest = await CloneRequestAsync(request, ct).ConfigureAwait(false);
            var response = await _http.SendAsync(retryRequest, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
                return response;

            var statusCode = (int)response.StatusCode;
            var reason = response.ReasonPhrase;
            response.Dispose();
            if (statusCode != 503 || attempt >= MaxTransientRetries)
                throw new LlmHttpException(statusCode, reason);

            var delay = TimeSpan.FromMilliseconds(700 * Math.Pow(2, attempt));
            await Task.Delay(delay, ct).ConfigureAwait(false);
        }
    }

    private static async Task<HttpRequestMessage> CloneRequestAsync(HttpRequestMessage source, CancellationToken ct)
    {
        var clone = new HttpRequestMessage(source.Method, source.RequestUri)
        {
            Version = source.Version,
            VersionPolicy = source.VersionPolicy
        };
        foreach (var header in source.Headers)
            clone.Headers.TryAddWithoutValidation(header.Key, header.Value);

        if (source.Content != null)
        {
            var content = await source.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
            clone.Content = new ByteArrayContent(content);
            foreach (var header in source.Content.Headers)
                clone.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
        return clone;
    }

    public record ChatMessage(string Role, string Content);

    public sealed class LlmHttpException : HttpRequestException
    {
        public LlmHttpException(int statusCode, string? reason)
            : base($"LLM 服务返回 HTTP {statusCode} ({reason ?? "Unknown"})。")
        {
            StatusCodeValue = statusCode;
        }

        public int StatusCodeValue { get; }
    }
}
