import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWavesurfer } from "@wavesurfer/react";
import { Vibrant } from 'node-vibrant/browser';
import { open } from "@tauri-apps/plugin-dialog";
import { Minimize2, X, Play, Pause, SkipBack, SkipForward, Search, FolderPlus, Volume2, VolumeX, MoreVertical, Music, PanelLeftClose, PanelLeftOpen, Shuffle, Repeat, Repeat1, ListMusic, ListPlus, Library, Disc3, Folder, Plus, ChevronLeft, ChevronUp, ChevronDown, Pencil, Check, Trash2, Wand2 } from "lucide-react";
import "./App.css";

const COLLAPSED_WINDOW_MIN_WIDTH = 390;
const COLLAPSED_WINDOW_MAX_WIDTH = 520;
const WINDOW_RESIZE_DURATION = 260;

type Track = {
  file_path: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration_secs?: number | null;
};

type FolderSummary = {
  path: string;
  name: string;
  track_count: number;
  duration_secs: number;
};

type PlaylistSummary = {
  id: number;
  name: string;
  track_count: number;
  duration_secs: number;
};

type BrowseMode = "songs" | "albums" | "folders" | "playlists";
type SortMode = "artist" | "album" | "title";
type VisualizerMode = "lavalamp" | "aurora" | "pulse";
type ImportNotice = {
  id: number;
  title: string;
  detail: string;
};

const VISUALIZER_MODES: VisualizerMode[] = ["lavalamp", "aurora", "pulse"];

const setDefaultPalette = () => {
  document.documentElement.style.setProperty('--bg-color-1', '#3a1c71');
  document.documentElement.style.setProperty('--bg-color-2', '#d76d77');
  document.documentElement.style.setProperty('--bg-color-3', '#ffaf7b');
};

