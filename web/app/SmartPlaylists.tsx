'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  listSmartPlaylists,
  getSmartPlaylist,
  createSmartPlaylist,
  updateSmartPlaylist,
  deleteSmartPlaylist,
  suggestSmartPlaylist,
  type SmartPlaylist,
  type SmartFilters,
} from './apiClient';
import { useAuth } from './store';
import { usePlayer } from './playerStore';

const SORT_OPTIONS = [
  { value: 'random', label: 'Random' },
  { value: 'most_played', label: 'Most Played' },
  { value: 'least_played', label: 'Least Played' },
  { value: 'recently_played', label: 'Recently Played' },
  { value: 'newest_added', label: 'Newest Added' },
  { value: 'oldest_added', label: 'Oldest Added' },
  { value: 'title_asc', label: 'Title (A-Z)' },
  { value: 'title_desc', label: 'Title (Z-A)' },
  { value: 'artist_asc', label: 'Artist' },
  { value: 'album_asc', label: 'Album' },
];

const emptyFilters: SmartFilters = {
  include: { artists: [], artistsMode: 'any', albums: [], genres: [], genresMode: 'any', years: [], countries: [] },
  exclude: { artists: [], albums: [], genres: [], years: [], countries: [] },
  duration: { min: null, max: null },
  favoriteOnly: false,
  maxResults: null,
};

type Track = {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  art_path: string | null;
  art_hash: string | null;
};

