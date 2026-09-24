//! The position of the macOS window buttons (ADR 020).
//!
//! The window uses `titleBarStyle: "Overlay"`, so AppKit draws the close, minimize and zoom
//! buttons over the top left of the web view. The title bar of the web view is 40 pixels high,
//! with a 1 pixel bottom border inside that height, so its controls centre at 19.5 from the top.
//! `trafficLightPosition` moves the buttons, and this module sets it so that they centre there
//! on every macOS version.
//!
//! # Why the value is measured
//!
//! tao and wry apply `trafficLightPosition` with one rule. They set the height of the title bar
//! container of AppKit to `buttonHeight + y`, and they move each button to `x` plus its default
//! distance from the first button. They do not move a button vertically: it keeps its default
//! distance from the bottom of the container. The top of a button is therefore `y - bottom`
//! from the top of the window, where `bottom` is that default distance.
//!
//! The button height and that distance differ between macOS versions. On macOS 26 and later
//! the button frame is 14 points high and 9 points from the bottom of a 32 point title bar. On
//! macOS 15 and earlier the title bar is 28 points. One fixed `y` cannot centre the buttons on
//! both, so [`create_main_window`] measures the close button of a window that is never shown,
//! with the style of the main window, and computes `y` from it ([`centred_traffic_light_y`]).
//!
//! tao and wry apply the position again on every draw, so a change to the buttons after the
//! window exists would not last. Tauri 2.11 also has no public setter for the position of an
//! open window. The position must therefore be in the configuration that builds the window.
//! `tauri.macos.conf.json` marks the main window `"create": false`, and [`create_main_window`]
//! builds it from that configuration with the measured position.
//!
//! # The fallback
//!
//! The configured `trafficLightPosition` stays the fallback. The window uses it when the
//! measurement fails, for example off the main thread, and when a measured value is not
//! plausible. It is the value that the rule gives for the metrics of macOS 26 and later.
//!
//! `x` is not measured. It stays the configured value, and the left reserve of the title bar in
//! `src/components/layout/titleBarLayout.ts` depends on it.

use tauri::utils::config::LogicalPosition;
use tauri::{App, Manager, Runtime, WebviewWindowBuilder};

/// The height of the title bar of the web view without its bottom border, in points: `h-10`
/// (40 pixels) less `border-b` (1 pixel) in `TitleBar.tsx`. The controls of the title bar centre
/// in this height.
const TITLE_BAR_CONTENT_HEIGHT: f64 = 39.0;

/// The frame of the standard close button in a window with the style of the main window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ButtonMetrics {
    /// The height of the button frame, in points.
    pub(crate) height: f64,
    /// The distance from the bottom of the title bar to the bottom of the button frame, in
    /// points. tao and wry keep this distance when they move the buttons.
    pub(crate) bottom: f64,
}

/// The `y` of `trafficLightPosition` that centres the buttons in the title bar of the web view,
/// or `None` when the metrics are not plausible.
///
/// The top of a button is `y - bottom` from the top of the window. The top that centres the
/// button is `(TITLE_BAR_CONTENT_HEIGHT - height) / 2`, rounded down to a whole point: a frame on
/// whole points stays sharp on a display at a scale of 1, and the button then centres at most
/// half a point above the controls. So `y` is that top plus `bottom`.
///
/// With the metrics of macOS 26 and later (height 14, bottom 9), `y` is 12 + 9 = 21.
pub(crate) fn centred_traffic_light_y(metrics: ButtonMetrics) -> Option<f64> {
    let ButtonMetrics { height, bottom } = metrics;
    // A range test is false for NaN and for an infinity.
    let plausible = height > 0.0
        && (0.0..TITLE_BAR_CONTENT_HEIGHT).contains(&height)
        && (0.0..TITLE_BAR_CONTENT_HEIGHT).contains(&bottom);
    if !plausible {
        return None;
    }
    let top = ((TITLE_BAR_CONTENT_HEIGHT - height) / 2.0).floor();
    Some(top + bottom)
}

/// Builds the main window from its configuration, with the traffic-light position measured for
/// this macOS version.
///
/// The configuration marks the window `"create": false`, so Tauri does not build it first. If a
/// window with the label exists anyway, because a later change removed that flag, this function
/// leaves it as it is. A second build would fail and stop the application.
pub fn create_main_window<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    if app.get_webview_window(crate::MAIN_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == crate::MAIN_WINDOW_LABEL)
    else {
        eprintln!("window: no configuration names the main window");
        return Ok(());
    };
    let mut config = config.clone();
    if let (Some(configured), Some(y)) = (
        config.traffic_light_position.as_ref(),
        measure_close_button().and_then(centred_traffic_light_y),
    ) {
        config.traffic_light_position = Some(LogicalPosition { x: configured.x, y });
    }
    WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
    Ok(())
}

