use rusqlite::{Connection, Result};
use std::path::PathBuf;
use std::time::Duration;

pub fn init_db(app_data_dir: &PathBuf) -> Result<Connection> {
    let db_path = app_data_dir.join("quaver.db");
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // WAL keeps readers responsive while scans write; journal_mode returns a row,
    // so query_row instead of pragma_update.
    let _ = conn.query_row("PRAGMA journal_mode = WAL", [], |_row| Ok(()));
    let _ = conn.busy_timeout(Duration::from_secs(5));

    conn.execute(
        "CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY,
            file_path TEXT UNIQUE NOT NULL,
            title TEXT,
            artist TEXT,
            album TEXT,
            duration_secs REAL,
            scanned_at INTEGER,
            last_metadata_fetch_attempt INTEGER DEFAULT 0
        )",
        [],
    )?;

    // Add column if migrating from an older schema version
    let _ = conn.execute("ALTER TABLE tracks ADD COLUMN last_metadata_fetch_attempt INTEGER DEFAULT 0", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS peaks (
            file_path TEXT PRIMARY KEY,
            peaks_json TEXT NOT NULL,
            modified_time INTEGER
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS folders (
            path TEXT PRIMARY KEY,
            added_at INTEGER
        )",
        [],
    )?;

    // Downloaded album art, keyed by the lowercased search query.
    // An empty blob records a confirmed miss so we don't re-query every launch.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS art_cache (
            cache_key TEXT PRIMARY KEY,
            data BLOB NOT NULL,
            fetched_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            position INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (playlist_id, file_path),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
            FOREIGN KEY (file_path) REFERENCES tracks(file_path) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tracks_artist_album_title ON tracks(artist, album, title)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_position ON playlist_tracks(playlist_id, position)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_playlist_tracks_file_path ON playlist_tracks(file_path)",
        [],
    )?;

    Ok(conn)
}
