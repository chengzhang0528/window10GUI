using DeskPilot.Console.Cli;
using DeskPilot.Console.Llm;

namespace DeskPilot.Console.Settings;

public sealed class SettingsDialog : Form
{
    private readonly AppSettings _settings;
    private TextBox _apiKeyBox = null!;
    private TextBox _baseUrlBox = null!;
    private ComboBox _modelBox = null!;
    private TextBox _chromePathBox = null!;
    private NumericUpDown _portBox = null!;
    private TextBox _cliPathBox = null!;
    private TextBox _domainAccountBox = null!;
    private TextBox _domainPasswordBox = null!;
    private TextBox _autoLoginHostsBox = null!;
    private Button _testConnectionButton = null!;
    private Button _saveButton = null!;
    private Label _statusLabel = null!;

    public AppSettings? Result { get; private set; }

    public SettingsDialog(AppSettings settings)
    {
        _settings = settings;

        Text = "DeskPilot 设置";
        ClientSize = new Size(700, 600);
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        AutoScaleMode = AutoScaleMode.Dpi;

        InitializeLayout();
        LoadValues();
    }

    private void InitializeLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            ColumnCount = 3,
            RowCount = 14
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));

        _apiKeyBox = new TextBox { Dock = DockStyle.Fill, UseSystemPasswordChar = true };
        var showKeyBox = new CheckBox
        {
            Text = "显示",
            AutoSize = true,
            Anchor = AnchorStyles.Left
        };
        showKeyBox.CheckedChanged += (_, _) => _apiKeyBox.UseSystemPasswordChar = !showKeyBox.Checked;
        AddRow(root, 0, "API Key", _apiKeyBox, showKeyBox);

        _baseUrlBox = new TextBox { Dock = DockStyle.Fill };
        AddRow(root, 1, "服务地址", _baseUrlBox);
        AddHint(root, 2, "填写服务根地址即可，例如 https://example.internal；程序会自动补全 /v1。API Key 只保存在当前用户目录，不写入仓库。");

        _modelBox = new ComboBox
        {
            Dock = DockStyle.Fill,
            DropDownStyle = ComboBoxStyle.DropDown
        };
        _testConnectionButton = new Button
        {
            Text = "测试并加载",
            Dock = DockStyle.Fill,
            AutoSize = true
        };
        _testConnectionButton.Click += async (_, _) => await TestConnectionAsync();
        AddRow(root, 3, "模型", _modelBox, _testConnectionButton);

        _chromePathBox = new TextBox { Dock = DockStyle.Fill };
        AddRow(root, 4, "Chrome 路径", _chromePathBox,
            CreateBrowseButton(_chromePathBox, "Chrome 可执行文件|chrome.exe|可执行文件|*.exe"));
        AddHint(root, 5, "Chrome 和 CLI 路径可以留空，DeskPilot 会优先自动查找；只有自动查找失败时才需要手动选择。");

        _portBox = new NumericUpDown
        {
            Dock = DockStyle.Left,
            Width = 140,
            Minimum = 1,
            Maximum = 65535
        };
        AddRow(root, 6, "调试端口", _portBox);

        _cliPathBox = new TextBox { Dock = DockStyle.Fill };
        AddRow(root, 7, "CLI 路径", _cliPathBox,
            CreateBrowseButton(_cliPathBox, "win-agent CLI|win-agent.exe|可执行文件|*.exe"));

        _domainAccountBox = new TextBox { Dock = DockStyle.Fill };
        AddRow(root, 8, "域账号", _domainAccountBox);

        _domainPasswordBox = new TextBox { Dock = DockStyle.Fill, UseSystemPasswordChar = true };
        var showPasswordBox = new CheckBox
        {
            Text = "显示",
            AutoSize = true,
            Anchor = AnchorStyles.Left
        };
        showPasswordBox.CheckedChanged += (_, _) =>
            _domainPasswordBox.UseSystemPasswordChar = !showPasswordBox.Checked;
        AddRow(root, 9, "域密码", _domainPasswordBox, showPasswordBox);

        _autoLoginHostsBox = new TextBox { Dock = DockStyle.Fill };
        AddRow(root, 10, "自动登录域名", _autoLoginHostsBox);
        AddHint(root, 11,
            "域账号和密码保存在当前用户环境变量中，不进入 settings.json、LLM 或会话日志。域名可用分号分隔；只有匹配站点才会自动提交。环境变量对同一 Windows 用户运行的其他进程可见。");

        _statusLabel = new Label
        {
            AutoSize = true,
            ForeColor = Color.DimGray,
            Anchor = AnchorStyles.Left,
            Padding = new Padding(0, 6, 0, 6)
        };
        root.Controls.Add(_statusLabel, 1, 12);
        root.SetColumnSpan(_statusLabel, 2);

        var buttonPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            AutoSize = true
        };
        _saveButton = new Button { Text = "保存并启动", Width = 100, Height = 30 };
        var cancelButton = new Button
        {
            Text = "取消",
            Width = 80,
            Height = 30,
            DialogResult = DialogResult.Cancel
        };
        _saveButton.Click += (_, _) => SaveAndClose();
        buttonPanel.Controls.Add(_saveButton);
        buttonPanel.Controls.Add(cancelButton);
        root.Controls.Add(buttonPanel, 1, 13);
        root.SetColumnSpan(buttonPanel, 2);

        Controls.Add(root);
        AcceptButton = _saveButton;
        CancelButton = cancelButton;
    }

    private void LoadValues()
    {
        _apiKeyBox.Text = _settings.LlmApiKey;
        _baseUrlBox.Text = _settings.LlmBaseUrl;
        _modelBox.Text = _settings.LlmModel;
        _chromePathBox.Text = _settings.ChromePath;
        _portBox.Value = Math.Clamp(_settings.ChromeDebugPort, 1, 65535);
        _cliPathBox.Text = string.IsNullOrWhiteSpace(_settings.CliPath)
            ? CliClient.ResolveCliPath(_settings) ?? string.Empty
            : _settings.CliPath;
        var credentials = CredentialStore.Load();
        _domainAccountBox.Text = credentials?.Account ?? string.Empty;
        _domainPasswordBox.Text = credentials?.Password ?? string.Empty;
        _autoLoginHostsBox.Text = credentials == null
            ? string.Empty
            : string.Join("; ", credentials.AllowedHosts);
        _statusLabel.Text = "先填写服务地址和 API Key，再点击“测试并加载”选择服务实际支持的模型。";
    }

    private async Task TestConnectionAsync()
    {
        if (!TryGetEndpointInputs(out var apiKey, out var baseUrl, out var error))
        {
            ShowStatus(error, isError: true);
            return;
        }

        SetBusy(true);
        ShowStatus("正在连接服务并读取模型列表...", isError: false);
        try
        {
            var models = await LlmClient.GetAvailableModelsAsync(baseUrl, apiKey);
            var currentModel = _modelBox.Text.Trim();

            _modelBox.BeginUpdate();
            _modelBox.Items.Clear();
            _modelBox.Items.AddRange(models.Cast<object>().ToArray());
            _modelBox.EndUpdate();

            _modelBox.Text = models.Contains(currentModel, StringComparer.OrdinalIgnoreCase)
                ? currentModel
                : models[0];
            _baseUrlBox.Text = baseUrl;
            ShowStatus($"连接成功，已加载 {models.Count} 个模型。", isError: false, success: true);
        }
        catch (Exception ex)
        {
            ShowStatus($"连接失败：{ex.Message}", isError: true);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void SaveAndClose()
    {
        if (!TryGetEndpointInputs(out var apiKey, out var baseUrl, out var error))
        {
            ShowStatus(error, isError: true);
            return;
        }

        var model = _modelBox.Text.Trim();
        if (model.Length == 0)
        {
            ShowStatus("请选择或填写模型。", isError: true);
            return;
        }

        var candidate = new AppSettings
        {
            LlmApiKey = apiKey,
            LlmBaseUrl = baseUrl,
            LlmModel = model,
            ChromePath = _chromePathBox.Text.Trim(),
            ChromeDebugPort = (int)_portBox.Value,
            CliPath = _cliPathBox.Text.Trim()
        };
        if (CliClient.ResolveCliPath(candidate) == null)
        {
            ShowStatus("未找到 win-agent.exe，请先构建 CLI 或点击“浏览...”选择文件。", isError: true);
            return;
        }

        if (!TryGetDomainCredentials(out var credentials, out error))
        {
            ShowStatus(error, isError: true);
            return;
        }

        try
        {
            CredentialStore.Save(credentials);
        }
        catch (Exception ex)
        {
            ShowStatus($"保存当前用户环境变量失败：{ex.Message}", isError: true);
            return;
        }

        Result = candidate;
        DialogResult = DialogResult.OK;
        Close();
    }

    private bool TryGetDomainCredentials(out DomainCredentials? credentials, out string error)
    {
        credentials = null;
        error = string.Empty;
        var account = _domainAccountBox.Text.Trim();
        var password = _domainPasswordBox.Text;
        var hostsText = _autoLoginHostsBox.Text.Trim();

        if (account.Length == 0 && password.Length == 0 && hostsText.Length == 0)
            return true;

        if (account.Length == 0 || password.Length == 0)
        {
            error = "域账号和域密码必须同时填写；全部留空可清除自动登录配置。";
            return false;
        }

        if (!CredentialStore.TryNormalizeHosts(hostsText, out var normalized, out var hosts, out error))
            return false;

        _autoLoginHostsBox.Text = normalized;
        credentials = new DomainCredentials(account, password, hosts);
        return true;
    }

    private bool TryGetEndpointInputs(out string apiKey, out string baseUrl, out string error)
    {
        apiKey = _apiKeyBox.Text.Trim();
        baseUrl = LlmClient.NormalizeBaseUrl(_baseUrlBox.Text);
        error = string.Empty;

        if (apiKey.Length == 0)
        {
            error = "请填写 API Key。";
            return false;
        }

        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            error = "服务地址无效，请填写完整的 http:// 或 https:// 地址。";
            return false;
        }

        return true;
    }

    private void SetBusy(bool busy)
    {
        _testConnectionButton.Enabled = !busy;
        _saveButton.Enabled = !busy;
        UseWaitCursor = busy;
    }

    private void ShowStatus(string message, bool isError, bool success = false)
    {
        _statusLabel.Text = message;
        _statusLabel.ForeColor = isError
            ? Color.Firebrick
            : success ? Color.DarkGreen : Color.DimGray;
    }

    private static void AddRow(TableLayoutPanel table, int row, string labelText, Control input, Control? action = null)
    {
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        var label = new Label
        {
            Text = labelText,
            AutoSize = true,
            Anchor = AnchorStyles.Left
        };
        input.Margin = new Padding(3, 7, 3, 7);
        table.Controls.Add(label, 0, row);
        table.Controls.Add(input, 1, row);
        if (action != null)
        {
            action.Margin = new Padding(5, 5, 3, 5);
            table.Controls.Add(action, 2, row);
        }
    }

    private static void AddHint(TableLayoutPanel table, int row, string text)
    {
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        var hint = new Label
        {
            Text = text,
            AutoSize = false,
            Dock = DockStyle.Fill,
            ForeColor = Color.DimGray,
            Padding = new Padding(3, 0, 3, 4)
        };
        table.Controls.Add(hint, 1, row);
        table.SetColumnSpan(hint, 2);
    }

    private static Button CreateBrowseButton(TextBox target, string filter)
    {
        var button = new Button { Text = "浏览...", Dock = DockStyle.Fill };
        button.Click += (_, _) =>
        {
            using var dialog = new OpenFileDialog
            {
                Filter = filter,
                CheckFileExists = true,
                FileName = target.Text
            };
            if (dialog.ShowDialog() == DialogResult.OK)
                target.Text = dialog.FileName;
        };
        return button;
    }
}
