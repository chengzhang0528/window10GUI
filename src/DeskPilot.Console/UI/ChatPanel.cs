using System.Text;
using DeskPilot.Console.Cli;
using DeskPilot.Console.Login;
using DeskPilot.Console.Llm;
using DeskPilot.Console.Session;
using DeskPilot.Console.Settings;

namespace DeskPilot.Console.UI;

public sealed class ChatPanel : Panel
{
    private readonly CliClient _cliClient;
    private readonly AppSettings _settings;
    private readonly LlmClient _llmClient;
    private readonly AutoLoginService _autoLoginService;
    private readonly SessionRecorder _sessionRecorder;
    private readonly List<LlmClient.ChatMessage> _history = new();

    private RichTextBox _outputBox = null!;
    private TextBox _inputBox = null!;
    private Button _sendButton = null!;
    private Button _retryButton = null!;
    private Button _clearButton = null!;
    private Button _stopButton = null!;
    private Label _statusLabel = null!;
    private string? _retryInput;
    private CancellationTokenSource? _chatCts;

    public ChatPanel(CliClient cliClient, AppSettings settings, SessionRecorder sessionRecorder)
    {
        _cliClient = cliClient;
        _settings = settings;
        _llmClient = new LlmClient(settings);
        _autoLoginService = new AutoLoginService(cliClient);
        _sessionRecorder = sessionRecorder;

        InitializeLayout();
    }

    private void InitializeLayout()
    {
        Padding = new Padding(0, 0, 0, 12);
        BackColor = AppTheme.Background;
        BorderStyle = BorderStyle.None;

        var card = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = AppTheme.Surface,
            BorderStyle = BorderStyle.FixedSingle
        };

        var header = new Panel
        {
            Dock = DockStyle.Top,
            Height = 54,
            Padding = new Padding(14, 0, 12, 0),
            BackColor = AppTheme.Surface
        };
        var titleLabel = new Label
        {
            Text = "AI 助手",
            Dock = DockStyle.Left,
            Width = 150,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = AppTheme.DefaultFont(11F, FontStyle.Bold),
            ForeColor = AppTheme.Text
        };

        _statusLabel = new Label
        {
            Text = "等待指令",
            Dock = DockStyle.Right,
            Width = 100,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = AppTheme.Primary,
            Font = AppTheme.DefaultFont(8.5F, FontStyle.Bold)
        };
        header.Controls.Add(_statusLabel);
        header.Controls.Add(titleLabel);

