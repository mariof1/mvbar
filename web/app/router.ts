'use client';

import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';

/**
 * Modern SPA Router for mvbar
 * 
 * Design principles (like Spotify/YouTube):
 * 1. Player is completely independent of navigation
 * 2. Back/forward buttons work within the app
 * 3. URLs are shareable/bookmarkable
 * 4. Navigation never affects player state
 */

// Route definitions
export type Route = 
  | { type: 'for-you' }
  | { type: 'search' }
  | { type: 'recently-added' }
  | { type: 'browse'; sub?: 'artists' | 'albums' | 'genres' | 'countries' | 'languages' }
  | { type: 'browse-artist'; artistId: number; artistName: string }
  | { type: 'browse-album'; artist: string; album: string; artistId?: number }
  | { type: 'browse-genre'; genre: string }
  | { type: 'browse-country'; country: string }
  | { type: 'browse-language'; language: string }
  | { type: 'playlists'; sub?: 'regular' | 'smart' }
  | { type: 'playlist'; playlistId: string }
  | { type: 'favorites' }
  | { type: 'history' }
  | { type: 'podcasts'; sub?: 'subscriptions' | 'new' }
  | { type: 'podcast'; podcastId: number }
  | { type: 'settings' }
  | { type: 'admin' };

// Router state
interface RouterState {
  route: Route;
  history: Route[];
  historyIndex: number;
  version: number; // Incremented on each route change to force React re-renders
  
  // Navigation methods
  navigate: (route: Route, replace?: boolean) => void;
  back: () => boolean;
  forward: () => boolean;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  
  // Internal method for popstate handler
  _setRoute: (route: Route) => void;
}

// Serialize route to URL hash
function routeToHash(route: Route): string {
  switch (route.type) {
    case 'for-you': return '#/for-you';
    case 'search': return '#/search';
    case 'recently-added': return '#/recently-added';
    case 'browse': return route.sub ? `#/browse/${route.sub}` : '#/browse';
    case 'browse-artist': return `#/browse/artist/${route.artistId}/${encodeURIComponent(route.artistName)}`;
    case 'browse-album': return `#/browse/album/${encodeURIComponent(route.artist)}/${encodeURIComponent(route.album)}${route.artistId ? `?artistId=${route.artistId}` : ''}`;
    case 'browse-genre': return `#/browse/genre/${encodeURIComponent(route.genre)}`;
    case 'browse-country': return `#/browse/country/${encodeURIComponent(route.country)}`;
    case 'browse-language': return `#/browse/language/${encodeURIComponent(route.language)}`;
    case 'playlists': return route.sub ? `#/playlists/${route.sub}` : '#/playlists';
    case 'playlist': return `#/playlist/${route.playlistId}`;
    case 'favorites': return '#/favorites';
    case 'history': return '#/history';
    case 'podcasts': return route.sub ? `#/podcasts/${route.sub}` : '#/podcasts';
    case 'podcast': return `#/podcast/${route.podcastId}`;
    case 'settings': return '#/settings';
    case 'admin': return '#/admin';
    default: return '#/search';
  }
}

