using System.Text.Json;
using DeskPilot.Console.Cli;
using DeskPilot.Console.Session;
using DeskPilot.Console.Settings;

namespace DeskPilot.Console.UI;

public sealed class QuickActionPanel : Panel
{
    private readonly CliClient _cliClient;
    private readonly ChatPanel _chatPanel;
    private readonly SessionRecorder _sessionRecorder;
    private FlowLayoutPanel _buttonFlow = null!;

    public QuickActionPanel(
        CliClient cliClient,
        AppSettings settings,
        ChatPanel chatPanel,
        SessionRecorder sessionRecorder)
    {
        _cliClient = cliClient;
        _chatPanel = chatPanel;
        _sessionRecorder = sessionRecorder;

        InitializeLayout();
    }

    private void InitializeLayout()
    {
        Padding = new Padding(0);
        BackColor = AppTheme.Surface;
        BorderStyle = BorderStyle.None;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12, 6, 12, 6),
            ColumnCount = 1,
            RowCount = 3,
            BackColor = AppTheme.Surface
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));

        var label = new Label
        {
            Text = "页面助手（无需写代码）",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = AppTheme.Text,
            Font = AppTheme.DefaultFont(10F, FontStyle.Bold)
        };

        _buttonFlow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            AutoScroll = true,
            BackColor = AppTheme.Surface,
            Margin = new Padding(0, 0, 0, 2)
        };

        AddButton("截图", async () =>
        {
            var path = Path.Combine(Path.GetTempPath(), "DeskPilot", $"quick_{DateTime.Now:HHmmss_fff}.png");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await _cliClient.SendAsync("screen.capture", JsonSerializer.SerializeToElement(new { path }), source: "quick");
            _chatPanel.AppendMessage("页面助手", "截图已保存到临时目录。");
        });

        AddButton("当前页面", async () =>
        {
            var context = await ReadPageContextAsync();
            _chatPanel.AppendToInput(context);
            _chatPanel.AppendMessage("页面助手", "已把当前页面的 URL、标题和关键信息带入输入框。");
        });

        AddButton("带入选中内容", async () =>
        {
            var result = await _cliClient.SendAsync(
                "chrome.evaluate",
                JsonSerializer.SerializeToElement(new { expression = "window.getSelection ? window.getSelection().toString() : ''" }),
                source: "quick");
            var selected = GetStringValue(result);
            if (string.IsNullOrWhiteSpace(selected))
            {
                _chatPanel.AppendMessage("页面助手", "请先在浏览器页面中选中一段文字，再点击此按钮。");
                return;
            }

            _chatPanel.AppendToInput($"【页面选中内容】\n{selected}");
            _chatPanel.AppendMessage("页面助手", "已把选中的内容带入输入框。");
        });

        AddButton("打开网页...", async () =>
        {
            var url = PromptInput("输入要打开的网页地址:");
            if (string.IsNullOrWhiteSpace(url))
                return;

            await _cliClient.SendAsync(
                "chrome.navigate",
                JsonSerializer.SerializeToElement(new { url, wait_until = "domcontentloaded", timeout_ms = 30000 }),
                source: "quick");
            _chatPanel.AppendMessage("页面助手", $"已打开网页：{url}");
        });

        var hint = new Label
        {
            Text = "先在浏览器中选中文字，再带入输入框；然后直接用自然语言告诉 AI 要做什么。",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = AppTheme.TextMuted,
            Font = AppTheme.DefaultFont(7.5F),
            AutoEllipsis = true
        };

        layout.Controls.Add(label, 0, 0);
        layout.Controls.Add(_buttonFlow, 0, 1);
        layout.Controls.Add(hint, 0, 2);
        Controls.Add(layout);
    }

    private async Task<string> ReadPageContextAsync()
    {
        const string expression = "JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,1800)})";
        var result = await _cliClient.SendAsync(
            "chrome.evaluate",
            JsonSerializer.SerializeToElement(new { expression }),
            source: "quick");
        var raw = GetStringValue(result);
        if (string.IsNullOrWhiteSpace(raw))
            return "【当前页面上下文】\n页面信息读取失败，请直接描述你要完成的事情。";

        try
        {
            using var document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            var url = root.TryGetProperty("url", out var urlElement) ? urlElement.GetString() : null;
            var title = root.TryGetProperty("title", out var titleElement) ? titleElement.GetString() : null;
            var text = root.TryGetProperty("text", out var textElement) ? textElement.GetString() : null;
            return $"【当前页面上下文】\n页面标题：{title ?? "(无标题)"}\n页面 URL：{url ?? "(未知)"}\n页面关键信息：{text ?? "(无可见文本)"}";
        }
        catch (JsonException)
        {
            return $"【当前页面上下文】\n{raw}";
        }
    }

    private static string? GetStringValue(JsonElement response)
    {
        return response.TryGetProperty("result", out var result) &&
               result.TryGetProperty("value", out var value) &&
               value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private void AddButton(string text, Func<Task> action)
    {
        var btn = new Button
        {
            Text = text,
            AutoSize = true,
            MinimumSize = new Size(106, 34),
            Height = 34,
            Margin = new Padding(0, 0, 8, 8),
            Padding = new Padding(8, 0, 8, 0)
        };
        AppTheme.StyleSecondaryButton(btn);
        btn.Click += async (_, _) =>
        {
            btn.Enabled = false;
            _sessionRecorder.Record("quick.action", "quick", "started", text);
            try
            {
                await action();
                _sessionRecorder.Record("quick.action", "quick", "success", text);
            }
            catch (Exception ex)
            {
                _chatPanel.AppendMessage("错误", ex.Message);
                _sessionRecorder.Record("quick.action", "quick", "error", $"{text}: {ex.Message}");
            }
            finally
            {
                btn.Enabled = true;
            }
        };
        _buttonFlow.Controls.Add(btn);
    }

    private string? PromptInput(string prompt)
    {
        using var dialog = new Form
        {
            Text = "DeskPilot",
            ClientSize = new Size(440, 150),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            BackColor = AppTheme.Background,
            Font = AppTheme.DefaultFont()
        };

        var label = new Label { Text = prompt, Location = new Point(16, 16), AutoSize = true, ForeColor = AppTheme.Text };
        var textBox = new TextBox { Location = new Point(16, 44), Width = 408 };
        var okBtn = new Button { Text = "确定", Location = new Point(254, 90), Width = 80, Height = 30, DialogResult = DialogResult.OK };
        var cancelBtn = new Button { Text = "取消", Location = new Point(344, 90), Width = 80, Height = 30, DialogResult = DialogResult.Cancel };
        AppTheme.StylePrimaryButton(okBtn);
        AppTheme.StyleSecondaryButton(cancelBtn);

        dialog.Controls.AddRange(new Control[] { label, textBox, okBtn, cancelBtn });
        dialog.AcceptButton = okBtn;
        dialog.CancelButton = cancelBtn;

        return dialog.ShowDialog() == DialogResult.OK ? textBox.Text.Trim() : null;
    }
}
