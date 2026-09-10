'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  adminLibraryWritable,
  adminUpdateTrackMetadata,
  browseAlbum,
  browseAlbums,
  browseArtistById,
  browseArtistTracks,
  browseArtists,
  browseCountries,
  browseCountryTracks,
  browseGenres,
  browseGenreTracks,
  browseLanguages,
  browseLanguageTracks,
} from './apiClient';
import { useFavorites } from './favoritesStore';
import { useAuth } from './store';
import { useLatestRequest } from './useLatestRequest';
import { useToastStore } from './Toast';
import { useLibraryUpdates } from './useWebSocket';
import { useRouter, useRoute } from './router';
import { AddMenu, type AddMenuTrack } from './AddMenu';
import { useBodyScrollLock } from './useBodyScrollLock';
import { formatArtistValue, trackArtistLabel } from './artistDisplay';
import { formatCount } from './format';
import { ArtworkImage } from './ArtworkImage';

type Tab = 'artists' | 'albums' | 'genres' | 'countries' | 'languages';

type Artist = { id: number; name: string; track_count: number; album_count: number; art_path?: string | null; art_hash?: string | null };
type Album = { display_artist: string; album: string; track_count: number; art_path: string | null; art_hash: string | null };
type Genre = { genre: string; track_count: number; artist_count: number };
type Country = { country: string; track_count: number; artist_count: number };
type Language = { language: string; track_count: number; artist_count: number };
type Track = {
  id: number;
  title: string | null;
  artist: string | null;
  album_artist?: string | null;
  display_artist?: string | null;
  album: string | null;
  duration_ms: number | null;
  art_path?: string | null;
  path?: string;
  genre?: string | null;
  country?: string | null;
  language?: string | null;
  year?: number | null;
  artists?: Array<{ id: number; name: string }>;
  discNumber?: number | null;
  trackNumber?: number | null;
};

// Genre color palette
const GENRE_COLORS = [
  'from-rose-500 to-pink-600',
  'from-violet-500 to-purple-600',
  'from-blue-500 to-indigo-600',
  'from-cyan-500 to-teal-600',
  'from-emerald-500 to-green-600',
  'from-amber-500 to-orange-600',
  'from-red-500 to-rose-600',
  'from-fuchsia-500 to-pink-600',
  'from-sky-500 to-blue-600',
  'from-lime-500 to-green-600',
];

// Country to ISO code mapping for flag images
const COUNTRY_CODES: Record<string, string> = {
  'Poland': 'pl',
  'France': 'fr',
  'Germany': 'de',
  'Spain': 'es',
  'United Kingdom': 'gb',
  'UK': 'gb',
  'United States': 'us',
  'USA': 'us',
  'Japan': 'jp',
  'South Korea': 'kr',
  'Korea': 'kr',
  'China': 'cn',
  'India': 'in',
  'Brazil': 'br',
  'Mexico': 'mx',
  'Canada': 'ca',
  'Australia': 'au',
  'Italy': 'it',
  'Sweden': 'se',
  'Norway': 'no',
  'Denmark': 'dk',
  'Finland': 'fi',
  'Netherlands': 'nl',
  'Belgium': 'be',
  'Austria': 'at',
  'Switzerland': 'ch',
  'Ireland': 'ie',
  'Portugal': 'pt',
  'Lithuania': 'lt',
  'Russia': 'ru',
  'Ukraine': 'ua',
  'Jamaica': 'jm',
  'Cuba': 'cu',
  'Argentina': 'ar',
  'Colombia': 'co',
  'Nigeria': 'ng',
  'South Africa': 'za',
  'Egypt': 'eg',
  'Israel': 'il',
  'Turkey': 'tr',
  'Greece': 'gr',
  'Romania': 'ro',
  'Czech Republic': 'cz',
  'Hungary': 'hu',
  'Iceland': 'is',
  'New Zealand': 'nz',
  'Philippines': 'ph',
  'Indonesia': 'id',
  'Thailand': 'th',
  'Vietnam': 'vn',
  'Malaysia': 'my',
  'Singapore': 'sg',
};

function getCountryCode(country: string): string | null {
  return COUNTRY_CODES[country] || null;
}

