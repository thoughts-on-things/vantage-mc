//! Remembering where the studio window was left.
//!
//! The box is stored in physical pixels next to the app's other config, and is
//! only restored when it still lands on a monitor that exists right now — a
//! window saved on a second display must not reopen off-screen after that
//! display is unplugged.

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const STATE_FILE: &str = "window-state.json";
/// Mirrors `minWidth`/`minHeight` in tauri.conf.json; a stored box smaller than
/// this came from a build with different constraints and is ignored.
const MIN_WIDTH: u32 = 860;
const MIN_HEIGHT: u32 = 600;
/// How much of the window must overlap a live monitor for the position to be
/// reused. Enough to keep the title bar grabbable.
const VISIBLE_MARGIN: i32 = 80;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBox {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// A monitor's physical rectangle: `(x, y, width, height)`.
type MonitorRect = (i32, i32, u32, u32);

/// Follows the window while the app runs so the box written at shutdown is the
/// *restored* geometry. Reading it at close time instead would persist the
/// full-screen rectangle of a maximized window and lose the size the user
/// actually chose.
#[derive(Default)]
pub struct Tracker {
    restored_box: Mutex<Option<WindowBox>>,
}

impl Tracker {
    /// Applies the stored box, if any, before the window is shown.
    pub fn restore(&self, window: &WebviewWindow) {
        let Some(saved) = read(&state_path(window)) else {
            return;
        };
        if saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT {
            let _ = window.set_size(PhysicalSize::new(saved.width, saved.height));
        }
        let monitors = monitor_rects(window);
        if visible_on(&saved, &monitors) {
            let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
        } else if !monitors.is_empty() {
            let _ = window.center();
        }
        if let Ok(mut slot) = self.restored_box.lock() {
            *slot = Some(WindowBox {
                maximized: false,
                ..saved
            });
        }
        if saved.maximized {
            let _ = window.maximize();
        }
    }

    /// Called on every move/resize. Maximized geometry is deliberately skipped.
    pub fn observe(&self, window: &WebviewWindow) {
        if window.is_maximized().unwrap_or(false) {
            return;
        }
        let Some(current) = measure(window) else {
            return;
        };
        if let Ok(mut slot) = self.restored_box.lock() {
            *slot = Some(current);
        }
    }

    /// Writes the remembered box plus the window's current maximized flag.
    pub fn persist(&self, window: &WebviewWindow) {
        let remembered = self.restored_box.lock().ok().and_then(|slot| *slot);
        let Some(mut state) = remembered.or_else(|| measure(window)) else {
            return;
        };
        state.maximized = window.is_maximized().unwrap_or(false);
        let path = state_path(window);
        let Some(parent) = path.parent() else { return };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&state) {
            let _ = fs::write(path, bytes);
        }
    }
}

fn measure(window: &WebviewWindow) -> Option<WindowBox> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None; // minimized windows report an empty client area
    }
    Some(WindowBox {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    })
}

fn state_path(window: &WebviewWindow) -> PathBuf {
    window
        .app_handle()
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(STATE_FILE)
}

fn read(path: &PathBuf) -> Option<WindowBox> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn monitor_rects(window: &WebviewWindow) -> Vec<MonitorRect> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            (position.x, position.y, size.width, size.height)
        })
        .collect()
}

/// True when a usable slice of the window lands inside one of `monitors`.
/// An empty monitor list means the platform could not enumerate displays, in
/// which case the stored position is trusted rather than discarded.
fn visible_on(state: &WindowBox, monitors: &[MonitorRect]) -> bool {
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|(x, y, width, height)| {
        let right = x.saturating_add(*width as i32);
        let bottom = y.saturating_add(*height as i32);
        let window_right = state.x.saturating_add(state.width as i32);
        let window_bottom = state.y.saturating_add(state.height as i32);
        window_right - VISIBLE_MARGIN > *x
            && state.x + VISIBLE_MARGIN < right
            && window_bottom - VISIBLE_MARGIN > *y
            && state.y + VISIBLE_MARGIN < bottom
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: MonitorRect = (0, 0, 1920, 1080);
    const SECOND: MonitorRect = (-1920, 120, 1920, 1080);

    fn boxed(x: i32, y: i32) -> WindowBox {
        WindowBox {
            x,
            y,
            width: 1280,
            height: 800,
            maximized: false,
        }
    }

    #[test]
    fn a_box_on_a_live_monitor_is_reused() {
        assert!(visible_on(&boxed(200, 140), &[PRIMARY]));
        assert!(visible_on(&boxed(-1800, 200), &[PRIMARY, SECOND]));
    }

    #[test]
    fn a_box_on_an_unplugged_monitor_is_rejected() {
        assert!(!visible_on(&boxed(-1800, 200), &[PRIMARY]));
        assert!(!visible_on(&boxed(4000, 0), &[PRIMARY]));
        // Dragged just off the bottom edge: not enough title bar left to grab.
        assert!(!visible_on(&boxed(600, 1040), &[PRIMARY]));
    }

    #[test]
    fn an_unknown_display_layout_trusts_the_stored_box() {
        assert!(visible_on(&boxed(-4000, -4000), &[]));
    }

    #[test]
    fn window_boxes_round_trip_through_json() {
        let state = WindowBox {
            x: -1720,
            y: 96,
            width: 1600,
            height: 980,
            maximized: true,
        };
        let text = serde_json::to_string(&state).unwrap();
        assert!(text.contains("\"maximized\":true"), "{text}");
        assert_eq!(serde_json::from_str::<WindowBox>(&text).unwrap(), state);
    }
}
