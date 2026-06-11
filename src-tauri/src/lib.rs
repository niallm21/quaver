mod db;
mod scanner;
mod waveform;
pub mod metadata;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::sync::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, Emitter};
use tauri_plugin_fs::FsExt;
use crate::scanner::TrackMetadata;

struct AppState {
    db: Mutex<Option<Connection>>,
    // Audio files passed on the command line (e.g. double-clicked in Explorer),
    // held until the frontend is ready to ask for them.
    pending_files: Mutex<Vec<String>>,
}

fn percent_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn audio_path_from_arg(arg: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let raw = arg.trim().trim_matches('"').trim_matches('\'').trim();
    if raw.is_empty() || raw.starts_with('-') {
        return None;
    }

    let lower = raw.to_ascii_lowercase();
    let path_text = if lower.starts_with("file://") {
        let mut rest = &raw[7..];
        if rest.starts_with('/') && rest.as_bytes().get(2) == Some(&b':') {
            rest = &rest[1..];
        }
        if rest.starts_with('/') {
            percent_decode_lossy(rest)
        } else {
            format!(r"\\{}", percent_decode_lossy(rest).replace('/', r"\"))
        }
    } else {
        raw.to_string()
    };

    let path = PathBuf::from(path_text);
    let path = if path.is_relative() {
        cwd.map(|base| base.join(path))?
    } else {
        path
    };
    let path = path.canonicalize().unwrap_or(path);

    if path.is_file() && scanner::is_supported_audio(&path) {
        Some(path)
    } else {
        None
    }
}

fn audio_files_from_args<'a>(args: impl Iterator<Item = &'a String>, cwd: Option<&Path>) -> Vec<String> {
    let mut files = Vec::new();
    for arg in args {
        if let Some(path) = audio_path_from_arg(arg, cwd) {
            let file = path.to_string_lossy().to_string();
            if !files.contains(&file) {
                files.push(file);
            }
        }
    }
    files
}

fn allow_audio_files(app: &tauri::AppHandle, files: &[String]) {
    for file in files {
        let _ = app.asset_protocol_scope().allow_file(file);
        let _ = app.fs_scope().allow_file(file);
    }
}

fn queue_audio_files(app: &tauri::AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }

    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut pending) = state.pending_files.lock() {
            for file in files {
                if !pending.contains(&file) {
                    pending.push(file);
                }
            }
        }
        let _ = app.emit("open-files", ());
    } else {
        let _ = app.emit("open-files", ());
    }
}

// Upsert keeps the existing row in place. INSERT OR REPLACE would delete + reinsert,
// and with foreign_keys ON the delete cascades into playlist_tracks, silently
// emptying playlists on every rescan. COALESCE preserves metadata recovered by the
// AcoustID fetcher when the file's own tags are missing.
const UPSERT_TRACK_SQL: &str =
    "INSERT INTO tracks (file_path, title, artist, album, duration_secs, scanned_at)
     VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))
     ON CONFLICT(file_path) DO UPDATE SET
        title = COALESCE(excluded.title, title),
        artist = COALESCE(excluded.artist, artist),
        album = COALESCE(excluded.album, album),
        duration_secs = excluded.duration_secs,
        scanned_at = excluded.scanned_at";

