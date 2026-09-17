using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text.Json;
using System.Windows.Forms;
using WindowsAgent;

internal static class Program
{
    private static int _assertions;
    [STAThread]
    private static int Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        if (args.Length == 2 && args[0] == "--fixture")
        {
            using var form = new Form { Text = args[1], ClientSize = new Size(960, 540),
                StartPosition = FormStartPosition.CenterScreen, BackColor = Color.White };
            form.Paint += (_, e) => Draw(e.Graphics);
            form.Shown += (_, _) => Console.WriteLine("ready");
            Application.Run(form);
            return 0;
        }
        try
        {
            GeometryTests();
            RecognitionTests();
            if (args.Length == 2 && args[0] == "--desktop") DesktopTest(Path.GetFullPath(args[1])).GetAwaiter().GetResult();
            Console.WriteLine($"PASS: {_assertions} OCR assertions");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }

    private static void Check(bool value, string message)
    {
        _assertions++;
        if (!value) throw new InvalidOperationException(message);
    }

    private static TextRecognitionResult Result(params TextBlock[] blocks)
        => new("test", "zh", 960, 540, string.Join("\n", blocks.Select(b => b.Text)), blocks);
    private static TextBlock Line(string text, int x = 100, int y = 100, int width = 200, params TextWord[] words)
        => new("line", text, new(x, y, width, 30), words);
    private static TextWord Word(string text, int x, int y = 100, int width = 100)
        => new(text, new(x, y, width, 30));

    private static void GeometryTests()
    {
        var primary = Result(Line("Help Center"));
        var windows = Result(Line("Help Center", words: [Word("Help", 100), Word("Center", 200)]));
        var matched = DesktopTextRecognition.MatchWords(primary, windows);
        Check(matched.Blocks[0].Words.Count == 2, "exact text and same location gets real words");
        Check(matched.Text == primary.Text && matched.Backend == primary.Backend, "Windows never replaces Tiny text/backend");
        Check(DesktopTextRecognition.MatchWords(primary, Result(Line("Help Center", 500, words: [Word("Help", 500)]))).Blocks[0].Words.Count == 0, "same text elsewhere rejected");
        Check(DesktopTextRecognition.MatchWords(primary, Result(Line("Help center", words: [Word("Help", 100), Word("center", 200)]))).Blocks[0].Words.Count == 0, "case differences rejected");
        Check(DesktopTextRecognition.MatchWords(Result(Line("user_42")), Result(Line("user42", words: [Word("user42", 100, width: 200)]))).Blocks[0].Words.Count == 0, "punctuation differences rejected");
        Check(DesktopTextRecognition.MatchWords(primary, Result(Line("Help Center", words: [Word("Other", 100)]))).Blocks[0].Words.Count == 0, "word text must agree too");
        Check(DesktopTextRecognition.MatchWords(primary, windows with { ImageWidth = 961 }).Blocks[0].Words.Count == 0, "image coordinate spaces must agree");
        var split = Result(Line("Center", 200, width: 100, words: [Word("Center", 200)]), Line("Help", width: 100, words: [Word("Help", 100)]));
        Check(DesktopTextRecognition.MatchWords(primary, split).Blocks[0].Words.Count == 2, "Windows line fragments ordered geometrically");
        Check(DesktopTextRecognition.MatchWords(Result(Line("Help Center"), Line("Help Center")), windows).Blocks.All(b => b.Words.Count == 0), "ambiguous geometric owner rejected");
        Check(DesktopTextRecognition.MatchWords(primary, Result(Line("Help Center", words: [Word("Help", 100, 200), Word("Center", 200, 200)]))).Blocks[0].Words.Count == 0, "words in another row rejected");
        Check(DesktopTextRecognition.MatchWords(primary, Result(Line("Help Center", width: 40, words: [Word("HelpCenter", 100, width: 40)]))).Blocks[0].Words.Count == 0, "tiny partial coverage cannot claim a whole line");
        var duplicate = Result(Line("Help Center"), Line("Help Center", y: 200));
        var duplicateMatched = DesktopTextRecognition.MatchWords(duplicate, windows);
        Check(duplicateMatched.Blocks[0].Words.Count == 2 && duplicateMatched.Blocks[1].Words.Count == 0, "same wording on different rows not reused");
        var bounds = DesktopTextRecognition.EnclosingBounds([-2f, 50.2f, 55f, 0f], [8.1f, 2f, 40f, 42.8f], 100, 100);
        Check(bounds == new TextBounds(0, 2, 55, 41), "quadrilateral maps to enclosing, clamped native pixels");
    }

