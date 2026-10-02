//! The colour of the window border on Windows 11.
//!
//! The main window on Windows has no system decorations, and the page draws its title bar (ADR
//! 020). tao keeps the system frame of such a window for its shadow and its resize edges, and
//! removes only the caption (`WM_NCCALCSIZE`). Windows 11 therefore still draws a 1 pixel
//! border around the window, outside the page and inside the shadow. The system picks its
//! colour from the theme of the window, and that grey is not a colour of the palette: it shows
//! as a line against the black preview, and against a light title bar when the window is dark.
//!
//! [`set_window_border_theme`] sets that border to the colour of `--border` in
//! `src/styles/globals.css`, in the theme that the page shows. The page calls it at start and
//! on each change of its theme (`src/lib/theme.ts`). It names a theme and never a colour, so a
//! page cannot paint the frame of a window in a colour of its choice.
//!
//! Windows 10 has no attribute for the border colour, and macOS takes none, so there the
//! command checks its input and does nothing more.

use serde::Serialize;
use tauri::WebviewWindow;

/// A theme that the page shows. The border takes the border colour of this theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BorderTheme {
    Light,
    Dark,
}

/// A colour as a Win32 `COLORREF`, `0x00BBGGRR`.
const fn colorref(red: u8, green: u8, blue: u8) -> u32 {
    ((blue as u32) << 16) | ((green as u32) << 8) | (red as u32)
}

/// `--border` of the light palette, `oklch(0.86 0.012 200)`, in sRGB: `#c8d3d4`. The test
/// `each_border_colour_is_the_border_token_of_its_palette` converts the token again.
const LIGHT_BORDER_COLOR: u32 = colorref(0xc8, 0xd3, 0xd4);

/// `--border` of the dark palette, `oklch(0.3 0.014 205)`, in sRGB: `#263031`.
const DARK_BORDER_COLOR: u32 = colorref(0x26, 0x30, 0x31);

/// The border colour of `theme`, as a `COLORREF`.
fn border_color(theme: BorderTheme) -> u32 {
    match theme {
        BorderTheme::Light => LIGHT_BORDER_COLOR,
        BorderTheme::Dark => DARK_BORDER_COLOR,
    }
}

/// The first build of Windows 11. `DWMWA_BORDER_COLOR` exists from this build on.
#[cfg(any(windows, test))]
const FIRST_BUILD_WITH_BORDER_COLOR: u32 = 22000;

/// True when Windows of this build number takes a border colour.
#[cfg(any(windows, test))]
fn supports_border_color(build: u32) -> bool {
    build >= FIRST_BUILD_WITH_BORDER_COLOR
}

/// Stable error codes of [`set_window_border_theme`] (ADR 011).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowBorderErrorCode {
    /// The theme is not `light` or `dark`.
    InvalidTheme,
}

/// The rejection of [`set_window_border_theme`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBorderError {
    pub code: WindowBorderErrorCode,
}

/// The theme of a name that the page sends, and a refusal for every other name.
fn parse_theme(name: &str) -> Result<BorderTheme, WindowBorderError> {
    match name {
        "light" => Ok(BorderTheme::Light),
        "dark" => Ok(BorderTheme::Dark),
        _ => Err(WindowBorderError {
            code: WindowBorderErrorCode::InvalidTheme,
        }),
    }
}

/// True for the label of the main window, the only window whose border the page colours. The
/// Settings window has the title bar and the frame of the system (ADR 038).
fn colours_its_border(label: &str) -> bool {
    label == crate::MAIN_WINDOW_LABEL
}

/// Sets the border of the calling window to the border colour of `theme`, `light` or `dark`.
/// Only Windows 11 and later applies it. A call from a window other than the main window
/// changes nothing.
///
/// The command is synchronous, so Tauri runs it on the main thread, which owns the window, and
/// two calls apply in the order of the calls.
#[tauri::command]
pub fn set_window_border_theme(
    window: WebviewWindow,
    theme: String,
) -> Result<(), WindowBorderError> {
    let theme = parse_theme(&theme)?;
    if colours_its_border(window.label()) {
        apply_border_color(&window, border_color(theme));
    }
    Ok(())
}

