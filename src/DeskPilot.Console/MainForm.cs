using System.Text.Json;
using DeskPilot.Console.Chrome;
using DeskPilot.Console.Cli;
using DeskPilot.Console.Session;
using DeskPilot.Console.Settings;
using DeskPilot.Console.UI;

namespace DeskPilot.Console;

public sealed class MainForm : Form
{
    private readonly AppSettings _settings;
    private readonly ChromeLauncher _chromeLauncher;
    private readonly ChromeStatusReader _chromeStatusReader = new();
    private readonly CliClient _cliClient;
    private readonly SessionRecorder _sessionRecorder;
    private MenuStrip _menuStrip = null!;
    private Label _chromeStatusLabel = null!;
    private Label _chromeUrlLabel = null!;
    private Button _refreshButton = null!;
    private Button _reopenChromeButton = null!;
    private ChatPanel _chatPanel = null!;
    private QuickActionPanel _quickActionPanel = null!;
    private System.Windows.Forms.Timer _chromeTrackingTimer = null!;
    private readonly CancellationTokenSource _lifetimeCts = new();
    private bool _refreshInProgress;

    public MainForm(
        AppSettings settings,
        ChromeLauncher chromeLauncher,
        CliClient cliClient,
        SessionRecorder sessionRecorder)
    {
        _settings = settings;
        _chromeLauncher = chromeLauncher;
        _cliClient = cliClient;
        _sessionRecorder = sessionRecorder;

        Text = "DeskPilot — 正在启动";
        Width = 460;
        Height = 900;
        MinimumSize = new Size(400, 680);
        MaximumSize = new Size(560, 1200);
        StartPosition = FormStartPosition.Manual;
        BackColor = AppTheme.Background;
        ForeColor = AppTheme.Text;
        Font = AppTheme.DefaultFont();

        InitializeMenu();
        InitializeLayout();
        _chromeTrackingTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        _chromeTrackingTimer.Tick += async (_, _) => await RefreshChromeStatusAsync();
    }

    private void InitializeMenu()
    {
        _menuStrip = new MenuStrip
        {
            Dock = DockStyle.Fill,
            AutoSize = false,
            Height = 38,
            BackColor = AppTheme.Surface,
            ForeColor = AppTheme.Text,
            Font = AppTheme.DefaultFont(),
            Padding = new Padding(12, 6, 0, 6)
        };

        var settingsItem = new ToolStripMenuItem("设置(&S)");
        settingsItem.Click += (_, _) =>
        {
            using var dialog = new Settings.SettingsDialog(_settings);
            if (dialog.ShowDialog() == DialogResult.OK && dialog.Result != null)
            {
                Settings.SettingsStore.Save(dialog.Result);
                MessageBox.Show("设置已保存。重启应用后生效。", "DeskPilot",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        };
        var historyItem = new ToolStripMenuItem("会话记录(&H)");
        historyItem.Click += (_, _) =>
        {
            using var dialog = new SessionHistoryDialog(_sessionRecorder.SessionFilePath);
            dialog.ShowDialog(this);
        };
        var exitItem = new ToolStripMenuItem("退出(&X)");
        exitItem.Click += (_, _) => Close();
        _menuStrip.Items.Add(settingsItem);
        _menuStrip.Items.Add(historyItem);
        _menuStrip.Items.Add(exitItem);
        MainMenuStrip = _menuStrip;
    }

    private void InitializeLayout()
    {
        var chromePanel = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12, 8, 12, 8),
            BackColor = AppTheme.Surface,
            BorderStyle = BorderStyle.FixedSingle
        };
        var chromeLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 3,
            BackColor = AppTheme.Surface,
            Margin = new Padding(0)
        };
        chromeLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        chromeLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
        chromeLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        chromeLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        chromeLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        _chromeStatusLabel = new Label
        {
            Text = "Chrome 未启动",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = AppTheme.DefaultFont(10.5F, FontStyle.Bold),
            ForeColor = AppTheme.Text
        };
        _chromeUrlLabel = new Label
        {
            Text = "URL: -",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            AutoEllipsis = true,
            ForeColor = AppTheme.TextMuted,
            Font = AppTheme.DefaultFont(8F)
        };
        _refreshButton = new Button { Text = "刷新状态", Dock = DockStyle.Fill, Margin = new Padding(6, 2, 0, 2) };
        _reopenChromeButton = new Button { Text = "重新打开", Dock = DockStyle.Fill, Margin = new Padding(6, 2, 0, 2) };
        AppTheme.StyleSecondaryButton(_refreshButton);
        AppTheme.StylePrimaryButton(_reopenChromeButton);
        _refreshButton.Click += async (_, _) => await RefreshChromeStatusFromUiAsync();
        _reopenChromeButton.Click += async (_, _) => await ReopenChromeAsync();

        chromeLayout.Controls.Add(_chromeStatusLabel, 0, 0);
        chromeLayout.Controls.Add(_refreshButton, 1, 0);
        chromeLayout.Controls.Add(_chromeUrlLabel, 0, 1);
        chromeLayout.Controls.Add(_reopenChromeButton, 1, 1);
        var tip = new Label
        {
            Text = "调试浏览器被关闭时，可在这里重新打开。",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = AppTheme.TextMuted,
            Font = AppTheme.DefaultFont(8F)
        };
        chromeLayout.Controls.Add(tip, 0, 2);
        chromeLayout.SetColumnSpan(tip, 2);
        chromePanel.Controls.Add(chromeLayout);