/// Measures the standard close button of a window that has the style of the main window and is
/// never shown. Returns `None` off the main thread, where AppKit cannot make a window.
///
/// The style is the style that tao gives a window with `titleBarStyle: "Overlay"` and
/// `hiddenTitle: true`: a titled, closable, miniaturizable and resizable window with a full-size
/// content view, a transparent title bar and a hidden title. AppKit lays out the buttons of a
/// window when it makes it, so the window does not need to be shown.
///
/// The probe runs in its own autorelease pool. AppKit can autorelease objects while it makes
/// the window and its title bar, and the pool frees them when the probe returns. They are then
/// gone before the main window is built. Without the pool they would wait for the first pool of
/// the event loop, which drains only after the setup hook returns.
fn measure_close_button() -> Option<ButtonMetrics> {
    let mtm = objc2::MainThreadMarker::new()?;
    // The result is plain data, so nothing that the pool frees can outlive it.
    objc2::rc::autoreleasepool(|_| probe_close_button(mtm))
}

/// The body of [`measure_close_button`]. It runs inside the autorelease pool of that function.
fn probe_close_button(mtm: objc2::MainThreadMarker) -> Option<ButtonMetrics> {
    use objc2::MainThreadOnly;
    use objc2_app_kit::{
        NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let content = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(800.0, 600.0));
    // SAFETY: this runs on the main thread (`mtm`), which AppKit requires. The arguments are a
    // valid rectangle, a valid style mask and a valid backing type. `defer` is true, so AppKit
    // makes no window device for a window that is never shown.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            content,
            style,
            NSBackingStoreType::Buffered,
            true,
        )
    };
    // SAFETY: the window is never shown and never closed. With this set to false, a close could
    // not release the window a second time after `Retained` releases it at the end of this
    // function.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);

    let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
    let frame = close.frame();
    Some(ButtonMetrics {
        height: frame.size.height,
        bottom: frame.origin.y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The metrics of macOS 26 and later, measured with `standardWindowButton` on macOS 27.
    const MACOS_26_METRICS: ButtonMetrics = ButtonMetrics {
        height: 14.0,
        bottom: 9.0,
    };

    fn mac_window_config() -> serde_json::Value {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.macos.conf.json"))
                .expect("the macOS configuration is JSON");
        config["app"]["windows"]
            .as_array()
            .and_then(|windows| {
                windows
                    .iter()
                    .find(|window| window["label"] == crate::MAIN_WINDOW_LABEL)
            })
            .cloned()
            .expect("the macOS configuration names the main window")
    }

    #[test]
    fn the_buttons_of_macos_26_centre_at_19() {
        let y = centred_traffic_light_y(MACOS_26_METRICS).expect("plausible metrics");
        assert_eq!(y, 21.0);
        // tao makes the container 14 + 21 = 35 high, and the button bottom stays 9 above its
        // bottom, so the button spans 12 to 26 from the top and centres at 19.
        let container = MACOS_26_METRICS.height + y;
        let top = container - MACOS_26_METRICS.bottom - MACOS_26_METRICS.height;
        assert_eq!(top, 12.0);
        assert_eq!(top + MACOS_26_METRICS.height / 2.0, 19.0);
    }

    #[test]
    fn a_taller_button_moves_up_to_stay_centred() {
        // A 16 point frame 6 points above the bottom of a 28 point title bar: the metrics that
        // macOS 15 and earlier are reported to have. The top is floor(11.5) = 11.
        let metrics = ButtonMetrics {
            height: 16.0,
            bottom: 6.0,
        };
        assert_eq!(centred_traffic_light_y(metrics), Some(17.0));
    }

    #[test]
    fn a_button_frame_on_a_half_point_still_starts_on_a_whole_point() {
        let metrics = ButtonMetrics {
            height: 15.0,
            bottom: 7.0,
        };
        // (39 - 15) / 2 = 12, so the top is 12 and y is 19.
        assert_eq!(centred_traffic_light_y(metrics), Some(19.0));
    }

    #[test]
    fn implausible_metrics_give_no_value() {
        let cases = [
            (0.0, 9.0),
            (-14.0, 9.0),
            (39.0, 9.0),
            (14.0, -1.0),
            (14.0, 39.0),
            (f64::NAN, 9.0),
            (14.0, f64::INFINITY),
        ];
        for (height, bottom) in cases {
            assert_eq!(
                centred_traffic_light_y(ButtonMetrics { height, bottom }),
                None,
                "height {height}, bottom {bottom}"
            );
        }
    }

    #[test]
    fn the_configured_position_is_the_value_for_macos_26() {
        // The fallback is what the rule gives on the version the application is developed on,
        // so a failed measurement there changes nothing.
        let position = &mac_window_config()["trafficLightPosition"];
        assert_eq!(position["x"], 12.0);
        assert_eq!(
            position["y"].as_f64(),
            centred_traffic_light_y(MACOS_26_METRICS)
        );
    }

    #[test]
    fn tauri_does_not_build_the_macos_main_window_itself() {
        // `create_main_window` builds it with the measured position. If Tauri built it too, the
        // second build would fail.
        assert_eq!(mac_window_config()["create"], false);
    }
}
