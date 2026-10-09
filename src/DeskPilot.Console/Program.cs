namespace DeskPilot.Console;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        var settings = Settings.SettingsStore.Load() ?? new Settings.AppSettings();
        while (string.IsNullOrWhiteSpace(settings.LlmApiKey) ||
               Cli.CliClient.ResolveCliPath(settings) == null)
        {
            using var dialog = new Settings.SettingsDialog(settings);
            if (dialog.ShowDialog() != DialogResult.OK || dialog.Result == null)
                return;

            settings = dialog.Result;
            if (string.IsNullOrWhiteSpace(settings.LlmApiKey))
            {
                MessageBox.Show("请填写 LLM API Key。", "DeskPilot",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                continue;
            }

            if (Cli.CliClient.ResolveCliPath(settings) == null)
            {
                MessageBox.Show("未找到 win-agent.exe，请选择有效的 CLI 路径。", "DeskPilot",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                continue;
            }

            Settings.SettingsStore.Save(settings);
        }

        using var sessionRecorder = new Session.SessionRecorder();
        var chromeLauncher = new Chrome.ChromeLauncher(settings);
        var cliClient = new Cli.CliClient(settings, sessionRecorder);

        using var form = new MainForm(settings, chromeLauncher, cliClient, sessionRecorder);
        Application.Run(form);
    }
}
