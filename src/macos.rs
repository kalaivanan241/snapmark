//! Thin wrappers over the macOS APIs Snapmark needs that Tauri doesn't expose:
//! display geometry, the on-screen window list, Screen Recording permission,
//! window levels and the pasteboard.

use std::ffi::c_void;

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSData, NSPoint, NSRect, NSSize, NSString};
use serde::Serialize;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGMainDisplayID() -> u32;
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
    fn CGRectMakeWithDictionaryRepresentation(dict: *const c_void, rect: *mut CGRect) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// A display in global coordinates (points, origin at the top-left of the main display).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Display {
    /// 1-based index as understood by `screencapture -D`.
    pub index: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Display {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

pub fn displays() -> Vec<Display> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    unsafe {
        if CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) != 0 || count == 0 {
            ids[0] = CGMainDisplayID();
            count = 1;
        }
    }
    ids[..count as usize]
        .iter()
        .enumerate()
        .map(|(i, &id)| {
            let b = unsafe { CGDisplayBounds(id) };
            Display { index: i + 1, x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height }
        })
        .collect()
}

pub fn cursor_location() -> (f64, f64) {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return (0.0, 0.0);
        }
        let p = CGEventGetLocation(event);
        CFRelease(event);
        (p.x, p.y)
    }
}

/// The display under the mouse pointer, falling back to the main display.
pub fn display_at_cursor() -> Display {
    let (x, y) = cursor_location();
    let all = displays();
    all.iter().copied().find(|d| d.contains(x, y)).unwrap_or(all[0])
}

pub fn has_screen_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Shows the system prompt the first time; afterwards it just returns false.
pub fn request_screen_access() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

/// An on-screen application window, in display-local points.
#[derive(Clone, Debug, Serialize)]
pub struct WinInfo {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub app: String,
    pub title: String,
}

/// Normal-layer windows on `display`, front to back, excluding our own process.
pub fn onscreen_windows(display: &Display, exclude_pid: u32) -> Vec<WinInfo> {
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) };
    if raw.is_null() {
        return Vec::new();
    }
    let list: CFArray<CFDictionary<CFString, CFType>> = unsafe { CFArray::wrap_under_create_rule(raw as _) };
    let mut out = Vec::new();
    for dict in list.iter() {
        let get = |key: &'static str| dict.find(CFString::from_static_string(key));
        let num = |key| get(key).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64());
        let text = |key| get(key).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string()).unwrap_or_default();

        if num("kCGWindowLayer") != Some(0.0) || num("kCGWindowAlpha").unwrap_or(1.0) <= 0.0 {
            continue;
        }
        if num("kCGWindowOwnerPID") == Some(exclude_pid as f64) {
            continue;
        }
        let Some(bounds) = get("kCGWindowBounds") else { continue };
        let mut r = CGRect::default();
        if !unsafe { CGRectMakeWithDictionaryRepresentation(bounds.as_CFTypeRef(), &mut r) } {
            continue;
        }
        if r.size.width < 40.0 || r.size.height < 40.0 {
            continue;
        }
        let (cx, cy) = (r.origin.x + r.size.width / 2.0, r.origin.y + r.size.height / 2.0);
        if !display.contains(cx, cy) {
            continue;
        }
        out.push(WinInfo {
            id: num("kCGWindowNumber").unwrap_or(0.0) as u32,
            x: r.origin.x - display.x,
            y: r.origin.y - display.y,
            w: r.size.width,
            h: r.size.height,
            app: text("kCGWindowOwnerName"),
            title: text("kCGWindowName"),
        });
    }
    out
}

// ---- AppKit (main thread only) ----------------------------------------------

/// Cover a display (global top-left coordinates, in points) with a borderless
/// window above the menu bar and Dock, on every Space, and bring it on screen.
///
/// # Safety
/// `ns_window` must be a live `NSWindow*` and this must run on the main thread.
pub unsafe fn show_overlay_window(ns_window: *mut c_void, x: f64, y: f64, w: f64, h: f64) {
    const SCREEN_SAVER_LEVEL: isize = 1000;
    // canJoinAllSpaces | stationary | fullScreenAuxiliary
    const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 8);
    // Cocoa's origin is the bottom-left of the main display.
    let main_h = CGDisplayBounds(CGMainDisplayID()).size.height;
    let frame = NSRect::new(NSPoint::new(x, main_h - y - h), NSSize::new(w, h));
    let win = ns_window as *mut AnyObject;
    let _: () = msg_send![win, setLevel: SCREEN_SAVER_LEVEL];
    let _: () = msg_send![win, setCollectionBehavior: BEHAVIOR];
    let _: () = msg_send![win, setHasShadow: false];
    let _: () = msg_send![win, setFrame: frame, display: true];
    let _: () = msg_send![win, orderFrontRegardless];
}

/// Keep a floating window (card, pin) visible over full-screen apps too.
///
/// # Safety
/// Same as [`make_overlay_window`].
pub unsafe fn make_floating_window(ns_window: *mut c_void) {
    const FLOATING_LEVEL: isize = 3;
    const BEHAVIOR: usize = (1 << 0) | (1 << 8);
    let win = ns_window as *mut AnyObject;
    let _: () = msg_send![win, setLevel: FLOATING_LEVEL];
    let _: () = msg_send![win, setCollectionBehavior: BEHAVIOR];
}

/// # Safety
/// Same as [`make_overlay_window`].
pub unsafe fn lock_aspect_ratio(ns_window: *mut c_void, w: f64, h: f64) {
    let win = ns_window as *mut AnyObject;
    let _: () = msg_send![win, setContentAspectRatio: NSSize::new(w, h)];
}

/// Hand focus back to whichever app was active before the capture.
///
/// # Safety
/// Must run on the main thread.
pub unsafe fn deactivate_app() {
    let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
    let _: () = msg_send![app, deactivate];
}

// ---- Pasteboard ---------------------------------------------------------------

fn with_pasteboard(f: impl FnOnce(*mut AnyObject) -> bool) -> bool {
    unsafe {
        let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return false;
        }
        let _: isize = msg_send![pb, clearContents];
        f(pb)
    }
}

/// Put PNG bytes on the clipboard as-is (no re-encode), so every app gets full resolution.
pub fn copy_png(bytes: &[u8]) -> bool {
    with_pasteboard(|pb| unsafe {
        let data = NSData::with_bytes(bytes);
        let ty = NSString::from_str("public.png");
        msg_send![pb, setData: &*data, forType: &*ty]
    })
}

pub fn copy_text(text: &str) -> bool {
    with_pasteboard(|pb| unsafe {
        let s = NSString::from_str(text);
        let ty = NSString::from_str("public.utf8-plain-text");
        msg_send![pb, setString: &*s, forType: &*ty]
    })
}
