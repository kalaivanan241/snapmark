//! Snapmark — a menu-bar screenshot & markup tool for macOS.
//!
//! Flow: a global hotkey (or the menu-bar panel) freezes the display under the
//! cursor into a PNG and shows it in a full-screen overlay where you pick an
//! area / window / the whole screen. The result is copied to the clipboard and
//! handed to the after-capture card, the editor, the save folder or a pinned
//! floating window.

mod capture;
mod config;
mod macos;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{
    ActivationPolicy, AppHandle, Emitter, LogicalPosition, Manager, Position, RunEvent, Size, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use config::{Config, Hotkeys};
use macos::{Display, WinInfo};

const RECENT_LIMIT: usize = 24;
/// Card and menu windows are transparent with a margin so the CSS shadow isn't clipped.
const CARD_SIZE: (f64, f64) = (380.0 + 48.0, 334.0 + 48.0);
const MENU_WIDTH: f64 = 344.0 + 32.0;
const SCREEN_RECORDING_SETTINGS: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

struct Capture {
    id: u64,
    path: PathBuf,
    width: u32,
    height: u32,
    /// Pixels per point of the display it came from (2.0 on Retina).
    scale: f64,
    taken: DateTime<Local>,
    display: Display,
    saved: Option<PathBuf>,
    /// Set for images opened from disk rather than captured.
    title: Option<String>,
}

impl Capture {
    fn name(&self) -> String {
        match &self.title {
            Some(t) => t.clone(),
            None => self.taken.format("Screenshot %Y-%m-%d at %H.%M.%S").to_string(),
        }
    }

