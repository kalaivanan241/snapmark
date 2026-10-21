//! User preferences, stored as JSON in ~/Library/Application Support/<id>/config.json.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Hotkeys {
    pub area: String,
    pub window: String,
    pub full: String,
    pub color: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            area: "ctrl+shift+4".into(),
            window: "ctrl+shift+5".into(),
            full: "ctrl+shift+3".into(),
            color: "ctrl+shift+c".into(),
        }
    }
}

impl Hotkeys {
    pub fn pairs(&self) -> [(&'static str, &str); 4] {
        [("area", &self.area), ("window", &self.window), ("full", &self.full), ("color", &self.color)]
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub hotkeys: Hotkeys,
    /// What happens after a capture: "card", "editor", "save" or "pin".
    pub after: String,
    /// Self-timer in seconds (0 = off).
    pub timer: u32,
    /// Copy every capture to the clipboard straight away.
    pub auto_copy: bool,
    /// Where ⌘S saves. Defaults to ~/Pictures/Snapmark.
    pub save_dir: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self { hotkeys: Hotkeys::default(), after: "card".into(), timer: 0, auto_copy: true, save_dir: None }
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!("snapmark: ignoring malformed {}: {e}", path.display());
                Self::default()
            }),
            Err(_) => {
                let cfg = Self::default();
                cfg.store(path);
                cfg
            }
        }
    }

    pub fn store(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, text);
        }
    }

    pub fn save_dir(&self) -> PathBuf {
        self.save_dir.clone().unwrap_or_else(|| {
            dirs::picture_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Pictures")).join("Snapmark")
        })
    }
}