// Reusable picker component for search/select
function SmartPicker({
  label,
  kind,
  selected,
  onChange,
  placeholder,
  token,
  displayFn,
  valueKey = 'id',
}: {
  label: string;
  kind: string;
  selected: Array<any>;
  onChange: (items: Array<any>) => void;
  placeholder?: string;
  token: string;
  displayFn: (item: any) => string;
  valueKey?: string;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    if (!token || !query.trim()) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await suggestSmartPlaylist(token, kind, query);
        setSuggestions(r.items ?? []);
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [query, token, kind]);

  const addItem = (item: any) => {
    const val = valueKey === 'value' ? item : item[valueKey];
    const exists = selected.some((s) => (valueKey === 'value' ? s === val : s[valueKey] === val));
    if (!exists) {
      onChange([...selected, valueKey === 'value' ? item : item]);
    }
    setQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
  };

  const removeItem = (item: any) => {
    const val = valueKey === 'value' ? item : item[valueKey];
    onChange(selected.filter((s) => (valueKey === 'value' ? s !== val : s[valueKey] !== val)));
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-300">{label}</label>
      <div className="flex flex-wrap gap-2 mb-2">
        {selected.map((item, idx) => (
          <span
            key={idx}
            className="px-3 py-1 bg-cyan-500/20 text-cyan-400 rounded-full text-sm flex items-center gap-2"
          >
            {displayFn(item)}
            <button onClick={() => removeItem(item)} className="hover:text-white">×</button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-white placeholder-slate-400 focus:outline-none text-sm"
          placeholder={placeholder || `Search ${label.toLowerCase()}...`}
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full p-2 bg-slate-800 rounded-lg border border-slate-700 max-h-40 overflow-y-auto">
            {suggestions.map((item, idx) => (
              <button
                key={idx}
                onClick={() => addItem(item)}
                className="block w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 rounded"
              >
                {displayFn(item)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function SmartPlaylists(props: {
  onPlayTrack?: (t: { id: number; title: string; artist: string }) => void;
  onPlayAll?: (tracks: Array<{ id: number; title: string; artist: string }>) => void;
}) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const { setQueueAndPlay } = usePlayer();

  const [playlists, setPlaylists] = useState<SmartPlaylist[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [trackCount, setTrackCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editor state
  const [editing, setEditing] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editSort, setEditSort] = useState('random');
  const [editMaxResults, setEditMaxResults] = useState<string>('');
  const [editFavoriteOnly, setEditFavoriteOnly] = useState(false);
  const [editDurationMin, setEditDurationMin] = useState<string>('');
  const [editDurationMax, setEditDurationMax] = useState<string>('');
  
  // Include filters
  const [includeArtists, setIncludeArtists] = useState<Array<{ id: number; name: string }>>([]);
  const [includeArtistsMode, setIncludeArtistsMode] = useState<'any' | 'all'>('any');
  const [includeAlbums, setIncludeAlbums] = useState<string[]>([]);
  const [includeGenres, setIncludeGenres] = useState<string[]>([]);
  const [includeGenresMode, setIncludeGenresMode] = useState<'any' | 'all'>('any');
  const [includeYears, setIncludeYears] = useState<number[]>([]);
  const [includeCountries, setIncludeCountries] = useState<string[]>([]);
  
  // Exclude filters
  const [excludeArtists, setExcludeArtists] = useState<Array<{ id: number; name: string }>>([]);
  const [excludeAlbums, setExcludeAlbums] = useState<string[]>([]);
  const [excludeGenres, setExcludeGenres] = useState<string[]>([]);
  const [excludeYears, setExcludeYears] = useState<number[]>([]);
  const [excludeCountries, setExcludeCountries] = useState<string[]>([]);

  // Artist name resolution
  const [artistNames, setArtistNames] = useState<Map<number, string>>(new Map());

  async function loadPlaylists() {
    if (!token) return;
    try {
      const r = await listSmartPlaylists(token);
      setPlaylists(r.items ?? []);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }

  async function loadPlaylist(id: number) {
    if (!token) return;
    setLoading(true);
    try {
      const r = await getSmartPlaylist(token, id);
      setTracks(r.tracks ?? []);
      setTrackCount(r.trackCount);
      setTruncated(r.truncated);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  // Resolve artist IDs to names - returns a map directly for immediate use
  async function resolveArtistNames(ids: number[]): Promise<Map<number, string>> {
    if (!token || ids.length === 0) return new Map();
    try {
      const r = await suggestSmartPlaylist(token, 'artist', '', ids);
      const newMap = new Map<number, string>();
      for (const item of r.items as Array<{ id: number; name: string }>) {
        newMap.set(item.id, item.name);
      }
      setArtistNames((prev) => new Map([...prev, ...newMap]));
      return newMap;
    } catch {
      return new Map();
    }
  }

  useEffect(() => {
    if (!token) return;
    loadPlaylists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (selectedId != null) loadPlaylist(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, token]);

  function buildFilters(): SmartFilters {
    return {
      include: {
        artists: includeArtists.map((a) => a.id),
        artistsMode: includeArtistsMode,
        albums: includeAlbums,
        genres: includeGenres,
        genresMode: includeGenresMode,
        years: includeYears,
        countries: includeCountries,
      },
      exclude: {
        artists: excludeArtists.map((a) => a.id),
        albums: excludeAlbums,
        genres: excludeGenres,
        years: excludeYears,
        countries: excludeCountries,
      },
      duration: {
        min: editDurationMin ? parseInt(editDurationMin, 10) : null,
        max: editDurationMax ? parseInt(editDurationMax, 10) : null,
      },
      favoriteOnly: editFavoriteOnly,
      maxResults: editMaxResults ? parseInt(editMaxResults, 10) : null,
    };
  }

  async function handleSave() {
    if (!token || !editName.trim()) return;
    setError(null);
    try {
      const filters = buildFilters();
      if (editId != null) {
        await updateSmartPlaylist(token, editId, editName.trim(), editSort, filters);
      } else {
        await createSmartPlaylist(token, editName.trim(), editSort, filters);
      }
      setEditing(false);
      setEditId(null);
      await loadPlaylists();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleDelete(id: number) {
    if (!token || !confirm('Delete this smart playlist?')) return;
    try {
      await deleteSmartPlaylist(token, id);
      if (selectedId === id) {
        setSelectedId(null);
        setTracks([]);
      }
      await loadPlaylists();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }

  async function openEditor(pl?: SmartPlaylist) {
    if (pl) {
      setEditId(pl.id);
      setEditName(pl.name);
      setEditSort(pl.sort || 'random');
      const f = pl.filters || emptyFilters;
      setEditMaxResults(f.maxResults ? String(f.maxResults) : '');
      setEditFavoriteOnly(f.favoriteOnly);
      setEditDurationMin(f.duration?.min ? String(f.duration.min) : '');
      setEditDurationMax(f.duration?.max ? String(f.duration.max) : '');
      
      // Resolve artist names for IDs
      const incArtistIds = f.include?.artists ?? [];
      const excArtistIds = f.exclude?.artists ?? [];
      let resolvedNames = new Map<number, string>();
      if (incArtistIds.length > 0 || excArtistIds.length > 0) {
        resolvedNames = await resolveArtistNames([...incArtistIds, ...excArtistIds]);
      }
      
      setIncludeArtists(incArtistIds.map((id) => ({ id, name: resolvedNames.get(id) || `Artist #${id}` })));
      setIncludeArtistsMode(f.include?.artistsMode || 'any');
      setIncludeAlbums(f.include?.albums ?? []);
      setIncludeGenres(f.include?.genres ?? []);
      setIncludeGenresMode(f.include?.genresMode || 'any');
      setIncludeYears(f.include?.years ?? []);
      setIncludeCountries(f.include?.countries ?? []);
      
      setExcludeArtists(excArtistIds.map((id) => ({ id, name: resolvedNames.get(id) || `Artist #${id}` })));
      setExcludeAlbums(f.exclude?.albums ?? []);
      setExcludeGenres(f.exclude?.genres ?? []);
      setExcludeYears(f.exclude?.years ?? []);
      setExcludeCountries(f.exclude?.countries ?? []);
    } else {
      setEditId(null);
      setEditName('');
      setEditSort('random');
      setEditMaxResults('');
      setEditFavoriteOnly(false);
      setEditDurationMin('');
      setEditDurationMax('');
      setIncludeArtists([]);
      setIncludeArtistsMode('any');
      setIncludeAlbums([]);
      setIncludeGenres([]);
      setIncludeGenresMode('any');
      setIncludeYears([]);
      setIncludeCountries([]);
      setExcludeArtists([]);
      setExcludeAlbums([]);
      setExcludeGenres([]);
      setExcludeYears([]);
      setExcludeCountries([]);
    }
    setEditing(true);
  }

  function playAll() {
    if (tracks.length === 0) return;
    setQueueAndPlay(
      tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist })),
      0
    );
  }

  function shufflePlay() {
    if (tracks.length === 0) return;
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    setQueueAndPlay(
      shuffled.map((t) => ({ id: t.id, title: t.title, artist: t.artist })),
      0
    );
  }

  if (!token) return null;

  const selectedPlaylist = playlists.find((p) => p.id === selectedId);

  // Editor Modal
  if (editing) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">{editId ? 'Edit Smart Playlist' : 'New Smart Playlist'}</h2>
          <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-white text-2xl">×</button>
        </div>

        {error && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">{error}</div>}

        {/* General Settings */}
        <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/30 space-y-4">
          <h3 className="text-lg font-bold text-white">General</h3>
          
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                placeholder="My Smart Playlist"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Sort Order</label>
              <select
                value={editSort}
                onChange={(e) => setEditSort(e.target.value)}
                className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Max Tracks</label>
              <input
                type="number"
                value={editMaxResults}
                onChange={(e) => setEditMaxResults(e.target.value)}
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-white placeholder-slate-400 focus:outline-none text-sm"
                placeholder="500"
                min="1"
                max="2000"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Min Duration (sec)</label>
              <input
                type="number"
                value={editDurationMin}
                onChange={(e) => setEditDurationMin(e.target.value)}
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-white placeholder-slate-400 focus:outline-none text-sm"
                placeholder="0"
                min="0"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Max Duration (sec)</label>
              <input
                type="number"
                value={editDurationMax}
                onChange={(e) => setEditDurationMax(e.target.value)}
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-white placeholder-slate-400 focus:outline-none text-sm"
                placeholder="∞"
                min="0"
              />
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer pt-2">
            <input
              type="checkbox"
              checked={editFavoriteOnly}
              onChange={(e) => setEditFavoriteOnly(e.target.checked)}
              className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500"
            />
            <span className="text-slate-300">Only include favorites</span>
          </label>
        </div>

        {/* Include/Exclude Grid */}
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Include Rules */}
          <div className="bg-emerald-900/20 p-4 rounded-xl border border-emerald-800/50 space-y-4">
            <h3 className="text-lg font-bold text-emerald-400 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Include Rules
            </h3>

            <SmartPicker
              label="Artists"
              kind="artist"
              selected={includeArtists}
              onChange={setIncludeArtists}
              token={token}
              displayFn={(a) => a?.name || `Artist #${a?.id}`}
            />
            <div className="-mt-2">
              <select
                value={includeArtistsMode}
                onChange={(e) => setIncludeArtistsMode(e.target.value as 'any' | 'all')}
                className="text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-300"
              >
                <option value="any">Match ANY artist</option>
                <option value="all">Match ALL artists</option>
              </select>
            </div>

            <SmartPicker
              label="Albums"
              kind="album"
              selected={includeAlbums}
              onChange={setIncludeAlbums}
              token={token}
              displayFn={(a) => String(a)}
              valueKey="value"
            />

            <SmartPicker
              label="Genres"
              kind="genre"
              selected={includeGenres}
              onChange={setIncludeGenres}
              token={token}
              displayFn={(g) => String(g)}
              valueKey="value"
            />
            <div className="-mt-2">
              <select
                value={includeGenresMode}
                onChange={(e) => setIncludeGenresMode(e.target.value as 'any' | 'all')}
                className="text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-300"
              >
                <option value="any">Match ANY genre</option>
                <option value="all">Match ALL genres</option>
              </select>
            </div>

            <SmartPicker
              label="Years"
              kind="year"
              selected={includeYears}
              onChange={setIncludeYears}
              token={token}
              displayFn={(y) => String(y)}
              valueKey="value"
            />

            <SmartPicker
              label="Countries"
              kind="country"
              selected={includeCountries}
              onChange={setIncludeCountries}
              token={token}
              displayFn={(c) => String(c)}
              valueKey="value"
            />
          </div>

          {/* Exclude Rules */}
          <div className="bg-red-900/20 p-4 rounded-xl border border-red-800/50 space-y-4">
            <h3 className="text-lg font-bold text-red-400 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
              Exclude Rules
            </h3>

            <SmartPicker
              label="Artists"
              kind="artist"
              selected={excludeArtists}
              onChange={setExcludeArtists}
              token={token}
              displayFn={(a) => a?.name || `Artist #${a?.id}`}
            />

            <SmartPicker
              label="Albums"
              kind="album"
              selected={excludeAlbums}
              onChange={setExcludeAlbums}
              token={token}
              displayFn={(a) => String(a)}
              valueKey="value"
            />

            <SmartPicker
              label="Genres"
              kind="genre"
              selected={excludeGenres}
              onChange={setExcludeGenres}
              token={token}
              displayFn={(g) => String(g)}
              valueKey="value"
            />

            <SmartPicker
              label="Years"
              kind="year"
              selected={excludeYears}
              onChange={setExcludeYears}
              token={token}
              displayFn={(y) => String(y)}
              valueKey="value"
            />

            <SmartPicker
              label="Countries"
              kind="country"
              selected={excludeCountries}
              onChange={setExcludeCountries}
              token={token}
              displayFn={(c) => String(c)}
              valueKey="value"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={handleSave}
            className="flex-1 px-6 py-3 bg-cyan-500 hover:bg-cyan-400 text-white rounded-xl font-medium transition-colors"
          >
            {editId ? 'Save Changes' : 'Create Playlist'}
          </button>
          <button
            onClick={() => setEditing(false)}
            className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-medium transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Mobile: show detail view when a playlist is selected
  const showDetail = selectedPlaylist !== undefined;

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">{error}</div>
      )}

      {/* Create Button */}
      <button
        onClick={() => openEditor()}
        className="w-full p-4 border-2 border-dashed border-slate-700 hover:border-purple-500/50 rounded-xl text-slate-400 hover:text-purple-400 transition-colors flex items-center justify-center gap-2"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
        Create Smart Playlist
      </button>

      {/* Mobile: show either list or detail, Desktop: show both side by side */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6">
        {/* Playlists List - hide on mobile when detail is shown */}
        <div className={`space-y-3 ${showDetail ? 'hidden lg:block' : ''}`}>
          <h3 className="text-lg font-semibold text-slate-300 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Smart Playlists
          </h3>
          <div className="space-y-2">
            {playlists.map((p) => (
              <div
                key={p.id}
                className={`p-3 sm:p-4 rounded-xl border transition-all duration-200 ${
                  selectedId === p.id
                    ? 'bg-purple-500/20 border-purple-500/50 ring-1 ring-purple-500/30'
                    : 'bg-slate-800/30 border-slate-700/30 hover:bg-slate-800/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setSelectedId(p.id)}
                    className="flex-1 min-w-0 text-left flex items-center gap-3"
                  >
                    <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white truncate">{p.name}</div>
                      <div className="text-sm text-slate-400">
                        {SORT_OPTIONS.find((o) => o.value === p.sort)?.label ?? 'Random'}
                      </div>
                    </div>
                  </button>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => openEditor(p)}
                      className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
                      title="Edit"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {playlists.length === 0 && (
              <div className="text-center py-8 text-slate-400">
                <p>No smart playlists yet</p>
                <p className="text-sm mt-1">Create one to get dynamic playlists</p>
              </div>
            )}
          </div>
        </div>

        {/* Tracks Detail View */}
        <div className={`space-y-4 ${!showDetail ? 'hidden lg:block' : ''}`}>
          {selectedPlaylist ? (
            <>
              {/* Header with back button on mobile */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelectedId(null)}
                  className="lg:hidden p-2 rounded-lg hover:bg-slate-800/50 text-slate-400 hover:text-white transition-colors flex-shrink-0"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg sm:text-xl font-bold text-white truncate">{selectedPlaylist.name}</h3>
                  <p className="text-sm text-slate-400">
                    {trackCount} tracks{truncated && ' (capped)'}
                  </p>
                </div>
                {/* Play buttons */}
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={playAll}
                    disabled={tracks.length === 0}
                    className="p-2 sm:px-4 sm:py-2 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-400 text-white rounded-full sm:rounded-lg font-medium transition-colors flex items-center gap-2"
                  >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    <span className="hidden sm:inline">Play</span>
                  </button>
                  <button
                    onClick={shufflePlay}
                    disabled={tracks.length === 0}
                    className="p-2 sm:px-4 sm:py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-full sm:rounded-lg font-medium transition-colors flex items-center gap-2"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span className="hidden sm:inline">Shuffle</span>
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="w-8 h-8 border-3 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-1 max-h-[60vh] lg:max-h-96 overflow-y-auto">
                  {tracks.map((t, idx) => (
                    <div
                      key={t.id}
                      className="group flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg hover:bg-slate-800/50 transition-colors"
                    >
                      {/* Track number / play button */}
                      <div className="w-8 flex-shrink-0 text-center">
                        <span className="text-sm text-slate-500 sm:group-hover:hidden">{idx + 1}</span>
                        <button
                          onClick={() => props.onPlayTrack?.({ id: t.id, title: t.title, artist: t.artist })}
                          className="sm:hidden sm:group-hover:block text-cyan-400"
                        >
                          <svg className="w-5 h-5 mx-auto" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </button>
                      </div>
                      {/* Track info */}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-white text-sm sm:text-base truncate">{t.title ?? `Track #${t.id}`}</div>
                        <div className="text-xs sm:text-sm text-slate-400 truncate">
                          {[t.artist, t.album].filter(Boolean).join(' • ') || 'Unknown'}
                        </div>
                      </div>
                      {/* Duration */}
                      {t.duration && (
                        <div className="text-xs sm:text-sm text-slate-500 flex-shrink-0">
                          {Math.floor(t.duration / 60)}:{String(t.duration % 60).padStart(2, '0')}
                        </div>
                      )}
                    </div>
                  ))}
                  {tracks.length === 0 && (
                    <div className="text-center py-8 text-slate-400">
                      No matching tracks
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="hidden lg:flex flex-col items-center justify-center h-64 text-slate-400">
              <svg className="w-16 h-16 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <p>Select a smart playlist</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