    fn info(&self) -> CaptureInfo {
        CaptureInfo {
            id: self.id,
            width: self.width,
            height: self.height,
            scale: self.scale,
            name: self.name(),
            saved: self.saved.as_deref().map(pretty_path),
            taken_ms: self.taken.timestamp_millis(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureInfo {
    id: u64,
    width: u32,
    height: u32,
    scale: f64,
    name: String,
    saved: Option<String>,
    taken_ms: i64,
}

/// One display's frozen image and the overlay window shown over it.
struct Screen {
    label: String,
    display: Display,
    frozen: PathBuf,
    width: u32,
    height: u32,
    windows: Vec<WinInfo>,
}

/// A capture in progress: every display is frozen and gets its own overlay.
struct Session {
    token: u64,
    mode: String,
    screens: Vec<Screen>,
    started: Instant,
}

impl Session {
    fn screen(&self, label: &str) -> Option<&Screen> {
        self.screens.iter().find(|s| s.label == label)
    }
}

fn overlay_label(d: &Display) -> String {
    format!("overlay-{}", d.index)
}

fn overlay_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("overlay-")).map(|(_, w)| w).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    token: u64,
    mode: String,
    width: u32,
    height: u32,
    w_pts: f64,
    h_pts: f64,
    windows: Vec<WinInfo>,
    timer: u32,
    after: String,
}

struct AppState {
    captures: Mutex<Vec<Capture>>,
    session: Mutex<Option<Session>>,
    card: Mutex<Option<u64>>,
    config: Mutex<Config>,
    config_path: PathBuf,
    cache_dir: PathBuf,
    shortcuts: Mutex<Vec<(Shortcut, &'static str)>>,
    next_id: AtomicU64,
    pin_seq: AtomicU64,
    busy: AtomicBool,
    menu_hidden_at: Mutex<Option<Instant>>,
}

fn pretty_path(p: &Path) -> String {
    match dirs::home_dir().and_then(|home| p.strip_prefix(home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => p.display().to_string(),
    }
}

fn open_external(target: impl AsRef<std::ffi::OsStr>) {
    let _ = std::process::Command::new("/usr/bin/open").arg(target).spawn();
}

fn with_capture<R>(app: &AppHandle, id: u64, f: impl FnOnce(&mut Capture) -> R) -> Result<R, String> {
    let st = app.state::<AppState>();
    let mut caps = st.captures.lock().unwrap();
    caps.iter_mut().find(|c| c.id == id).map(f).ok_or_else(|| "That capture is no longer available".into())
}

fn show_error(app: &AppHandle, message: &str) {
    eprintln!("snapmark: {message}");
    app.dialog().message(message).title("Snapmark").kind(MessageDialogKind::Error).show(|_| {});
}

// ---- Capture lifecycle ------------------------------------------------------------

fn start_capture(app: &AppHandle, mode: &str) {
    let st = app.state::<AppState>();
    {
        let mut session = st.session.lock().unwrap();
        if let Some(s) = session.as_ref() {
            let overlay_up = overlay_windows(app).iter().any(|w| w.is_visible().unwrap_or(false));
            if overlay_up {
                let _ = app.emit("overlay:mode", mode);
                return;
            }
            if s.started.elapsed() < Duration::from_secs(3) {
                return;
            }
            // The overlay never came up; drop the stale session and start over.
            *session = None;
        }
    }
    if st.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let mode = mode.to_string();
    std::thread::spawn(move || {
        if let Err(e) = begin_capture(&app, &mode) {
            show_error(&app, &format!("Couldn't start the capture: {e}"));
        }
        app.state::<AppState>().busy.store(false, Ordering::SeqCst);
    });
}

fn begin_capture(app: &AppHandle, mode: &str) -> Result<(), String> {
    if !macos::has_screen_access() {
        ask_for_screen_access(app);
        return Ok(());
    }
    let st = app.state::<AppState>();

    // Keep our own floating UI out of the shot.
    let mut hid_any = false;
    for label in ["menu", "card"] {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
                hid_any = true;
            }
        }
    }
    if hid_any {
        std::thread::sleep(Duration::from_millis(120));
    }

    // Freeze every display at the same moment.
    let grabs: Vec<_> = macos::displays()
        .into_iter()
        .map(|d| {
            let path = st.cache_dir.join(format!("frozen-{}.png", d.index));
            std::thread::spawn(move || {
                capture::display(d.index, &path)?;
                let (w, h) = capture::dimensions(&path)?;
                Ok::<_, String>((d, path, w, h))
            })
        })
        .collect();
    let mut screens = Vec::new();
    for grab in grabs {
        let (display, frozen, width, height) = grab.join().map_err(|_| "capture thread panicked".to_string())??;
        screens.push(Screen {
            label: overlay_label(&display),
            display,
            frozen,
            width,
            height,
            windows: macos::onscreen_windows(&display, std::process::id()),
        });
    }
    for screen in &screens {
        ensure_overlay(app, &screen.label)?;
    }
    // Overlays for displays that have since been unplugged stay hidden.
    let token = st.next_id.fetch_add(1, Ordering::SeqCst);
    let labels: Vec<String> = screens.iter().map(|s| s.label.clone()).collect();
    *st.session.lock().unwrap() =
        Some(Session { token, mode: mode.to_string(), screens, started: Instant::now() });
    for label in &labels {
        let _ = app.emit_to(label.as_str(), "overlay:begin", ());
    }
    follow_cursor(app.clone(), token);
    Ok(())
}

/// While the overlays are up, give keyboard focus to the one under the pointer
/// so Esc / ↵ / arrows act on the display you're looking at.
fn follow_cursor(app: AppHandle, token: u64) {
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            std::thread::sleep(Duration::from_millis(60));
            let label = {
                let st = app.state::<AppState>();
                let session = st.session.lock().unwrap();
                match session.as_ref() {
                    Some(s) if s.token == token => overlay_label(&macos::display_at_cursor()),
                    _ => return,
                }
            };
            if last.as_ref() == Some(&label) {
                continue;
            }
            if let Some(w) = app.get_webview_window(&label) {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.set_focus();
                    last = Some(label);
                }
            }
        }
    });
}

