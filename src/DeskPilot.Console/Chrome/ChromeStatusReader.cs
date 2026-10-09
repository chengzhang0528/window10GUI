using System.Text.Json;

namespace DeskPilot.Console.Chrome;

/// <summary>
/// Reads the connected Chrome target list through the local DevTools HTTP endpoint.
/// This is intentionally passive: status refresh must not acquire a DeskPilot
/// activity lease, activate a window, or restore focus while the user is typing.
/// </summary>
public sealed class ChromeStatusReader
{
    private static readonly HttpClient HttpClient = new()
    {
        Timeout = TimeSpan.FromSeconds(1)
    };

    public async Task<ChromeTargetStatus?> ReadAsync(int debugPort, CancellationToken cancellationToken = default)
    {
        using var response = await HttpClient.GetAsync(
            $"http://127.0.0.1:{debugPort}/json/list",
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
            return null;

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        if (document.RootElement.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var target in document.RootElement.EnumerateArray())
        {
            var type = target.TryGetProperty("type", out var typeProperty)
                ? typeProperty.GetString()
                : null;
            if (!string.Equals(type, "page", StringComparison.OrdinalIgnoreCase))
                continue;

            var url = target.TryGetProperty("url", out var urlProperty)
                ? urlProperty.GetString() ?? "-"
                : "-";
            var title = target.TryGetProperty("title", out var titleProperty)
                ? titleProperty.GetString() ?? ""
                : "";
            return new ChromeTargetStatus(url, title);
        }

        return null;
    }
}

public sealed record ChromeTargetStatus(string Url, string Title);
