using System.Text.Json;
using DeskPilot.Console.Cli;
using DeskPilot.Console.Settings;

namespace DeskPilot.Console.Login;

public sealed class AutoLoginService
{
    private readonly CliClient _cliClient;

    public AutoLoginService(CliClient cliClient)
    {
        _cliClient = cliClient;
    }

    public async Task<AutoLoginResult> TryLoginAsync(string? pageUrl, CancellationToken ct = default)
    {
        var credentials = CredentialStore.Load();
        if (credentials == null)
            return new AutoLoginResult(false, "not_configured", "未配置域账号、密码或允许登录的站点域名。");

        if (!Uri.TryCreate(pageUrl, UriKind.Absolute, out var uri))
            return new AutoLoginResult(false, "unknown_host", "当前登录页面没有可验证的站点域名，未发送凭据。");

        if (!CredentialStore.IsHostAllowed(uri.IdnHost, credentials.AllowedHosts))
            return new AutoLoginResult(false, "host_not_allowed", $"当前站点 {uri.IdnHost} 不在自动登录允许列表中，未发送凭据。");

        var expression = BuildLoginExpression(credentials.Account, credentials.Password);
        var response = await _cliClient.SendAsync(
            "chrome.evaluate",
            JsonSerializer.SerializeToElement(new { expression, timeout_ms = 30000 }),
            ct,
            source: "auto-login",
            redactParameters: true);

        if (!TryGetEvaluationValue(response, out var value) ||
            !value.TryGetProperty("status", out var statusElement))
        {
            return new AutoLoginResult(false, "unexpected_result", "自动登录脚本没有返回可识别结果。");
        }

        var status = statusElement.GetString() ?? "unknown";
        if (status != "submitted")
        {
            var message = status switch
            {
                "password_not_found" => "页面上没有找到可见密码输入框。",
                "account_not_found" => "页面上没有找到可见账号输入框。",
                "submit_not_found" => "已填写账号和密码，但没有找到登录提交按钮。",
                _ => "自动登录页面识别失败。"
            };
            return new AutoLoginResult(false, status, message);
        }

        for (var attempt = 0; attempt < 2; attempt++)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(1200), ct);
            var probe = await _cliClient.SendAsync(
                "chrome.evaluate",
                JsonSerializer.SerializeToElement(new { expression = "({url:location.href})", timeout_ms = 5000 }),
                ct,
                source: "auto-login");
            var pageState = GetPageState(probe);
            if (pageState == "usable")
                return new AutoLoginResult(true, "success", "已使用本机环境变量中的凭据完成自动登录。");
            if (pageState == "risk_challenge")
                return new AutoLoginResult(false, pageState, "登录后出现安全验证，需要用户处理。");
        }

        return new AutoLoginResult(false, "login_required", "已提交登录信息，但页面仍停留在登录状态，请检查凭据或手动处理。");
    }

    private static string BuildLoginExpression(string account, string password)
    {
        var accountJson = JsonSerializer.Serialize(account);
        var passwordJson = JsonSerializer.Serialize(password);
        return $$"""
            (() => {
              const account = {{accountJson}};
              const password = {{passwordJson}};
              const visible = el => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
              };
              const passwordInput = Array.from(document.querySelectorAll('input[type="password"],input[autocomplete="current-password"]')).find(visible);
              if (!passwordInput) return { status: 'password_not_found' };
              const allInputs = Array.from(document.querySelectorAll('input')).filter(visible);
              const accountCandidates = allInputs.filter(el =>
                el !== passwordInput &&
                !['hidden', 'password', 'checkbox', 'radio', 'submit', 'button'].includes((el.type || '').toLowerCase()));
              const metadata = el => [el.name, el.id, el.placeholder, el.autocomplete, el.getAttribute('aria-label')]
                .filter(Boolean).join(' ').toLowerCase();
              const labelText = el => {
                const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
                return `${label?.textContent || ''} ${el.parentElement?.textContent || ''}`.toLowerCase();
              };
              const passwordRect = passwordInput.getBoundingClientRect();
              const accountInput = accountCandidates
                .map((el, index) => {
                  const meta = metadata(el);
                  const labels = labelText(el);
                  const rect = el.getBoundingClientRect();
                  let score = 0;
                  if (el.autocomplete === 'username') score += 100;
                  if (/user|account|login|name|email|employee|登录名|账号|用户名/.test(meta)) score += 60;
                  if (/user|account|login|name|email|employee|登录名|账号|用户名/.test(labels)) score += 30;
                  if (el.type === 'email') score += 20;
                  if (el.type === 'text') score += 10;
                  if (rect.top <= passwordRect.top + 80) score += 8;
                  score -= Math.min(20, Math.abs(rect.top - passwordRect.top) / 100);
                  return { el, score, index };
                })
                .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.el;
              if (!accountInput) return { status: 'account_not_found', account_found: false, password_found: true, submit_found: false };
              const setValue = (el, value) => {
                const proto = Object.getPrototypeOf(el);
                const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
                if (descriptor && descriptor.set) descriptor.set.call(el, value); else el.value = value;
                el.focus();
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
              };
              setValue(accountInput, account);
              setValue(passwordInput, password);
              const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]')).filter(visible);
              const submit = buttons.find(el => el.matches('button[type="submit"],input[type="submit"]')) ||
                buttons.find(el => /^(登录|登\s*录|login|log\s*in|sign\s*in)$/i.test((el.innerText || el.value || el.textContent || '').trim()));
              if (submit) {
                submit.click();
                return { status: 'submitted', account_found: !!accountInput, password_found: true, submit_found: true };
              }
              if (passwordInput.form && typeof passwordInput.form.requestSubmit === 'function') {
                passwordInput.form.requestSubmit();
                return { status: 'submitted', account_found: !!accountInput, password_found: true, submit_found: true };
              }
              return { status: 'submit_not_found', account_found: !!accountInput, password_found: true, submit_found: false };
            })()
            """;
    }

    private static bool TryGetEvaluationValue(JsonElement response, out JsonElement value)
    {
        value = default;
        return response.TryGetProperty("result", out var payload) &&
               payload.TryGetProperty("value", out value) &&
               value.ValueKind == JsonValueKind.Object;
    }

    private static string? GetPageState(JsonElement response) =>
        response.TryGetProperty("result", out var payload) &&
        payload.TryGetProperty("page_state", out var state) &&
        state.ValueKind == JsonValueKind.String
            ? state.GetString()
            : null;
}

public sealed record AutoLoginResult(bool Success, string Status, string Message);
