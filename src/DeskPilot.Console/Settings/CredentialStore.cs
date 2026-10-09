namespace DeskPilot.Console.Settings;

public sealed record DomainCredentials(string Account, string Password, IReadOnlyList<string> AllowedHosts);

public static class CredentialStore
{
    public const string AccountVariable = "DESKPILOT_DOMAIN_ACCOUNT";
    public const string PasswordVariable = "DESKPILOT_DOMAIN_PASSWORD";
    public const string HostsVariable = "DESKPILOT_AUTO_LOGIN_HOSTS";

    public static DomainCredentials? Load()
    {
        var account = ReadVariable(AccountVariable);
        var password = ReadVariable(PasswordVariable);
        var hosts = ReadVariable(HostsVariable);
        if (string.IsNullOrWhiteSpace(account) || string.IsNullOrEmpty(password) ||
            !TryNormalizeHosts(hosts, out _, out var allowedHosts, out _))
        {
            return null;
        }

        return new DomainCredentials(account.Trim(), password, allowedHosts);
    }

    public static void Save(DomainCredentials? credentials)
    {
        var account = credentials?.Account.Trim();
        var password = credentials?.Password;
        var hosts = credentials == null ? null : string.Join(';', credentials.AllowedHosts);

        SetVariable(AccountVariable, account);
        SetVariable(PasswordVariable, password);
        SetVariable(HostsVariable, hosts);
    }

    public static bool TryNormalizeHosts(
        string? value,
        out string normalized,
        out IReadOnlyList<string> hosts,
        out string error)
    {
        var result = new List<string>();
        foreach (var item in (value ?? string.Empty).Split(
                     [';', ',', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var candidate = item.Trim().TrimEnd('.');
            if (candidate.StartsWith("*.", StringComparison.Ordinal))
                candidate = candidate[2..];

            var uriText = candidate.Contains("://", StringComparison.Ordinal)
                ? candidate
                : "https://" + candidate;
            if (!Uri.TryCreate(uriText, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
                uri.IdnHost.Length == 0 || uri.AbsolutePath != "/" ||
                uri.Query.Length > 0 || uri.Fragment.Length > 0)
            {
                normalized = string.Empty;
                hosts = [];
                error = $"自动登录域名无效：{item}";
                return false;
            }

            result.Add(uri.IdnHost.ToLowerInvariant());
        }

        result = result.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        normalized = string.Join("; ", result);
        hosts = result;
        error = result.Count == 0 ? "请至少填写一个允许自动登录的站点域名。" : string.Empty;
        return result.Count > 0;
    }

    public static bool IsHostAllowed(string host, IReadOnlyList<string> allowedHosts)
    {
        var normalizedHost = host.Trim().TrimEnd('.');
        return allowedHosts.Any(allowed =>
            normalizedHost.Equals(allowed, StringComparison.OrdinalIgnoreCase) ||
            normalizedHost.EndsWith('.' + allowed, StringComparison.OrdinalIgnoreCase));
    }

    private static string? ReadVariable(string name) =>
        Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Process) ??
        Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);

    private static void SetVariable(string name, string? value)
    {
        var storedValue = string.IsNullOrEmpty(value) ? null : value;
        Environment.SetEnvironmentVariable(name, storedValue, EnvironmentVariableTarget.User);
        Environment.SetEnvironmentVariable(name, storedValue, EnvironmentVariableTarget.Process);
    }
}
