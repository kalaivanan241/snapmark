//! Pixel grabbing. We shell out to Apple's own `screencapture`, which keeps
//! working across macOS releases (the CoreGraphics capture calls are being
//! retired) and produces native-resolution PNGs.

use std::path::Path;
use std::process::Command;

use image::codecs::png::{CompressionType, FilterType, PngDecoder, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder};

const SCREENCAPTURE: &str = "/usr/sbin/screencapture";

fn run(args: &[&str], out: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(out);
    let status = Command::new(SCREENCAPTURE)
        .args(args)
        .arg(out)
        .status()
        .map_err(|e| format!("couldn't run screencapture: {e}"))?;
    if !status.success() || !out.exists() {
        return Err("screencapture didn't produce an image".into());
    }
    Ok(())
}

/// Silent capture of one whole display (`index` is 1-based, main display first).
pub fn display(index: usize, out: &Path) -> Result<(), String> {
    run(&["-x", "-t", "png", "-D", &index.to_string()], out)
}

/// Capture a single window by its CG window number, without the drop shadow.
pub fn window(id: u32, out: &Path) -> Result<(), String> {
    run(&["-x", "-o", "-t", "png", "-l", &id.to_string()], out)
}

pub fn dimensions(path: &Path) -> Result<(u32, u32), String> {
    image::image_dimensions(path).map_err(|e| e.to_string())
}

/// Crop a pixel rectangle out of a PNG file. The rect is clamped to the image.
/// The display's colour profile is carried over so colours stay exact.
pub fn crop(src: &Path, x: u32, y: u32, w: u32, h: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let file = std::io::BufReader::new(std::fs::File::open(src).map_err(|e| e.to_string())?);
    let mut decoder = PngDecoder::new(file).map_err(|e| e.to_string())?;
    let icc = decoder.icc_profile().ok().flatten();
    let img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?.into_rgba8();
    let x = x.min(img.width().saturating_sub(1));
    let y = y.min(img.height().saturating_sub(1));
    let w = w.clamp(1, img.width() - x);
    let h = h.clamp(1, img.height() - y);
    let sub = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    Ok((encode_png(sub.as_raw(), w, h, icc)?, w, h))
}

fn encode_png(rgba: &[u8], w: u32, h: u32, icc: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive);
    if let Some(icc) = icc {
        let _ = encoder.set_icc_profile(icc);
    }
    encoder.write_image(rgba, w, h, ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_clamps_and_keeps_colour_profile() {
        let dir = std::env::temp_dir().join(format!("snapmark-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.png");
        let rgba: Vec<u8> = (0..40 * 30).flat_map(|i| [(i % 40) as u8, (i / 40) as u8, 0, 255]).collect();
        let icc = b"fake-icc-profile".to_vec();
        std::fs::write(&src, encode_png(&rgba, 40, 30, Some(icc.clone())).unwrap()).unwrap();

        let (bytes, w, h) = crop(&src, 10, 5, 100, 10).unwrap();
        assert_eq!((w, h), (30, 10), "width is clamped to the image");
        let mut dec = PngDecoder::new(std::io::Cursor::new(&bytes)).unwrap();
        assert_eq!(dec.icc_profile().unwrap(), Some(icc));
        let img = DynamicImage::from_decoder(dec).unwrap().into_rgba8();
        assert_eq!(img.get_pixel(0, 0).0, [10, 5, 0, 255], "crop starts at the requested pixel");
        std::fs::remove_dir_all(dir).ok();
    }
}
