using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DeskPilot.Console.UI;

namespace DeskPilot.Console.Session;

public sealed class SessionHistoryDialog : Form
{
    private readonly ComboBox _sessionBox = new();
    private readonly DataGridView _eventsGrid = new();
    private readonly Label _summaryLabel = new();
    private List<SessionLogEntry> _entries = [];

    public SessionHistoryDialog(string currentSessionPath)
    {
        Text = "DeskPilot 会话记录";
        ClientSize = new Size(1040, 660);
        MinimumSize = new Size(820, 520);
        StartPosition = FormStartPosition.CenterParent;
        BackColor = AppTheme.Background;
        Font = AppTheme.DefaultFont();

        InitializeLayout();
        LoadSessions(currentSessionPath);
    }

    private void InitializeLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(14),
            RowCount = 3,
            ColumnCount = 1,
            BackColor = AppTheme.Background
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));

        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3 };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));
        header.Controls.Add(new Label
        {
            Text = "会话",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = AppTheme.DefaultFont(10F, FontStyle.Bold)
        }, 0, 0);
        _sessionBox.Dock = DockStyle.Fill;
        _sessionBox.DropDownStyle = ComboBoxStyle.DropDownList;
        _sessionBox.Margin = new Padding(0, 8, 12, 8);
        _sessionBox.SelectedIndexChanged += (_, _) => LoadSelectedSession();
        header.Controls.Add(_sessionBox, 1, 0);
        _summaryLabel.Dock = DockStyle.Fill;
        _summaryLabel.TextAlign = ContentAlignment.MiddleRight;
        _summaryLabel.ForeColor = AppTheme.TextMuted;
        header.Controls.Add(_summaryLabel, 2, 0);

        ConfigureGrid();

        var footer = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Padding = new Padding(0, 10, 0, 0)
        };
        var closeButton = new Button { Text = "关闭", Width = 82, Height = 32, DialogResult = DialogResult.Cancel };
        var exportButton = new Button { Text = "生成 NDJSON 脚本", Width = 150, Height = 32 };
        var selectCommandsButton = new Button { Text = "选择成功命令", Width = 130, Height = 32 };
        AppTheme.StyleSecondaryButton(closeButton);
        AppTheme.StylePrimaryButton(exportButton);
        AppTheme.StyleSecondaryButton(selectCommandsButton);
        exportButton.Click += (_, _) => ExportSelectedCommands();
        selectCommandsButton.Click += (_, _) => SelectSuccessfulCommands();
        footer.Controls.Add(closeButton);
        footer.Controls.Add(exportButton);
        footer.Controls.Add(selectCommandsButton);

        root.Controls.Add(header, 0, 0);
        root.Controls.Add(_eventsGrid, 0, 1);
        root.Controls.Add(footer, 0, 2);
        Controls.Add(root);
        CancelButton = closeButton;
    }

    private void ConfigureGrid()
    {
        _eventsGrid.Dock = DockStyle.Fill;
        _eventsGrid.BackgroundColor = AppTheme.Surface;
        _eventsGrid.BorderStyle = BorderStyle.FixedSingle;
        _eventsGrid.AllowUserToAddRows = false;
        _eventsGrid.AllowUserToDeleteRows = false;
        _eventsGrid.AllowUserToResizeRows = false;
        _eventsGrid.RowHeadersVisible = false;
        _eventsGrid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        _eventsGrid.AutoGenerateColumns = false;
        _eventsGrid.Columns.Add(new DataGridViewCheckBoxColumn { Name = "Selected", HeaderText = "选择", Width = 54 });
        _eventsGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Sequence", HeaderText = "序号", Width = 60, ReadOnly = true });
        _eventsGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Time", HeaderText = "时间", Width = 90, ReadOnly = true });
        _eventsGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Source", HeaderText = "来源", Width = 90, ReadOnly = true });
        _eventsGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Status", HeaderText = "状态", Width = 80, ReadOnly = true });
        _eventsGrid.Columns.Add(new DataGridViewTextBoxColumn
        {
            Name = "Summary",
            HeaderText = "事件 / 指令 / 结果",
            AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill,
            ReadOnly = true
        });
        _eventsGrid.CellDoubleClick += (_, e) =>
        {
            if (e.RowIndex < 0 || _eventsGrid.Rows[e.RowIndex].Tag is not SessionLogEntry entry)
                return;
            MessageBox.Show(entry.Detail, $"事件 #{entry.Sequence}", MessageBoxButtons.OK, MessageBoxIcon.Information);
        };
    }

    private void LoadSessions(string currentSessionPath)
    {
        Directory.CreateDirectory(SessionRecorder.SessionsRoot);
        var files = Directory.GetFiles(SessionRecorder.SessionsRoot, "session-*.ndjson", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTime)
            .ToArray();
        _sessionBox.Items.Clear();
        foreach (var file in files)
            _sessionBox.Items.Add(new SessionChoice(file, BuildSessionLabel(file, file == currentSessionPath)));

        if (_sessionBox.Items.Count > 0)
            _sessionBox.SelectedIndex = Math.Max(0, Array.IndexOf(files, currentSessionPath));
    }

    private void LoadSelectedSession()
    {
        _eventsGrid.Rows.Clear();
        if (_sessionBox.SelectedItem is not SessionChoice choice)
            return;

        _entries = SessionLogReader.Read(choice.Path);
        foreach (var entry in _entries)
        {
            var index = _eventsGrid.Rows.Add(false, entry.Sequence, entry.Timestamp.ToString("HH:mm:ss"),
                entry.Source, entry.Status, entry.DisplaySummary);
            _eventsGrid.Rows[index].Tag = entry;
        }
        var commandCount = _entries.Count(entry => entry.IsSuccessfulCliCommand);
        _summaryLabel.Text = $"{_entries.Count} 个事件 · {commandCount} 条成功命令";
    }

    private void SelectSuccessfulCommands()
    {
        foreach (DataGridViewRow row in _eventsGrid.Rows)
        {
            var select = row.Tag is SessionLogEntry entry && entry.IsSuccessfulCliCommand;
            row.Cells["Selected"].Value = select;
        }
    }

    private void ExportSelectedCommands()
    {
        var selected = _eventsGrid.Rows.Cast<DataGridViewRow>()
            .Where(row => Convert.ToBoolean(row.Cells["Selected"].Value ?? false))
            .Select(row => row.Tag as SessionLogEntry)
            .Where(entry => entry?.IsSuccessfulCliCommand == true)
            .Cast<SessionLogEntry>()
            .ToArray();
        if (selected.Length == 0)
        {
            MessageBox.Show("请先选择至少一条成功的 CLI 命令。", "DeskPilot",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        using var dialog = new SaveFileDialog
        {
            Filter = "NDJSON 脚本|*.ndjson|JSON Lines|*.jsonl",
            FileName = $"deskpilot-script-{DateTime.Now:yyyyMMdd-HHmmss}.ndjson",
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
            return;

        File.WriteAllText(dialog.FileName, SessionLogReader.BuildScript(selected), new UTF8Encoding(false));
        MessageBox.Show($"已导出 {selected.Length} 条命令。\n{dialog.FileName}", "DeskPilot",
            MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private static string BuildSessionLabel(string path, bool current)
    {
        var timestamp = File.GetCreationTime(path).ToString("yyyy-MM-dd HH:mm:ss");
        return current ? $"{timestamp}（当前会话）" : timestamp;
    }

    private sealed record SessionChoice(string Path, string Label)
    {
        public override string ToString() => Label;
    }
}

internal sealed record SessionLogEntry(
    long Sequence,
    DateTimeOffset Timestamp,
    string Kind,
    string Source,
    string Status,
    string Summary,
    string? Method,
    string? ParamsJson,
    string? ResultJson)
{
    internal bool IsSuccessfulCliCommand => Kind == "cli.response" && Status == "success" && !string.IsNullOrWhiteSpace(Method);

    internal string DisplaySummary => !string.IsNullOrWhiteSpace(Summary)
        ? Summary.ReplaceLineEndings(" ")
        : Method ?? Kind;

    internal string Detail => $"类型: {Kind}\n来源: {Source}\n状态: {Status}\n方法: {Method ?? "-"}\n\n参数:\n{ParamsJson ?? "-"}\n\n结果:\n{ResultJson ?? "-"}";
}

internal static class SessionLogReader
{
    internal static List<SessionLogEntry> Read(string path)
    {
        var entries = new List<SessionLogEntry>();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
                continue;
            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                entries.Add(new SessionLogEntry(
                    root.GetProperty("sequence").GetInt64(),
                    DateTimeOffset.Parse(root.GetProperty("timestamp").GetString()!),
                    root.GetProperty("kind").GetString() ?? "unknown",
                    root.GetProperty("source").GetString() ?? "unknown",
                    root.GetProperty("status").GetString() ?? "unknown",
                    root.TryGetProperty("summary", out var summary) ? summary.GetString() ?? string.Empty : string.Empty,
                    root.TryGetProperty("method", out var method) ? method.GetString() : null,
                    root.TryGetProperty("params", out var parameters) ? parameters.GetRawText() : null,
                    root.TryGetProperty("result", out var result) ? result.GetRawText() : null));
            }
            catch (JsonException)
            {
                // Ignore a partially written final line while the current session is active.
            }
        }
        return entries;
    }

    internal static string BuildScript(IEnumerable<SessionLogEntry> entries)
    {
        var lines = new List<string>();
        var id = 0;
        foreach (var entry in entries.Where(item => item.IsSuccessfulCliCommand))
        {
            var command = new JsonObject
            {
                ["id"] = (++id).ToString(),
                ["method"] = entry.Method
            };
            if (!string.IsNullOrWhiteSpace(entry.ParamsJson))
                command["params"] = JsonNode.Parse(entry.ParamsJson);
            lines.Add(command.ToJsonString());
        }
        return string.Join(Environment.NewLine, lines) + Environment.NewLine;
    }
}
