namespace DeskPilot.Console.Settings;

public sealed class AppSettings
{
    public string LlmApiKey { get; set; } = string.Empty;
    public string LlmBaseUrl { get; set; } = "https://api.openai.com/v1";
    public string LlmModel { get; set; } = "gpt-4o";
    public string ChromePath { get; set; } = string.Empty;
    public int ChromeDebugPort { get; set; } = 9222;
    public string CliPath { get; set; } = string.Empty;
}