        _chatPanel = new ChatPanel(_cliClient, _settings, _sessionRecorder) { Dock = DockStyle.Fill };
        _quickActionPanel = new QuickActionPanel(_cliClient, _settings, _chatPanel, _sessionRecorder)
        {
            Dock = DockStyle.Bottom,
            Height = 148
        };

        var assistantCard = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = AppTheme.Surface,
            BorderStyle = BorderStyle.FixedSingle
        };
        assistantCard.Controls.Add(_chatPanel);
        assistantCard.Controls.Add(_quickActionPanel);

        var content = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(10, 8, 10, 10),
            BackColor = AppTheme.Background
        };
        content.Controls.Add(assistantCard);

        var rootLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            BackColor = AppTheme.Background,
            Margin = new Padding(0),
            Padding = new Padding(0)
        };
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 112));
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        rootLayout.Controls.Add(_menuStrip, 0, 0);
        rootLayout.Controls.Add(chromePanel, 0, 1);
        rootLayout.Controls.Add(content, 0, 2);
        Controls.Add(rootLayout);
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        var workArea = Screen.FromControl(this).WorkingArea;
        Location = new Point(workArea.Right - Width - 12, workArea.Top + 12);
        _chromeTrackingTimer.Start();
        await InitializeChromeAsync();
    }

    private async Task InitializeChromeAsync()
    {
        _chromeStatusLabel.Text = "Chrome: 正在启动...";
        _chromeStatusLabel.ForeColor = AppTheme.Warning;
        try
        {
            await _chromeLauncher.LaunchAsync(_lifetimeCts.Token);
            _cliClient.Connect();
            _sessionRecorder.Record("application.ready", "application", "success", "Chrome 与 CLI 已连接，等待用户指令");
            _chromeStatusLabel.Text = $"Chrome: 已连接 · {_chromeLauncher.DebugPort}";
            _chromeStatusLabel.ForeColor = AppTheme.Success;
            Text = "DeskPilot — 等待指令";
            await RefreshChromeStatusAsync();
        }
        catch (OperationCanceledException) when (_lifetimeCts.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _sessionRecorder.Record("application.ready", "application", "error", ex.Message);
            SetChromeUnavailable(ex.Message);
        }
    }

    private async Task ReopenChromeAsync()
    {
        _reopenChromeButton.Enabled = false;
        _reopenChromeButton.Text = "启动中...";
        try
        {
            _chromeLauncher.Stop();
            await _chromeLauncher.LaunchAsync(_lifetimeCts.Token);
            if (!_cliClient.IsConnected)
                _cliClient.Connect();
            _chromeStatusLabel.Text = $"Chrome: 已重新打开 · {_chromeLauncher.DebugPort}";
            _chromeStatusLabel.ForeColor = AppTheme.Success;
            Text = "DeskPilot — 等待指令";
            await RefreshChromeStatusAsync();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            SetChromeUnavailable(ex.Message);
            MessageBox.Show($"重新打开 Chrome 失败：{ex.Message}", "DeskPilot",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _reopenChromeButton.Text = "重新打开";
            _reopenChromeButton.Enabled = true;
        }
    }

    private async Task RefreshChromeStatusAsync()
    {
        if (_refreshInProgress || !_cliClient.IsConnected)
            return;

        _refreshInProgress = true;
        try
        {
            var target = await _chromeStatusReader.ReadAsync(
                _chromeLauncher.DebugPort,
                _lifetimeCts.Token);
            if (target == null)
            {
                SetChromeUnavailable("没有打开的浏览器页面");
                return;
            }

            _chromeUrlLabel.Text = $"URL: {target.Url}";
            _chromeStatusLabel.Text = $"Chrome: 已连接 · {_chromeLauncher.DebugPort}";
            _chromeStatusLabel.ForeColor = AppTheme.Success;
        }
        catch (OperationCanceledException) when (_lifetimeCts.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            SetChromeUnavailable(ex.Message);
        }
        finally
        {
            _refreshInProgress = false;
        }
    }

    private async Task RefreshChromeStatusFromUiAsync()
    {
        _refreshButton.Enabled = false;
        _refreshButton.Text = "刷新中...";
        try { await RefreshChromeStatusAsync(); }
        finally
        {
            _refreshButton.Text = "刷新状态";
            _refreshButton.Enabled = true;
        }
    }

    private void SetChromeUnavailable(string detail)
    {
        _chromeStatusLabel.Text = "Chrome: 未连接";
        _chromeStatusLabel.ForeColor = AppTheme.Danger;
        _chromeUrlLabel.Text = $"URL: {detail}";
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _chromeTrackingTimer.Stop();
        _chromeTrackingTimer.Dispose();
        _lifetimeCts.Cancel();
        _cliClient.Dispose();
        _chromeLauncher.Stop();
        _lifetimeCts.Dispose();
        base.OnFormClosed(e);
    }
}