fn ask_for_screen_access(app: &AppHandle) {
    macos::request_screen_access();
    app.dialog()
        .message(
            "Snapmark needs Screen Recording permission to take screenshots.\n\n\
             Turn on Snapmark in System Settings → Privacy & Security → Screen & System Audio Recording, \
             then quit and reopen Snapmark.",
        )
        .title("Allow screen recording")
        .buttons(MessageDialogButtons::OkCancelCustom("Open System Settings".into(), "Later".into()))
        .show(|open| {
            if open {
                open_external(SCREEN_RECORDING_SETTINGS);
            }
        });
}

/// Hide the overlay and give focus back to the app the user was in.
fn end_overlay(app: &AppHandle) {
    let _ = app.emit("overlay:end", ());
    for w in overlay_windows(app) {
        let _ = w.hide();
    }
    let _ = app.run_on_main_thread(|| unsafe { macos::deactivate_app() });
}

#[derive(Deserialize, Clone, Copy)]
struct RectPts {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    mode: String,
    rect: Option<RectPts>,
    window_id: Option<u32>,
    timer: u32,
    after: String,
}

fn finish_capture(app: &AppHandle, s: &Screen, c: &Commit) -> Result<u64, String> {
    let st = app.state::<AppState>();
    if c.timer > 0 {
        std::thread::sleep(Duration::from_secs(c.timer as u64));
    }
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let out = st.cache_dir.join(format!("capture-{id}.png"));
    let scale = s.width as f64 / s.display.w;

    let (width, height) = match (c.mode.as_str(), c.window_id) {
        ("window", Some(wid)) => {
            capture::window(wid, &out)?;
            capture::dimensions(&out)?
        }
        _ => {
            let src = if c.timer > 0 {
                let fresh = st.cache_dir.join("timed.png");
                capture::display(s.display.index, &fresh)?;
                fresh
            } else {
                s.frozen.clone()
            };
            match c.rect.filter(|_| c.mode != "full") {
                Some(r) => {
                    let px = |v: f64| (v * scale).round().max(0.0) as u32;
                    let (bytes, w, h) = capture::crop(&src, px(r.x), px(r.y), px(r.w).max(1), px(r.h).max(1))?;
                    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
                    (w, h)
                }
                None => {
                    std::fs::copy(&src, &out).map_err(|e| e.to_string())?;
                    capture::dimensions(&out)?
                }
            }
        }
    };

    if st.config.lock().unwrap().auto_copy {
        if let Ok(bytes) = std::fs::read(&out) {
            macos::copy_png(&bytes);
        }
    }

    let mut caps = st.captures.lock().unwrap();
    caps.insert(
        0,
        Capture { id, path: out, width, height, scale, taken: Local::now(), display: s.display, saved: None, title: None },
    );
    caps.truncate(RECENT_LIMIT);
    Ok(id)
}

fn after_capture(app: &AppHandle, id: u64, after: &str) -> Result<(), String> {
    match after {
        "editor" => open_editor(app, id),
        "pin" => pin_capture(app, id),
        "save" => {
            save_capture_file(app, id)?;
            show_card(app, id)
        }
        _ => show_card(app, id),
    }
}

/// Bring an image file from disk into the capture list (converted to PNG) so it can be annotated.
fn import_image(app: &AppHandle, path: &Path) -> Result<u64, String> {
    let st = app.state::<AppState>();
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let out = st.cache_dir.join(format!("capture-{id}.png"));
    let is_png = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if is_png {
        std::fs::copy(path, &out).map_err(|e| e.to_string())?;
    } else {
        image::open(path)
            .and_then(|img| img.save_with_format(&out, image::ImageFormat::Png))
            .map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    }
    let (width, height) = capture::dimensions(&out)?;
    // Assume the image came from this Mac's display, so stroke sizes feel the same as on captures.
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(2.0);
    let title = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    let mut caps = st.captures.lock().unwrap();
    caps.insert(
        0,
        Capture {
            id,
            path: out,
            width,
            height,
            scale,
            taken: Local::now(),
            display: macos::display_at_cursor(),
            saved: None,
            title,
        },
    );
    caps.truncate(RECENT_LIMIT);
    Ok(id)
}

