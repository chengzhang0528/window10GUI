namespace DeskPilot.Console.UI;

internal static class AppTheme
{
    internal static readonly Color Background = Color.FromArgb(244, 247, 250);
    internal static readonly Color Surface = Color.White;
    internal static readonly Color SurfaceMuted = Color.FromArgb(248, 250, 252);
    internal static readonly Color Border = Color.FromArgb(218, 225, 232);
    internal static readonly Color Primary = Color.FromArgb(37, 99, 235);
    internal static readonly Color PrimaryHover = Color.FromArgb(29, 78, 216);
    internal static readonly Color Text = Color.FromArgb(30, 41, 59);
    internal static readonly Color TextMuted = Color.FromArgb(100, 116, 139);
    internal static readonly Color Success = Color.FromArgb(22, 163, 74);
    internal static readonly Color Warning = Color.FromArgb(217, 119, 6);
    internal static readonly Color Danger = Color.FromArgb(220, 38, 38);

    internal static Font DefaultFont(float size = 9F, FontStyle style = FontStyle.Regular) =>
        new("Microsoft YaHei UI", size, style);

    internal static void StylePrimaryButton(Button button)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = Primary;
        button.ForeColor = Color.White;
        button.Font = DefaultFont(9F, FontStyle.Bold);
        button.Cursor = Cursors.Hand;
        button.UseVisualStyleBackColor = false;
        button.MouseEnter += (_, _) => button.BackColor = PrimaryHover;
        button.MouseLeave += (_, _) => button.BackColor = Primary;
    }

    internal static void StyleSecondaryButton(Button button)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = Border;
        button.FlatAppearance.BorderSize = 1;
        button.BackColor = Surface;
        button.ForeColor = Text;
        button.Font = DefaultFont();
        button.Cursor = Cursors.Hand;
        button.UseVisualStyleBackColor = false;
        button.MouseEnter += (_, _) => button.BackColor = SurfaceMuted;
        button.MouseLeave += (_, _) => button.BackColor = Surface;
    }
}