    private static void Draw(Graphics graphics)
    {
        graphics.Clear(Color.White);
        using var title = new Font("Segoe UI", 28);
        using var font = new Font("Microsoft YaHei", 22);
        graphics.DrawString("DeskPilot OCR Fixture", title, Brushes.Black, 60, 60);
        graphics.DrawString("Please open Help Center for details.", font, Brushes.Black, 60, 180);
        graphics.DrawString("今天下午三点开会", font, Brushes.Black, 60, 280);
        graphics.DrawString("Save", font, Brushes.Black, 60, 380);
    }

    private static void RecognitionTests()
    {
        var path = Path.Combine(Path.GetTempPath(), $"deskpilot-ocr-{Guid.NewGuid():N}.png");
        try
        {
            using (var bitmap = new Bitmap(960, 540))
            {
                using (var graphics = Graphics.FromImage(bitmap)) Draw(graphics);
                bitmap.Save(path, ImageFormat.Png);
            }
            var called = 0;
            var code = "OCR_LANGUAGE_UNAVAILABLE";
            using var provider = new DesktopTextRecognition(_ => { called++; throw new AgentException(code, "fixture", false); });
            var first = provider.Recognize(path, false);
            Check(first.Recognition.Backend == DesktopTextRecognition.Backend, "default uses Tiny");
            Check(first.Recognition.Text.Contains("Help Center", StringComparison.Ordinal), "real Tiny reads inline target");
            Check(first.Recognition.Text.Contains("今天下午三点开会", StringComparison.Ordinal), "real Tiny reads Chinese body");
            Check(first.Recognition.Blocks.All(b => b.Words.Count == 0), "Tiny does not fabricate word boxes");
            Check(called == 0 && first.WordLocalization.Status == "not_requested", "default never calls Windows localizer");
            var repeat = provider.Recognize(path, false);
            Check(first.Recognition.Text == repeat.Recognition.Text, "session model reuse gives stable text");
            foreach (var failure in new[] { "OCR_LANGUAGE_UNAVAILABLE", "OCR_UNAVAILABLE", "OCR_FAILED" })
            {
                code = failure;
                var degraded = provider.Recognize(path, true);
                Check(degraded.Recognition.Text == first.Recognition.Text && degraded.WordLocalization.Status == "unavailable" &&
                    degraded.WordLocalization.ErrorCode == failure, "optional Windows failure preserves Tiny: " + failure);
            }
            Check(called == 3, "Windows called only when requested");
            var checks = 0;
            try
            {
                provider.Recognize(path, true, () => { checks++; throw new AgentException("ACTIVITY_CANCELLED", "fixture", true); });
                throw new InvalidOperationException("cancelled OCR accepted");
            }
            catch (AgentException ex) { Check(ex.Code == "ACTIVITY_CANCELLED" && checks == 1 && called == 3, "cancellation checkpoint prevents OCR work"); }
            checks = 0;
            try
            {
                provider.Recognize(path, true, () =>
                {
                    if (++checks == 3) throw new AgentException("ACTIVITY_CANCELLED", "fixture", true);
                });
                throw new InvalidOperationException("post-inference cancellation ignored");
            }
            catch (AgentException ex) { Check(ex.Code == "ACTIVITY_CANCELLED" && called == 3, "post-inference cancellation prevents optional Windows work"); }
            checks = 0;
            try
            {
                provider.Recognize(path, true, () =>
                {
                    if (++checks == 4) throw new AgentException("ACTIVITY_CANCELLED", "fixture", true);
                });
                throw new InvalidOperationException("optional-failure cancellation ignored");
            }
            catch (AgentException ex) { Check(ex.Code == "ACTIVITY_CANCELLED" && called == 4, "optional failure does not hide cancellation"); }
            try { provider.Recognize(path + ".missing", false); throw new InvalidOperationException("missing input accepted"); }
            catch (AgentException ex) { Check(ex.Code == "OCR_FAILED", "decode errors stay structured and do not fall back"); }
            provider.Dispose();
            provider.Dispose();
            try { provider.Recognize(path, false); throw new InvalidOperationException("disposed provider reused"); }
            catch (ObjectDisposedException) { Check(true, "model owner disposes idempotently"); }
        }
        finally { File.Delete(path); }
    }

    private static Process Start(string executable, params string[] args)
    {
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        return Process.Start(info) ?? throw new InvalidOperationException("could not start test child");
    }