/// Handle launch arguments: `--capture <area|window|full|color>` and/or image paths.
fn handle_args(app: &AppHandle, args: &[String]) {
    let mut files = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--capture" {
            let mode = it.next().map(String::as_str).unwrap_or("area");
            start_capture(app, mode);
        } else if arg == "--cancel" {
            app.state::<AppState>().session.lock().unwrap().take();
            end_overlay(app);
        } else if Path::new(arg).is_file() {
            files.push(PathBuf::from(arg));
        }
    }
    if !files.is_empty() {
        open_files(app, files);
    }
}

fn open_files(app: &AppHandle, paths: Vec<PathBuf>) {
    for path in paths {
        match import_image(app, &path).and_then(|id| open_editor(app, id)) {
            Ok(()) => {}
            Err(e) => show_error(app, &e),
        }
    }
}

// ---- Windows ----------------------------------------------------------------------

fn ensure_overlay(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("overlay.html".into()))
        .title("Snapmark capture")
        .visible(false)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .accept_first_mouse(true)
        .focused(false)
        .background_color(Color(0, 0, 0, 255))
        .build()
        .map_err(|e| e.to_string())
}

fn ensure_menu(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("menu") {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, "menu", WebviewUrl::App("menu.html".into()))
        .title("Snapmark")
        .inner_size(MENU_WIDTH, 560.0)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .accept_first_mouse(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())
}

fn float_window(win: &WebviewWindow, aspect: Option<(f64, f64)>) {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Ok(ns) = w.ns_window() {
            unsafe {
                macos::make_floating_window(ns);
                if let Some((aw, ah)) = aspect {
                    macos::lock_aspect_ratio(ns, aw, ah);
                }
            }
        }
    });
}

fn show_card(app: &AppHandle, id: u64) -> Result<(), String> {
    let st = app.state::<AppState>();
    *st.card.lock().unwrap() = Some(id);
    let d = with_capture(app, id, |c| c.display)?;
    let (x, y) = (d.x + 8.0, d.y + d.h - CARD_SIZE.1 - 8.0);
    if let Some(win) = app.get_webview_window("card") {
        let _ = win.set_position(LogicalPosition::new(x, y));
        let _ = app.emit_to("card", "card:show", id);
        let _ = win.show();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "card", WebviewUrl::App("card.html".into()))
        .title("Snapmark")
        .inner_size(CARD_SIZE.0, CARD_SIZE.1)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
    float_window(&win, None);
    Ok(())
}

fn hide_card(app: &AppHandle) {
    *app.state::<AppState>().card.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window("card") {
        let _ = w.hide();
    }
}

fn open_editor(app: &AppHandle, id: u64) -> Result<(), String> {
    let label = format!("editor-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let (name, d) = with_capture(app, id, |c| (c.name(), c.display))?;
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    let w = (d.w * 0.92).clamp(880.0, 1440.0);
    let h = (d.h * 0.9).clamp(560.0, 900.0);
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("editor.html?id={id}").into()))
        .title(&name)
        .inner_size(w, h)
        .min_inner_size(880.0, 560.0)
        .position(d.x + (d.w - w) / 2.0, d.y + (d.h - h) / 2.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(18.0, 20.0))
        .background_color(Color(26, 27, 31, 255))
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

fn pin_capture(app: &AppHandle, id: u64) -> Result<(), String> {
    let st = app.state::<AppState>();
    let (name, width, height, scale, d) = with_capture(app, id, |c| (c.name(), c.width, c.height, c.scale, c.display))?;
    let n = st.pin_seq.fetch_add(1, Ordering::SeqCst);
    let (mut w, mut h) = (width as f64 / scale, height as f64 / scale);
    let fit = (d.w * 0.6 / w).min(d.h * 0.6 / h).min(1.0);
    w = (w * fit).max(48.0);
    h = (h * fit).max(48.0);
    let nudge = (n % 8) as f64 * 24.0;
    let win = WebviewWindowBuilder::new(app, format!("pin-{id}-{n}"), WebviewUrl::App(format!("pin.html?id={id}").into()))
        .title(format!("Pinned — {name}"))
        .inner_size(w, h)
        .position(d.x + (d.w - w) / 2.0 + nudge, d.y + (d.h - h) / 2.0 + nudge)
        .decorations(false)
        .resizable(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
    float_window(&win, Some((w, h)));
    Ok(())
}

fn pinned_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("pin-")).map(|(_, w)| w).collect()
}