function CountryFlag({ country, size = 'md' }: { country: string; size?: 'sm' | 'md' | 'lg' }) {
  const code = getCountryCode(country);
  const sizeClass = size === 'sm' ? 'w-5 h-4' : size === 'lg' ? 'w-12 h-9' : 'w-8 h-6';
  
  if (!code) {
    return (
      <svg className={`${sizeClass} text-white`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  
  return (
    <img 
      src={`https://flagcdn.com/w80/${code}.png`}
      srcSet={`https://flagcdn.com/w160/${code}.png 2x`}
      alt={country}
      className={`${sizeClass} object-cover rounded shadow-sm`}
    />
  );
}

function getGenreColor(genre: string): string {
  let hash = 0;
  for (let i = 0; i < genre.length; i++) {
    hash = genre.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GENRE_COLORS[Math.abs(hash) % GENRE_COLORS.length];
}

function formatDuration(ms: number | null): string {
  if (!ms) return '--:--';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function BrowseNew(props: {
  onPlayTrack?: (t: { id: number; title: string | null; artist: string | null; album?: string | null }) => void;
  onPlayAll?: (tracks: Array<{ id: number; title: string | null; artist: string | null; album?: string | null }>) => void;
  onAddToQueue?: (t: { id: number; title: string | null; artist: string | null; album?: string | null }) => void;
  onNavigateArtist?: (artistId: number) => void;
}) {
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const showToast = useToastStore((s) => s.show);
  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);
  const lastUpdate = useLibraryUpdates((s) => s.lastUpdate);
  const lastEvent = useLibraryUpdates((s) => s.lastEvent);
  
  // Navigation using new router
  const route = useRoute();
  const navigate = useRouter((s) => s.navigate);
  const back = useRouter((s) => s.back);

  // Derive state from route - memoized to avoid unnecessary effect reruns
  const tab = (route.type === 'browse' && route.sub ? route.sub : 'artists') as Tab;
  
  // Create a stable key for album selection to use in effects
  const selectedAlbumKey = route.type === 'browse-album' 
    ? `${route.artist}|${route.album}|${route.artistId}` 
    : null;
  
  const selectedAlbum = useMemo(() => 
    route.type === 'browse-album' ? { artist: route.artist, album: route.album, artistId: route.artistId } : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedAlbumKey]
  );
  
  // Create a stable key for artist selection
  const selectedArtistKey = route.type === 'browse-artist' ? `${route.artistId}|${route.artistName}` : null;
  
  const selectedArtist = useMemo(() => 
    route.type === 'browse-artist' ? { id: route.artistId, name: route.artistName } : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedArtistKey]
  );
  
  const selectedGenre = route.type === 'browse-genre' ? route.genre : null;
  const selectedCountry = route.type === 'browse-country' ? route.country : null;
  const selectedLanguage = route.type === 'browse-language' ? route.language : null;

  const [loading, setLoading] = useState(false);
  const [wsRefreshing, setWsRefreshing] = useState(false);
  const [filter, setFilter] = useState('');

  const [debouncedFilter, setDebouncedFilter] = useState('');

  // Debounce filter input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(filter), 300);
    return () => clearTimeout(t);
  }, [filter]);

  // Artists state
  const [artists, setArtists] = useState<Artist[]>([]);
  const [artistsTotal, setArtistsTotal] = useState(0);
  const [artistsOffset, setArtistsOffset] = useState(0);

  // Albums state
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumsTotal, setAlbumsTotal] = useState(0);
  const [albumsOffset, setAlbumsOffset] = useState(0);

  // Genres state
  const [genres, setGenres] = useState<Genre[]>([]);
  const [genresTotal, setGenresTotal] = useState(0);
  const [genresOffset, setGenresOffset] = useState(0);

  // Countries state
  const [countries, setCountries] = useState<Country[]>([]);
  const [countriesTotal, setCountriesTotal] = useState(0);

  // Languages state
  const [languages, setLanguages] = useState<Language[]>([]);
  const [languagesTotal, setLanguagesTotal] = useState(0);

  // Detail view data (derived from nav store selection)
  const [artistAlbums, setArtistAlbums] = useState<Array<{ album: string; display_artist: string; track_count: number; art_path: string | null }>>([]);
  const [artistAppearsOn, setArtistAppearsOn] = useState<Array<{ album: string; album_artist: string; track_count: number; art_path: string | null }>>([]);
  const [artistArt, setArtistArt] = useState<{ art_path: string | null; art_hash: string | null } | null>(null);

  const [albumDetail, setAlbumDetail] = useState<{ name: string; artist: string; art_path: string | null; tracks: Track[]; totalDiscs: number } | null>(null);

  const [anyWritable, setAnyWritable] = useState(false);
  const [canEditMeta, setCanEditMeta] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editTrack, setEditTrack] = useState<Track | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editArtists, setEditArtists] = useState('');
  const [editAlbum, setEditAlbum] = useState('');
  const [editAlbumArtist, setEditAlbumArtist] = useState('');
  const [editTrackNumber, setEditTrackNumber] = useState('');
  const [editDiscNumber, setEditDiscNumber] = useState('');
  const [editYear, setEditYear] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editCountry, setEditCountry] = useState('');
  const [editLanguage, setEditLanguage] = useState('');

  const [editInitial, setEditInitial] = useState<{
    title: string;
    artists: string;
    album: string;
    albumArtist: string;
    trackNumber: string;
    discNumber: string;
    year: string;
    genre: string;
    country: string;
    language: string;
  } | null>(null);
  useBodyScrollLock(editOpen);

  const [genreTracks, setGenreTracks] = useState<Track[]>([]);

  const [countryTracks, setCountryTracks] = useState<Track[]>([]);

  const [languageTracks, setLanguageTracks] = useState<Track[]>([]);

  const [listError, setListError] = useState<{ tab: Tab; reset: boolean; silent: boolean } | null>(null);

  const PAGE_SIZE = 48;

  const beginListRequest = useLatestRequest(`${tab}:${debouncedFilter}`, token);
  const pendingListRequest = useRef<(() => boolean) | null>(null);

  // Load artists
  const loadArtists = useCallback(async (reset = false, opts?: { silent?: boolean }) => {
    if (!token || pendingListRequest.current?.()) return;
    const isCurrent = beginListRequest();
    if (!isCurrent()) return;
    pendingListRequest.current = isCurrent;
    const silent = Boolean(opts?.silent);
    setListError(null);
    if (silent) setWsRefreshing(true);
    else setLoading(true);
    try {
      const offset = reset ? 0 : artistsOffset;
      // A background refresh retains every page the listener has loaded.
      const limit = reset && silent ? Math.max(PAGE_SIZE, artistsOffset) : PAGE_SIZE;
      const rows: Artist[] = [];
      let total = 0;
      do {
        const r = await browseArtists(token, Math.min(200, limit - rows.length), offset + rows.length, 'az', debouncedFilter || undefined);
        if (!isCurrent()) return;
        rows.push(...r.artists);
        total = r.total;
        if (r.artists.length === 0) break;
      } while (rows.length < limit && offset + rows.length < total);
      setArtists(previous => reset ? rows : [...previous, ...rows]);
      setArtistsTotal(total);
      setArtistsOffset(offset + rows.length);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
      setListError({ tab: 'artists', reset: reset, silent });
    } finally {
      if (isCurrent()) {
        pendingListRequest.current = null;
        setWsRefreshing(false);
        setLoading(false);
      }
    }
  }, [token, artistsOffset, clear, debouncedFilter, beginListRequest]);

  // Load albums
  const loadAlbums = useCallback(async (reset = false, opts?: { silent?: boolean }) => {
    if (!token || pendingListRequest.current?.()) return;
    const isCurrent = beginListRequest();
    if (!isCurrent()) return;
    pendingListRequest.current = isCurrent;
    const silent = Boolean(opts?.silent);
    setListError(null);
    if (silent) setWsRefreshing(true);
    else setLoading(true);
    try {
      const offset = reset ? 0 : albumsOffset;
      // A background refresh retains every page the listener has loaded.
      const limit = reset && silent ? Math.max(PAGE_SIZE, albumsOffset) : PAGE_SIZE;
      const rows: Album[] = [];
      let total = 0;
      do {
        const r = await browseAlbums(token, Math.min(200, limit - rows.length), offset + rows.length, 'az', undefined, debouncedFilter || undefined);
        if (!isCurrent()) return;
        rows.push(...r.albums);
        total = r.total;
        if (r.albums.length === 0) break;
      } while (rows.length < limit && offset + rows.length < total);
      setAlbums(previous => reset ? rows : [...previous, ...rows]);
      setAlbumsTotal(total);
      setAlbumsOffset(offset + rows.length);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
      setListError({ tab: 'albums', reset: reset, silent });
    } finally {
      if (isCurrent()) {
        pendingListRequest.current = null;
        setWsRefreshing(false);
        setLoading(false);
      }
    }
  }, [token, albumsOffset, clear, debouncedFilter, beginListRequest]);

  // Load genres
  const loadGenres = useCallback(async (reset = false, opts?: { silent?: boolean }) => {
    if (!token || pendingListRequest.current?.()) return;
    const isCurrent = beginListRequest();
    if (!isCurrent()) return;
    pendingListRequest.current = isCurrent;
    const silent = Boolean(opts?.silent);
    setListError(null);
    if (silent) setWsRefreshing(true);
    else setLoading(true);
    try {
      const offset = reset ? 0 : genresOffset;
      // A background refresh retains every page the listener has loaded.
      const limit = reset && silent ? Math.max(PAGE_SIZE, genresOffset) : PAGE_SIZE;
      const rows: Genre[] = [];
      let total = 0;
      do {
        const r = await browseGenres(token, Math.min(200, limit - rows.length), offset + rows.length, 'tracks_desc', debouncedFilter || undefined);
        if (!isCurrent()) return;
        rows.push(...r.genres);
        total = r.total;
        if (r.genres.length === 0) break;
      } while (rows.length < limit && offset + rows.length < total);
      setGenres(previous => reset ? rows : [...previous, ...rows]);
      setGenresTotal(total);
      setGenresOffset(offset + rows.length);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
      setListError({ tab: 'genres', reset: reset, silent });
    } finally {
      if (isCurrent()) {
        pendingListRequest.current = null;
        setWsRefreshing(false);
        setLoading(false);
      }
    }
  }, [token, genresOffset, clear, debouncedFilter, beginListRequest]);

  // Load countries
  const loadCountries = useCallback(async (opts?: { silent?: boolean }) => {
    if (!token || pendingListRequest.current?.()) return;
    const isCurrent = beginListRequest();
    if (!isCurrent()) return;
    pendingListRequest.current = isCurrent;
    const silent = Boolean(opts?.silent);
    setListError(null);
    if (silent) setWsRefreshing(true);
    else setLoading(true);
    try {
      const r = await browseCountries(token);
      if (!isCurrent()) return;
      const filtered = debouncedFilter
        ? r.countries.filter(c => c.country.toLowerCase().includes(debouncedFilter.toLowerCase()))
        : r.countries;
      setCountries(filtered);
      setCountriesTotal(filtered.length);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
      setListError({ tab: 'countries', reset: false, silent });
    } finally {
      if (isCurrent()) {
        pendingListRequest.current = null;
        setWsRefreshing(false);
        setLoading(false);
      }
    }
  }, [token, clear, debouncedFilter, beginListRequest]);

  // Load languages
  const loadLanguages = useCallback(async (opts?: { silent?: boolean }) => {
    if (!token || pendingListRequest.current?.()) return;
    const isCurrent = beginListRequest();
    if (!isCurrent()) return;
    pendingListRequest.current = isCurrent;
    const silent = Boolean(opts?.silent);
    setListError(null);
    if (silent) setWsRefreshing(true);
    else setLoading(true);
    try {
      const r = await browseLanguages(token);
      if (!isCurrent()) return;
      const filtered = debouncedFilter
        ? r.languages.filter(l => l.language.toLowerCase().includes(debouncedFilter.toLowerCase()))
        : r.languages;
      setLanguages(filtered);
      setLanguagesTotal(filtered.length);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
      setListError({ tab: 'languages', reset: false, silent });
    } finally {
      if (isCurrent()) {
        pendingListRequest.current = null;
        setWsRefreshing(false);
        setLoading(false);
      }
    }
  }, [token, clear, debouncedFilter, beginListRequest]);

  // One initial/reset request per tab and filter; pagination never resets the list.
  useEffect(() => {
    if (tab === 'artists') {
      setArtists([]);
      setArtistsOffset(0);
      loadArtists(true);
    } else if (tab === 'albums') {
      setAlbums([]);
      setAlbumsOffset(0);
      loadAlbums(true);
    } else if (tab === 'genres') {
      setGenres([]);
      setGenresOffset(0);
      loadGenres(true);
    } else if (tab === 'countries') {
      loadCountries();
    } else if (tab === 'languages') {
      loadLanguages();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, debouncedFilter, token]);


  useEffect(() => {
    if (!token || user?.role !== 'admin') {
      setAnyWritable(false);
      setCanEditMeta(false);
      return;
    }
    (async () => {
      try {
        const r = await adminLibraryWritable(token);
        setAnyWritable(Boolean(r.anyWritable));
        setCanEditMeta(Boolean(r.anyWritable));
      } catch (e: any) {
        if (e?.status === 401) clear();
        setAnyWritable(false);
        setCanEditMeta(false);
      }
    })();
  }, [token, user?.role, clear]);

  // Helper to refresh album detail
  const currentAlbum = useRef({ album: selectedAlbum, token });
  currentAlbum.current = { album: selectedAlbum, token };
  const albumRequest = useRef(0);
  const refreshAlbumDetail = useCallback(async () => {
    if (!token || !selectedAlbum || currentAlbum.current.album !== selectedAlbum || currentAlbum.current.token !== token) return;
    const request = ++albumRequest.current;
    const isCurrent = () => request === albumRequest.current && currentAlbum.current.album === selectedAlbum && currentAlbum.current.token === token;
    try {
      const r = await browseAlbum(token, selectedAlbum.artist, selectedAlbum.album, selectedAlbum.artistId);
      if (!isCurrent()) return;
      setAlbumDetail({
        name: r.album.name,
        artist: r.album.artist,
        art_path: r.album.art_path,
        tracks: r.tracks,
        totalDiscs: r.album.total_discs ?? 1,
      });
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
    }
  }, [token, selectedAlbum, clear]);

  // Helper to refresh artist detail
  const beginArtistRequest = useLatestRequest(selectedArtist, token);
  const refreshArtistDetail = useCallback(async () => {
    if (!token || !selectedArtist) return;
    const isCurrent = beginArtistRequest();
    if (!isCurrent()) return;
    try {
      const r = await browseArtistById(token, selectedArtist.id);
      if (!isCurrent()) return;
      setArtistAlbums(r.albums);
      setArtistAppearsOn(r.appearsOn);
      setArtistArt({ art_path: r.artist.art_path, art_hash: r.artist.art_hash });
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
    }
  }, [token, selectedArtist, clear, beginArtistRequest]);

  const beginGenreRequest = useLatestRequest(selectedGenre, token);

  // Helper to refresh genre tracks
  const refreshGenreTracks = useCallback(async () => {
    if (!token || !selectedGenre) return;
    const isCurrent = beginGenreRequest();
    if (!isCurrent()) return;
    try {
      const r = await browseGenreTracks(token, selectedGenre, 100);
      if (isCurrent()) setGenreTracks(r.tracks);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
    }
  }, [token, selectedGenre, clear, beginGenreRequest]);

  const beginCountryRequest = useLatestRequest(selectedCountry, token);

  // Helper to refresh country tracks
  const refreshCountryTracks = useCallback(async () => {
    if (!token || !selectedCountry) return;
    const isCurrent = beginCountryRequest();
    if (!isCurrent()) return;
    try {
      const r = await browseCountryTracks(token, selectedCountry, 100);
      if (isCurrent()) setCountryTracks(r.tracks);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
    }
  }, [token, selectedCountry, clear, beginCountryRequest]);

  const beginLanguageRequest = useLatestRequest(selectedLanguage, token);

  // Helper to refresh language tracks
  const refreshLanguageTracks = useCallback(async () => {
    if (!token || !selectedLanguage) return;
    const isCurrent = beginLanguageRequest();
    if (!isCurrent()) return;
    try {
      const r = await browseLanguageTracks(token, selectedLanguage, 100);
      if (isCurrent()) setLanguageTracks(r.tracks);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
    }
  }, [token, selectedLanguage, clear, beginLanguageRequest]);

  // Refresh data when library updates arrive via WebSocket.
  // We do this as a quiet, debounced background refresh to avoid visible spinners/flicker during scans.
  const lastRefreshRef = useRef<number>(0);
  const wsRefreshTimerRef = useRef<any>(null);
  useEffect(() => {
    if (!lastUpdate || !lastEvent) return;

    // Throttle refreshes to once per ~4s to avoid spam during bulk scans
    const now = Date.now();
    if (now - lastRefreshRef.current < 4000) return;
    if (loading || wsRefreshing) return;

    if (wsRefreshTimerRef.current) clearTimeout(wsRefreshTimerRef.current);
    wsRefreshTimerRef.current = setTimeout(() => {
      lastRefreshRef.current = Date.now();
      if (tab === 'artists') loadArtists(true, { silent: true });
      else if (tab === 'albums') loadAlbums(true, { silent: true });
      else if (tab === 'genres') loadGenres(true, { silent: true });
      else if (tab === 'countries') loadCountries({ silent: true });
      else if (tab === 'languages') loadLanguages({ silent: true });

      // Also refresh detail views if open (these don't show spinners)
      if (selectedAlbum) refreshAlbumDetail();
      if (selectedArtist) refreshArtistDetail();
      if (selectedGenre) refreshGenreTracks();
      if (selectedCountry) refreshCountryTracks();
      if (selectedLanguage) refreshLanguageTracks();
    }, 400);

    return () => {
      if (wsRefreshTimerRef.current) clearTimeout(wsRefreshTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUpdate]); // intentionally only lastUpdate to avoid loops

  // Load artist detail
  useEffect(() => {
    setArtistAlbums([]);
    setArtistAppearsOn([]);
    setArtistArt(null);
    if (!selectedArtist) return;
    refreshArtistDetail();
  }, [selectedArtist, refreshArtistDetail]);

  // Load album detail
  useEffect(() => {
    setAlbumDetail(null);
    if (selectedAlbum) refreshAlbumDetail();
    const counter = albumRequest;
    return () => { ++counter.current; };
  }, [selectedAlbum, refreshAlbumDetail]);

  // Load genre tracks
  useEffect(() => {
    setGenreTracks([]);
    if (!selectedGenre) return;
    refreshGenreTracks();
  }, [selectedGenre, refreshGenreTracks]);

  // Load country tracks
  useEffect(() => {
    setCountryTracks([]);
    if (!selectedCountry) return;
    refreshCountryTracks();
  }, [selectedCountry, refreshCountryTracks]);

  // Load language tracks
  useEffect(() => {
    setLanguageTracks([]);
    if (!selectedLanguage) return;
    refreshLanguageTracks();
  }, [selectedLanguage, refreshLanguageTracks]);

  // Keep existing cards stationary while pages are appended or refreshed.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollViewportSizeRef = useRef('');
  const [scrollViewportRevision, setScrollViewportRevision] = useState(0);
  const autoFillSignatureRef = useRef('');
  const wsRefreshingRef = useRef(false);
  useEffect(() => {
    wsRefreshingRef.current = wsRefreshing;
  }, [wsRefreshing]);

  const loadNextListPage = useCallback(() => {
    if (tab === 'artists' && artists.length < artistsTotal) {
      void loadArtists();
      return true;
    } else if (tab === 'albums' && albums.length < albumsTotal) {
      void loadAlbums();
      return true;
    } else if (tab === 'genres' && genres.length < genresTotal) {
      void loadGenres();
      return true;
    }
    return false;
  }, [tab, artists.length, artistsTotal, albums.length, albumsTotal, genres.length, genresTotal, loadArtists, loadAlbums, loadGenres]);

  const handleScroll = useCallback(() => {
    if (loading || wsRefreshingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) loadNextListPage();
  }, [loading, loadNextListPage]);

  // A wide viewport can fit the entire first page without creating a scrollbar.
  // Keep measuring it so resizing to a larger window also fills the new space.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    const recordSize = () => {
      const size = `${el.clientWidth}:${el.clientHeight}`;
      if (scrollViewportSizeRef.current === size) return;
      scrollViewportSizeRef.current = size;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrollViewportRevision(revision => revision + 1));
    };

    recordSize();
    const observer = new ResizeObserver(recordSize);
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [tab, selectedArtistKey, selectedAlbumKey, selectedGenre, selectedCountry, selectedLanguage]);

  useEffect(() => {
    if (loading || wsRefreshing || listError) return;
    const el = scrollRef.current;
    if (!el) return;

    let count = 0;
    let total = 0;
    if (tab === 'artists') {
      count = artists.length;
      total = artistsTotal;
    } else if (tab === 'albums') {
      count = albums.length;
      total = albumsTotal;
    } else if (tab === 'genres') {
      count = genres.length;
      total = genresTotal;
    } else {
      return;
    }
    if (count >= total) return;

    const frame = requestAnimationFrame(() => {
      if (el.scrollHeight - el.clientHeight >= 200) return;
      const signature = `${tab}:${debouncedFilter}:${count}:${total}:${el.clientWidth}:${el.clientHeight}`;
      if (autoFillSignatureRef.current === signature) return;
      autoFillSignatureRef.current = signature;
      loadNextListPage();
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, wsRefreshing, listError, tab, debouncedFilter, artists.length, artistsTotal, albums.length, albumsTotal, genres.length, genresTotal, scrollViewportRevision, loadNextListPage]);

  // Switch tab using router
  const switchTab = useCallback((newTab: Tab) => {
    if (newTab === tab) return;
    navigate({ type: 'browse', sub: newTab });
  }, [tab, navigate]);

  // Back navigation - uses router
  const goBack = useCallback(() => {
    back();
  }, [back]);

  // Wrapper for selecting artist
  const selectArtist = useCallback((artist: { id: number; name: string }) => {
    setAlbumDetail(null);
    navigate({ type: 'browse-artist', artistId: artist.id, artistName: artist.name });
  }, [navigate]);

  // Wrapper for selecting album
  const selectAlbum = useCallback((album: { artist: string; album: string; artistId?: number }) => {
    navigate({ type: 'browse-album', artist: album.artist, album: album.album, artistId: album.artistId });
  }, [navigate]);

  // Wrapper for selecting genre
  const selectGenre = useCallback((genre: string) => {
    navigate({ type: 'browse-genre', genre });
  }, [navigate]);

  // Wrapper for selecting country
  const selectCountry = useCallback((country: string) => {
    navigate({ type: 'browse-country', country });
  }, [navigate]);

  // Wrapper for selecting language
  const selectLanguage = useCallback((language: string) => {
    navigate({ type: 'browse-language', language });
  }, [navigate]);

  const isDetailView = Boolean(selectedArtist || albumDetail || selectedGenre || selectedCountry || selectedLanguage);

  if (!token) return null;

  // ============ Detail Views ============

  // Album Detail View
  if (albumDetail) {
    const openEditTrack = (t: Track) => {
      setEditTrack(t);
      setEditTitle(t.title ?? '');
      const a = (t.artists && t.artists.length > 0)
        ? t.artists.map((x) => x.name).join('\n')
        : (t.artist ?? '');
      setEditArtists(a);
      setEditAlbum(albumDetail.name);
      const aa = (t.album_artist ?? '')
        .split(/(?:\s*;\s*|\0|\uFEFF|\\n|\r?\n)+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .join('\n');
      setEditAlbumArtist(aa);
      setEditTrackNumber(t.trackNumber ? String(t.trackNumber) : '');
      setEditDiscNumber(t.discNumber ? String(t.discNumber) : '');
      setEditYear(t.year ? String(t.year) : '');
      const g = (t.genre ?? '').split(';').map((x) => x.trim()).filter(Boolean).join('\n');
      setEditGenre(g);
      const c = (t.country ?? '')
        .split(/(?:\s*;\s*|\0|\uFEFF|\\n|\r?\n)+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .join('\n');
      setEditCountry(c);
      const l = (t.language ?? '')
        .split(/(?:\s*;\s*|\0|\uFEFF|\\n|\r?\n)+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .join('\n');
      setEditLanguage(l);
      setEditInitial({
        title: t.title ?? '',
        artists: a,
        album: albumDetail.name,
        albumArtist: aa,
        trackNumber: t.trackNumber ? String(t.trackNumber) : '',
        discNumber: t.discNumber ? String(t.discNumber) : '',
        year: t.year ? String(t.year) : '',
        genre: g,
        country: c,
        language: l,
      });
      setEditError(null);
      setEditOpen(true);
    };

    return (
      <div className="space-y-6">
        <button onClick={goBack} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="flex items-end gap-4 sm:gap-6">
          <ArtworkImage src={albumDetail.art_path ? `/api/art/${albumDetail.art_path}` : null} alt={albumDetail.name} kind="album" className="w-24 h-24 sm:w-48 sm:h-48 rounded-xl shadow-2xl flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg sm:text-3xl font-bold text-white truncate leading-tight">{albumDetail.name}</h1>
            <p className="text-sm sm:text-xl text-slate-400 mt-1 truncate">{albumDetail.artist}</p>
            <p className="text-sm text-slate-500 mt-2">
              {formatCount(albumDetail.tracks.length, 'track')}
              {albumDetail.totalDiscs > 1 && ` · ${albumDetail.totalDiscs} discs`}
            </p>
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => props.onPlayAll?.(albumDetail.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: albumDetail.name })))}
                className="px-6 py-2 bg-cyan-500 hover:bg-cyan-400 text-white rounded-full font-medium flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play All
              </button>
              <AddMenu
                label="album"
                title={`Add ${albumDetail.name}...`}
                getTracks={() => albumDetail.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: albumDetail.name }))}
              />
            </div>
          </div>
        </div>

        <div className="space-y-1">
          {albumDetail.tracks.map((track, idx) => {
            // Show disc header if this is the first track of a new disc
            const showDiscHeader = albumDetail.totalDiscs > 1 && 
              (idx === 0 || track.discNumber !== albumDetail.tracks[idx - 1]?.discNumber);
            const displayTrackNum = track.trackNumber ?? (idx + 1);
            
            return (
              <div key={track.id}>
                {showDiscHeader && (
                  <div className="flex items-center gap-3 py-3 px-3">
                    <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center">
                      <span className="text-sm font-bold text-slate-300">{track.discNumber ?? 1}</span>
                    </div>
                    <span className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Disc {track.discNumber ?? 1}</span>
                  </div>
                )}
                <div
                  className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 hover:bg-slate-800/50 rounded-lg transition-colors cursor-pointer"
                  onClick={() => props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: albumDetail.name })}
                >
                  {/* Track number - always show play icon on mobile, hover on desktop */}
                  <button type="button" aria-label={`Play ${track.title || 'Untitled'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: albumDetail.name });
                    }}
                    className="w-6 sm:w-8 text-center flex-shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    <span className="text-xs sm:text-sm text-slate-500 hidden sm:inline sm:group-hover:hidden sm:group-focus-within:hidden">{displayTrackNum}</span>
                    <svg className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400 mx-auto sm:hidden sm:group-hover:block sm:group-focus-within:block" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-white truncate text-sm sm:text-base">{track.title || 'Untitled'}</div>
                    <div className="text-xs sm:text-sm text-slate-400 truncate">
                      {track.artists.length > 0 ? (
                        track.artists.map((a, i) => (
                          <span key={a.id}>
                            {i > 0 && <span className="text-slate-600"> • </span>}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                selectArtist({ id: a.id, name: a.name });
                              }}
                              className="hover:text-cyan-400 hover:underline"
                            >
                              {a.name}
                            </button>
                          </span>
                        ))
                      ) : (
                        track.artist
                      )}
                    </div>
                  </div>
                  <div className="text-xs sm:text-sm text-slate-500 flex-shrink-0">{formatDuration(track.duration_ms)}</div>
                  {/* Actions - always visible on mobile, hover on desktop */}
                  <div className="flex items-center gap-0 sm:gap-1 sm:opacity-0 sm:group-hover:opacity-100">
                    <button
                      aria-label={favIds.has(track.id) ? `Remove ${track.title || 'track'} from favorites` : `Add ${track.title || 'track'} to favorites`}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!token) return;
                        try {
                          await toggleFav(token, track.id);
                        } catch (error: any) {
                          if (error?.status === 401) clear();
                          showToast('Could not update favorites. Please try again.', 'error');
                        }
                      }}
                      className={`p-1.5 sm:p-2 rounded-full hover:bg-slate-700 ${favIds.has(track.id) ? 'text-pink-500' : 'text-slate-400'}`}
                    >
                      <svg className="w-4 h-4 sm:w-5 sm:h-5" fill={favIds.has(track.id) ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                    </button>

                    {canEditMeta && (track.path ?? '').toLowerCase().endsWith('.mp3') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditTrack(track);
                        }}
                        className="p-1.5 sm:p-2 rounded-full hover:bg-slate-700 text-slate-400"
                        title="Edit metadata (MP3)"
                      >
                        <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    )}

                    <div className="block">
                      <AddMenu
                        label="track"
                        title="Add to..."
                        getTracks={() => [{ id: track.id, title: track.title, artist: trackArtistLabel(track), album: albumDetail.name }]}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {editOpen && editTrack && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => {
              if (editSaving) return;
              setEditOpen(false);
              setEditInitial(null);
            }}
          >
            <div
              className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto overscroll-contain rounded-xl border border-slate-700 bg-slate-800 p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-white truncate">Edit metadata</h3>
                  <p className="text-sm text-slate-400 truncate">{editTrack.title || 'Untitled'}</p>
                </div>
                <button
                  className="p-2 rounded-lg hover:bg-slate-700 text-slate-300"
                  onClick={() => {
                    if (editSaving) return;
                    setEditOpen(false);
                    setEditInitial(null);
                  }}
                  aria-label="Close"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {editError && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                  {editError}
                </div>
              )}

              <div className="mt-4 space-y-3">
                <label className="text-sm text-slate-300">
                  Title
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                    placeholder="Track title"
                  />
                </label>

                <label className="text-sm text-slate-300">
                  Album
                  <input
                    value={editAlbum}
                    onChange={(e) => setEditAlbum(e.target.value)}
                    className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                    placeholder="Album"
                  />
                </label>

                <label className="text-sm text-slate-300">
                  Album Artists (one per line)
                  <textarea
                    value={editAlbumArtist}
                    onChange={(e) => setEditAlbumArtist(e.target.value)}
                    rows={3}
                    className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                    placeholder="Album Artist"
                  />
                </label>

                <label className="text-sm text-slate-300">
                  Artists (one per line)
                  <textarea
                    value={editArtists}
                    onChange={(e) => setEditArtists(e.target.value)}
                    rows={3}
                    className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                    placeholder="Artist name"
                  />
                </label>

                <label className="text-sm text-slate-300">
                  Genres (one per line)
                  <textarea
                    value={editGenre}
                    onChange={(e) => setEditGenre(e.target.value)}
                    rows={3}
                    className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                    placeholder="Genres"
                  />
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="text-sm text-slate-300">
                    Languages (one per line)
                    <textarea
                      value={editLanguage}
                      onChange={(e) => setEditLanguage(e.target.value)}
                      rows={3}
                      className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                      placeholder="Languages"
                    />
                  </label>

                  <label className="text-sm text-slate-300">
                    Countries (one per line)
                    <textarea
                      value={editCountry}
                      onChange={(e) => setEditCountry(e.target.value)}
                      rows={3}
                      className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                      placeholder="Countries"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label className="text-sm text-slate-300">
                    Track #
                    <input
                      inputMode="numeric"
                      value={editTrackNumber}
                      onChange={(e) => setEditTrackNumber(e.target.value)}
                      className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                      placeholder="1"
                    />
                  </label>

                  <label className="text-sm text-slate-300">
                    Disc #
                    <input
                      inputMode="numeric"
                      value={editDiscNumber}
                      onChange={(e) => setEditDiscNumber(e.target.value)}
                      className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                      placeholder="1"
                    />
                  </label>

                  <label className="text-sm text-slate-300">
                    Year
                    <input
                      inputMode="numeric"
                      value={editYear}
                      onChange={(e) => setEditYear(e.target.value)}
                      className="mt-1 w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white"
                      placeholder="2025"
                    />
                  </label>
                </div>

                <div className="text-xs text-slate-500 flex items-end">
                  MP3 only (writes ID3 tags) · forces a rescan
                </div>
              </div>

              <div className="mt-5 flex gap-3 justify-end">
                <button
                  onClick={() => {
                    if (editSaving) return;
                    setEditOpen(false);
                    setEditInitial(null);
                  }}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={editSaving}
                  onClick={async () => {
                    if (!token || !editTrack) return;
                    setEditSaving(true);
                    setEditError(null);
                    try {
                      const toNull = (s: string) => {
                        const v = s.trim();
                        return v === '' ? null : v;
                      };
                      const toNumOrNull = (s: string) => {
                        const v = s.trim();
                        if (!v) return null;
                        const n = Number(v);
                        return Number.isFinite(n) ? n : null;
                      };
                      const normLines = (s: string, splitRe: RegExp = /\r?\n/) =>
                        s
                          .split(splitRe)
                          .map((x) => x.trim())
                          .filter(Boolean);
                      const canonLines = (s: string, splitRe?: RegExp) => normLines(s, splitRe).join('\n');
                      const joinMulti = (lines: string[]) => lines.join('\u0000');

                      const artists = normLines(editArtists);
                      const genres = normLines(editGenre);
                      const countries = normLines(editCountry, /\\n|\r?\n/);
                      const languages = normLines(editLanguage, /\\n|\r?\n/);
                      const albumArtists = normLines(editAlbumArtist);

                      const init = editInitial ?? {
                        title: editTitle,
                        artists: canonLines(editArtists),
                        album: editAlbum,
                        albumArtist: canonLines(editAlbumArtist),
                        trackNumber: editTrackNumber.trim(),
                        discNumber: editDiscNumber.trim(),
                        year: editYear.trim(),
                        genre: canonLines(editGenre),
                        country: canonLines(editCountry, /\\n|\r?\n/),
                        language: canonLines(editLanguage, /\\n|\r?\n/),
                      };

                      const cur = {
                        title: editTitle,
                        artists: canonLines(editArtists),
                        album: editAlbum,
                        albumArtist: canonLines(editAlbumArtist),
                        trackNumber: editTrackNumber.trim(),
                        discNumber: editDiscNumber.trim(),
                        year: editYear.trim(),
                        genre: canonLines(editGenre),
                        country: canonLines(editCountry, /\\n|\r?\n/),
                        language: canonLines(editLanguage, /\\n|\r?\n/),
                      };

                      const payload: any = {};
                      if (cur.title !== init.title) payload.title = toNull(editTitle);
                      if (cur.album !== init.album) payload.album = toNull(editAlbum);
                      if (cur.trackNumber !== init.trackNumber) payload.trackNumber = toNumOrNull(editTrackNumber);
                      if (cur.discNumber !== init.discNumber) payload.discNumber = toNumOrNull(editDiscNumber);
                      if (cur.year !== init.year) payload.year = toNumOrNull(editYear);

                      if (cur.artists !== init.artists) payload.artists = artists;
                      if (cur.albumArtist !== init.albumArtist) payload.albumArtist = albumArtists.length ? joinMulti(albumArtists) : null;
                      if (cur.genre !== init.genre) payload.genre = genres.length ? joinMulti(genres) : null;
                      if (cur.country !== init.country) payload.country = countries.length ? joinMulti(countries) : null;
                      if (cur.language !== init.language) payload.language = languages.length ? joinMulti(languages) : null;

                      if (Object.keys(payload).length === 0) {
                        setEditOpen(false);
                        setEditInitial(null);
                        return;
                      }

                      await adminUpdateTrackMetadata(token, editTrack.id, payload);

                      // If album name changed, navigate to the new album route.
                      const newAlbum = editAlbum.trim();
                      if (newAlbum && newAlbum !== albumDetail.name) {
                        navigate({ type: 'browse-album', artist: '', album: newAlbum, artistId: undefined });
                      }

                      // Best-effort refresh (rescan can take a moment)
                      await new Promise((r) => setTimeout(r, 1500));
                      if (selectedAlbum) {
                        const r = await browseAlbum(token, selectedAlbum.artist, selectedAlbum.album, selectedAlbum.artistId);
                        setAlbumDetail({
                          name: r.album.name,
                          artist: r.album.artist,
                          art_path: r.album.art_path,
                          tracks: r.tracks,
                          totalDiscs: r.album.total_discs ?? 1,
                        });
                      }

                      setEditOpen(false);
                      setEditInitial(null);
                    } catch (e: any) {
                      if (e?.status === 401) clear();
                      setEditError(e?.data?.error || e?.data?.message || e?.message || 'Failed to save');
                    } finally {
                      setEditSaving(false);
                    }
                  }}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-medium disabled:opacity-60"
                >
                  {editSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Artist Detail View
  if (selectedArtist) {
    return (
      <div className="space-y-6">
        <button onClick={goBack} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="flex items-center gap-4 sm:gap-6">
          <div className="w-24 h-24 sm:w-32 sm:h-32 shrink-0 rounded-full overflow-hidden bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-4xl font-bold text-white shadow-xl">
            <ArtworkImage src={artistArt?.art_path ? `/api/art/${artistArt.art_path}` : null} alt={selectedArtist.name} kind="artist" className="w-full h-full" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-white [overflow-wrap:anywhere]">{selectedArtist.name}</h1>
            <p className="text-slate-400 mt-1">{formatCount(artistAlbums.length, 'album')}</p>
            <div className="mt-3">
              <AddMenu
                label="artist"
                title={`Add ${selectedArtist.name}...`}
                getTracks={async () => {
                  if (!token || !selectedArtist) return [];
                  const r = await browseArtistTracks(token, selectedArtist.id);
                  return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                }}
              />
            </div>
          </div>
        </div>

        {artistAlbums.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-4">Albums</h2>
            <div className="media-card-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {artistAlbums.map((a) => (
                <div key={a.album} className="relative group">
                  <button
                    onClick={() => selectAlbum({ artist: a.display_artist, album: a.album, artistId: selectedArtist?.id })}
                    className="w-full text-left"
                  >
                    <div className="aspect-square rounded-lg overflow-hidden bg-slate-800 mb-2 shadow-lg group-hover:shadow-xl transition-shadow">
                      <ArtworkImage src={a.art_path ? `/api/art/${a.art_path}` : null} alt={a.album} kind="album" className="w-full h-full group-hover:scale-105 transition-transform" />
                    </div>
                    <div className="font-medium text-white truncate group-hover:text-cyan-400">{a.album}</div>
                    <div className="text-sm text-slate-500">{formatCount(a.track_count, 'track')}</div>
                  </button>
                  <div className="absolute top-2 right-2 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                    <AddMenu
                      variant="subtle"
                      label="album"
                      title={`Add ${a.album}...`}
                      getTracks={async () => {
                        if (!token) return [];
                        const r = await browseAlbum(token, a.display_artist, a.album, selectedArtist?.id);
                        return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {artistAppearsOn.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-4">Appears On</h2>
            <div className="media-card-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {artistAppearsOn.map((a) => (
                <div key={`${a.album_artist}-${a.album}`} className="relative group">
                  <button
                    onClick={() => selectAlbum({ artist: a.album_artist, album: a.album })}
                    className="w-full text-left"
                  >
                    <div className="aspect-square rounded-lg overflow-hidden bg-slate-800 mb-2 shadow-lg group-hover:shadow-xl transition-shadow">
                      <ArtworkImage src={a.art_path ? `/api/art/${a.art_path}` : null} alt={a.album} kind="album" className="w-full h-full group-hover:scale-105 transition-transform" />
                    </div>
                    <div className="font-medium text-white truncate group-hover:text-cyan-400">{a.album}</div>
                    <div className="text-sm text-slate-500 truncate">{a.album_artist}</div>
                  </button>
                  <div className="absolute top-2 right-2 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                    <AddMenu
                      variant="subtle"
                      label="album"
                      title={`Add ${a.album}...`}
                      getTracks={async () => {
                        if (!token) return [];
                        const r = await browseAlbum(token, a.album_artist, a.album);
                        return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Genre Tracks View
  if (selectedGenre) {
    return (
      <div className="space-y-6">
        <button onClick={goBack} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="flex flex-wrap items-center gap-4 sm:flex-nowrap">
          <div className={`w-16 h-16 shrink-0 rounded-xl bg-gradient-to-br ${getGenreColor(selectedGenre)} flex items-center justify-center`}>
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-white [overflow-wrap:anywhere]">{selectedGenre}</h1>
            <p className="text-slate-400">{formatCount(genreTracks.length, 'track')}</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <button
            onClick={() => props.onPlayAll?.(genreTracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })))}
            className="shrink-0 whitespace-nowrap px-6 py-2 bg-cyan-500 hover:bg-cyan-400 text-white rounded-full font-medium flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play All
          </button>
          <AddMenu
            label="genre"
            title={`Add ${selectedGenre}...`}
            getTracks={() => genreTracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album }))}
          />
          </div>
        </div>

        <div className="space-y-1">
          {genreTracks.map((track, idx) => (
            <div
              key={track.id}
              className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 hover:bg-slate-800/50 rounded-lg transition-colors cursor-pointer"
              onClick={() => props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: track.album })}
            >
              <button type="button" aria-label={`Play ${track.title || 'Untitled'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: track.album });
                    }}
                    className="w-6 sm:w-8 text-center flex-shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <span className="text-xs sm:text-sm text-slate-500 hidden sm:inline sm:group-hover:hidden sm:group-focus-within:hidden">{idx + 1}</span>
                <svg className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400 mx-auto sm:hidden sm:group-hover:block sm:group-focus-within:block" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              {track.art_path && (
                <img src={`/api/art/${track.art_path}`} alt="" className="w-8 h-8 sm:w-10 sm:h-10 rounded flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white truncate text-sm sm:text-base">{track.title || 'Untitled'}</div>
                <div className="text-xs sm:text-sm text-slate-400 truncate">
                  {track.artists.length > 0 ? (
                    track.artists.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && <span className="text-slate-600"> • </span>}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            selectArtist({ id: a.id, name: a.name });
                          }}
                          className="hover:text-cyan-400 hover:underline"
                        >
                          {a.name}
                        </button>
                      </span>
                    ))
                  ) : (
                    track.artist
                  )}
                </div>
              </div>
              <div className="text-xs sm:text-sm text-slate-500 flex-shrink-0">{formatDuration(track.duration_ms)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Country Detail View
  if (selectedCountry) {
    return (
      <div className="space-y-6">
        <button onClick={goBack} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="flex flex-wrap items-center gap-4 sm:flex-nowrap">
          <div className={`w-16 h-16 shrink-0 rounded-xl bg-gradient-to-br ${getGenreColor(selectedCountry)} flex items-center justify-center`}>
            <CountryFlag country={selectedCountry} size="lg" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-white [overflow-wrap:anywhere]">{selectedCountry}</h1>
            <p className="text-slate-400">{formatCount(countryTracks.length, 'track')}</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <button
            onClick={() => props.onPlayAll?.(countryTracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })))}
            className="shrink-0 whitespace-nowrap px-6 py-2 bg-cyan-500 hover:bg-cyan-400 text-white rounded-full font-medium flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play All
          </button>
          <AddMenu
            label="country"
            title={`Add ${selectedCountry}...`}
            getTracks={() => countryTracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album }))}
          />
          </div>
        </div>

        <div className="space-y-1">
          {countryTracks.map((track, idx) => (
            <div
              key={track.id}
              className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 hover:bg-slate-800/50 rounded-lg transition-colors cursor-pointer"
              onClick={() => props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: track.album })}
            >
              <button type="button" aria-label={`Play ${track.title || 'Untitled'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: track.album });
                    }}
                    className="w-6 sm:w-8 text-center flex-shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <span className="text-xs sm:text-sm text-slate-500 hidden sm:inline sm:group-hover:hidden sm:group-focus-within:hidden">{idx + 1}</span>
                <svg className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400 mx-auto sm:hidden sm:group-hover:block sm:group-focus-within:block" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              {track.art_path && (
                <img src={`/api/art/${track.art_path}`} alt="" className="w-8 h-8 sm:w-10 sm:h-10 rounded flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white truncate text-sm sm:text-base">{track.title || 'Untitled'}</div>
                <div className="text-xs sm:text-sm text-slate-400 truncate">
                  {track.artists.length > 0 ? (
                    track.artists.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && <span className="text-slate-600"> • </span>}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            selectArtist({ id: a.id, name: a.name });
                          }}
                          className="hover:text-cyan-400 hover:underline"
                        >
                          {a.name}
                        </button>
                      </span>
                    ))
                  ) : (
                    track.artist
                  )}
                </div>
              </div>
              <div className="text-xs sm:text-sm text-slate-500 flex-shrink-0">{formatDuration(track.duration_ms)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Language Detail View
  if (selectedLanguage) {
    return (
      <div className="space-y-6">
        <button onClick={goBack} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="flex flex-wrap items-center gap-4 sm:flex-nowrap">
          <div className={`w-16 h-16 shrink-0 rounded-xl bg-gradient-to-br ${getGenreColor(selectedLanguage)} flex items-center justify-center`}>
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-white [overflow-wrap:anywhere]">{selectedLanguage}</h1>
            <p className="text-slate-400">{formatCount(languageTracks.length, 'track')}</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <button
            onClick={() => props.onPlayAll?.(languageTracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })))}
            className="shrink-0 whitespace-nowrap px-6 py-2 bg-cyan-500 hover:bg-cyan-400 text-white rounded-full font-medium flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play All
          </button>
          <AddMenu
            label="language"
            title={`Add ${selectedLanguage}...`}
            getTracks={() => languageTracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album }))}
          />
          </div>
        </div>

        <div className="space-y-1">
          {languageTracks.map((track, idx) => (
            <div
              key={track.id}
              className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 hover:bg-slate-800/50 rounded-lg transition-colors cursor-pointer"
              onClick={() => props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: track.album })}
            >
              <button type="button" aria-label={`Play ${track.title || 'Untitled'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onPlayTrack?.({ id: track.id, title: track.title, artist: trackArtistLabel(track), album: track.album });
                    }}
                    className="w-6 sm:w-8 text-center flex-shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <span className="text-xs sm:text-sm text-slate-500 hidden sm:inline sm:group-hover:hidden sm:group-focus-within:hidden">{idx + 1}</span>
                <svg className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400 mx-auto sm:hidden sm:group-hover:block sm:group-focus-within:block" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              {track.art_path && (
                <img src={`/api/art/${track.art_path}`} alt="" className="w-8 h-8 sm:w-10 sm:h-10 rounded flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white truncate text-sm sm:text-base">{track.title || 'Untitled'}</div>
                <div className="text-xs sm:text-sm text-slate-400 truncate">
                  {track.artists.length > 0 ? (
                    track.artists.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && <span className="text-slate-600"> • </span>}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            selectArtist({ id: a.id, name: a.name });
                          }}
                          className="hover:text-cyan-400 hover:underline"
                        >
                          {a.name}
                        </button>
                      </span>
                    ))
                  ) : (
                    track.artist
                  )}
                </div>
              </div>
              <div className="text-xs sm:text-sm text-slate-500 flex-shrink-0">{formatDuration(track.duration_ms)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ============ Main Browse View ============
  return (
    <div className="space-y-6">
      {/* Tabs + Filter */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-4">
        {/* Scrollable tabs container for mobile */}
        <div className="overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0">
          <div className="flex gap-1 p-1 bg-slate-800/50 rounded-xl w-max sm:w-auto">
            {(['artists', 'albums', 'genres', 'countries', 'languages'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => switchTab(t)}
                className={`px-4 sm:px-6 py-2 rounded-lg font-medium transition-colors capitalize text-sm sm:text-base whitespace-nowrap ${
                  tab === t ? 'bg-cyan-500 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Filter Input */}
        <div className="relative flex-1 max-w-xs">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${tab}...`}
            className="w-full pl-10 pr-8 py-2 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Result count */}
        <div className="text-sm text-slate-500">
          {loading && (
            (tab === 'artists' && artists.length === 0) ||
            (tab === 'albums' && albums.length === 0) ||
            (tab === 'genres' && genres.length === 0) ||
            (tab === 'countries' && countries.length === 0) ||
            (tab === 'languages' && languages.length === 0)
          ) ? 'Loading…' : listError ? 'Unavailable' : (
            <>
              {tab === 'artists' && formatCount(artistsTotal, 'artist')}
              {tab === 'albums' && formatCount(albumsTotal, 'album')}
              {tab === 'genres' && formatCount(genresTotal, 'genre')}
              {tab === 'countries' && formatCount(countriesTotal, 'country', 'countries')}
              {tab === 'languages' && formatCount(languagesTotal, 'language')}
            </>
          )}
        </div>
      </div>

      {listError && (
        <div className="rounded-xl bg-red-500/10 p-3 text-sm text-red-300">
          <p role="alert">Could not load {listError.tab}. Please try again.</p>
          <button type="button" className="mt-2 rounded px-3 py-2 text-cyan-400 hover:bg-white/10" onClick={() => {
            const opts = { silent: listError.silent };
            if (listError.tab === 'artists') void loadArtists(listError.reset, opts);
            else if (listError.tab === 'albums') void loadAlbums(listError.reset, opts);
            else if (listError.tab === 'genres') void loadGenres(listError.reset, opts);
            else if (listError.tab === 'countries') void loadCountries(opts);
            else void loadLanguages(opts);
          }}>Retry</button>
        </div>
      )}

      {/* Content */}
      <div ref={scrollRef} onScroll={handleScroll} className="overflow-y-auto no-scrollbar" style={{ maxHeight: 'calc(100vh - 280px)' }}>
        {/* Artists Grid */}
        {tab === 'artists' && (
          <div className="media-card-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {artists.map((a) => (
              <div key={a.id} className="relative group">
                <button
                  data-flip-id={`artist:${a.id}`}
                  onClick={() => selectArtist({ id: a.id, name: a.name })}
                  className="w-full text-center p-4 rounded-xl hover:bg-slate-800/50 transition-colors"
                >
                  <div className="w-24 h-24 mx-auto rounded-full overflow-hidden bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center text-2xl font-bold text-white group-hover:from-cyan-500 group-hover:to-blue-600 transition-all shadow-lg">
                    <ArtworkImage src={a.art_path ? `/api/art/${a.art_path}` : null} alt={a.name} kind="artist" className="w-full h-full" />
                  </div>
                  <div className="mt-3 font-medium text-white truncate group-hover:text-cyan-400">{a.name}</div>
                  <div className="text-sm text-slate-500">{formatCount(a.album_count, 'album')}</div>
                </button>
                <div className="absolute top-3 right-3 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                  <AddMenu
                    variant="subtle"
                    label="artist"
                    title={`Add ${a.name}...`}
                    getTracks={async () => {
                      if (!token) return [];
                      const r = await browseArtistTracks(token, a.id);
                      return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                    }}
                  />
                </div>
              </div>
            ))}
            {loading && (
              <div className="col-span-full flex justify-center py-8">
                <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        )}

        {/* Albums Grid */}
        {tab === 'albums' && (
          <div className="media-card-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {albums.map((a) => (
              <div key={`${a.display_artist}||${a.album}`} className="relative group">
                <button
                  data-flip-id={`album:${a.display_artist}||${a.album}`}
                  onClick={() => selectAlbum({ artist: a.display_artist, album: a.album })}
                  className="w-full text-left"
                >
                  <div className="aspect-square rounded-lg overflow-hidden bg-slate-800 mb-2 shadow-lg group-hover:shadow-xl transition-shadow">
                    <ArtworkImage src={a.art_path ? `/api/art/${a.art_path}` : null} alt={a.album} kind="album" className="w-full h-full group-hover:scale-105 transition-transform" />
                  </div>
                  <div className="font-medium text-white truncate group-hover:text-cyan-400">{a.album}</div>
                  <div className="text-sm text-slate-500 truncate">{formatArtistValue(a.display_artist) ?? 'Unknown Artist'}</div>
                </button>
                <div className="absolute top-2 right-2 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                  <AddMenu
                    variant="subtle"
                    label="album"
                    title={`Add ${a.album}...`}
                    getTracks={async () => {
                      if (!token) return [];
                      const r = await browseAlbum(token, a.display_artist, a.album);
                      return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                    }}
                  />
                </div>
              </div>
            ))}
            {loading && (
              <div className="col-span-full flex justify-center py-8">
                <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        )}

        {/* Genres Grid */}
        {tab === 'genres' && (
          <div className="browse-category-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {genres.map((g) => (
              <button
                key={g.genre}
                data-flip-id={`genre:${g.genre}`}
                onClick={() => selectGenre(g.genre)}
                className={`group relative aspect-[3/2] rounded-xl overflow-hidden bg-gradient-to-br ${getGenreColor(g.genre)} p-4 flex flex-col justify-end text-left shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all`}
              >
                <div className="absolute inset-0 bg-black/20" />
                <div className="relative">
                  <div className="font-bold text-white text-lg">{g.genre}</div>
                  <div className="text-white/80 text-sm">{formatCount(g.track_count, 'track')}</div>
                </div>
              </button>
            ))}
            {loading && (
              <div className="col-span-full flex justify-center py-8">
                <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        )}

        {/* Countries Grid */}
        {tab === 'countries' && (
          <div className="browse-category-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {countries.map((c) => (
              <button
                key={c.country}
                data-flip-id={`country:${c.country}`}
                onClick={() => selectCountry(c.country)}
                className={`group relative aspect-[3/2] rounded-xl overflow-hidden bg-gradient-to-br ${getGenreColor(c.country)} p-4 flex flex-col justify-end text-left shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all`}
              >
                <div className="absolute inset-0 bg-black/20" />
                <div className="absolute top-3 right-3 opacity-80 group-hover:opacity-100 transition-opacity">
                  <CountryFlag country={c.country} size="md" />
                </div>
                <div className="relative">
                  <div className="font-bold text-white text-lg">{c.country}</div>
                  <div className="text-white/80 text-sm">{formatCount(c.track_count, 'track')}</div>
                </div>
              </button>
            ))}
            {loading && (
              <div className="col-span-full flex justify-center py-8">
                <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        )}

        {/* Languages Grid */}
        {tab === 'languages' && (
          <div className="browse-category-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {languages.map((l) => (
              <button
                key={l.language}
                data-flip-id={`language:${l.language}`}
                onClick={() => selectLanguage(l.language)}
                className={`group relative aspect-[3/2] rounded-xl overflow-hidden bg-gradient-to-br ${getGenreColor(l.language)} p-4 flex flex-col justify-end text-left shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all`}
              >
                <div className="absolute inset-0 bg-black/20" />
                <div className="relative">
                  <div className="font-bold text-white text-lg flex items-center gap-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                    </svg>
                    {l.language}
                  </div>
                  <div className="text-white/80 text-sm">{formatCount(l.track_count, 'track')}</div>
                </div>
              </button>
            ))}
            {loading && (
              <div className="col-span-full flex justify-center py-8">
                <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
