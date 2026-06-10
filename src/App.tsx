import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWavesurfer } from "@wavesurfer/react";
import { Vibrant } from 'node-vibrant/browser';
import { open } from "@tauri-apps/plugin-dialog";
import { Minimize2, X, Play, Pause, SkipBack, SkipForward, Search, FolderPlus, Volume2, VolumeX, MoreVertical, Music, PanelLeftClose, PanelLeftOpen, Shuffle, Repeat, Repeat1, ListMusic, Library, Disc3, Folder, Plus, ChevronLeft, Trash2, Wand2 } from "lucide-react";
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
  if (!Array.isArray(artBytes) || artBytes.length === 0) return null;
  const blob = new Blob([new Uint8Array(artBytes as number[])]);
  return URL.createObjectURL(blob);
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
  const [visualizer, setVisualizer] = useState<VisualizerMode>("lavalamp");
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
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");

  const handleRescan = async () => {
    if (!isTauri) return;
    setMenuOpen(false);
    setIsScanning(true);
    try {
      const updated = await invoke<Track[]>("rescan_library");
      const nextTracks = dedupeTracks(updated);
      setTracks(nextTracks);
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

  useEffect(() => {
    if (!isTauri) return;
    const fetchLibrary = () => {
      invoke<Track[]>("get_library")
        .then((t) => setTracks(dedupeTracks(t)))
        .catch(console.error);
    };

    fetchLibrary();
    refreshFolders();
    refreshPlaylists();

    const unlisten = listen("metadata-updated", () => {
      console.log("Metadata updated, refreshing library...");
      fetchLibrary();
    });

    return () => {
      unlisten.then(f => f());
    };
  }, [isTauri, refreshFolders, refreshPlaylists]);

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

  const { wavesurfer, isPlaying } = useWavesurfer({
    container: containerRef,
    height: 48,
    waveColor: 'rgba(255, 255, 255, 0.4)',
    progressColor: 'rgba(255, 255, 255, 0.9)',
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
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
    if (containerRef.current) {
      containerRef.current.style.transform = "";
      containerRef.current.style.filter = "";
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
    if (wavesurfer) wavesurfer.setVolume(muted ? 0 : volume);
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
      if (peaks && peaks.length) wavesurfer.load(url, [peaks]);
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
  const getShuffleIndex = () => {
    if (filteredTracks.length === 0) return null;
    if (filteredTracks.length === 1) return 0;
    let nextIndex = currentIndex;
    while (nextIndex === currentIndex) {
      nextIndex = Math.floor(Math.random() * filteredTracks.length);
    }
    return nextIndex;
  };
  const getNextTrackIndex = (wrap = repeatMode === "all") => {
    if (filteredTracks.length === 0) return null;
    if (shuffleEnabled) return getShuffleIndex();
    if (currentIndex < 0) return 0;
    if (currentIndex < filteredTracks.length - 1) return currentIndex + 1;
    return wrap ? 0 : null;
  };
  const getPrevTrackIndex = () => {
    if (filteredTracks.length === 0) return null;
    if (shuffleEnabled) return getShuffleIndex();
    if (currentIndex > 0) return currentIndex - 1;
    return repeatMode === "all" ? filteredTracks.length - 1 : null;
  };
  const playNext = () => {
    const nextIndex = getNextTrackIndex();
    if (nextIndex !== null) setCurrentTrack(filteredTracks[nextIndex]);
  };
  const playPrev = () => {
    const prevIndex = getPrevTrackIndex();
    if (prevIndex !== null) setCurrentTrack(filteredTracks[prevIndex]);
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
      if (nextIndex !== null) setCurrentTrack(filteredTracks[nextIndex]);
    };
    wavesurfer.on("finish", onFinish);
    return () => wavesurfer.un("finish", onFinish);
  }, [wavesurfer, currentTrack, filteredTracks, shuffleEnabled, repeatMode]);

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
      }
      display += (target - display) * 0.18; // easing → fluid, not twitchy
      document.documentElement.style.setProperty('--audio-level', display.toString());
      if (el) {
        el.style.transformOrigin = "center";
        el.style.transform = `scaleY(${1 + display * 0.08})`;
        el.style.filter = `drop-shadow(0 0 ${display * 12}px var(--bg-color-1, rgba(255,255,255,0.4)))`;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [wavesurfer]);

  useEffect(() => {
    if (!isTauri || !currentTrack) return;
    const idx = filteredTracks.findIndex(t => t.file_path === currentTrack.file_path);
    if (idx < 0) return;
    const upcoming = [filteredTracks[idx + 1], filteredTracks[idx + 2]].filter(Boolean);
    upcoming.forEach(t => {
      invoke("get_waveform_peaks", { filePath: t.file_path }).catch(() => {});
    });
  }, [currentTrack, filteredTracks, isTauri]);

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
                    onClick={() => setSelectedPlaylistId(playlist.id)}
                  >
                    <div className="source-icon playlist-source-icon">
                      <ListMusic size={18} />
                    </div>
                    <div className="source-row-main">
                      <div className="source-row-title">{playlist.name}</div>
                      <div className="source-row-subtitle">{playlist.track_count} tracks{formatMinutesLabel(playlist.duration_secs) ? ` · ${formatMinutesLabel(playlist.duration_secs)}` : ""}</div>
                    </div>
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
                    onClick={() => setCurrentTrack(track)}
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
                    {browseMode === "playlists" && selectedPlaylistId !== null && (
                      <button
                        className="track-remove-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRemoveFromPlaylist(track);
                        }}
                        title="Remove from playlist"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
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
    </div>
  );
}

export default App;