fn toggle_menu(app: &AppHandle, rect: tauri::Rect) {
    let st = app.state::<AppState>();
    let Ok(win) = ensure_menu(app) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    // Clicking the icon while the panel is open blurs (and hides) it first.
    if st.menu_hidden_at.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(250)) {
        return;
    }

    let (px, py) = match rect.position {
        Position::Physical(p) => (p.x as f64, p.y as f64),
        Position::Logical(p) => (p.x, p.y),
    };
    let (pw, ph) = match rect.size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width, s.height),
    };
    let scale = match rect.position {
        Position::Logical(_) => 1.0,
        Position::Physical(_) => app
            .available_monitors()
            .unwrap_or_default()
            .into_iter()
            .find(|m| {
                let (p, s) = (m.position(), m.size());
                px >= p.x as f64 && px < (p.x + s.width as i32) as f64 && py >= p.y as f64 && py < (p.y + s.height as i32) as f64
            })
            .map(|m| m.scale_factor())
            .unwrap_or(2.0),
    };
    let (cx, bottom) = ((px + pw / 2.0) / scale, (py + ph) / scale);
    let displays = macos::displays();
    let d = displays
        .iter()
        .find(|d| cx >= d.x && cx < d.x + d.w && bottom >= d.y - 1.0 && bottom <= d.y + d.h)
        .copied()
        .unwrap_or(displays[0]);
    let x = (cx - MENU_WIDTH / 2.0).clamp(d.x, d.x + d.w - MENU_WIDTH);
    let _ = win.set_position(LogicalPosition::new(x, bottom - 10.0));
    let _ = app.emit_to("menu", "menu:show", ());
    let _ = win.show();
    let _ = win.set_focus();
}

// ---- Saving -----------------------------------------------------------------------

fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).png"));
        n += 1;
    }
    path
}

/// Write PNG bytes for a capture. The first save picks a fresh file name in the
/// save folder; later saves of the same capture overwrite that file.
fn save_bytes(app: &AppHandle, id: u64, bytes: &[u8]) -> Result<String, String> {
    let dir = app.state::<AppState>().config.lock().unwrap().save_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let path = with_capture(app, id, |c| c.saved.clone().unwrap_or_else(|| unique_path(&dir, &c.name())))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    with_capture(app, id, |c| c.saved = Some(path.clone()))?;
    Ok(pretty_path(&path))
}

fn save_capture_file(app: &AppHandle, id: u64) -> Result<String, String> {
    let src = with_capture(app, id, |c| c.path.clone())?;
    let bytes = std::fs::read(src).map_err(|e| e.to_string())?;
    save_bytes(app, id, &bytes)
}

// ---- Hotkeys & config ---------------------------------------------------------------

fn register_hotkeys(app: &AppHandle) {
    let st = app.state::<AppState>();
    let hotkeys = st.config.lock().unwrap().hotkeys.clone();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = Vec::new();
    for (action, accel) in hotkeys.pairs() {
        if accel.trim().is_empty() {
            continue;
        }
        match accel.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc) {
                Ok(()) => map.push((sc, action)),
                Err(e) => eprintln!("snapmark: couldn't register {accel} for {action}: {e}"),
            },
            Err(e) => eprintln!("snapmark: bad hotkey {accel:?} for {action}: {e}"),
        }
    }
    *st.shortcuts.lock().unwrap() = map;
}