    private static async Task DesktopTest(string executable)
    {
        var title = $"DeskPilot OCR test {Guid.NewGuid():N}";
        using var fixture = Start(Environment.ProcessPath!, "--fixture", title);
        using var cli = Start(executable, "exec", "--stdin", "--format", "ndjson");
        var fixtureErrors = fixture.StandardError.ReadToEndAsync();
        var cliErrors = cli.StandardError.ReadToEndAsync();
        var screenshots = new List<string>();
        var id = 0;
        async Task<JsonElement> Request(string method, object parameters)
        {
            await cli.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { id = (++id).ToString(), method, @params = parameters }));
            await cli.StandardInput.FlushAsync();
            var line = await cli.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(45));
            using var response = JsonDocument.Parse(line ?? throw new InvalidOperationException("CLI EOF"));
            return response.RootElement.Clone();
        }
        try
        {
            Check(await fixture.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15)) == "ready", "isolated fixture ready");
            var ready = await Request("wait.window", new { title_exact = title, timeout_ms = 5000, show_overlay = false, restore_original_window = true });
            Check(ready.GetProperty("ok").GetBoolean(), "fixture is discoverable through the public window provider");
            var capabilities = await Request("capabilities", new { });
            Check(capabilities.GetProperty("result").GetProperty("execution_layers").EnumerateArray().Any(e => e.GetString() == DesktopTextRecognition.Backend), "capabilities advertises Tiny");
            var doctor = await Request("doctor", new { });
            var desktopText = doctor.GetProperty("result").GetProperty("desktop_text");
            Check(desktopText.GetProperty("available").GetBoolean() && desktopText.GetProperty("backend").GetString() == DesktopTextRecognition.Backend, "doctor checks Tiny initialization");
            Check(desktopText.GetProperty("word_localization").GetProperty("backend").GetString() == DesktopTextRecognition.WordBackend, "doctor reports localizer independently");
            foreach (var words in new[] { false, true })
            {
                var response = await Request("messages.observe", new { title_exact = title, expected_identity = "DeskPilot OCR Fixture",
                    identity_region = new { x = 0, y = 0, width = 960, height = 190 },
                    content_region = new { x = 0, y = 190, width = 960, height = 350 },
                    include_text_blocks = true, include_words = words, show_overlay = false, restore_original_window = true });
                Check(response.GetProperty("ok").GetBoolean(), "public messages.observe succeeds: " + response.GetRawText());
                var result = response.GetProperty("result");
                screenshots.Add(result.GetProperty("screenshot").GetProperty("path").GetString()!);
                Check(result.GetProperty("screenshot").GetProperty("trusted").GetBoolean(), "trusted public capture");
                var recognition = result.GetProperty("recognition");
                Check(recognition.GetProperty("backend").GetString() == DesktopTextRecognition.Backend, "public default Tiny");
                Check(recognition.GetProperty("content").GetProperty("text").GetString()!.Contains("Help Center", StringComparison.Ordinal), "public body read");
                Check(result.GetProperty("context_identity").GetProperty("matched").GetBoolean(), "public identity verification");
                Check(recognition.GetProperty("word_localization").GetProperty("status").GetString() == (words ? "verified_matches" : "not_requested"), "on-demand real Windows word localization");
                if (words)
                {
                    var blocks = recognition.GetProperty("content").GetProperty("blocks").EnumerateArray().ToArray();
                    Check(blocks.Any(b => b.GetProperty("words").GetArrayLength() > 0), "public verified words present");
                }
            }
            var mismatch = await Request("messages.observe", new { title_exact = title, expected_identity = "Unrelated ZXQ identity 9384726", show_overlay = false, restore_original_window = true });
            Check(!mismatch.GetProperty("ok").GetBoolean() && mismatch.GetProperty("error").GetProperty("code").GetString() == "CONTEXT_IDENTITY_MISMATCH", "wrong identity still rejected");
            var closed = await Request("close", new { });
            Check(closed.GetProperty("ok").GetBoolean(), "public close");
            cli.StandardInput.Close();
            await cli.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Check(cli.ExitCode == 0, "public helper shuts down");
            Check(screenshots.All(path => !File.Exists(path)), "session-owned screenshots cleaned");
            Check(string.IsNullOrWhiteSpace(await cliErrors), "no OCR diagnostics pollute stderr");
        }
        finally
        {
            if (!cli.HasExited) { cli.Kill(entireProcessTree: true); await cli.WaitForExitAsync(); }
            if (!fixture.HasExited)
            {
                fixture.CloseMainWindow();
                try { await fixture.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
                catch (TimeoutException) { fixture.Kill(); await fixture.WaitForExitAsync(); }
            }
            _ = await fixtureErrors;
        }
    }
}