        _outputBox = new RichTextBox
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            BackColor = AppTheme.SurfaceMuted,
            ForeColor = AppTheme.Text,
            BorderStyle = BorderStyle.None,
            Font = AppTheme.DefaultFont(9.5F),
            ScrollBars = RichTextBoxScrollBars.Vertical,
            DetectUrls = true,
            Margin = new Padding(12)
        };
        var outputFrame = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            BackColor = AppTheme.Surface
        };
        outputFrame.Controls.Add(_outputBox);

        var inputPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 128,
            Padding = new Padding(12, 10, 12, 12),
            ColumnCount = 5,
            BackColor = AppTheme.Surface
        };
        inputPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        inputPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 72));
        inputPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 56));
        inputPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 64));
        inputPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 56));
        _inputBox = new TextBox
        {
            Dock = DockStyle.Fill,
            Font = AppTheme.DefaultFont(10F),
            Multiline = true,
            AcceptsReturn = true,
            ScrollBars = ScrollBars.Vertical,
            BorderStyle = BorderStyle.FixedSingle,
            Margin = new Padding(0, 0, 8, 0)
        };
        _sendButton = new Button
        {
            Text = "发送",
            Dock = DockStyle.Fill,
            Margin = new Padding(6, 0, 0, 0)
        };
        AppTheme.StylePrimaryButton(_sendButton);
        _retryButton = new Button
        {
            Text = "刷新重试",
            Dock = DockStyle.Fill,
            Margin = new Padding(6, 0, 0, 0),
            Enabled = false
        };
        AppTheme.StyleSecondaryButton(_retryButton);
        _clearButton = new Button
        {
            Text = "清空",
            Dock = DockStyle.Fill,
            Margin = new Padding(0)
        };
        AppTheme.StyleSecondaryButton(_clearButton);
        _stopButton = new Button
        {
            Text = "停止",
            Dock = DockStyle.Fill,
            Margin = new Padding(6, 0, 0, 0),
            Enabled = false
        };
        AppTheme.StyleSecondaryButton(_stopButton);

        _sendButton.Click += async (_, _) => await SendAsync();
        _stopButton.Click += (_, _) => _chatCts?.Cancel();
        _retryButton.Click += async (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(_retryInput))
                await SendAsync(_retryInput, isRetry: true);
        };
        _inputBox.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true;
                _ = SendAsync();
            }
        };
        _clearButton.Click += (_, _) =>
        {
            _outputBox.Clear();
            _history.Clear();
        };

        inputPanel.Controls.Add(_inputBox, 0, 0);
        inputPanel.Controls.Add(_retryButton, 1, 0);
        inputPanel.Controls.Add(_clearButton, 2, 0);
        inputPanel.Controls.Add(_sendButton, 3, 0);
        inputPanel.Controls.Add(_stopButton, 4, 0);

        card.Controls.Add(outputFrame);
        card.Controls.Add(inputPanel);
        card.Controls.Add(header);
        Controls.Add(card);
    }

    private async Task SendAsync(string? requestedInput = null, bool isRetry = false)
    {
        if (!_sendButton.Enabled)
            return;

        var input = (requestedInput ?? _inputBox.Text).Trim();
        if (input.Length == 0)
            return;

        if (!isRetry)
        {
            _inputBox.Clear();
            _retryInput = null;
            AppendMessage("用户", input);
            _sessionRecorder.Record("chat.user", "user", "success", input);
        }
        _statusLabel.Text = "思考中...";
        _statusLabel.ForeColor = AppTheme.Warning;
        _sendButton.Enabled = false;
        _retryButton.Enabled = false;
        _stopButton.Enabled = true;
        using var chatCts = new CancellationTokenSource();
        _chatCts = chatCts;

        try
        {
            var nextPrompt = input;
            var userMessageAdded = false;
            var requiresRecovery = false;
            var awaitingVerification = false;
            string? lastFailureFingerprint = null;
            var repeatedFailureCount = 0;
            while (true)
            {
                _statusLabel.Text = "思考中...";
                var response = await _llmClient.ChatAsync(nextPrompt, _history, chatCts.Token);
                if (!userMessageAdded)
                {
                    _history.Add(new LlmClient.ChatMessage("user", input));
                    userMessageAdded = true;
                }

                if (!response.StartsWith("__TOOL_CALL__", StringComparison.Ordinal))
                {
                    if (requiresRecovery || awaitingVerification)
                    {
                        const string continuationMessage = "当前仍未取得完成证据，继续检查并修复，不结束本轮任务。";
                        AppendMessage("进度", continuationMessage);
                        _history.Add(new LlmClient.ChatMessage("user", continuationMessage));
                        nextPrompt = requiresRecovery
                            ? "上一条工具调用失败，任务尚未完成。请换一种通用策略重新观察当前页面并继续操作；不要直接总结或声称完成。"
                            : "刚才执行了会改变页面状态的操作，但还没有验证业务结果。请重新观察 URL、标题、正文关键文本或目标控件，确认成功后再回复。";
                        continue;
                    }

                    AppendMessage("助手", response);
                    _retryInput = null;
                    _history.Add(new LlmClient.ChatMessage("assistant", response));
                    _sessionRecorder.Record("chat.assistant", "assistant", "success", response);
                    break;
                }

                var command = response["__TOOL_CALL__".Length..];
                var safeCommand = SessionRecorder.RedactSensitiveText(command);
                AppendMessage("工具", $"执行: {safeCommand}");
                _sessionRecorder.Record("llm.tool", "assistant", "success", safeCommand);
                _history.Add(new LlmClient.ChatMessage("assistant", $"工具调用:\n{safeCommand}"));
                _statusLabel.Text = "执行中...";

                var execution = await ExecuteCliCommandAsync(command, chatCts.Token);
                var safeDisplayText = SessionRecorder.RedactSensitiveText(execution.DisplayText);
                AppendMessage("结果", safeDisplayText);
                _history.Add(new LlmClient.ChatMessage("user", $"工具执行结果:\n{safeDisplayText}"));
                requiresRecovery = !execution.Succeeded;
                if (!execution.Succeeded)
                {
                    var failureFingerprint = $"{safeCommand}\n{safeDisplayText}";
                    repeatedFailureCount = string.Equals(lastFailureFingerprint, failureFingerprint, StringComparison.Ordinal)
                        ? repeatedFailureCount + 1
                        : 1;
                    lastFailureFingerprint = failureFingerprint;
                    if (repeatedFailureCount >= 2)
                    {
                        const string stalledMessage = "同一工具调用连续失败且页面没有产生新进展，本轮已停止，避免无限重试。请修正输入或点击“刷新重试”继续。";
                        AppendMessage("助手", stalledMessage);
                        _history.Add(new LlmClient.ChatMessage("assistant", stalledMessage));
                        _retryInput = input;
                        _retryButton.Enabled = true;
                        _statusLabel.Text = "可重试";
                        _sessionRecorder.Record("chat.stalled", "application", "error", stalledMessage);
                        break;
                    }
                }
                else
                {
                    lastFailureFingerprint = null;
                    repeatedFailureCount = 0;
                }
                awaitingVerification = execution.Succeeded && execution.RequiresVerification;
                if (execution.PauseReason != null)
                {
                    if (execution.PauseReason == "login_required")
                    {
                        _statusLabel.Text = "自动登录中...";
                        var autoLogin = await _autoLoginService.TryLoginAsync(execution.PageUrl, chatCts.Token);
                        _sessionRecorder.Record(
                            "login.auto",
                            "application",
                            autoLogin.Success ? "success" : "paused",
                            autoLogin.Message);
                        AppendMessage("自动登录", autoLogin.Message);
                        if (autoLogin.Success)
                        {
                            _history.Add(new LlmClient.ChatMessage("user", "DeskPilot 已使用本机配置完成自动登录，请继续完成原目标。"));
                            nextPrompt = "自动登录已完成，请重新观察页面并继续完成用户目标。";
                            continue;
                        }

                        var failedMessage = autoLogin.Status == "not_configured"
                            ? "页面已打开，但当前需要登录。请在设置中配置域账号、域密码和允许自动登录的站点域名，或在 Chrome 中手动登录。"
                            : autoLogin.Message;
                        AppendMessage("助手", failedMessage);
                        _history.Add(new LlmClient.ChatMessage("assistant", failedMessage));
                        _sessionRecorder.Record("chat.assistant", "assistant", "success", failedMessage);
                        break;
                    }

                    var pauseMessage = execution.PauseReason == "risk_challenge"
                        ? "页面已打开，但浏览器要求人工完成安全验证。请在 Chrome 中处理后再继续。"
                        : "页面已打开，但当前需要重新登录。请在 Chrome 中完成登录后再继续。";
                    AppendMessage("助手", pauseMessage);
                    _history.Add(new LlmClient.ChatMessage("assistant", pauseMessage));
                    _sessionRecorder.Record("chat.assistant", "assistant", "success", pauseMessage);
                    break;
                }
                nextPrompt = requiresRecovery
                    ? "上一条工具调用失败，任务尚未完成。请换一种通用策略重新观察当前页面并继续操作；不要直接总结或声称完成。"
                    : awaitingVerification
                        ? "刚才执行了会改变页面状态的操作。请重新观察 URL、标题、正文关键文本或目标控件，验证业务结果后再回复。"
                        : "请根据刚才的工具结果继续完成用户目标；如仍需操作，请继续调用工具，完成后直接回复用户。";
            }

        }
        catch (OperationCanceledException) when (_chatCts?.IsCancellationRequested == true)
        {
            const string stoppedMessage = "已按用户要求停止本次任务，当前页面状态未作额外假设。";
            AppendMessage("助手", stoppedMessage);
            _sessionRecorder.Record("chat.cancelled", "user", "success", stoppedMessage);
        }
        catch (Exception ex)
        {
            AppendMessage("错误", ex.Message);
            if (ex is LlmClient.LlmHttpException { StatusCodeValue: 503 })
            {
                _retryInput = input;
                _retryButton.Enabled = true;
                _statusLabel.Text = "可重试";
                AppendMessage("助手", "LLM 服务暂时不可用，已保留本次请求。点击“重试”可原地再次发送。\n已自动完成有限次数重试，避免持续占用服务。");
            }
            _sessionRecorder.Record("chat.error", "application", "error", ex.Message);
        }
        finally
        {
            _statusLabel.Text = "等待指令";
            _statusLabel.ForeColor = AppTheme.Primary;
            _sendButton.Enabled = true;
            _stopButton.Enabled = false;
            _chatCts = null;
            if (_retryInput == null)
                _retryButton.Enabled = false;
        }
    }

    private async Task<CliExecutionResult> ExecuteCliCommandAsync(string command, CancellationToken ct)
    {
        // 从 bash 命令中提取 NDJSON
        var ndjson = ExtractNdjson(command);
        if (ndjson == null)
            return new CliExecutionResult("无法解析命令中的 NDJSON。", null, null, false, false);

        try
        {
            var doc = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(ndjson);
            var method = doc.GetProperty("method").GetString() ?? "";
            System.Text.Json.JsonElement? params_ = doc.TryGetProperty("params", out var p) ? p : (System.Text.Json.JsonElement?)null;

            var beforeContext = await ReadPageLocationAsync(ct);
            var result = await _cliClient.SendAsync(method, params_, ct, source: "chat");
            var displayText = System.Text.Json.JsonSerializer.Serialize(result,
                new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
            var succeeded = result.TryGetProperty("ok", out var ok) && ok.ValueKind == System.Text.Json.JsonValueKind.True;
            string? pauseReason = null;
            string? pageUrl = null;
            if (!string.Equals(method, "chrome.ensure", StringComparison.Ordinal) &&
                TryGetPageStatePayload(result, out var payload))
            {
                if (payload.TryGetProperty("page_state", out var pageState) &&
                    pageState.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    var value = pageState.GetString();
                    if (value is "login_required" or "risk_challenge")
                        pauseReason = value;
                }
                if (payload.TryGetProperty("url", out var url) &&
                    url.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    pageUrl = url.GetString();
                }
            }
            pageUrl ??= TryGetString(result, "url") ?? beforeContext.Url;
            var pageTitle = TryGetString(result, "title") ?? beforeContext.Title;
            var action = DescribeAction(method);
            _sessionRecorder.Record(
                "llm.step",
                "assistant",
                succeeded ? "success" : "error",
                $"页面 {pageUrl ?? "未知页面"}：{action}",
                method,
                new { page_url = pageUrl, page_title = pageTitle, action, before_url = beforeContext.Url, before_title = beforeContext.Title });
            var requiresVerification = method is "chrome.click" or "chrome.fill" or "chrome.select";
            return new CliExecutionResult(displayText, pauseReason, pageUrl, succeeded, requiresVerification);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new CliExecutionResult($"CLI 执行失败: {ex.Message}", null, null, false, false);
        }
    }

    private sealed record CliExecutionResult(
        string DisplayText,
        string? PauseReason,
        string? PageUrl,
        bool Succeeded,
        bool RequiresVerification);

    private static string? TryGetString(System.Text.Json.JsonElement response, string name)
    {
        if (response.TryGetProperty("result", out var result) &&
            result.TryGetProperty(name, out var value) &&
            value.ValueKind == System.Text.Json.JsonValueKind.String)
            return value.GetString();

        return null;
    }

    private async Task<(string? Url, string? Title)> ReadPageLocationAsync(CancellationToken ct)
    {
        try
        {
            var response = await _cliClient.SendAsync(
                "chrome.evaluate",
                System.Text.Json.JsonSerializer.SerializeToElement(new
                {
                    expression = "({url: location.href, title: document.title})"
                }),
                ct,
                source: "context");
            if (response.TryGetProperty("result", out var result) &&
                result.TryGetProperty("value", out var value) &&
                value.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                var url = value.TryGetProperty("url", out var urlElement) ? urlElement.GetString() : null;
                var title = value.TryGetProperty("title", out var titleElement) ? titleElement.GetString() : null;
                return (url, title);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _sessionRecorder.Record("context.read", "assistant", "error", ex.Message);
        }

        return (null, null);
    }

    private static string DescribeAction(string method) => method switch
    {
        "chrome.navigate" => "打开页面",
        "chrome.click" => "点击功能按钮",
        "chrome.fill" => "填写表单字段",
        "chrome.select" => "选择表单选项",
        "chrome.evaluate" => "读取或分析页面信息",
        "chrome.query" => "查找页面元素",
        "chrome.wait" => "等待页面状态",
        _ => method
    };

    private static bool TryGetPageStatePayload(System.Text.Json.JsonElement response, out System.Text.Json.JsonElement payload)
    {
        if (response.TryGetProperty("result", out payload) &&
            payload.ValueKind == System.Text.Json.JsonValueKind.Object)
        {
            return true;
        }

        if (response.TryGetProperty("error", out var error) &&
            error.ValueKind == System.Text.Json.JsonValueKind.Object &&
            error.TryGetProperty("details", out payload) &&
            payload.ValueKind == System.Text.Json.JsonValueKind.Object)
        {
            return true;
        }

        payload = default;
        return false;
    }

    private static string? ExtractNdjson(string command)
    {
        // LLM 命令通常是 shell heredoc 形式：<<< '{"id":"1",...}'。
        // 不能用下一个单引号作为结束位置，因为 JS 表达式常包含 "|| ''"。
        // 从第一个 JSON 对象开始按 JSON 字符串/括号扫描，直到完整对象结束。
        var marker = command.IndexOf("<<<", StringComparison.Ordinal);
        if (marker < 0)
            return null;

        var start = command.IndexOf('{', marker + 3);
        if (start < 0)
            return null;

        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var index = start; index < command.Length; index++)
        {
            var character = command[index];
            if (inString)
            {
                if (escaped)
                    escaped = false;
                else if (character == '\\')
                    escaped = true;
                else if (character == '"')
                    inString = false;

                continue;
            }

            if (character == '"')
                inString = true;
            else if (character == '{')
                depth++;
            else if (character == '}' && --depth == 0)
                return command[start..(index + 1)];
        }

        return null;
    }

    public void AppendMessage(string role, string content)
    {
        var color = role switch
        {
            "用户" => AppTheme.Primary,
            "助手" => AppTheme.Success,
            "工具" => AppTheme.Warning,
            "结果" => AppTheme.TextMuted,
            "错误" => AppTheme.Danger,
            _ => AppTheme.Text
        };

        _outputBox.SelectionStart = _outputBox.TextLength;
        _outputBox.SelectionLength = 0;
        _outputBox.SelectionColor = color;
        _outputBox.SelectionFont = AppTheme.DefaultFont(9F, FontStyle.Bold);
        _outputBox.AppendText($"{role}\n");
        _outputBox.SelectionColor = AppTheme.Text;
        _outputBox.SelectionFont = AppTheme.DefaultFont(9.5F);
        _outputBox.AppendText($"{content}\n\n");
        _outputBox.ScrollToCaret();
    }

    public void AppendToInput(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return;

        var separator = string.IsNullOrWhiteSpace(_inputBox.Text) ? string.Empty : Environment.NewLine + Environment.NewLine;
        _inputBox.AppendText(separator + text.Trim());
        _inputBox.Focus();
        _inputBox.SelectionStart = _inputBox.TextLength;
        _inputBox.ScrollToCaret();
    }
}