/// Pick up hand edits to config.json (the gear button opens it).
fn reload_config(app: &AppHandle) {
    let st = app.state::<AppState>();
    let fresh = Config::load(&st.config_path);
    let hotkeys_changed = {
        let mut cfg = st.config.lock().unwrap();
        let changed = cfg.hotkeys != fresh.hotkeys;
        *cfg = fresh;
        changed
    };
    if hotkeys_changed {
        register_hotkeys(app);
    }
}

// ---- Commands: overlay ----------------------------------------------------------------

#[tauri::command]
fn overlay_session(window: WebviewWindow, state: State<AppState>) -> Option<SessionInfo> {
    let session = state.session.lock().unwrap();
    let cfg = state.config.lock().unwrap();
    let s = session.as_ref()?;
    let screen = s.screen(window.label())?;
    Some(SessionInfo {
        token: s.token,
        mode: s.mode.clone(),
        width: screen.width,
        height: screen.height,
        w_pts: screen.display.w,
        h_pts: screen.display.h,
        windows: screen.windows.clone(),
        timer: cfg.timer,
        after: cfg.after.clone(),
    })
}

#[tauri::command]
fn overlay_image(window: WebviewWindow, state: State<AppState>) -> Result<Response, String> {
    let path = state
        .session
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.screen(window.label()).map(|sc| sc.frozen.clone()))
        .ok_or("no capture in progress")?;
    std::fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn overlay_present(window: WebviewWindow, state: State<AppState>, token: u64) {
    let Some(d) = state
        .session
        .lock()
        .unwrap()
        .as_ref()
        .filter(|s| s.token == token)
        .and_then(|s| s.screen(window.label()).map(|sc| sc.display))
    else {
        return;
    };
    let under_cursor = macos::display_at_cursor().index == d.index;
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns) = w.ns_window() {
            // Positioned with AppKit directly: displays can have different scale
            // factors and negative origins, which the generic setters get wrong.
            unsafe { macos::show_overlay_window(ns, d.x, d.y, d.w, d.h) };
        }
        if under_cursor {
            let _ = w.set_focus();
        }
    });
}

#[tauri::command]
fn overlay_cancel(app: AppHandle, state: State<AppState>) {
    state.session.lock().unwrap().take();
    end_overlay(&app);
}

#[tauri::command]
fn overlay_commit(window: WebviewWindow, app: AppHandle, state: State<AppState>, args: Commit) -> Result<(), String> {
    let session = state.session.lock().unwrap().take().ok_or("no capture in progress")?;
    end_overlay(&app);
    let label = window.label().to_string();
    std::thread::spawn(move || {
        let result = session
            .screen(&label)
            .ok_or_else(|| "that display is gone".to_string())
            .and_then(|screen| finish_capture(&app, screen, &args))
            .and_then(|id| after_capture(&app, id, &args.after));
        if let Err(e) = result {
            show_error(&app, &format!("Capture failed: {e}"));
        }
    });
    Ok(())
}

#[tauri::command]
fn overlay_pick_color(app: AppHandle, state: State<AppState>, hex: String) {
    state.session.lock().unwrap().take();
    end_overlay(&app);
    macos::copy_text(&hex);
}

#[tauri::command]
fn set_capture_prefs(state: State<AppState>, timer: u32, after: String) {
    let mut cfg = state.config.lock().unwrap();
    cfg.timer = timer;
    cfg.after = after;
    cfg.store(&state.config_path);
}

// ---- Commands: captures ---------------------------------------------------------------

#[tauri::command]
fn capture_info(app: AppHandle, id: u64) -> Result<CaptureInfo, String> {
    with_capture(&app, id, |c| c.info())
}

