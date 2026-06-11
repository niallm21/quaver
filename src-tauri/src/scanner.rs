use walkdir::WalkDir;
use lofty::probe::Probe;
use lofty::tag::Accessor;
use lofty::file::{AudioFile, TaggedFileExt};
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct TrackMetadata {
    pub file_path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
}

pub const SUPPORTED_EXTS: [&str; 7] = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"];

pub fn is_supported_audio(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|ext| SUPPORTED_EXTS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn scan_directory(dir: &str) -> Vec<TrackMetadata> {
    let mut files = Vec::new();

    for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && is_supported_audio(path) {
            if let Some(meta) = read_metadata(path) {
                files.push(meta);
            }
        }
    }
    files
}

pub fn read_metadata(path: &std::path::Path) -> Option<TrackMetadata> {
    let mut track_meta = TrackMetadata {
        file_path: path.to_string_lossy().to_string(),
        title: None,
        artist: None,
        album: None,
        duration_secs: None,
    };

    let tagged_file = match Probe::open(path) {
        Ok(probe) => {
            match probe.read() {
                Ok(t) => t,
                Err(_) => return Some(track_meta),
            }
        },
        Err(_) => return Some(track_meta),
    };

    let tag = match tagged_file.primary_tag() {
        Some(primary_tag) => Some(primary_tag),
        None => tagged_file.first_tag(),
    };

    if let Some(tag) = tag {
        track_meta.title = tag.title().map(|s| s.into_owned());
        track_meta.artist = tag.artist().map(|s| s.into_owned());
        track_meta.album = tag.album().map(|s| s.into_owned());
    }
    
    track_meta.duration_secs = Some(tagged_file.properties().duration().as_secs_f64());

    Some(track_meta)
}

pub fn read_art(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    let tagged_file = Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let tag = match tagged_file.primary_tag() {
        Some(primary_tag) => Some(primary_tag),
        None => tagged_file.first_tag(),
    };

    if let Some(tag) = tag {
        if let Some(pic) = tag.pictures().first() {
            return Ok(Some(pic.data().to_vec()));
        }
    }
    
    // Fallback: look for cover.jpg, folder.jpg, etc.
    if let Some(parent) = path.parent() {
        let names = ["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png", "albumart.jpg", "albumart.png", "AlbumArtSmall.jpg"];
        for name in names.iter() {
            let candidate = parent.join(name);
            if candidate.exists() {
                if let Ok(data) = std::fs::read(&candidate) {
                    return Ok(Some(data));
                }
            }
        }
    }
    
    Ok(None)
}