// Parse URL hash to route
function hashToRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const parts = path.split('/').map(p => decodeURIComponent(p));
  const query = new URLSearchParams(hash.split('?')[1] || '');
  
  if (!path || path === 'search') return { type: 'search' };
  if (path === 'for-you') return { type: 'for-you' };
  if (path === 'recently-added') return { type: 'recently-added' };
  if (path === 'favorites') return { type: 'favorites' };
  if (path === 'history') return { type: 'history' };
  if (path === 'settings') return { type: 'settings' };
  if (path === 'admin') return { type: 'admin' };
  
  // Browse routes
  if (parts[0] === 'browse') {
    if (parts[1] === 'artist' && parts[2]) {
      return { type: 'browse-artist', artistId: parseInt(parts[2], 10), artistName: parts[3] || '' };
    }
    if (parts[1] === 'album' && parts[2] && parts[3]) {
      const artistId = query.get('artistId');
      return { type: 'browse-album', artist: parts[2], album: parts[3].split('?')[0], artistId: artistId ? parseInt(artistId, 10) : undefined };
    }
    if (parts[1] === 'genre' && parts[2]) {
      return { type: 'browse-genre', genre: parts[2] };
    }
    if (parts[1] === 'country' && parts[2]) {
      return { type: 'browse-country', country: parts[2] };
    }
    if (parts[1] === 'language' && parts[2]) {
      return { type: 'browse-language', language: parts[2] };
    }
    if (parts[1] === 'artists' || parts[1] === 'albums' || parts[1] === 'genres' || parts[1] === 'countries' || parts[1] === 'languages') {
      return { type: 'browse', sub: parts[1] };
    }
    return { type: 'browse' };
  }
  
  // Playlist routes
  if (parts[0] === 'playlists') {
    if (parts[1] === 'regular' || parts[1] === 'smart') {
      return { type: 'playlists', sub: parts[1] };
    }
    return { type: 'playlists' };
  }
  if (parts[0] === 'playlist' && parts[1]) {
    return { type: 'playlist', playlistId: parts[1] };
  }
  
  // Podcast routes
  if (parts[0] === 'podcasts') {
    if (parts[1] === 'subscriptions' || parts[1] === 'new') {
      return { type: 'podcasts', sub: parts[1] };
    }
    return { type: 'podcasts' };
  }
  if (parts[0] === 'podcast' && parts[1]) {
    return { type: 'podcast', podcastId: parseInt(parts[1], 10) };
  }
  
  return { type: 'search' };
}

// Get initial route from URL or localStorage
function getInitialRoute(): Route {
  if (typeof window === 'undefined') return { type: 'search' };
  
  // Try URL hash first
  if (window.location.hash) {
    return hashToRoute(window.location.hash);
  }
  
  // Fall back to localStorage
  const saved = window.localStorage.getItem('mvbar_route');
  if (saved) {
    try {
      return JSON.parse(saved) as Route;
    } catch {
      // Invalid saved route
    }
  }
  
  // Default
  return { type: 'search' };
}

// Create the router store
export const useRouter = create<RouterState>((set, get) => ({
  route: { type: 'search' },
  history: [{ type: 'search' }],
  historyIndex: 0,
  version: 0,
  
  navigate: (route, replace = false) => {
    const state = get();
    
    // Update URL
    if (typeof window !== 'undefined') {
      const hash = routeToHash(route);
      if (replace) {
        window.history.replaceState({ route, mvbar: true }, '', hash);
      } else {
        window.history.pushState({ route, mvbar: true }, '', hash);
      }
      
      // Save to localStorage for persistence
      window.localStorage.setItem('mvbar_route', JSON.stringify(route));
    }
    
    if (replace) {
      // Replace current history entry
      const newHistory = [...state.history];
      newHistory[state.historyIndex] = route;
      set({ route, history: newHistory, version: state.version + 1 });
    } else {
      // Add to history, truncating any forward history
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(route);
      set({ 
        route, 
        history: newHistory, 
        historyIndex: newHistory.length - 1,
        version: state.version + 1
      });
    }
  },
  
  back: () => {
    const state = get();
    if (state.historyIndex <= 0) return false;
    
    const newIndex = state.historyIndex - 1;
    const route = state.history[newIndex];
    
    if (typeof window !== 'undefined') {
      window.history.back();
    }
    
    set({ route, historyIndex: newIndex, version: state.version + 1 });
    return true;
  },
  
  forward: () => {
    const state = get();
    if (state.historyIndex >= state.history.length - 1) return false;
    
    const newIndex = state.historyIndex + 1;
    const route = state.history[newIndex];
    
    if (typeof window !== 'undefined') {
      window.history.forward();
    }
    
    set({ route, historyIndex: newIndex, version: state.version + 1 });
    return true;
  },
  
  canGoBack: () => get().historyIndex > 0,
  canGoForward: () => get().historyIndex < get().history.length - 1,
  
  // Internal method for popstate - uses set() to ensure proper reactivity
  _setRoute: (newRoute) => {
    const state = get();
    
    // Find the route in our history
    const idx = state.history.findIndex(r => 
      JSON.stringify(r) === JSON.stringify(newRoute)
    );
    
    if (idx >= 0) {
      set({ route: { ...newRoute }, historyIndex: idx, version: state.version + 1 });
    } else {
      set({ 
        route: { ...newRoute }, 
        history: [...state.history, { ...newRoute }],
        historyIndex: state.history.length,
        version: state.version + 1
      });
    }
    
    // Save to localStorage
    window.localStorage.setItem('mvbar_route', JSON.stringify(newRoute));
  },
}));

