'use client';

import { useRouter } from './router';

/**
 * Navigation header with back/forward buttons
 * Like Spotify/YouTube navigation controls
 */
export function NavigationHeader({ className = '' }: { className?: string }) {
  const { back, forward, canGoBack, canGoForward } = useRouter();
  
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button
        onClick={() => back()}
        disabled={!canGoBack()}
        className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/60 transition-colors"
        title="Go back"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <button
        onClick={() => forward()}
        disabled={!canGoForward()}
        className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/60 transition-colors"
        title="Go forward"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Back button that navigates to a specific route or goes back in history
 */
export function BackButton({ 
  onClick, 
  label = 'Back',
  className = '' 
}: { 
  onClick?: () => void;
  label?: string;
  className?: string;
}) {
  const { back, canGoBack } = useRouter();
  
  const handleClick = () => {
    if (onClick) {
      onClick();
    } else if (canGoBack()) {
      back();
    }
  };
  
  return (
    <button
      onClick={handleClick}
      className={`flex items-center gap-2 text-white/70 hover:text-white transition-colors ${className}`}
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
