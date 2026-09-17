using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Sdcb.SimdPaddleOCR;
using Sdcb.SimdPaddleOCR.Models.ChineseV6Tiny;

namespace WindowsAgent;

/// <summary>Session-owned Tiny reader with optional, independently verified Windows word geometry.</summary>
internal sealed class DesktopTextRecognition : IDisposable
{
    internal const string Backend = "paddle_tiny_offline";
    internal const string WordBackend = "windows_media_ocr_offline";
    private PaddleOcrAll? _ocr;
    private bool _disposed;
    private readonly Func<string, TextRecognitionResult> _readWords;

    internal DesktopTextRecognition(Func<string, TextRecognitionResult>? readWords = null)
        => _readWords = readWords ?? (path => OfflineTextRecognition.Recognize(path, null, 1d));

    private PaddleOcrAll GetModel()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        try
        {
            // Embedded model resources: no runtime download, global cache or model files.
            return _ocr ??= PaddleOcrAll.LoadAsync(ChineseV6TinyModels.Default).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            throw new AgentException("OCR_UNAVAILABLE", $"Tiny OCR could not be initialized: {ex.GetType().Name}.", false);
        }
    }

    internal object Diagnose()
    {
        try
        {
            _ = GetModel();
            return new { available = true, backend = Backend, language = "zh", offline = true,
                word_localization = OfflineTextRecognition.Diagnose() };
        }
        catch (AgentException ex)
        {
            return new { available = false, backend = Backend, error_code = ex.Code,
                word_localization = OfflineTextRecognition.Diagnose() };
        }
    }

    internal DesktopTextResult Recognize(string path, bool includeWords, Action? checkpoint = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        checkpoint?.Invoke();
        var ocr = GetModel();
        checkpoint?.Invoke();
        TextRecognitionResult primary;
        try
        {
            using var source = new Bitmap(path);
            using var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format24bppRgb);
            using (var graphics = Graphics.FromImage(bitmap)) graphics.DrawImageUnscaled(source, 0, 0);
            var stride = checked(bitmap.Width * 3);
            var pixels = new byte[checked(stride * bitmap.Height)];
            var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                for (var y = 0; y < bitmap.Height; y++)
                    Marshal.Copy(IntPtr.Add(data.Scan0, checked(y * data.Stride)), pixels, y * stride, stride);
            }
            finally { bitmap.UnlockBits(data); }
            // Use native-scale full layout once for both identity and body. Do not
            // inherit Windows' 3x crop heuristic or synthesize per-character boxes.
            var result = ocr.Run(pixels, bitmap.Width, bitmap.Height);
            var blocks = result.Lines.Where(line => !string.IsNullOrWhiteSpace(line.Text))
                .Select((line, index) => new TextBlock($"text_{index + 1:0000}", line.Text,
                    EnclosingBounds(new[] { line.Box.X1, line.Box.X2, line.Box.X3, line.Box.X4 },
                        new[] { line.Box.Y1, line.Box.Y2, line.Box.Y3, line.Box.Y4 }, bitmap.Width, bitmap.Height),
                    Array.Empty<TextWord>())).ToArray();
            primary = new TextRecognitionResult(Backend, "zh", (uint)bitmap.Width, (uint)bitmap.Height,
                string.Join("\n", blocks.Select(block => block.Text)), blocks);
        }
        catch (Exception ex)
        {
            throw new AgentException("OCR_FAILED", $"Tiny OCR failed: {ex.GetType().Name}.", true, new { backend = Backend });
        }
        checkpoint?.Invoke();
        if (!includeWords) return new(primary, new("not_requested", null, 0));

        TextRecognitionResult windows;
        try { windows = _readWords(path); }
        catch (AgentException ex) when (ex.Code is "OCR_UNAVAILABLE" or "OCR_LANGUAGE_UNAVAILABLE" or "OCR_FAILED")
        {
            // An optional localizer failure must not replace or discard Tiny text.
            checkpoint?.Invoke();
            return new(primary, new("unavailable", ex.Code, 0));
        }
        checkpoint?.Invoke();
        var matched = MatchWords(primary, windows);
        var count = matched.Blocks.Count(block => block.Words.Count > 0);
        return new(matched, new(count == 0 ? "no_verified_matches" : "verified_matches", null, count));
    }

    internal static TextRecognitionResult MatchWords(TextRecognitionResult primary, TextRecognitionResult windows)
    {
        if (primary.ImageWidth != windows.ImageWidth || primary.ImageHeight != windows.ImageHeight) return primary;
        // Never merge by string identity alone: repeated text at another location
        // is not the same target. Each Windows block must have one geometric owner.
        var owners = windows.Blocks.Select(block => primary.Blocks.Select((line, index) => (line, index))
            .Where(item => OverlapsLine(item.line.Bounds, block.Bounds)).Select(item => item.index).ToArray()).ToArray();
        var blocks = primary.Blocks.Select((line, index) =>
        {
            var related = windows.Blocks.Where((_, i) => owners[i].Length == 1 && owners[i][0] == index)
                .OrderBy(block => block.Bounds.X).ToArray();
            if (related.Length == 0 || Normalize(string.Concat(related.Select(block => block.Text))) != Normalize(line.Text)) return line;
            var words = related.SelectMany(block => block.Words).ToArray();
            if (words.Length == 0 || Normalize(string.Concat(words.Select(word => word.Text))) != Normalize(line.Text)) return line;
            if (words.Any(word => !OverlapsLine(line.Bounds, word.Bounds))) return line;
            var union = new TextBounds(words.Min(word => word.Bounds.X), words.Min(word => word.Bounds.Y),
                words.Max(word => word.Bounds.Right) - words.Min(word => word.Bounds.X),
                words.Max(word => word.Bounds.Bottom) - words.Min(word => word.Bounds.Y));
            var intersection = Intersection(line.Bounds, union);
            var unionArea = Area(line.Bounds) + Area(union) - intersection;
            return unionArea > 0 && intersection / unionArea >= 0.5 ? line with { Words = words } : line;
        }).ToArray();
        return primary with { Blocks = blocks };
    }

    private static bool OverlapsLine(TextBounds line, TextBounds candidate)
        => Area(candidate) > 0 && Intersection(line, candidate) / Area(candidate) >= 0.8 &&
            Math.Abs(line.CenterY - candidate.CenterY) <= Math.Max(line.Height, candidate.Height) * 0.5;

    private static double Area(TextBounds bounds) => (double)bounds.Width * bounds.Height;
    private static double Intersection(TextBounds a, TextBounds b)
        => (double)Math.Max(0, Math.Min(a.Right, b.Right) - Math.Max(a.X, b.X)) *
            Math.Max(0, Math.Min(a.Bottom, b.Bottom) - Math.Max(a.Y, b.Y));
    private static string Normalize(string text) => new(text.Where(character => !char.IsWhiteSpace(character)).ToArray());

    internal static TextBounds EnclosingBounds(float[] xs, float[] ys, int width, int height)
    {
        var left = Math.Clamp((int)Math.Floor(xs.Min()), 0, width - 1);
        var top = Math.Clamp((int)Math.Floor(ys.Min()), 0, height - 1);
        var right = Math.Clamp((int)Math.Ceiling(xs.Max()), left + 1, width);
        var bottom = Math.Clamp((int)Math.Ceiling(ys.Max()), top + 1, height);
        return new(left, top, right - left, bottom - top);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _ocr?.Dispose();
        _ocr = null;
    }
}

internal sealed record DesktopTextResult(TextRecognitionResult Recognition, WordLocalizationStatus WordLocalization);
internal sealed record WordLocalizationStatus(string Status, string? ErrorCode, int MatchedBlocks);