/// Sets `DWMWA_BORDER_COLOR` of the window, on Windows 11 and later. A failure leaves the border
/// of the system, which the caller cannot repair, so it goes to the log only.
#[cfg(windows)]
fn apply_border_color(window: &WebviewWindow, color: u32) {
    if !dwm::build_number().is_some_and(supports_border_color) {
        return;
    }
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0,
        Err(error) => {
            eprintln!("window border: the window handle was not available: {error}");
            return;
        }
    };
    if let Err(result) = dwm::set_border_color(hwnd, color) {
        eprintln!("window border: the colour was not set: HRESULT {result:#010x}");
    }
}

/// Off Windows there is no border colour to set.
#[cfg(not(windows))]
fn apply_border_color(_window: &WebviewWindow, _color: u32) {}

/// The two system calls, declared by hand as in `fsutil`. tauri and tao use the `windows`
/// crate, but this crate does not depend on it, and two functions do not need it.
#[cfg(windows)]
mod dwm {
    use std::ffi::c_void;

    /// `DWMWA_BORDER_COLOR` of `DWMWINDOWATTRIBUTE` in `dwmapi.h`. Its value is a `COLORREF`.
    const DWMWA_BORDER_COLOR: u32 = 34;

    /// `OSVERSIONINFOW` of `winnt.h`, which `RtlGetVersion` fills.
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform_id: u32,
        service_pack: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            attribute: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }

    /// The build number of the Windows that runs, or `None` when the call fails.
    ///
    /// `RtlGetVersion` reports the version that runs. `GetVersionExW` reports at most the
    /// version that the manifest of the executable names. tao reads the version in the same way,
    /// for the same build 22000 (`windows-version`).
    pub(super) fn build_number() -> Option<u32> {
        let mut info = OsVersionInfo {
            size: std::mem::size_of::<OsVersionInfo>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform_id: 0,
            service_pack: [0; 128],
        };
        // STATUS_SUCCESS is 0.
        let status = unsafe { RtlGetVersion(&mut info) };
        (status == 0).then_some(info.build)
    }

    /// Sets the border colour of `hwnd`, or returns the failed `HRESULT`.
    pub(super) fn set_border_color(hwnd: *mut c_void, color: u32) -> Result<(), i32> {
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                (&color as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        // S_OK is 0.
        if result == 0 {
            Ok(())
        } else {
            Err(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `oklch(lightness chroma hue)` in 8-bit sRGB, as CSS Color 4 converts it: OKLCh to OKLab,
    /// OKLab to linear sRGB with the matrices of Björn Ottosson, then the sRGB transfer function.
    /// Each channel is clamped to 0..=1 and rounded to the nearest of 256 steps.
    fn oklch_to_srgb8(lightness: f64, chroma: f64, hue_degrees: f64) -> [u8; 3] {
        let (sin, cos) = hue_degrees.to_radians().sin_cos();
        let (a, b) = (chroma * cos, chroma * sin);
        let l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
        let m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
        let s = (lightness - 0.089_484_177_5 * a - 1.291_485_548_0 * b).powi(3);
        let linear = [
            4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
            -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
            -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s,
        ];
        linear.map(|channel| {
            let channel = channel.clamp(0.0, 1.0);
            let encoded = if channel <= 0.003_130_8 {
                12.92 * channel
            } else {
                1.055 * channel.powf(1.0 / 2.4) - 0.055
            };
            (encoded * 255.0).round() as u8
        })
    }

    /// The three numbers of the first `--border: oklch(...)` in `palette`.
    fn border_token(palette: &str) -> (f64, f64, f64) {
        const PREFIX: &str = "--border: oklch(";
        let start = palette.find(PREFIX).expect("the palette defines --border") + PREFIX.len();
        let end = start + palette[start..].find(')').expect("the value closes");
        let numbers: Vec<f64> = palette[start..end]
            .split_whitespace()
            .map(|number| number.parse().expect("each part is a number"))
            .collect();
        assert_eq!(numbers.len(), 3, "{}", &palette[start..end]);
        (numbers[0], numbers[1], numbers[2])
    }

    #[test]
    fn the_conversion_gives_the_known_srgb_colours() {
        // Guards the converter itself: white, black, and the sRGB red, which CSS Color 4 gives
        // as oklch(0.62796 0.25768 29.2339).
        assert_eq!(oklch_to_srgb8(1.0, 0.0, 0.0), [255, 255, 255]);
        assert_eq!(oklch_to_srgb8(0.0, 0.0, 0.0), [0, 0, 0]);
        assert_eq!(oklch_to_srgb8(0.62796, 0.25768, 29.2339), [255, 0, 0]);
    }

    #[test]
    fn each_border_colour_is_the_border_token_of_its_palette() {
        // A change of `--border` in either palette must change the colour here too. The light
        // palette is in `:root`, before `.dark`, and the dark palette is in `.dark`.
        let css = include_str!("../../../src/styles/globals.css");
        let dark_start = css
            .find("\n.dark {")
            .expect("globals.css has a dark palette");
        let (light, dark) = css.split_at(dark_start);
        for (palette, theme) in [(light, BorderTheme::Light), (dark, BorderTheme::Dark)] {
            let (lightness, chroma, hue) = border_token(palette);
            let [red, green, blue] = oklch_to_srgb8(lightness, chroma, hue);
            assert_eq!(
                border_color(theme),
                colorref(red, green, blue),
                "{theme:?}: oklch({lightness} {chroma} {hue}) is #{red:02x}{green:02x}{blue:02x}"
            );
        }
    }

    #[test]
    fn the_border_colours_are_colorrefs_with_red_in_the_low_byte() {
        assert_eq!(colorref(0x12, 0x34, 0x56), 0x0056_3412);
        assert_eq!(border_color(BorderTheme::Light), 0x00d4_d3c8);
        assert_eq!(border_color(BorderTheme::Dark), 0x0031_3026);
    }

    #[test]
    fn only_light_and_dark_name_a_theme() {
        assert_eq!(parse_theme("light"), Ok(BorderTheme::Light));
        assert_eq!(parse_theme("dark"), Ok(BorderTheme::Dark));
        // `system` is a preference and not a theme: the page resolves it first. A colour is
        // never a theme.
        for name in ["system", "Light", "", "#c8d3d4", "0x00d4d3c8"] {
            assert_eq!(
                parse_theme(name),
                Err(WindowBorderError {
                    code: WindowBorderErrorCode::InvalidTheme
                }),
                "{name}"
            );
        }
        assert_eq!(
            serde_json::to_value(WindowBorderError {
                code: WindowBorderErrorCode::InvalidTheme
            })
            .expect("an error serializes"),
            serde_json::json!({ "code": "invalidTheme" })
        );
    }

    #[test]
    fn the_border_colour_needs_windows_11() {
        // 19045 is Windows 10 22H2, the last Windows 10. 22000 is the first Windows 11, 22631
        // is 23H2 and 26100 is 24H2.
        for build in [0, 10240, 19045, 21999] {
            assert!(!supports_border_color(build), "{build}");
        }
        for build in [22000, 22631, 26100] {
            assert!(supports_border_color(build), "{build}");
        }
    }

    #[test]
    fn only_the_main_window_colours_its_border() {
        assert!(colours_its_border(crate::MAIN_WINDOW_LABEL));
        assert!(!colours_its_border(crate::SETTINGS_WINDOW_LABEL));
        assert!(!colours_its_border(""));
    }
}