// Initialize router from URL/storage and set up listeners
let initialized = false;
export function initRouter() {
  if (typeof window === 'undefined' || initialized) return;
  initialized = true;
  
  // Use a small delay to ensure hash is available after hydration
  const doInit = () => {
    const initialRoute = getInitialRoute();
    const hash = routeToHash(initialRoute);
    
    console.log('[Router] Initializing with hash:', window.location.hash, '-> route:', initialRoute);
    
    window.history.replaceState({ route: initialRoute, mvbar: true }, '', hash);
    useRouter.setState({ 
      route: initialRoute, 
      history: [initialRoute], 
      historyIndex: 0 
    });
    
    // Listen for browser back/forward
    window.addEventListener('popstate', (e) => {
      // Always parse the current URL hash to get the route
      // This ensures we sync with the actual browser URL
      const currentHash = window.location.hash;
      const route = hashToRoute(currentHash);
      
      const currentState = useRouter.getState();
      
      // Check if route actually changed
      if (JSON.stringify(route) !== JSON.stringify(currentState.route)) {
        // Use the internal _setRoute method to ensure proper zustand reactivity
        useRouter.getState()._setRoute(route);
      }
    });
  };
  
  // Check if hash is available, if not wait a tick
  if (window.location.hash) {
    doInit();
  } else {
    // Wait for next frame to ensure URL is fully parsed
    requestAnimationFrame(doInit);
  }
}

// Helper to get the main "tab" from a route (for sidebar highlighting)
export function getTabFromRoute(route: Route): string {
  switch (route.type) {
    case 'for-you': return 'for-you';
    case 'search': return 'search';
    case 'recently-added': return 'recently-added';
    case 'browse':
    case 'browse-artist':
    case 'browse-album':
    case 'browse-genre':
    case 'browse-country':
    case 'browse-language':
      return 'browse';
    case 'playlists':
    case 'playlist':
      return 'playlists';
    case 'favorites': return 'favorites';
    case 'history': return 'history';
    case 'podcasts':
    case 'podcast':
      return 'podcasts';
    case 'settings': return 'settings';
    case 'admin': return 'admin';
    default: return 'search';
  }
}

// Type guard helpers
export function isBrowseRoute(route: Route): route is Route & { type: 'browse' | 'browse-artist' | 'browse-album' | 'browse-genre' | 'browse-country' | 'browse-language' } {
  return route.type.startsWith('browse');
}

export function isPodcastRoute(route: Route): route is Route & { type: 'podcasts' | 'podcast' } {
  return route.type === 'podcasts' || route.type === 'podcast';
}

export function isPlaylistRoute(route: Route): route is Route & { type: 'playlists' | 'playlist' } {
  return route.type === 'playlists' || route.type === 'playlist';
}

// Helper hook to get route with proper shallow comparison for reactivity
export function useRoute(): Route {
  // Subscribe to version to ensure re-renders on route changes
  // The version changes whenever route changes
  useRouter((s) => s.version);
  // Get the current route
  return useRouter.getState().route;
}