#[tauri::command]
fn capture_image(app: AppHandle, id: u64) -> Result<Response, String> {
    let path = with_capture(&app, id, |c| c.path.clone())?;
    std::fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_capture_cmd(app: AppHandle, mode: String) {
    start_capture(&app, &mode);
}

#[tauri::command]
fn open_editor_cmd(app: AppHandle, id: u64) -> Result<(), String> {
    open_editor(&app, id)
}

#[tauri::command]
fn copy_capture(app: AppHandle, id: u64) -> Result<(), String> {
    let path = with_capture(&app, id, |c| c.path.clone())?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    macos::copy_png(&bytes).then_some(()).ok_or_else(|| "Couldn't write to the clipboard".into())
}

#[tauri::command]
fn save_capture(app: AppHandle, id: u64) -> Result<String, String> {
    save_capture_file(&app, id)
}

#[tauri::command]
fn pin_capture_cmd(app: AppHandle, id: u64) -> Result<(), String> {
    pin_capture(&app, id)
}

#[tauri::command]
fn reveal_capture(app: AppHandle, id: u64) -> Result<(), String> {
    let path = with_capture(&app, id, |c| c.saved.clone())?.ok_or("Not saved yet")?;
    let _ = std::process::Command::new("/usr/bin/open").arg("-R").arg(path).spawn();
    Ok(())
}

#[tauri::command]
fn card_current(app: AppHandle, state: State<AppState>) -> Option<CaptureInfo> {
    let id = (*state.card.lock().unwrap())?;
    with_capture(&app, id, |c| c.info()).ok()
}

#[tauri::command]
fn card_dismiss(app: AppHandle) {
    hide_card(&app);
}

// ---- Commands: editor ---------------------------------------------------------------

fn png_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) if bytes.starts_with(b"\x89PNG") => Ok(bytes),
        _ => Err("expected PNG bytes".into()),
    }
}

fn capture_id_header(request: &Request<'_>) -> Result<u64, String> {
    request
        .headers()
        .get("x-capture-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| "missing capture id".into())
}

#[tauri::command]
fn editor_copy(request: Request<'_>) -> Result<(), String> {
    let bytes = png_body(&request)?;
    macos::copy_png(bytes).then_some(()).ok_or_else(|| "Couldn't write to the clipboard".into())
}

#[tauri::command]
fn editor_save(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    save_bytes(&app, capture_id_header(&request)?, png_body(&request)?)
}

#[tauri::command]
async fn editor_save_as(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let bytes = png_body(&request)?.to_vec();
    let id = capture_id_header(&request)?;
    let name = with_capture(&app, id, |c| c.name())?;
    let dir = app.state::<AppState>().config.lock().unwrap().save_dir();
    let _ = std::fs::create_dir_all(&dir);
    let picked = app
        .dialog()
        .file()
        .set_directory(&dir)
        .set_file_name(format!("{name}.png"))
        .add_filter("PNG image", &["png"])
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    Ok(Some(pretty_path(&path)))
}

#[tauri::command]
fn save_dir_label(state: State<AppState>) -> String {
    pretty_path(&state.config.lock().unwrap().save_dir())
}

// ---- Commands: menu-bar panel ---------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuState {
    hotkeys: Hotkeys,
    pins: usize,
    autostart: bool,
    recent: Vec<CaptureInfo>,
    screen_access: bool,
}

