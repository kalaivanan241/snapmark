# Snapmark

A menu-bar screenshot & markup app for macOS, written in Rust (Tauri v2) with the UI from the Snapmark design.

## Install

```sh
./scripts/bundle.sh --install   # builds dist/Snapmark.app, copies it to ~/Applications and launches it
```

The first time you capture, macOS asks for **Screen Recording** permission. Turn on Snapmark in
System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen it.
The app is ad-hoc signed, so after a rebuild you may need to toggle the permission off and on again.

Run from source with `cargo run` (when you launch it from a terminal, that terminal's Screen Recording permission applies).

## Hotkeys

| Global | |
|---|---|
| ⌃⇧4 | Capture area |
| ⌃⇧5 | Capture window |
| ⌃⇧3 | Capture full screen |
| ⌃⇧C | Pick a colour (copies hex) |

You can change these from the gear icon in the menu-bar panel, which opens `config.json`. Changes apply the next time the panel opens.
In the same file: `after` (`card` / `editor` / `save` / `pin`), `timer`, `auto_copy` and `save_dir` (default `~/Pictures/Snapmark`).

**Capture overlay:** drag to select · click a window to snap to it · Space while dragging moves the selection · ⇧ locks the ratio ·
arrow keys nudge · ↵ or double-click captures · A / W / F / P switch mode · Esc cancels.

**Editor:** V select · C crop · P pen · H highlighter · A arrow · L line · R rectangle · O ellipse · T text · N step · B blur ·
S spotlight · M magnifier · E eraser · 1–8 colours · [ ] stroke · ⌘C copy · ⌘S save · ⇧⌘S save as · ⌘Z / ⇧⌘Z undo/redo ·
⌘D duplicate · ⌫ delete · ⌘0 fit · ⌘1 actual size · pinch or ⌘-scroll to zoom · two-finger scroll or Space-drag to pan.

Every capture is copied to the clipboard straight away. After that, the card lets you annotate, copy, save or pin it.

## Scripting

`Snapmark --capture area|window|full|color` starts a capture in the running instance, and `Snapmark image.png` opens an image in the editor.
You can wire these to Raycast, Shortcuts or a Stream Deck.

## Layout

- `src/main.rs`: app state, capture lifecycle, windows, commands
- `src/capture.rs`: wraps `/usr/sbin/screencapture`, handles cropping (keeps the display's ICC profile)
- `src/macos.rs`: CoreGraphics/AppKit FFI (displays, window list, permission, window levels, pasteboard)
- `src/config.rs`: preferences
- `ui/`: overlay, editor, after-capture card, menu-bar panel, pinned window (plain HTML/JS, no build step)
- `scripts/make_icons.py`: regenerates `icons/`
