using System.IO;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

namespace WindowsAgent;

/// <summary>
/// Uses the OCR language packs already installed in Windows. This provider is
/// intentionally screen- and application-agnostic: it returns positioned text
/// blocks and never embeds selectors or business rules for a particular app.
/// </summary>
internal static class OfflineTextRecognition
{
    internal static object Diagnose()
    {
        try
        {
            var engine = OcrEngine.TryCreateFromUserProfileLanguages();
            return new
            {
                available = engine is not null,
                backend = "windows_media_ocr_offline",
                language = engine?.RecognizerLanguage?.LanguageTag,
                installed_languages = OcrEngine.AvailableRecognizerLanguages.Select(language => language.LanguageTag).ToArray(),
                max_image_dimension = OcrEngine.MaxImageDimension
            };
        }
        catch (Exception ex)
        {
            return new { available = false, backend = "windows_media_ocr_offline", error = ex.Message };
        }
    }

    internal static TextRecognitionResult Recognize(string path, TextBounds? region = null, double preferredScale = 2d)
        => RecognizeAsync(path, region, preferredScale).GetAwaiter().GetResult();

    private static async Task<TextRecognitionResult> RecognizeAsync(string path, TextBounds? region, double preferredScale)
    {
        OcrEngine? engine;
        try
        {
            engine = OcrEngine.TryCreateFromUserProfileLanguages();
        }
        catch (Exception ex)
        {
            throw new AgentException("OCR_UNAVAILABLE", $"Windows offline OCR could not be initialized: {ex.Message}", false);
        }
        if (engine is null)
        {
            throw new AgentException("OCR_LANGUAGE_UNAVAILABLE", "Windows has no OCR language compatible with the current user profile.", false,
                new { installed_languages = OcrEngine.AvailableRecognizerLanguages.Select(language => language.LanguageTag).ToArray() });
        }

        try
        {
            var file = await StorageFile.GetFileFromPathAsync(Path.GetFullPath(path));
            using IRandomAccessStream stream = await file.OpenAsync(FileAccessMode.Read);
            var decoder = await BitmapDecoder.CreateAsync(stream);
            var width = decoder.PixelWidth;
            var height = decoder.PixelHeight;
            var cropX = (uint)Math.Clamp(region?.X ?? 0, 0, Math.Max(0, checked((int)width) - 1));
            var cropY = (uint)Math.Clamp(region?.Y ?? 0, 0, Math.Max(0, checked((int)height) - 1));
            var cropWidth = (uint)Math.Clamp(region?.Width ?? checked((int)width), 1, checked((int)(width - cropX)));
            var cropHeight = (uint)Math.Clamp(region?.Height ?? checked((int)height), 1, checked((int)(height - cropY)));
            var maxDimension = Math.Max(cropWidth, cropHeight);
            var requestedScale = Math.Clamp(preferredScale, 1d, 4d);
            var scale = Math.Min(requestedScale, OcrEngine.MaxImageDimension / (double)Math.Max(1u, maxDimension));
            // BitmapTransform applies scaling before Bounds. Express both the
            // full image dimensions and crop rectangle in that scaled space;
            // using original-space Bounds with a scaled crop-sized canvas
            // shifts the decoded region toward the upper-left.
            var scaledWidth = Math.Max(1u, (uint)Math.Round(width * scale));
            var scaledHeight = Math.Max(1u, (uint)Math.Round(height * scale));
            var scaledCropX = Math.Min(scaledWidth - 1, (uint)Math.Round(cropX * scale));
            var scaledCropY = Math.Min(scaledHeight - 1, (uint)Math.Round(cropY * scale));
            var scaledCropRight = Math.Min(scaledWidth, (uint)Math.Round((cropX + cropWidth) * scale));
            var scaledCropBottom = Math.Min(scaledHeight, (uint)Math.Round((cropY + cropHeight) * scale));
            var transform = new BitmapTransform
            {
                Bounds = new BitmapBounds
                {
                    X = scaledCropX,
                    Y = scaledCropY,
                    Width = Math.Max(1u, scaledCropRight - scaledCropX),
                    Height = Math.Max(1u, scaledCropBottom - scaledCropY)
                },
                ScaledWidth = scaledWidth,
                ScaledHeight = scaledHeight,
                InterpolationMode = BitmapInterpolationMode.Cubic
            };
            using var bitmap = await decoder.GetSoftwareBitmapAsync(
                BitmapPixelFormat.Bgra8,
                BitmapAlphaMode.Premultiplied,
                transform,
                ExifOrientationMode.IgnoreExifOrientation,
                ColorManagementMode.DoNotColorManage);
            var result = await engine.RecognizeAsync(bitmap);
            var inverseScale = scale <= 0 ? 1d : 1d / scale;
            var blocks = new List<TextBlock>();
            var index = 0;
            foreach (var line in result.Lines)
            {
                var words = line.Words.Select(word => new TextWord(
                    word.Text,
                    ScaleBounds(word.BoundingRect.X, word.BoundingRect.Y, word.BoundingRect.Width, word.BoundingRect.Height, inverseScale,
                        checked((int)cropX), checked((int)cropY))))
                    .ToArray();
                if (words.Length == 0 || string.IsNullOrWhiteSpace(line.Text)) continue;
                var left = words.Min(word => word.Bounds.X);
                var top = words.Min(word => word.Bounds.Y);
                var right = words.Max(word => word.Bounds.X + word.Bounds.Width);
                var bottom = words.Max(word => word.Bounds.Y + word.Bounds.Height);
                blocks.Add(new TextBlock(
                    $"text_{++index:0000}",
                    NormalizeText(line.Text),
                    new TextBounds(left, top, Math.Max(1, right - left), Math.Max(1, bottom - top)),
                    words));
            }

            return new TextRecognitionResult(
                "windows_media_ocr_offline",
                engine.RecognizerLanguage.LanguageTag,
                width,
                height,
                NormalizeText(result.Text),
                blocks);
        }
        catch (AgentException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new AgentException("OCR_FAILED", $"Windows offline OCR failed: {ex.Message}", true,
                new { path = Path.GetFullPath(path), backend = "windows_media_ocr_offline" });
        }
    }

    private static TextBounds ScaleBounds(double x, double y, double width, double height, double scale, int offsetX, int offsetY)
        => new(
            offsetX + (int)Math.Round(x * scale),
            offsetY + (int)Math.Round(y * scale),
            Math.Max(1, (int)Math.Round(width * scale)),
            Math.Max(1, (int)Math.Round(height * scale)));

    private static string NormalizeText(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : string.Join("\n", value.Replace("\r", string.Empty, StringComparison.Ordinal)
                .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries));
}

internal sealed record TextRecognitionResult(
    string Backend,
    string Language,
    uint ImageWidth,
    uint ImageHeight,
    string Text,
    IReadOnlyList<TextBlock> Blocks);

internal sealed record TextBlock(string Id, string Text, TextBounds Bounds, IReadOnlyList<TextWord> Words);

internal sealed record TextWord(string Text, TextBounds Bounds);

internal sealed record TextBounds(int X, int Y, int Width, int Height)
{
    internal int Right => X + Width;
    internal int Bottom => Y + Height;
    internal int CenterX => X + Width / 2;
    internal int CenterY => Y + Height / 2;
}