fn file_modified_time(path: &Path) -> i64 {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn path_is_in_folder(file_path: &str, folder: &str) -> bool {
    let file_path = file_path.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let folder = folder.replace('\\', "/").trim_end_matches('/').to_lowercase();
    file_path == folder || file_path.starts_with(&format!("{}/", folder))
}

#[derive(Serialize)]
struct FolderSummary {
    path: String,
    name: String,
    track_count: usize,
    duration_secs: f64,
}

#[derive(Serialize)]
struct PlaylistSummary {
    id: i64,
    name: String,
    track_count: i64,
    duration_secs: f64,
}

#[tauri::command]
async fn scan_folder(folder_path: String, app_handle: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Vec<TrackMetadata>, String> {
    app_handle.fs_scope().allow_directory(&folder_path, true).map_err(|e| e.to_string())?;
    let _ = app_handle.asset_protocol_scope().allow_directory(&folder_path, true);
    let scan_path = folder_path.clone();
    let files = tokio::task::spawn_blocking(move || scanner::scan_directory(&scan_path))
        .await
        .map_err(|e| e.to_string())?;

    let mut db_guard = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = db_guard.as_mut() {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let _ = tx.execute(
            "INSERT OR REPLACE INTO folders (path, added_at) VALUES (?1, strftime('%s','now'))",
            (&folder_path,),
        );
        for track in &files {
            let _ = tx.execute(UPSERT_TRACK_SQL, (
                &track.file_path,
                &track.title,
                &track.artist,
                &track.album,
                &track.duration_secs,
            ));
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(files)
}

#[tauri::command]
async fn get_waveform_peaks(file_path: String, state: tauri::State<'_, AppState>) -> Result<Vec<f32>, String> {
    let path = std::path::PathBuf::from(&file_path);
    let modified_time = file_modified_time(&path);

    // Check cache in db first
    {
        let db_guard = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(conn) = db_guard.as_ref() {
            let mut stmt = conn.prepare("SELECT peaks_json, COALESCE(modified_time, 0) FROM peaks WHERE file_path = ?1")
                .map_err(|e| e.to_string())?;

            let cached: Option<(String, i64)> = stmt.query_row([&file_path], |row| {
                Ok((row.get(0)?, row.get(1)?))
            }).ok();

            if let Some((peaks_json, cached_modified_time)) = cached {
                if let Ok(peaks) = serde_json::from_str::<Vec<f32>>(&peaks_json) {
                    // modified_time of 0 means the file is unreadable; don't trust a match on it
                    if cached_modified_time == modified_time && modified_time != 0 {
                        return Ok(peaks);
                    }
                }
            }
        }
    }

    // Generate peaks (approx 1000 min/max pairs = 2000 items) off the async runtime
    let peaks = tokio::task::spawn_blocking(move || waveform::generate_peaks(&path, 1000))
        .await
        .map_err(|e| e.to_string())??;
    
    // Cache the result
    if let Ok(db_guard) = state.db.lock() {
        if let Some(conn) = db_guard.as_ref() {
            let peaks_json = serde_json::to_string(&peaks).unwrap();
            let _ = conn.execute(
                "INSERT OR REPLACE INTO peaks (file_path, peaks_json, modified_time) VALUES (?1, ?2, ?3)",
                (&file_path, &peaks_json, modified_time),
            );
        }
    }

    Ok(peaks)
}

// Art is returned as a raw-bytes IPC response (ArrayBuffer on the JS side) instead of
// a JSON number array; an empty body means "no art".
#[tauri::command]
async fn get_track_art(file_path: String) -> Result<tauri::ipc::Response, String> {
    let path = std::path::PathBuf::from(file_path);
    let art = tokio::task::spawn_blocking(move || scanner::read_art(&path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(art.unwrap_or_default()))
}

const ART_MISS_TTL_SECS: i64 = 7 * 24 * 60 * 60;

#[tauri::command]
async fn get_track_preview_art(
    file_path: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let path = std::path::PathBuf::from(&file_path);
    let embedded = tokio::task::spawn_blocking(move || scanner::read_art(&path))
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(Some(art)) = embedded {
        return Ok(tauri::ipc::Response::new(art));
    }

    let query = if let (Some(artist), Some(album)) = (artist.as_deref(), album.as_deref()) {
        Some(format!("{} {}", artist, album))
    } else if let (Some(artist), Some(title)) = (artist.as_deref(), title.as_deref()) {
        Some(format!("{} {}", artist, title))
    } else {
        None
    };

    let Some(query) = query else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    let cache_key = query.to_lowercase();

    // Serve from the persistent cache so launches don't re-download the library's art.
    {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(conn) = guard.as_ref() {
            let cached: Option<(Vec<u8>, i64)> = conn
                .query_row(
                    "SELECT data, strftime('%s','now') - fetched_at FROM art_cache WHERE cache_key = ?1",
                    [&cache_key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();
            if let Some((data, age_secs)) = cached {
                if !data.is_empty() {
                    return Ok(tauri::ipc::Response::new(data));
                }
                if age_secs < ART_MISS_TTL_SECS {
                    return Ok(tauri::ipc::Response::new(Vec::new()));
                }
            }
        }
    }

    // Cache both hits and confirmed misses; network errors propagate uncached so a
    // flaky connection doesn't poison the cache.
    let art = metadata::fetch_album_art(&query).await?;
    let data = art.unwrap_or_default();
    if let Ok(guard) = state.db.lock() {
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO art_cache (cache_key, data, fetched_at) VALUES (?1, ?2, strftime('%s','now'))",
                (&cache_key, &data),
            );
        }
    }
    Ok(tauri::ipc::Response::new(data))
}

#[tauri::command]
fn get_library(state: tauri::State<'_, AppState>) -> Result<Vec<TrackMetadata>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    let mut stmt = conn
        .prepare("SELECT file_path, title, artist, album, duration_secs FROM tracks ORDER BY artist, album, title")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TrackMetadata {
                file_path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                duration_secs: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();
    for r in rows { tracks.push(r.map_err(|e| e.to_string())?); }
    Ok(tracks)
}

#[tauri::command]
fn get_folders(state: tauri::State<'_, AppState>) -> Result<Vec<FolderSummary>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;

    let mut folder_stmt = conn
        .prepare("SELECT path FROM folders ORDER BY added_at DESC")
        .map_err(|e| e.to_string())?;
    let folder_rows = folder_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let folders: Vec<String> = folder_rows.filter_map(|row| row.ok()).collect();

    let mut track_stmt = conn
        .prepare("SELECT file_path, COALESCE(duration_secs, 0) FROM tracks")
        .map_err(|e| e.to_string())?;
    let track_rows = track_stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)))
        .map_err(|e| e.to_string())?;
    let tracks: Vec<(String, f64)> = track_rows.filter_map(|row| row.ok()).collect();

    Ok(folders
        .into_iter()
        .map(|path| {
            let mut track_count = 0usize;
            let mut duration_secs = 0f64;
            for (file_path, duration) in &tracks {
                if path_is_in_folder(file_path, &path) {
                    track_count += 1;
                    duration_secs += *duration;
                }
            }

            let name = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
                .unwrap_or_else(|| path.clone());

            FolderSummary {
                path,
                name,
                track_count,
                duration_secs,
            }
        })
        .collect())
}

fn playlist_summary(conn: &Connection, playlist_id: i64) -> Result<PlaylistSummary, String> {
    conn.query_row(
        "SELECT p.id, p.name, COUNT(pt.file_path) AS track_count, COALESCE(SUM(t.duration_secs), 0) AS duration_secs
         FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         LEFT JOIN tracks t ON t.file_path = pt.file_path
         WHERE p.id = ?1
         GROUP BY p.id, p.name",
        [playlist_id],
        |row| {
            Ok(PlaylistSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                duration_secs: row.get(3)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_playlists(state: tauri::State<'_, AppState>) -> Result<Vec<PlaylistSummary>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, COUNT(pt.file_path) AS track_count, COALESCE(SUM(t.duration_secs), 0) AS duration_secs
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             LEFT JOIN tracks t ON t.file_path = pt.file_path
             GROUP BY p.id, p.name
             ORDER BY p.updated_at DESC, p.created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PlaylistSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                duration_secs: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut playlists = Vec::new();
    for row in rows {
        playlists.push(row.map_err(|e| e.to_string())?);
    }
    Ok(playlists)
}

#[tauri::command]
fn create_playlist(name: String, state: tauri::State<'_, AppState>) -> Result<PlaylistSummary, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Playlist name cannot be empty".into());
    }

    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    conn.execute(
        "INSERT INTO playlists (name, created_at, updated_at) VALUES (?1, strftime('%s','now'), strftime('%s','now'))",
        [trimmed],
    )
    .map_err(|e| e.to_string())?;
    playlist_summary(conn, conn.last_insert_rowid())
}

#[tauri::command]
fn create_playlist_from_tracks(
    name: String,
    file_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<PlaylistSummary, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Playlist name cannot be empty".into());
    }

    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    conn.execute(
        "INSERT INTO playlists (name, created_at, updated_at) VALUES (?1, strftime('%s','now'), strftime('%s','now'))",
        [trimmed],
    )
    .map_err(|e| e.to_string())?;
    let playlist_id = conn.last_insert_rowid();

    for (index, file_path) in file_paths.iter().enumerate() {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, file_path, position, added_at)
             VALUES (?1, ?2, ?3, strftime('%s','now'))",
            (playlist_id, file_path, index as i64),
        );
    }

    playlist_summary(conn, playlist_id)
}

#[tauri::command]
fn add_tracks_to_playlist(
    playlist_id: i64,
    file_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<PlaylistSummary, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    let start_position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
            [playlist_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    for (index, file_path) in file_paths.iter().enumerate() {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, file_path, position, added_at)
             VALUES (?1, ?2, ?3, strftime('%s','now'))",
            (playlist_id, file_path, start_position + index as i64),
        );
    }
    let _ = conn.execute("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?1", [playlist_id]);

    playlist_summary(conn, playlist_id)
}

#[tauri::command]
fn get_playlist_tracks(
    playlist_id: i64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TrackMetadata>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    let mut stmt = conn
        .prepare(
            "SELECT t.file_path, t.title, t.artist, t.album, t.duration_secs
             FROM playlist_tracks pt
             JOIN tracks t ON t.file_path = pt.file_path
             WHERE pt.playlist_id = ?1
             ORDER BY pt.position, pt.added_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([playlist_id], |row| {
            Ok(TrackMetadata {
                file_path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                duration_secs: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut tracks = Vec::new();
    for row in rows {
        tracks.push(row.map_err(|e| e.to_string())?);
    }
    Ok(tracks)
}

#[tauri::command]
fn rename_playlist(
    playlist_id: i64,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<PlaylistSummary, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Playlist name cannot be empty".into());
    }

    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    conn.execute(
        "UPDATE playlists SET name = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
        (trimmed, playlist_id),
    )
    .map_err(|e| e.to_string())?;
    playlist_summary(conn, playlist_id)
}

#[tauri::command]
fn delete_playlist(playlist_id: i64, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    // playlist_tracks rows go with it via ON DELETE CASCADE
    conn.execute("DELETE FROM playlists WHERE id = ?1", [playlist_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_playlist_order(
    playlist_id: i64,
    file_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<PlaylistSummary, String> {
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("db not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (index, file_path) in file_paths.iter().enumerate() {
        let _ = tx.execute(
            "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND file_path = ?3",
            (index as i64, playlist_id, file_path),
        );
    }
    let _ = tx.execute("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?1", [playlist_id]);
    tx.commit().map_err(|e| e.to_string())?;
    playlist_summary(conn, playlist_id)
}

#[tauri::command]
fn remove_track_from_playlist(
    playlist_id: i64,
    file_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<PlaylistSummary, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    conn.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND file_path = ?2",
        (playlist_id, file_path),
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?1", [playlist_id]);
    playlist_summary(conn, playlist_id)
}

#[tauri::command]
async fn rescan_library(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TrackMetadata>, String> {
    // 1) Collect the known folders (lock released immediately after)
    let folders: Vec<String> = {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("db not initialised")?;
        let mut stmt = conn.prepare("SELECT path FROM folders").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut seen_paths = HashSet::new();

    // 2) Re-scope + re-scan each folder, upserting tracks.
    //    scan_directory is slow I/O, so do NOT hold the DB lock across it.
    for folder in &folders {
        let _ = app_handle.fs_scope().allow_directory(folder, true);
        let _ = app_handle.asset_protocol_scope().allow_directory(folder, true);
        let scan_path = folder.clone();
        let files = tokio::task::spawn_blocking(move || scanner::scan_directory(&scan_path))
            .await
            .map_err(|e| e.to_string())?;
        for track in &files {
            seen_paths.insert(track.file_path.clone());
        }
        let mut guard = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(conn) = guard.as_mut() {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for track in &files {
                let _ = tx.execute(
                    UPSERT_TRACK_SQL,
                    (&track.file_path, &track.title, &track.artist, &track.album, &track.duration_secs),
                );
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
    }

    if !folders.is_empty() {
        let mut guard = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(conn) = guard.as_mut() {
            let existing_paths: Vec<String> = {
                let mut stmt = conn
                    .prepare("SELECT file_path FROM tracks")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.filter_map(|row| row.ok()).collect()
            };

            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for file_path in existing_paths {
                if seen_paths.contains(&file_path) {
                    continue;
                }

                if folders.iter().any(|folder| path_is_in_folder(&file_path, folder)) {
                    let _ = tx.execute("DELETE FROM playlist_tracks WHERE file_path = ?1", [&file_path]);
                    let _ = tx.execute("DELETE FROM peaks WHERE file_path = ?1", [&file_path]);
                    let _ = tx.execute("DELETE FROM tracks WHERE file_path = ?1", [&file_path]);
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
    }

    // 3) Return the full, de-duplicated library (same query as get_library)
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    let mut stmt = conn
        .prepare("SELECT file_path, title, artist, album, duration_secs FROM tracks ORDER BY artist, album, title")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(TrackMetadata {
            file_path: row.get(0)?,
            title: row.get(1)?,
            artist: row.get(2)?,
            album: row.get(3)?,
            duration_secs: row.get(4)?,
        }))
        .map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();
    for r in rows { tracks.push(r.map_err(|e| e.to_string())?); }
    Ok(tracks)
}

#[tauri::command]
fn get_launch_files(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut guard = state.pending_files.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut *guard))
}

#[tauri::command]
async fn import_files(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TrackMetadata>, String> {
    let candidates: Vec<String> = paths
        .into_iter()
        .filter(|p| {
            let path = std::path::Path::new(p);
            path.is_file() && scanner::is_supported_audio(path)
        })
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    for path in &candidates {
        let _ = app_handle.asset_protocol_scope().allow_file(path);
        let _ = app_handle.fs_scope().allow_file(path);
    }

    let imported = tokio::task::spawn_blocking(move || {
        candidates
            .iter()
            .filter_map(|p| scanner::read_metadata(std::path::Path::new(p)))
            .collect::<Vec<TrackMetadata>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = guard.as_mut() {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for track in &imported {
            let _ = tx.execute(UPSERT_TRACK_SQL, (
                &track.file_path,
                &track.title,
                &track.artist,
                &track.album,
                &track.duration_secs,
            ));
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(imported)
}

#[tauri::command]
fn reset_library(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("db not initialised")?;
    conn.execute("DELETE FROM tracks", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM peaks", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM playlist_tracks", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM playlists", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM art_cache", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // A second launch (e.g. double-clicking a song in Explorer) forwards
            // its arguments here and exits; play the files in this instance.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let files = audio_files_from_args(argv.iter(), Some(Path::new(&cwd)));
            allow_audio_files(app, &files);
            queue_audio_files(app, files);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&app_dir).unwrap();
            let db = db::init_db(&app_dir).unwrap();
            // Re-grant scopes for every previously-added folder
            if let Ok(mut stmt) = db.prepare("SELECT path FROM folders") {
                if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                    for path in rows.flatten() {
                        let _ = app.fs_scope().allow_directory(&path, true);
                        let _ = app.asset_protocol_scope().allow_directory(&path, true);
                    }
                }
            }
            // Audio files passed on first launch (Explorer "open with" / default app)
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().ok();
            let initial_files = audio_files_from_args(args.iter(), cwd.as_deref());
            allow_audio_files(app.handle(), &initial_files);

            app.manage(AppState {
                db: Mutex::new(Some(db)),
                pending_files: Mutex::new(initial_files),
            });

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Background metadata fetcher
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    
                    let state = app_handle.state::<AppState>();
                    let file_path_to_process = {
                        if let Ok(guard) = state.db.lock() {
                            if let Some(conn) = guard.as_ref() {
                                // Find a track missing any metadata field where we haven't
                                // attempted a fetch in the last hour, or haven't attempted at all.
                                let stmt = conn.prepare(
                                    "SELECT file_path FROM tracks WHERE (title IS NULL OR artist IS NULL OR album IS NULL) AND (strftime('%s','now') - last_metadata_fetch_attempt > 3600) LIMIT 1"
                                );
                                if let Ok(mut stmt) = stmt {
                                    if let Ok(row) = stmt.query_row([], |row| row.get::<_, String>(0)) {
                                        Some(row)
                                    } else {
                                        None
                                    }
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    };

                    if let Some(path) = file_path_to_process {
                        // Mark as attempted to avoid infinite tight loops
                        if let Ok(guard) = state.db.lock() {
                            if let Some(conn) = guard.as_ref() {
                                let _ = conn.execute(
                                    "UPDATE tracks SET last_metadata_fetch_attempt = strftime('%s','now') WHERE file_path = ?1",
                                    [&path]
                                );
                            }
                        }

                        // Try to fetch
                        if let Ok(meta) = metadata::fetch_metadata(&path).await {
                            if meta.title.is_some() || meta.artist.is_some() || meta.album.is_some() {
                                if let Ok(guard) = state.db.lock() {
                                    if let Some(conn) = guard.as_ref() {
                                        let _ = conn.execute(
                                            "UPDATE tracks SET title = COALESCE(?1, title), artist = COALESCE(?2, artist), album = COALESCE(?3, album) WHERE file_path = ?4",
                                            (meta.title, meta.artist, meta.album, &path)
                                        );
                                    }
                                }
                                // Emit event to update UI
                                let _ = app_handle.emit("metadata-updated", ());
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            get_waveform_peaks,
            get_track_art,
            get_track_preview_art,
            get_library,
            get_folders,
            get_playlists,
            create_playlist,
            create_playlist_from_tracks,
            add_tracks_to_playlist,
            get_playlist_tracks,
            rename_playlist,
            delete_playlist,
            set_playlist_order,
            remove_track_from_playlist,
            rescan_library,
            reset_library,
            get_launch_files,
            import_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