const applyPaletteFromUrl = (url: string, shouldApply: () => boolean = () => true) => {
  Vibrant.from(url).getPalette().then((palette: any) => {
    if (!shouldApply()) return;
    if (palette.Vibrant && palette.Muted && palette.DarkVibrant) {
      document.documentElement.style.setProperty('--bg-color-1', palette.Vibrant.hex);
      document.documentElement.style.setProperty('--bg-color-2', palette.DarkVibrant.hex);
      document.documentElement.style.setProperty('--bg-color-3', palette.Muted.hex);
    }
  }).catch(console.error);
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const createArtObjectUrl = (artBytes: unknown) => {
  // Art commands return raw bytes (ArrayBuffer); an empty body means "no art".
  if (artBytes instanceof ArrayBuffer) {
    if (artBytes.byteLength === 0) return null;
    return URL.createObjectURL(new Blob([artBytes]));
  }
  if (Array.isArray(artBytes) && artBytes.length > 0) {
    return URL.createObjectURL(new Blob([new Uint8Array(artBytes as number[])]));
  }
  return null;
};

const getTrackName = (track: Track) => (
  track.title || track.file_path.split('\\').pop()?.split('/').pop() || "Unknown Track"
);

const getArtQuery = (track: Track) => {
  if (track.artist && track.album) return `${track.artist} ${track.album}`;
  if (track.title && track.artist) return `${track.artist} ${track.title}`;
  return "";
};

const getArtistName = (track: Track) => track.artist?.trim() || "Unknown Artist";
const getAlbumName = (track: Track) => track.album?.trim() || "Unknown Album";
const getAlbumKey = (track: Track) => `${getArtistName(track)}\u0000${getAlbumName(track)}`;
const normalizeLibraryPath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const trackBelongsToFolder = (track: Track, folderPath: string) => {
  const folder = normalizeLibraryPath(folderPath);
  const filePath = normalizeLibraryPath(track.file_path);
  return filePath === folder || filePath.startsWith(`${folder}/`);
};

const formatMinutesLabel = (seconds = 0) => {
  if (!seconds || seconds < 1) return "";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

const dedupeTracks = (items: Track[]) => {
  const tracksByPath = new Map<string, Track>();
  for (const item of items) tracksByPath.set(item.file_path, item);
  return Array.from(tracksByPath.values());
};

function TrackThumbnail({
  track,
  src,
  loadThumbnail,
}: {
  track: Track;
  src?: string | null;
  loadThumbnail: (track: Track) => void;
}) {
  useEffect(() => {
    if (!src) loadThumbnail(track);
  }, [track.file_path, track.title, track.artist, track.album, src, loadThumbnail]);

  if (src) {
    return <img className="track-thumb" src={src} alt="" />;
  }

  return (
    <div className="track-thumb track-thumb-empty">
      <Music size={16} aria-hidden="true" />
    </div>
  );
}

function AlbumThumbnail({
  tracks,
  src,
  loadAlbumThumbnail,
}: {
  tracks: Track[];
  src?: string | null;
  loadAlbumThumbnail: (tracks: Track[]) => void;
}) {
  useEffect(() => {
    if (!src && tracks.length > 0) loadAlbumThumbnail(tracks);
  }, [tracks, src, loadAlbumThumbnail]);

  if (src) {
    return <img className="track-thumb" src={src} alt="" />;
  }

  return (
    <div className="track-thumb track-thumb-empty">
      <Music size={16} aria-hidden="true" />
    </div>
  );
}

function BackgroundVisualizer({ mode }: { mode: VisualizerMode }) {
  return (
    <div className="visualizer-bg" data-mode={mode} aria-hidden="true">
      {VISUALIZER_MODES.map((layer) => (
        <div key={layer} className={`visualizer-layer ${layer}`}>
          <div className="vis-element vis-1"></div>
          <div className="vis-element vis-2"></div>
          <div className="vis-element vis-3"></div>
          <div className="vis-element vis-4"></div>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [visualizer, setVisualizer] = useState<VisualizerMode>(() => {
    const saved = localStorage.getItem("quaver_visualizer");
    return VISUALIZER_MODES.includes(saved as VisualizerMode) ? (saved as VisualizerMode) : "lavalamp";
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [playlistTracks, setPlaylistTracks] = useState<Record<number, Track[]>>({});
  const [browseMode, setBrowseMode] = useState<BrowseMode>("songs");
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [selectedAlbumKey, setSelectedAlbumKey] = useState<string | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("artist");
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [currentArtUrl, setCurrentArtUrl] = useState<string | null>(null);
  const [trackArtUrls, setTrackArtUrls] = useState<Record<string, string | null>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [showScroll, setShowScroll] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(() => localStorage.getItem("quaver_shuffle") === "1");
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">(() => {
    const saved = localStorage.getItem("quaver_repeat");
    return saved === "all" || saved === "one" ? saved : "off";
  });
  // The play queue is snapshotted when a track is started from a view, so searching
  // or browsing elsewhere doesn't change what plays next.
  const [queue, setQueue] = useState<Track[]>([]);

  // "Add to playlist" picker: which track it's for and where to anchor it
  const [pickerTrack, setPickerTrack] = useState<Track | null>(null);
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(null);
  const [pickerCreating, setPickerCreating] = useState(false);
  const [pickerNewName, setPickerNewName] = useState("");
  const [renamingPlaylistId, setRenamingPlaylistId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDeletePlaylistId, setConfirmingDeletePlaylistId] = useState<number | null>(null);
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);

  useEffect(() => { localStorage.setItem("quaver_visualizer", visualizer); }, [visualizer]);
  useEffect(() => { localStorage.setItem("quaver_shuffle", shuffleEnabled ? "1" : "0"); }, [shuffleEnabled]);
  useEffect(() => { localStorage.setItem("quaver_repeat", repeatMode); }, [repeatMode]);

  const handleRescan = async () => {
    if (!isTauri) return;
    setMenuOpen(false);
    setIsScanning(true);
    try {
      const updated = await invoke<Track[]>("rescan_library");
      const nextTracks = dedupeTracks(updated);
      setTracks(nextTracks);
      setQueue(prev => prev.filter(track => nextTracks.some(next => next.file_path === track.file_path)));
      if (currentTrack && !nextTracks.some(track => track.file_path === currentTrack.file_path)) {
        playbackRequestRef.current += 1;
        setCurrentTrack(null);
      }
      await Promise.all([refreshFolders(), refreshPlaylists()]);
    } catch (e) {
      console.error("rescan failed", e);
    } finally {
      setIsScanning(false);
    }
  };
  const [confirmingReset, setConfirmingReset] = useState(false);

  const handleReset = async () => {
    if (!isTauri) return;
    setMenuOpen(false);
    setConfirmingReset(false);
    setIsCreatingPlaylist(false);
    setTracks([]);
    setFolders([]);
    setPlaylists([]);
    setPlaylistTracks({});
    setSelectedFolderPath(null);
    setSelectedAlbumKey(null);
    setSelectedPlaylistId(null);
    setBrowseMode("songs");
    playbackRequestRef.current += 1;
    setQueue([]);
    setCurrentTrack(null);
    setCurrentTime(0);
    setCurrentArtUrl(null);
    peaksRef.current = null;
    document.documentElement.style.setProperty('--audio-level', '0');
    if (containerRef.current) {
      containerRef.current.style.transform = "";
      containerRef.current.style.filter = "";
    }
    if (wavesurfer) {
      wavesurfer.stop();
      wavesurfer.empty?.();
    }
    clearTrackThumbnails();
    setDefaultPalette();

    try {
      await invoke("reset_library");
    } catch (e) {
      console.error("reset failed", e);
    }
  };

  const [volume, setVolume] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem("quaver_volume") ?? "0.8");
    return Number.isFinite(v) ? v : 0.8;
  });
  const [muted, setMuted] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const peaksRef = useRef<number[] | null>(null);
  const playbackRequestRef = useRef(0);
  const trackArtUrlsRef = useRef<Record<string, string | null>>({});
  const requestedTrackArtRef = useRef<Set<string>>(new Set());
  const fallbackArtUrlsRef = useRef<Record<string, string | null>>({});
  const fallbackArtPromisesRef = useRef<Record<string, Promise<string | null>>>({});
  const importNoticeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const trackArtVersionRef = useRef(0);
  const thumbnailsMountedRef = useRef(true);
  const expandedWindowWidthRef = useRef<number | null>(null);
  const lastShelfWidthRef = useRef(270);

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const refreshFolders = useCallback(async () => {
    if (!isTauri) return;
    try {
      const nextFolders = await invoke<FolderSummary[]>("get_folders");
      setFolders(nextFolders);
    } catch (e) {
      console.error("folders refresh failed", e);
    }
  }, [isTauri]);

  const refreshPlaylists = useCallback(async () => {
    if (!isTauri) return;
    try {
      const nextPlaylists = await invoke<PlaylistSummary[]>("get_playlists");
      setPlaylists(nextPlaylists);
    } catch (e) {
      console.error("playlists refresh failed", e);
    }
  }, [isTauri]);

  const getTrackPreviewArt = (track: Track) => invoke("get_track_preview_art", {
    filePath: track.file_path,
    title: track.title ?? null,
    artist: track.artist ?? null,
    album: track.album ?? null,
  });

  const getShelfWidth = () => {
    const measured = sidebarRef.current?.getBoundingClientRect().width ?? 0;
    if (measured > 20) {
      lastShelfWidthRef.current = measured;
      return measured;
    }
    return lastShelfWidthRef.current;
  };

  const getCollapsedWindowWidth = () => (
    Math.min(
      COLLAPSED_WINDOW_MAX_WIDTH,
      Math.max(COLLAPSED_WINDOW_MIN_WIDTH, window.innerWidth - getShelfWidth())
    )
  );

  const animateWindowWidth = async (targetWidth: number, appWindow: any) => {
    if (!isTauri) return;

    const { LogicalSize } = await import("@tauri-apps/api/dpi");

    const startWidth = window.innerWidth;
    const height = window.innerHeight;
    const startTime = performance.now();
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number): Promise<void> => {
      const progress = Math.min(1, (now - startTime) / WINDOW_RESIZE_DURATION);
      const eased = easeOutCubic(progress);
      const width = Math.round(startWidth + (targetWidth - startWidth) * eased);

      return appWindow.setSize(new LogicalSize(width, height)).catch(console.error).then(() => {
        if (progress < 1) {
          return new Promise<void>(resolve => requestAnimationFrame(next => resolve(step(next))));
        }
      });
    };

    await step(startTime);
  };

  const handleToggleShelf = async () => {
    const nextOpen = !sidebarOpen;

    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      const isFixedSizeSurface = await Promise.all([
        appWindow.isFullscreen(),
        appWindow.isMaximized(),
      ]).then(([fullscreen, maximized]) => fullscreen || maximized).catch(() => false);

      if (!nextOpen) {
        expandedWindowWidthRef.current = window.innerWidth;
      }

      setSidebarOpen(nextOpen);

      if (!isFixedSizeSurface) {
        const targetWidth = nextOpen
          ? Math.max(expandedWindowWidthRef.current ?? window.innerWidth + getShelfWidth(), window.innerWidth + getShelfWidth())
          : getCollapsedWindowWidth();

        await animateWindowWidth(targetWidth, appWindow);
      }
    } else {
      setSidebarOpen(nextOpen);
    }
  };

  const clearTrackThumbnails = () => {
    trackArtVersionRef.current += 1;
    const urlsToRevoke = new Set<string>();
    for (const url of Object.values(trackArtUrlsRef.current)) {
      if (url) urlsToRevoke.add(url);
    }
    for (const url of Object.values(fallbackArtUrlsRef.current)) {
      if (url) urlsToRevoke.add(url);
    }
    for (const url of urlsToRevoke) {
      URL.revokeObjectURL(url);
    }
    trackArtUrlsRef.current = {};
    fallbackArtUrlsRef.current = {};
    fallbackArtPromisesRef.current = {};
    requestedTrackArtRef.current.clear();
    setTrackArtUrls({});
  };

  const getFallbackThumbnailUrl = async (track: Track) => {
    const query = getArtQuery(track);
    const cacheKey = (query || track.file_path).toLowerCase();
    if (fallbackArtUrlsRef.current[cacheKey]) {
      return fallbackArtUrlsRef.current[cacheKey];
    }

    if (!fallbackArtPromisesRef.current[cacheKey]) {
      fallbackArtPromisesRef.current[cacheKey] = getTrackPreviewArt(track)
        .then((artBytes) => createArtObjectUrl(artBytes))
        .then((url) => {
          fallbackArtUrlsRef.current[cacheKey] = url;
          delete fallbackArtPromisesRef.current[cacheKey];
          return url;
        })
        .catch((e) => {
          console.error("thumbnail fallback art failed", e);
          delete fallbackArtPromisesRef.current[cacheKey];
          return null;
        });
    }

    return fallbackArtPromisesRef.current[cacheKey];
  };

  const setTrackThumbnailUrl = (filePath: string, url: string | null) => {
    setTrackArtUrls(prev => {
      const previousUrl = prev[filePath];
      const next = { ...prev, [filePath]: url };
      const sharedFallbackUrls = Object.values(fallbackArtUrlsRef.current);
      if (previousUrl && previousUrl !== url && !sharedFallbackUrls.includes(previousUrl) && !Object.values(next).includes(previousUrl)) {
        URL.revokeObjectURL(previousUrl);
      }
      trackArtUrlsRef.current = next;
      return next;
    });
  };

  const setTrackThumbnailUrls = (filePaths: string[], url: string | null) => {
    if (filePaths.length === 0) return;
    setTrackArtUrls(prev => {
      const next = { ...prev };
      const previousUrls = new Set<string>();
      for (const filePath of filePaths) {
        const previousUrl = next[filePath];
        if (previousUrl && previousUrl !== url) previousUrls.add(previousUrl);
        next[filePath] = url;
      }
      const sharedFallbackUrls = Object.values(fallbackArtUrlsRef.current);
      for (const previousUrl of previousUrls) {
        if (!sharedFallbackUrls.includes(previousUrl) && !Object.values(next).includes(previousUrl)) {
          URL.revokeObjectURL(previousUrl);
        }
      }
      trackArtUrlsRef.current = next;
      return next;
    });
  };

  const loadTrackThumbnail = useCallback((track: Track) => {
    if (!isTauri || trackArtUrlsRef.current[track.file_path]) return;
    const version = trackArtVersionRef.current;

    const requestKey = `${track.file_path}\u0000row-preview`;
    if (requestedTrackArtRef.current.has(requestKey)) return;
    requestedTrackArtRef.current.add(requestKey);

    getFallbackThumbnailUrl(track)
      .then((url) => {
        if (url && version === trackArtVersionRef.current && thumbnailsMountedRef.current) {
          setTrackThumbnailUrl(track.file_path, url);
        }
        else requestedTrackArtRef.current.delete(requestKey);
      })
      .catch((e) => {
        console.error("row thumbnail failed", e);
        requestedTrackArtRef.current.delete(requestKey);
      });
  }, [isTauri]);

  const loadAlbumThumbnail = useCallback((albumTracks: Track[]) => {
    if (!isTauri || albumTracks.length === 0) return;
    const existingUrl = albumTracks
      .map(track => trackArtUrlsRef.current[track.file_path])
      .find(Boolean) ?? null;
    if (existingUrl) {
      const missingFilePaths = albumTracks
        .map(track => track.file_path)
        .filter(filePath => !trackArtUrlsRef.current[filePath]);
      setTrackThumbnailUrls(missingFilePaths, existingUrl);
      return;
    }

    const albumKey = getAlbumKey(albumTracks[0]).toLowerCase();
    const requestKey = `${albumKey}\u0000album-preview`;
    if (requestedTrackArtRef.current.has(requestKey)) return;
    requestedTrackArtRef.current.add(requestKey);

    const version = trackArtVersionRef.current;
    const filePaths = albumTracks.map(track => track.file_path);

    (async () => {
      const localCandidates = albumTracks.slice(0, 6);
      for (const track of localCandidates) {
        if (!thumbnailsMountedRef.current || version !== trackArtVersionRef.current) return;

        let url: string | null = null;
        try {
          const localArt = await invoke("get_track_art", { filePath: track.file_path });
          url = createArtObjectUrl(localArt);
        } catch {
          url = null;
        }

        if (url) {
          fallbackArtUrlsRef.current[albumKey] = url;
          setTrackThumbnailUrls(filePaths, url);
          return;
        }

        await delay(20);
      }

      const queryTrack = albumTracks.find(track => getArtQuery(track)) ?? albumTracks[0];
      const url = await getFallbackThumbnailUrl(queryTrack);
      if (url && thumbnailsMountedRef.current && version === trackArtVersionRef.current) {
        fallbackArtUrlsRef.current[albumKey] = url;
        setTrackThumbnailUrls(filePaths, url);
        return;
      }

      requestedTrackArtRef.current.delete(requestKey);
    })().catch((e) => {
      console.error("album thumbnail failed", e);
      requestedTrackArtRef.current.delete(requestKey);
    });
  }, [isTauri]);

  const handleMinimize = async () => {
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().minimize();
    }
  };

  const handleClose = async () => {
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().close();
    }
  };

  const handleAddFolder = async () => {
    if (!isTauri) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      
      if (selected) {
        const folderPath = Array.isArray(selected) ? selected[0] : selected;
        const scannedTracks = await invoke<Track[]>("scan_folder", { folderPath });
        setTracks(prev => dedupeTracks([...prev, ...scannedTracks]));
        await refreshFolders();
        setBrowseMode("folders");
        setSelectedFolderPath(folderPath);
      }
    } catch (err) {
      console.error("Failed to add folder", err);
    }
  };

  const showImportNotice = useCallback((imported: Track[]) => {
    if (imported.length === 0) return;
    if (importNoticeTimerRef.current) window.clearTimeout(importNoticeTimerRef.current);
    const firstTrack = getTrackName(imported[0]);
    setImportNotice({
      id: Date.now(),
      title: imported.length === 1 ? "Added to Quaver" : `${imported.length} songs added`,
      detail: imported.length === 1 ? firstTrack : `${firstTrack} and ${imported.length - 1} more`,
    });
    importNoticeTimerRef.current = window.setTimeout(() => {
      setImportNotice(null);
      importNoticeTimerRef.current = null;
    }, 3400);
  }, []);

  useEffect(() => () => {
    if (importNoticeTimerRef.current) window.clearTimeout(importNoticeTimerRef.current);
  }, []);

  // Files opened from the OS (double-click in Explorer / "Open with"): import
  // them into the library, queue them, and start playing the first one.
  const importAndPlayFiles = useCallback(async (paths: string[]) => {
    if (!isTauri || paths.length === 0) return;
    try {
      const imported = await invoke<Track[]>("import_files", { paths: Array.from(new Set(paths)) });
      if (imported.length === 0) return;
      setTracks(prev => dedupeTracks([...prev, ...imported]));
      setQueue(imported);
      setCurrentTrack(imported[0]);
      setBrowseMode("songs");
      setSelectedFolderPath(null);
      setSelectedAlbumKey(null);
      setSelectedPlaylistId(null);
      setSearchQuery("");
      setIsSearchOpen(false);
      showImportNotice(imported);
    } catch (e) {
      console.error("file import failed", e);
    }
  }, [isTauri, showImportNotice]);

  const drainLaunchFiles = useCallback(async () => {
    if (!isTauri) return;
    const files = await invoke<string[]>("get_launch_files");
    if (files.length > 0) await importAndPlayFiles(files);
  }, [isTauri, importAndPlayFiles]);

  useEffect(() => {
    if (!isTauri) return;
    const fetchLibrary = () => {
      invoke<Track[]>("get_library")
        .then((t) => setTracks(dedupeTracks(t)))
        .catch(console.error);
    };

    // Import launch files before the first library fetch so they're included in it
    (async () => {
      try {
        await drainLaunchFiles();
      } catch (e) {
        console.error("launch files failed", e);
      }
      fetchLibrary();
    })();
    refreshFolders();
    refreshPlaylists();

    const unlistenMeta = listen("metadata-updated", () => {
      console.log("Metadata updated, refreshing library...");
      fetchLibrary();
    });
    const unlistenOpen = listen("open-files", () => {
      drainLaunchFiles().then(fetchLibrary).catch(console.error);
    });

    return () => {
      unlistenMeta.then(f => f());
      unlistenOpen.then(f => f());
    };
  }, [isTauri, refreshFolders, refreshPlaylists, drainLaunchFiles]);

  useEffect(() => {
    if (!isTauri || selectedPlaylistId === null) return;
    invoke<Track[]>("get_playlist_tracks", { playlistId: selectedPlaylistId })
      .then((items) => {
        setPlaylistTracks(prev => ({ ...prev, [selectedPlaylistId]: dedupeTracks(items) }));
      })
      .catch(console.error);
  }, [isTauri, selectedPlaylistId]);

  useEffect(() => {
    if (!currentTrack || !isTauri) {
      setCurrentArtUrl(null);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    const publishArt = (url: string, thumbnailUrl: string | null = null) => {
      createdUrl = url;
      if (cancelled) {
        URL.revokeObjectURL(url);
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
        return;
      }
      setCurrentArtUrl(url);
      if (thumbnailUrl) setTrackThumbnailUrl(currentTrack.file_path, thumbnailUrl);
      applyPaletteFromUrl(url, () => !cancelled);
    };

    setCurrentArtUrl(null);

    (async () => {
      try {
        const previewArt = await getTrackPreviewArt(currentTrack);
        if (cancelled) return;

        const previewUrl = createArtObjectUrl(previewArt);
        if (previewUrl) {
          const thumbnailUrl = createArtObjectUrl(previewArt);
          const query = getArtQuery(currentTrack);
          if (query && thumbnailUrl) {
            fallbackArtUrlsRef.current[query.toLowerCase()] = thumbnailUrl;
          }
          publishArt(previewUrl, thumbnailUrl);
        }
      } catch (e) {
        console.error("album art failed", e);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [currentTrack, isTauri]);

  useEffect(() => {
    trackArtUrlsRef.current = trackArtUrls;
  }, [trackArtUrls]);

  useEffect(() => {
    return () => {
      thumbnailsMountedRef.current = false;
      const urlsToRevoke = new Set<string>();
      for (const url of Object.values(trackArtUrlsRef.current)) {
        if (url) urlsToRevoke.add(url);
      }
      for (const url of Object.values(fallbackArtUrlsRef.current)) {
        if (url) urlsToRevoke.add(url);
      }
      for (const url of urlsToRevoke) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauri || tracks.length === 0) return;
    const version = trackArtVersionRef.current;
    let cancelled = false;

    const groups = new Map<string, Track[]>();
    for (const track of tracks) {
      if (trackArtUrlsRef.current[track.file_path]) continue;
      const query = getArtQuery(track);
      if (!query) continue;
      const cacheKey = query.toLowerCase();
      groups.set(cacheKey, [...(groups.get(cacheKey) ?? []), track]);
    }

    (async () => {
      const queue = Array.from(groups.values());
      const runGroup = async (group: Track[]) => {
        if (cancelled) return;
        const url = await getFallbackThumbnailUrl(group[0]);
        if (!url || cancelled || version !== trackArtVersionRef.current || !thumbnailsMountedRef.current) {
          return;
        }

        const filePaths = group
          .map(track => track.file_path)
          .filter(filePath => !trackArtUrlsRef.current[filePath]);
        setTrackThumbnailUrls(filePaths, url);
        await delay(120);
      };

      const workerCount = Math.min(2, queue.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (queue.length > 0 && !cancelled) {
          const group = queue.shift();
          if (group) await runGroup(group);
        }
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [tracks, isTauri]);

  useEffect(() => {
    if (!isTauri || tracks.length === 0) return;
    const version = trackArtVersionRef.current;
    let cancelled = false;

    (async () => {
      for (const track of tracks) {
        if (cancelled) return;
        if (trackArtUrlsRef.current[track.file_path]) continue;

        const requestKey = `${track.file_path}\u0000local`;
        if (requestedTrackArtRef.current.has(requestKey)) continue;
        requestedTrackArtRef.current.add(requestKey);

        let url: string | null = null;
        try {
          const localArt = await invoke("get_track_art", { filePath: track.file_path });
          url = createArtObjectUrl(localArt);
        } catch {
          url = null;
        }

        if (!url) continue;

        if (!thumbnailsMountedRef.current || version !== trackArtVersionRef.current) {
          URL.revokeObjectURL(url);
          return;
        }

        setTrackThumbnailUrl(track.file_path, url);
        await delay(50);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tracks, isTauri]);

  useEffect(() => {
    if (!currentTrack) return;
    const refreshedTrack = tracks.find(t => t.file_path === currentTrack.file_path);
    if (refreshedTrack && refreshedTrack !== currentTrack) setCurrentTrack(refreshedTrack);
  }, [tracks, currentTrack?.file_path]);

  // Keep queue entries in sync with refreshed library metadata (e.g. AcoustID updates)
  useEffect(() => {
    setQueue(prev => {
      if (prev.length === 0) return prev;
      const byPath = new Map(tracks.map(track => [track.file_path, track]));
      let changed = false;
      const next = prev.map(track => {
        const refreshed = byPath.get(track.file_path);
        if (refreshed && refreshed !== track) {
          changed = true;
          return refreshed;
        }
        return track;
      });
      return changed ? next : prev;
    });
  }, [tracks]);

  const { wavesurfer, isPlaying } = useWavesurfer({
    container: containerRef,
    height: 48,
    waveColor: 'rgba(255, 255, 255, 0.44)',
    progressColor: 'rgba(255, 255, 255, 0.78)',
    cursorColor: 'rgba(255, 255, 255, 0.72)',
    cursorWidth: 1,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    fillParent: true,
    hideScrollbar: true,
    autoScroll: false,
    autoCenter: false,
  });

  const togglePlay = () => {
    if (wavesurfer && currentTrack) {
      wavesurfer.playPause();
    }
  };

  useEffect(() => {
    if (!wavesurfer || currentTrack) return;
    playbackRequestRef.current += 1;
    peaksRef.current = null;
    setCurrentTime(0);
    document.documentElement.style.setProperty('--audio-level', '0');
    document.documentElement.style.setProperty('--wave-glow', '0px');
    if (containerRef.current) {
      containerRef.current.style.removeProperty("transform");
      containerRef.current.style.removeProperty("filter");
      containerRef.current.style.setProperty("--wave-glow", "0px");
      (containerRef.current.firstElementChild as HTMLElement | null)?.style.removeProperty("transform");
    }
    wavesurfer.stop();
    wavesurfer.empty?.();
  }, [wavesurfer, currentTrack]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(Math.abs(seconds) / 60);
    const s = Math.floor(Math.abs(seconds) % 60);
    const sign = seconds < 0 ? "-" : "";
    return `${sign}${m}:${s.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!wavesurfer) return;
    const onTimeUpdate = (time: number) => setCurrentTime(time);
    const onReady = () => setCurrentTime(0);
    wavesurfer.on("timeupdate", onTimeUpdate);
    wavesurfer.on("ready", onReady);
    return () => {
      wavesurfer.un("timeupdate", onTimeUpdate);
      wavesurfer.un("ready", onReady);
    };
  }, [wavesurfer]);

  useEffect(() => {
    // Squared curve approximates perceptual loudness, so the lower half of the slider is usable
    if (wavesurfer) wavesurfer.setVolume(muted ? 0 : volume * volume);
    localStorage.setItem("quaver_volume", String(volume));
  }, [wavesurfer, volume, muted]);

  useEffect(() => {
    if (!wavesurfer || !currentTrack || !isTauri) return;
    let cancelled = false;
    const requestId = ++playbackRequestRef.current;
    const url = convertFileSrc(currentTrack.file_path);

    (async () => {
      let peaks: number[] | undefined;
      try {
        peaks = (await invoke("get_waveform_peaks", { filePath: currentTrack.file_path })) as number[];
      } catch (e) {
        console.error("peak generation failed; playing without precomputed waveform", e);
      }
      if (cancelled || requestId !== playbackRequestRef.current) return;
      peaksRef.current = peaks && peaks.length ? peaks : null;
      const duration = currentTrack.duration_secs || undefined;
      if (peaks && peaks.length) wavesurfer.load(url, [peaks], duration);
      else wavesurfer.load(url);
    })();

    const onReady = () => {
      if (requestId === playbackRequestRef.current) {
        wavesurfer.play().catch(console.error);
      }
    };
    wavesurfer.on("ready", onReady);
    return () => { cancelled = true; wavesurfer.un("ready", onReady); };
  }, [wavesurfer, currentTrack, isTauri]);

  const selectedFolder = useMemo(
    () => folders.find(folder => folder.path === selectedFolderPath) ?? null,
    [folders, selectedFolderPath]
  );
  const selectedPlaylist = useMemo(
    () => playlists.find(playlist => playlist.id === selectedPlaylistId) ?? null,
    [playlists, selectedPlaylistId]
  );
  const albumGroups = useMemo(() => Array.from(tracks.reduce((groups, track) => {
    const key = getAlbumKey(track);
    const current = groups.get(key) ?? {
      key,
      album: getAlbumName(track),
      artist: getArtistName(track),
      tracks: [] as Track[],
      duration_secs: 0,
    };
    current.tracks.push(track);
    current.duration_secs += track.duration_secs ?? 0;
    groups.set(key, current);
    return groups;
  }, new Map<string, { key: string; album: string; artist: string; tracks: Track[]; duration_secs: number }>()).values())
    .sort((a, b) => `${a.artist} ${a.album}`.localeCompare(`${b.artist} ${b.album}`)), [tracks]);
  const selectedAlbum = useMemo(
    () => albumGroups.find(album => album.key === selectedAlbumKey) ?? null,
    [albumGroups, selectedAlbumKey]
  );

  useEffect(() => {
    if (!isTauri || albumGroups.length === 0) return;
    let cancelled = false;

    (async () => {
      for (const album of albumGroups) {
        if (cancelled) return;
        const hasCover = album.tracks.some(track => trackArtUrlsRef.current[track.file_path]);
        if (!hasCover) {
          loadAlbumThumbnail(album.tracks);
          await delay(90);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [albumGroups, isTauri, loadAlbumThumbnail]);

  const sourceTracks = useMemo(() => {
    if (browseMode === "folders" && selectedFolderPath) {
      return tracks.filter(track => trackBelongsToFolder(track, selectedFolderPath));
    }

    if (browseMode === "playlists" && selectedPlaylistId !== null) {
      return playlistTracks[selectedPlaylistId] ?? [];
    }

    if (browseMode === "albums" && selectedAlbum) {
      return selectedAlbum.tracks;
    }

    return tracks;
  }, [browseMode, playlistTracks, selectedAlbum, selectedFolderPath, selectedPlaylistId, tracks]);
  const sortedSourceTracks = useMemo(() => {
    if (browseMode === "playlists" && selectedPlaylistId !== null) return sourceTracks;

    return [...sourceTracks].sort((a, b) => {
      if (sortMode === "title") {
        return getTrackName(a).localeCompare(getTrackName(b));
      }

      if (sortMode === "album") {
        return `${getAlbumName(a)} ${getArtistName(a)} ${getTrackName(a)}`
          .localeCompare(`${getAlbumName(b)} ${getArtistName(b)} ${getTrackName(b)}`);
      }

      return `${getArtistName(a)} ${getAlbumName(a)} ${getTrackName(a)}`
        .localeCompare(`${getArtistName(b)} ${getAlbumName(b)} ${getTrackName(b)}`);
    });
  }, [browseMode, selectedPlaylistId, sortMode, sourceTracks]);
  const normalizedQuery = searchQuery.toLowerCase();
  const visibleAlbumGroups = useMemo(() => albumGroups.filter(album =>
    album.album.toLowerCase().includes(normalizedQuery) ||
    album.artist.toLowerCase().includes(normalizedQuery)
  ), [albumGroups, normalizedQuery]);
  const visibleFolders = useMemo(() => folders.filter(folder =>
    folder.name.toLowerCase().includes(normalizedQuery) ||
    folder.path.toLowerCase().includes(normalizedQuery)
  ), [folders, normalizedQuery]);
  const visiblePlaylists = useMemo(() => playlists.filter(playlist =>
    playlist.name.toLowerCase().includes(normalizedQuery)
  ), [playlists, normalizedQuery]);
  const filteredTracks = useMemo(() => sortedSourceTracks.filter(t =>
    (t.title?.toLowerCase().includes(normalizedQuery) ||
     t.artist?.toLowerCase().includes(normalizedQuery) ||
     t.album?.toLowerCase().includes(normalizedQuery) ||
     t.file_path.toLowerCase().includes(normalizedQuery))
  ), [normalizedQuery, sortedSourceTracks]);
  const isSourceList = (browseMode === "albums" && !selectedAlbumKey) ||
    (browseMode === "folders" && !selectedFolderPath) ||
    (browseMode === "playlists" && selectedPlaylistId === null);
  const canCreatePlaylistFromView = (!isSourceList && filteredTracks.length > 0) ||
    (browseMode === "playlists" && selectedPlaylistId === null);
  const currentIndex = filteredTracks.findIndex(t => t.file_path === currentTrack?.file_path);
  const remainingDurationSecs = filteredTracks.reduce((total, track, index) => {
    const duration = track.duration_secs ?? 0;
    if (!duration) return total;
    if (currentIndex < 0) return total + duration;
    if (index < currentIndex) return total;
    if (index === currentIndex) return total + Math.max(duration - currentTime, 0);
    return total + duration;
  }, 0);
  const visibleDurationLabel = formatMinutesLabel(remainingDurationSecs);
  const sourceTitle = browseMode === "albums" && selectedAlbum
    ? selectedAlbum.album
    : browseMode === "albums"
      ? "Albums"
      : browseMode === "folders" && selectedFolder
        ? selectedFolder.name
        : browseMode === "folders"
          ? "Folders"
          : browseMode === "playlists" && selectedPlaylist
            ? selectedPlaylist.name
            : browseMode === "playlists"
              ? "Playlists"
              : "Library";
  const playlistSubtitle = isSourceList
    ? browseMode === "albums"
      ? `${albumGroups.length} albums`
      : browseMode === "folders"
        ? `${folders.length} folders`
        : `${playlists.length} playlists`
    : filteredTracks.length === 0
      ? "No tracks"
      : visibleDurationLabel
        ? `${visibleDurationLabel} remaining`
        : `${filteredTracks.length} tracks`;
  const createPlaylistDefaultName = browseMode === "folders" && selectedFolder
    ? `${selectedFolder.name} Mix`
    : browseMode === "albums" && selectedAlbum
      ? selectedAlbum.album
      : browseMode === "playlists"
        ? "New Playlist"
        : "My Playlist";
  const currentAlbum = currentTrack?.album?.trim();
  const repeatLabel = repeatMode === "one" ? "Repeat one" : repeatMode === "all" ? "Repeat all" : "Repeat off";

  const queueIndex = currentTrack ? queue.findIndex(t => t.file_path === currentTrack.file_path) : -1;
  const queuePathsKey = useMemo(() => queue.map(t => t.file_path).join("\u0000"), [queue]);
  const shuffleOrderRef = useRef<number[]>([]);
  const currentTrackPathRef = useRef<string | null>(null);

  useEffect(() => {
    currentTrackPathRef.current = currentTrack?.file_path ?? null;
  }, [currentTrack?.file_path]);

  // A shuffled permutation of the queue: every track plays once per cycle, and
  // prev/next walk the same sequence. Keyed on the queue's paths (not identity)
  // so metadata refreshes don't reshuffle mid-listen.
  useEffect(() => {
    if (!shuffleEnabled || queue.length === 0) {
      shuffleOrderRef.current = [];
      return;
    }
    const order = queue.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const playingIndex = queue.findIndex(t => t.file_path === currentTrackPathRef.current);
    if (playingIndex >= 0) {
      const pos = order.indexOf(playingIndex);
      if (pos > 0) {
        order.splice(pos, 1);
        order.unshift(playingIndex);
      }
    }
    shuffleOrderRef.current = order;
  }, [queuePathsKey, shuffleEnabled]);

  const playTrack = (track: Track) => {
    setQueue(filteredTracks);
    setCurrentTrack(track);
  };
  const getNextTrackIndex = (wrap = repeatMode === "all") => {
    if (queue.length === 0) return null;
    if (shuffleEnabled) {
      const order = shuffleOrderRef.current;
      if (order.length === 0) return null;
      const pos = order.indexOf(queueIndex);
      if (pos < 0) return order[0];
      if (pos < order.length - 1) return order[pos + 1];
      return wrap ? order[0] : null;
    }
    if (queueIndex < 0) return 0;
    if (queueIndex < queue.length - 1) return queueIndex + 1;
    return wrap ? 0 : null;
  };
  const getPrevTrackIndex = () => {
    if (queue.length === 0) return null;
    if (shuffleEnabled) {
      const order = shuffleOrderRef.current;
      if (order.length === 0) return null;
      const pos = order.indexOf(queueIndex);
      if (pos < 0) return order[0];
      if (pos > 0) return order[pos - 1];
      return repeatMode === "all" ? order[order.length - 1] : null;
    }
    if (queueIndex > 0) return queueIndex - 1;
    return repeatMode === "all" ? queue.length - 1 : null;
  };
  const playNext = () => {
    if (queue.length === 0) {
      if (filteredTracks.length > 0) playTrack(filteredTracks[0]);
      return;
    }
    const nextIndex = getNextTrackIndex();
    if (nextIndex !== null) setCurrentTrack(queue[nextIndex]);
  };
  const playPrev = () => {
    if (queue.length === 0) {
      if (filteredTracks.length > 0) playTrack(filteredTracks[0]);
      return;
    }
    const prevIndex = getPrevTrackIndex();
    if (prevIndex !== null) setCurrentTrack(queue[prevIndex]);
  };
  const cycleRepeatMode = () => {
    setRepeatMode(mode => mode === "off" ? "all" : mode === "all" ? "one" : "off");
  };
  const selectBrowseMode = (mode: BrowseMode) => {
    setBrowseMode(mode);
    setSelectedAlbumKey(null);
    setSelectedFolderPath(null);
    setSelectedPlaylistId(null);
    setIsCreatingPlaylist(false);
    setSearchQuery("");
    setIsSearchOpen(false);
  };
  const handleBackToSourceList = () => {
    if (browseMode === "albums") setSelectedAlbumKey(null);
    if (browseMode === "folders") setSelectedFolderPath(null);
    if (browseMode === "playlists") setSelectedPlaylistId(null);
    setIsCreatingPlaylist(false);
    setSearchQuery("");
  };
  const handleStartCreatePlaylist = () => {
    setBrowseMode(browseMode === "playlists" && selectedPlaylistId === null ? "playlists" : browseMode);
    setNewPlaylistName(createPlaylistDefaultName);
    setIsCreatingPlaylist(true);
  };
  const handleCreatePlaylist = async () => {
    if (!isTauri) return;
    const name = newPlaylistName.trim();
    if (!name) return;

    try {
      const filePaths = browseMode === "playlists" && selectedPlaylistId === null
        ? []
        : filteredTracks.map(track => track.file_path);
      const created = filePaths.length > 0
        ? await invoke<PlaylistSummary>("create_playlist_from_tracks", { name, filePaths })
        : await invoke<PlaylistSummary>("create_playlist", { name });

      setPlaylists(prev => [created, ...prev.filter(playlist => playlist.id !== created.id)]);
      if (filePaths.length > 0) {
        setPlaylistTracks(prev => ({ ...prev, [created.id]: filteredTracks }));
      }
      setBrowseMode("playlists");
      setSelectedPlaylistId(created.id);
      setSelectedAlbumKey(null);
      setSelectedFolderPath(null);
      setIsCreatingPlaylist(false);
      setNewPlaylistName("");
      await refreshPlaylists();
    } catch (e) {
      console.error("playlist create failed", e);
    }
  };
  const openPlaylistPicker = (track: Track, event: React.MouseEvent) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setPickerPos({ x: rect.left, y: rect.bottom });
    setPickerTrack(track);
    setPickerCreating(false);
    setPickerNewName("");
  };
  const closePlaylistPicker = () => {
    setPickerTrack(null);
    setPickerPos(null);
    setPickerCreating(false);
    setPickerNewName("");
  };
  const handleAddTrackToPlaylist = async (playlistId: number) => {
    if (!isTauri || !pickerTrack) return;
    const track = pickerTrack;
    try {
      const updated = await invoke<PlaylistSummary>("add_tracks_to_playlist", {
        playlistId,
        filePaths: [track.file_path],
      });
      setPlaylists(prev => prev.map(playlist => playlist.id === updated.id ? updated : playlist));
      setPlaylistTracks(prev => {
        const existing = prev[playlistId];
        if (!existing || existing.some(item => item.file_path === track.file_path)) return prev;
        return { ...prev, [playlistId]: [...existing, track] };
      });
      closePlaylistPicker();
    } catch (e) {
      console.error("add to playlist failed", e);
    }
  };
  const handleCreatePlaylistWithTrack = async () => {
    if (!isTauri || !pickerTrack) return;
    const name = pickerNewName.trim();
    if (!name) return;
    try {
      const created = await invoke<PlaylistSummary>("create_playlist_from_tracks", {
        name,
        filePaths: [pickerTrack.file_path],
      });
      setPlaylists(prev => [created, ...prev.filter(playlist => playlist.id !== created.id)]);
      setPlaylistTracks(prev => ({ ...prev, [created.id]: [pickerTrack] }));
      closePlaylistPicker();
    } catch (e) {
      console.error("create playlist with track failed", e);
    }
  };
  const startRenamePlaylist = (playlist: PlaylistSummary) => {
    setRenamingPlaylistId(playlist.id);
    setRenameValue(playlist.name);
    setConfirmingDeletePlaylistId(null);
  };
  const handleRenamePlaylist = async () => {
    if (!isTauri || renamingPlaylistId === null) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      const updated = await invoke<PlaylistSummary>("rename_playlist", {
        playlistId: renamingPlaylistId,
        name,
      });
      setPlaylists(prev => prev.map(playlist => playlist.id === updated.id ? updated : playlist));
      setRenamingPlaylistId(null);
      setRenameValue("");
    } catch (e) {
      console.error("playlist rename failed", e);
    }
  };
  const handleDeletePlaylist = async (playlistId: number) => {
    if (!isTauri) return;
    try {
      await invoke("delete_playlist", { playlistId });
      setPlaylists(prev => prev.filter(playlist => playlist.id !== playlistId));
      setPlaylistTracks(prev => {
        const next = { ...prev };
        delete next[playlistId];
        return next;
      });
      if (selectedPlaylistId === playlistId) setSelectedPlaylistId(null);
      setConfirmingDeletePlaylistId(null);
    } catch (e) {
      console.error("playlist delete failed", e);
    }
  };
  const movePlaylistTrack = async (track: Track, direction: -1 | 1) => {
    if (!isTauri || selectedPlaylistId === null) return;
    const list = playlistTracks[selectedPlaylistId] ?? [];
    const index = list.findIndex(item => item.file_path === track.file_path);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    setPlaylistTracks(prev => ({ ...prev, [selectedPlaylistId]: next }));
    try {
      const updated = await invoke<PlaylistSummary>("set_playlist_order", {
        playlistId: selectedPlaylistId,
        filePaths: next.map(item => item.file_path),
      });
      setPlaylists(prev => prev.map(playlist => playlist.id === updated.id ? updated : playlist));
    } catch (e) {
      console.error("playlist reorder failed", e);
      invoke<Track[]>("get_playlist_tracks", { playlistId: selectedPlaylistId })
        .then(items => setPlaylistTracks(prev => ({ ...prev, [selectedPlaylistId]: dedupeTracks(items) })))
        .catch(console.error);
    }
  };
  const handleRemoveFromPlaylist = async (track: Track) => {
    if (!isTauri || selectedPlaylistId === null) return;
    try {
      const updated = await invoke<PlaylistSummary>("remove_track_from_playlist", {
        playlistId: selectedPlaylistId,
        filePath: track.file_path,
      });
      setPlaylistTracks(prev => ({
        ...prev,
        [selectedPlaylistId]: (prev[selectedPlaylistId] ?? []).filter(item => item.file_path !== track.file_path),
      }));
      setPlaylists(prev => prev.map(playlist => playlist.id === updated.id ? updated : playlist));
    } catch (e) {
      console.error("playlist remove failed", e);
    }
  };
  const cycleSortMode = () => {
    setSortMode(mode => mode === "artist" ? "album" : mode === "album" ? "title" : "artist");
  };

  useEffect(() => {
    if (!wavesurfer) return;
    const onFinish = () => {
      if (repeatMode === "one") {
        wavesurfer.seekTo(0);
        wavesurfer.play().catch(console.error);
        return;
      }

      const nextIndex = getNextTrackIndex(repeatMode === "all");
      if (nextIndex !== null) setCurrentTrack(queue[nextIndex]);
    };
    wavesurfer.on("finish", onFinish);
    return () => wavesurfer.un("finish", onFinish);
  }, [wavesurfer, currentTrack, queue, shuffleEnabled, repeatMode]);

  useEffect(() => {
    if (!wavesurfer) return;
    const el = containerRef.current;
    let raf = 0;
    let alive = true;
    let display = 0; // smoothed level, eased frame to frame

    const tick = () => {
      if (!alive) return;
      const peaks = peaksRef.current;
      let target = 0;
      if (peaks && peaks.length >= 2 && wavesurfer.isPlaying()) {
        const dur = wavesurfer.getDuration() || 0;
        if (dur > 0) {
          const frac = Math.min(0.999, Math.max(0, wavesurfer.getCurrentTime() / dur));
          const pairs = Math.floor(peaks.length / 2);
          const i = Math.min(pairs - 1, Math.floor(frac * pairs));
          const min = peaks[2 * i];
          const max = peaks[2 * i + 1];
          // peak envelope at the playhead, lightly boosted, clamped to 0..1
          target = Math.min(1, ((Math.abs(min) + Math.abs(max)) / 2) * 1.6);
        }
      } else if (wavesurfer.isPlaying()) {
        const decoded = wavesurfer.getDecodedData?.();
        const dur = wavesurfer.getDuration() || decoded?.duration || 0;
        const channel = decoded?.getChannelData(0);
        if (channel && channel.length > 0 && dur > 0) {
          const center = Math.floor((wavesurfer.getCurrentTime() / dur) * channel.length);
          const radius = 420;
          const start = Math.max(0, center - radius);
          const end = Math.min(channel.length, center + radius);
          let sum = 0;
          for (let i = start; i < end; i += 1) sum += channel[i] * channel[i];
          const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
          target = Math.min(1, rms * 5.2);
        } else {
          target = 0.1;
        }
      }
      display += (target - display) * 0.18; // easing → fluid, not twitchy
      document.documentElement.style.setProperty('--audio-level', display.toString());
      if (el) {
        const waveformNode = el.firstElementChild as HTMLElement | null;
        if (waveformNode) {
          waveformNode.style.transformOrigin = "center";
          waveformNode.style.transform = `scaleY(${1 + display * 0.12})`;
        }
        el.style.setProperty("--wave-glow", `${display * 12}px`);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [wavesurfer]);

  useEffect(() => {
    if (!isTauri || !currentTrack || queue.length === 0) return;
    const upcoming: Track[] = [];
    if (shuffleEnabled) {
      const order = shuffleOrderRef.current;
      const pos = order.indexOf(queueIndex);
      if (pos >= 0) {
        for (const orderPos of [pos + 1, pos + 2]) {
          const idx = order[orderPos];
          if (idx !== undefined) upcoming.push(queue[idx]);
        }
      }
    } else if (queueIndex >= 0) {
      upcoming.push(...[queue[queueIndex + 1], queue[queueIndex + 2]].filter(Boolean));
    }
    upcoming.forEach(t => {
      invoke("get_waveform_peaks", { filePath: t.file_path }).catch(() => {});
    });
  }, [currentTrack, queue, queueIndex, shuffleEnabled, isTauri]);

  return (
    <div className="app-container">
      <BackgroundVisualizer mode={visualizer} />
      {/* Titlebar */}
      <div className="titlebar">
        <div className="titlebar-drag-region" data-tauri-drag-region></div>
        <button
          className="titlebar-button"
          onClick={handleMinimize}
          title="Minimize"
        >
          <Minimize2 size={16} />
        </button>
        <button
          className="titlebar-button close"
          onClick={handleClose}
          title="Close"
        >
          <X size={16} />
        </button>
      </div>

      {/* Main Content */}
      <div className={`content ${sidebarOpen ? "" : "shelf-hidden"}`}>
        {/* Sidebar */}
        <div ref={sidebarRef} className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
          <div className="sidebar-topbar">
            <div className={`sidebar-title-block ${isSearchOpen ? "searching" : ""}`}>
              {!isSourceList && (
                <button className="source-back-button" onClick={handleBackToSourceList} title="Back">
                  <ChevronLeft size={16} />
                </button>
              )}
              <div className="sidebar-title">{sourceTitle}</div>
              <div className="sidebar-subtitle">{playlistSubtitle}</div>
            </div>

            <div className="sidebar-search-wrap">
              <input 
                ref={searchInputRef}
                className={`sidebar-search-input ${isSearchOpen ? "open" : ""}`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                onBlur={() => {
                  if (searchQuery === "") setIsSearchOpen(false);
                }}
              />
            </div>

            <div className="sidebar-action-group">
              <button 
                className="icon-btn" 
                onClick={() => {
                  if (!isSearchOpen) {
                    setIsSearchOpen(true);
                    setTimeout(() => searchInputRef.current?.focus(), 50);
                  } else if (searchQuery === "") {
                    setIsSearchOpen(false);
                  }
                }}
                title="Search"
              >
                <Search size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={handleStartCreatePlaylist}
                disabled={!canCreatePlaylistFromView}
                title={filteredTracks.length > 0 ? "Create playlist from this view" : "New playlist"}
              >
                <Plus size={18} />
              </button>
              <button className="icon-btn" onClick={handleAddFolder} title="Add Folder">
                <FolderPlus size={18} />
              </button>
              <div style={{ position: 'relative' }}>
                <button className="icon-btn" onClick={() => { setMenuOpen(o => !o); setConfirmingReset(false); }} title="More">
                  <MoreVertical size={18} />
                </button>
                {menuOpen && (
                  <>
                    {/* click-away overlay */}
                    <div onClick={() => { setMenuOpen(false); setConfirmingReset(false); }} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
                    <div style={{
                      position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 51, minWidth: 170,
                      background: 'rgba(30,30,40,0.85)', backdropFilter: 'blur(12px)',
                      border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: 6,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
                    }}>
                      <button
                        onClick={handleRescan}
                        disabled={isScanning}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                          border: 'none', color: 'white', padding: '8px 10px', borderRadius: 6,
                          cursor: isScanning ? 'default' : 'pointer', fontSize: '0.86em', opacity: isScanning ? 0.6 : 1
                        }}
                      >
                        {isScanning ? 'Rescanning…' : 'Rescan library'}
                      </button>
                      
                      {!confirmingReset ? (
                        <button
                          onClick={() => setConfirmingReset(true)}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                            border: 'none', color: '#ff8585', padding: '8px 10px', borderRadius: 6,
                            cursor: 'pointer', fontSize: '0.86em'
                          }}
                        >
                          Reset library…
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={handleReset}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left', background: 'rgba(255,80,80,0.15)',
                              border: 'none', color: '#ff8585', padding: '8px 10px', borderRadius: 6,
                              cursor: 'pointer', fontSize: '0.86em', fontWeight: 600
                            }}
                          >
                            Yes, remove all tracks
                          </button>
                          <button
                            onClick={() => setConfirmingReset(false)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                              border: 'none', color: 'white', padding: '8px 10px', borderRadius: 6,
                              cursor: 'pointer', fontSize: '0.86em'
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {/* Future menu items go here (settings, rebuild waveforms, etc.) */}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="source-tabs">
            <button className={`source-tab ${browseMode === "songs" ? "active" : ""}`} onClick={() => selectBrowseMode("songs")} title="Songs">
              <Library size={17} />
            </button>
            <button className={`source-tab ${browseMode === "albums" ? "active" : ""}`} onClick={() => selectBrowseMode("albums")} title="Albums">
              <Disc3 size={17} />
            </button>
            <button className={`source-tab ${browseMode === "folders" ? "active" : ""}`} onClick={() => selectBrowseMode("folders")} title="Folders">
              <Folder size={17} />
            </button>
            <button className={`source-tab ${browseMode === "playlists" ? "active" : ""}`} onClick={() => selectBrowseMode("playlists")} title="Playlists">
              <ListMusic size={17} />
            </button>
          </div>
          {!isSourceList && (
            <div className="source-toolbar">
              <button className="sort-pill" onClick={cycleSortMode}>
                Sort: {sortMode === "artist" ? "Artist" : sortMode === "album" ? "Album" : "Title"}
              </button>
            </div>
          )}
          {isCreatingPlaylist && (
            <form className="playlist-composer" onSubmit={(event) => { event.preventDefault(); handleCreatePlaylist(); }}>
              <input
                value={newPlaylistName}
                onChange={(event) => setNewPlaylistName(event.target.value)}
                autoFocus
                placeholder="Playlist name"
              />
              <button type="submit">Create</button>
              <button type="button" onClick={() => setIsCreatingPlaylist(false)}>Cancel</button>
            </form>
          )}
          <div 
            className={`tracklist ${showScroll ? "show-scroll" : ""}`} 
            onMouseEnter={() => setShowScroll(true)}
            onMouseLeave={() => setShowScroll(false)}
          >
            {browseMode === "albums" && !selectedAlbumKey && (
              <>
                {visibleAlbumGroups.length === 0 && <div className="empty-state">No albums</div>}
                {visibleAlbumGroups.map((album) => {
                  const coverUrl = album.tracks
                    .map(track => trackArtUrls[track.file_path])
                    .find(Boolean) ?? null;
                  return (
                    <div
                      key={album.key}
                      className="source-row"
                      onClick={() => setSelectedAlbumKey(album.key)}
                    >
                      <AlbumThumbnail
                        tracks={album.tracks}
                        src={coverUrl}
                        loadAlbumThumbnail={loadAlbumThumbnail}
                      />
                      <div className="source-row-main">
                        <div className="source-row-title">{album.album}</div>
                        <div className="source-row-subtitle">{album.artist} · {album.tracks.length} tracks</div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {browseMode === "folders" && !selectedFolderPath && (
              <>
                {visibleFolders.length === 0 && <div className="empty-state">No folders</div>}
                {visibleFolders.map((folder) => (
                  <div
                    key={folder.path}
                    className="source-row"
                    onClick={() => setSelectedFolderPath(folder.path)}
                  >
                    <div className="source-icon">
                      <Folder size={18} />
                    </div>
                    <div className="source-row-main">
                      <div className="source-row-title">{folder.name}</div>
                      <div className="source-row-subtitle">{folder.track_count} tracks{formatMinutesLabel(folder.duration_secs) ? ` · ${formatMinutesLabel(folder.duration_secs)}` : ""}</div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {browseMode === "playlists" && selectedPlaylistId === null && (
              <>
                {visiblePlaylists.length === 0 && <div className="empty-state">No playlists yet</div>}
                {visiblePlaylists.map((playlist) => (
                  <div
                    key={playlist.id}
                    className="source-row"
                    onClick={() => {
                      if (renamingPlaylistId !== playlist.id) setSelectedPlaylistId(playlist.id);
                    }}
                  >
                    <div className="source-icon playlist-source-icon">
                      <ListMusic size={18} />
                    </div>
                    {renamingPlaylistId === playlist.id ? (
                      <form
                        className="playlist-rename-form"
                        onClick={(event) => event.stopPropagation()}
                        onSubmit={(event) => { event.preventDefault(); handleRenamePlaylist(); }}
                      >
                        <input
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          autoFocus
                          placeholder="Playlist name"
                        />
                        <button type="submit" className="track-row-action visible" title="Save name">
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          className="track-row-action visible"
                          title="Cancel"
                          onClick={() => setRenamingPlaylistId(null)}
                        >
                          <X size={13} />
                        </button>
                      </form>
                    ) : (
                      <>
                        <div className="source-row-main">
                          <div className="source-row-title">{playlist.name}</div>
                          <div className="source-row-subtitle">{playlist.track_count} tracks{formatMinutesLabel(playlist.duration_secs) ? ` · ${formatMinutesLabel(playlist.duration_secs)}` : ""}</div>
                        </div>
                        <div className="track-row-actions" onClick={(event) => event.stopPropagation()}>
                          {confirmingDeletePlaylistId === playlist.id ? (
                            <>
                              <button
                                className="track-row-action danger visible"
                                onClick={() => handleDeletePlaylist(playlist.id)}
                                title="Confirm delete"
                              >
                                <Check size={13} />
                              </button>
                              <button
                                className="track-row-action visible"
                                onClick={() => setConfirmingDeletePlaylistId(null)}
                                title="Cancel"
                              >
                                <X size={13} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="track-row-action"
                                onClick={() => startRenamePlaylist(playlist)}
                                title="Rename playlist"
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                className="track-row-action danger"
                                onClick={() => setConfirmingDeletePlaylistId(playlist.id)}
                                title="Delete playlist"
                              >
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </>
            )}

            {!isSourceList && (
              <>
                {filteredTracks.length === 0 && <div className="empty-state">No tracks</div>}
                {filteredTracks.map((track) => (
                  <div 
                    key={track.file_path}
                    className={`track-row ${currentTrack?.file_path === track.file_path ? "active" : ""}`}
                    onClick={() => playTrack(track)}
                  >
                    <TrackThumbnail
                      track={track}
                      src={trackArtUrls[track.file_path]}
                      loadThumbnail={loadTrackThumbnail}
                    />
                    <div className="track-row-main">
                      <div className="track-row-title">{getTrackName(track)}</div>
                      <div className="track-row-artist">{track.artist || "Unknown Artist"}</div>
                    </div>
                    <div className="track-row-actions">
                      {browseMode === "playlists" && selectedPlaylistId !== null && searchQuery === "" && (
                        <>
                          <button
                            className="track-row-action"
                            onClick={(event) => {
                              event.stopPropagation();
                              movePlaylistTrack(track, -1);
                            }}
                            title="Move up"
                          >
                            <ChevronUp size={13} />
                          </button>
                          <button
                            className="track-row-action"
                            onClick={(event) => {
                              event.stopPropagation();
                              movePlaylistTrack(track, 1);
                            }}
                            title="Move down"
                          >
                            <ChevronDown size={13} />
                          </button>
                        </>
                      )}
                      <button
                        className="track-row-action"
                        onClick={(event) => openPlaylistPicker(track, event)}
                        title="Add to playlist"
                      >
                        <ListPlus size={13} />
                      </button>
                      {browseMode === "playlists" && selectedPlaylistId !== null && (
                        <button
                          className="track-row-action danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleRemoveFromPlaylist(track);
                          }}
                          title="Remove from playlist"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    {currentTrack?.file_path === track.file_path && (
                      <Volume2 className="track-playing-indicator" size={14} aria-hidden="true" />
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <button
          className={`shelf-toggle ${sidebarOpen ? "open" : "closed"}`}
          onClick={handleToggleShelf}
          title={sidebarOpen ? "Hide playlist" : "Show playlist"}
          aria-label={sidebarOpen ? "Hide playlist" : "Show playlist"}
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>

        {/* Now Playing */}
        <div className="now-playing">
          {currentArtUrl ? (
            <img src={currentArtUrl} className="album-art-placeholder" alt="Album Art" />
          ) : (
            <div className="album-art-placeholder"></div>
          )}

          <div className="playback-progress">
            <div ref={containerRef} className="waveform-host"></div>
            <div className="time-row">
              <span className="time-label elapsed">
                {formatTime(currentTime)}
              </span>
              <span className="time-label remaining">
                {wavesurfer && wavesurfer.getDuration() > 0 ? formatTime(currentTime - wavesurfer.getDuration()) : "0:00"}
              </span>
            </div>
          </div>

          <div className="track-info">
            <h2 className="track-title">{currentTrack ? getTrackName(currentTrack) : "Select a track"}</h2>
            <p className="track-artist">{currentTrack?.artist || "Unknown Artist"}</p>
            {currentAlbum && <p className="track-album">{currentAlbum}</p>}
          </div>

          <div className="transport-controls">
            <button className="icon-btn" onClick={playPrev} title="Previous">
              <SkipBack size={24} />
            </button>
            <button className="icon-btn play-toggle" onClick={togglePlay} title={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <Pause size={32} fill="white" /> : <Play size={32} fill="white" />}
            </button>
            <button className="icon-btn" onClick={playNext} title="Next">
              <SkipForward size={24} />
            </button>
          </div>

          <div className="volume-control">
            <button className="icon-btn" onClick={() => setMuted(m => !m)} title="Mute">
              {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input
              type="range" min={0} max={1} step={0.01}
              className="volume-slider"
              value={muted ? 0 : volume}
              onChange={(e) => { setMuted(false); setVolume(parseFloat(e.target.value)); }}
              style={{ ["--pct" as any]: `${(muted ? 0 : volume) * 100}%` }}
            />
            <Volume2 className="volume-endcap" size={18} aria-hidden="true" />
          </div>

          <div className="utility-controls">
            <button
              className="icon-btn"
              onClick={(event) => { if (currentTrack) openPlaylistPicker(currentTrack, event); }}
              disabled={!currentTrack}
              title="Add current song to playlist"
            >
              <ListPlus size={19} />
            </button>
            <button className={`icon-btn visualizer-btn ${visualizer}`} onClick={() => {
              setVisualizer((mode) => VISUALIZER_MODES[(VISUALIZER_MODES.indexOf(mode) + 1) % VISUALIZER_MODES.length]);
            }} title={`Visualizer: ${visualizer}`}>
              <Wand2 size={19} />
            </button>
            <button className="icon-btn" onClick={handleToggleShelf} title={sidebarOpen ? "Hide playlist" : "Show playlist"}>
              <ListMusic size={19} />
            </button>
            <button
              className={`icon-btn ${shuffleEnabled ? "is-active" : ""}`}
              onClick={() => setShuffleEnabled(enabled => !enabled)}
              title={shuffleEnabled ? "Shuffle on" : "Shuffle off"}
            >
              <Shuffle size={18} />
            </button>
            <button
              className={`icon-btn ${repeatMode !== "off" ? "is-active" : ""}`}
              onClick={cycleRepeatMode}
              title={repeatLabel}
            >
              {repeatMode === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
            </button>
          </div>
        </div>
      </div>

      {importNotice && (
        <div className="import-toast" key={importNotice.id} role="status">
          <div className="import-toast-icon">
            <ListPlus size={16} />
          </div>
          <div className="import-toast-copy">
            <div className="import-toast-title">{importNotice.title}</div>
            <div className="import-toast-detail">{importNotice.detail}</div>
          </div>
        </div>
      )}

      {/* Add-to-playlist picker */}
      {pickerTrack && pickerPos && (
        <>
          <div className="picker-overlay" onClick={closePlaylistPicker} />
          <div
            className="playlist-picker"
            style={{
              left: Math.max(8, Math.min(pickerPos.x, window.innerWidth - 248)),
              top: Math.max(8, Math.min(pickerPos.y + 6, window.innerHeight - 320)),
            }}
          >
            <div className="playlist-picker-header">Add to playlist</div>
            <div className="playlist-picker-track">{getTrackName(pickerTrack)}</div>
            <div className="playlist-picker-list">
              {playlists.length === 0 && (
                <div className="playlist-picker-empty">No playlists yet</div>
              )}
              {playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  className="playlist-picker-item"
                  onClick={() => handleAddTrackToPlaylist(playlist.id)}
                >
                  <ListMusic size={14} />
                  <span className="playlist-picker-name">{playlist.name}</span>
                  <span className="playlist-picker-count">{playlist.track_count}</span>
                </button>
              ))}
            </div>
            {pickerCreating ? (
              <form
                className="playlist-picker-new"
                onSubmit={(event) => { event.preventDefault(); handleCreatePlaylistWithTrack(); }}
              >
                <input
                  value={pickerNewName}
                  onChange={(event) => setPickerNewName(event.target.value)}
                  autoFocus
                  placeholder="Playlist name"
                />
                <button type="submit" title="Create playlist">
                  <Check size={14} />
                </button>
              </form>
            ) : (
              <button
                className="playlist-picker-item playlist-picker-create"
                onClick={() => { setPickerCreating(true); setPickerNewName(""); }}
              >
                <Plus size={14} />
                <span className="playlist-picker-name">New playlist…</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default App;