#[tauri::command]
fn menu_state(app: AppHandle, state: State<AppState>) -> MenuState {
    reload_config(&app);
    MenuState {
        hotkeys: state.config.lock().unwrap().hotkeys.clone(),
        pins: pinned_windows(&app).len(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        recent: state.captures.lock().unwrap().iter().take(3).map(Capture::info).collect(),
        screen_access: macos::has_screen_access(),
    }
}

#[tauri::command]
fn hide_menu(app: AppHandle) {
    if let Some(w) = app.get_webview_window("menu") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if on { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())?;
    Ok(launcher.is_enabled().unwrap_or(on))
}

#[tauri::command]
fn open_folder(state: State<AppState>) {
    let dir = state.config.lock().unwrap().save_dir();
    let _ = std::fs::create_dir_all(&dir);
    open_external(dir);
}

#[tauri::command]
fn open_preferences(state: State<AppState>) {
    state.config.lock().unwrap().store(&state.config_path);
    let _ = std::process::Command::new("/usr/bin/open").arg("-t").arg(&state.config_path).spawn();
}

#[tauri::command]
fn open_screen_settings(app: AppHandle) {
    macos::request_screen_access();
    open_external(SCREEN_RECORDING_SETTINGS);
    hide_menu(app);
}

#[tauri::command]
async fn open_image(app: AppHandle) -> Result<(), String> {
    hide_menu(app.clone());
    let picked = app
        .dialog()
        .file()
        .set_title("Open an image to annotate")
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp"])
        .blocking_pick_files();
    let paths = picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
    open_files(&app, paths);
    Ok(())
}

#[tauri::command]
fn show_pins(app: AppHandle) {
    for w in pinned_windows(&app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Front-end errors end up in the app's stderr (visible when run from a terminal).
#[tauri::command]
fn js_log(window: WebviewWindow, message: String) {
    eprintln!("snapmark [{}]: {message}", window.label());
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---- App ------------------------------------------------------------------------------

fn main() {
    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let action = {
                let st = app.state::<AppState>();
                let map = st.shortcuts.lock().unwrap();
                map.iter().find(|(s, _)| s == shortcut).map(|(_, a)| *a)
            };
            if let Some(action) = action {
                start_capture(app, action);
            }
        })
        .build();

    tauri::Builder::default()
        // A second launch (e.g. `Snapmark --capture area` from a script) is forwarded here.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_args(app, args.get(1..).unwrap_or_default());
        }))
        .plugin(shortcuts)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);

            let cache_dir = app.path().app_cache_dir()?;
            let _ = std::fs::remove_dir_all(&cache_dir);
            std::fs::create_dir_all(&cache_dir)?;
            let config_path = app.path().app_config_dir()?.join("config.json");
            let config = Config::load(&config_path);

            app.manage(AppState {
                captures: Mutex::new(Vec::new()),
                session: Mutex::new(None),
                card: Mutex::new(None),
                config: Mutex::new(config),
                config_path,
                cache_dir,
                shortcuts: Mutex::new(Vec::new()),
                next_id: AtomicU64::new(1),
                pin_seq: AtomicU64::new(0),
                busy: AtomicBool::new(false),
                menu_hidden_at: Mutex::new(None),
            });
            register_hotkeys(app.handle());

            TrayIconBuilder::with_id("snapmark")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?)
                .icon_as_template(true)
                .tooltip("Snapmark")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button_state: MouseButtonState::Up, rect, .. } = event {
                        toggle_menu(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            for d in macos::displays() {
                ensure_overlay(app.handle(), &overlay_label(&d))?;
            }
            ensure_menu(app.handle())?;

            if !macos::has_screen_access() {
                macos::request_screen_access();
            }

            let args: Vec<String> = std::env::args().skip(1).collect();
            handle_args(app.handle(), &args);
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                WindowEvent::Focused(false) if label == "menu" => {
                    let _ = window.hide();
                    *window.state::<AppState>().menu_hidden_at.lock().unwrap() = Some(Instant::now());
                }
                WindowEvent::Destroyed if label.starts_with("editor-") => {
                    let app = window.app_handle();
                    let editors_left =
                        app.webview_windows().keys().any(|l| l.starts_with("editor-") && l.as_str() != label);
                    if !editors_left {
                        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            overlay_session,
            overlay_image,
            overlay_present,
            overlay_cancel,
            overlay_commit,
            overlay_pick_color,
            set_capture_prefs,
            capture_info,
            capture_image,
            start_capture_cmd,
            open_editor_cmd,
            copy_capture,
            save_capture,
            pin_capture_cmd,
            reveal_capture,
            card_current,
            card_dismiss,
            editor_copy,
            editor_save,
            editor_save_as,
            save_dir_label,
            menu_state,
            hide_menu,
            set_autostart,
            open_folder,
            open_preferences,
            open_screen_settings,
            show_pins,
            open_image,
            js_log,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Snapmark")
        .run(|app, event| match event {
            // Closing the last editor must not quit a menu-bar app.
            RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
            // Finder "Open With" / dropping images on the Dock icon.
            RunEvent::Opened { urls } => {
                let paths = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
                open_files(app, paths);
            }
            _ => {}
        });
}
