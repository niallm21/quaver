# Quaver

A lightweight local music player for Windows, built with Tauri 2, React, and TypeScript.

- Scans folders for `mp3`, `wav`, `flac`, `ogg`, `m4a`, `aac`, and `opus` files
- Browse by songs, albums, folders, or playlists, with search and sorting
- Seekable waveform display with cached peak data (SQLite)
- Album art from embedded tags, sidecar covers, or the iTunes Search API (cached locally)
- Automatic metadata recovery for untagged files via AcoustID audio fingerprinting
- Audio-reactive background visualizers themed from the current album art

## Development

```sh
npm install
npm run tauri dev   # or launch.bat
```

## Build

```sh
npm run tauri build
```
