'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { sendAiChat, AiChatMessage, AiToolResult } from './apiClient';
import { usePreferences } from './preferencesStore';

interface AiChatProps {
  isOpen: boolean;
  onClose: () => void;
  token: string;
  onPlay?: (tracks: Array<{ id: number; title: string | null; artist: string | null }>) => void;
  onAddToQueue?: (tracks: Array<{ id: number; title: string | null; artist: string | null }>) => void;
}

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  toolResults?: AiToolResult[];
}

function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function TrackCard({ track, onPlay, onQueue }: {
  track: { id: number; title: string; artist: string; album?: string; duration_ms?: number };
  onPlay?: () => void;
  onQueue?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg bg-slate-700/50 hover:bg-slate-700 transition-colors group">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{track.title || 'Untitled'}</div>
        <div className="text-xs text-slate-400 truncate">
          {track.artist || 'Unknown'}{track.album ? ` · ${track.album}` : ''}
          {track.duration_ms ? ` · ${formatDuration(track.duration_ms)}` : ''}
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {onPlay && (
          <button
            onClick={onPlay}
            className="p-1.5 rounded-md bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-400 transition-colors"
            title="Play"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}
        {onQueue && (
          <button
            onClick={onQueue}
            className="p-1.5 rounded-md bg-slate-600/50 hover:bg-slate-600 text-slate-300 transition-colors"
            title="Add to queue"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function ToolResultCards({ result, onPlay, onQueue }: {
  result: AiToolResult;
  onPlay?: (tracks: Array<{ id: number; title: string | null; artist: string | null }>) => void;
  onQueue?: (tracks: Array<{ id: number; title: string | null; artist: string | null }>) => void;
}) {
  const tracks = result.result?.tracks || [];
  if (tracks.length === 0 && !result.result?.playlist) return null;

  const mappedTracks = tracks.map(t => ({ id: t.id, title: t.title || null, artist: t.artist || null }));

  return (
    <div className="mt-2 space-y-1">
      {/* Bulk actions */}
      {tracks.length > 1 && (
        <div className="flex gap-2 mb-2">
          {(result.result?.action === 'play' || result.tool === 'search_tracks') && onPlay && (
            <button
              onClick={() => onPlay(mappedTracks)}
              className="px-3 py-1.5 text-xs rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              Play All ({tracks.length})
            </button>
          )}
          {onQueue && (
            <button
              onClick={() => onQueue(mappedTracks)}
              className="px-3 py-1.5 text-xs rounded-md bg-slate-600/50 hover:bg-slate-600 text-slate-300 transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Queue All
            </button>
          )}
        </div>
      )}

      {/* Track list */}
      {tracks.map(t => (
        <TrackCard
          key={t.id}
          track={t}
          onPlay={onPlay ? () => onPlay([{ id: t.id, title: t.title || null, artist: t.artist || null }]) : undefined}
          onQueue={onQueue ? () => onQueue([{ id: t.id, title: t.title || null, artist: t.artist || null }]) : undefined}
        />
      ))}

      {/* Playlist created */}
      {result.result?.playlist && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
          ✓ Playlist &quot;{result.result.playlist.name}&quot; created with {result.result.playlist.track_count} tracks
        </div>
      )}
    </div>
  );
}

export default function AiChat({ isOpen, onClose, token, onPlay, onAddToQueue }: AiChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { openrouterConfigured } = usePreferences();

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isOpen]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: DisplayMessage = { role: 'user', content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    try {
      const chatHistory: AiChatMessage[] = updatedMessages.map(m => ({
        role: m.role,
        content: m.content,
      }));

      const res = await sendAiChat(token, chatHistory);

      if (res.ok) {
        const assistantMsg: DisplayMessage = {
          role: 'assistant',
          content: res.response,
          toolResults: res.toolResults,
        };
        setMessages(prev => [...prev, assistantMsg]);

        // Auto-execute play/queue actions
        for (const tr of res.toolResults) {
          const tracks = tr.result?.tracks?.map(t => ({ id: t.id, title: t.title || null, artist: t.artist || null })) || [];
          if (tr.result?.action === 'play' && tracks.length > 0 && onPlay) {
            onPlay(tracks);
          } else if (tr.result?.action === 'queue' && tracks.length > 0 && onAddToQueue) {
            for (const t of tracks) onAddToQueue([t]);
          }
        }
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: res.error || 'Something went wrong. Please try again.',
        }]);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error && 'data' in err
        ? (err as { data?: { error?: string } }).data?.error || 'Failed to reach AI service'
        : 'Failed to reach AI service';
      setMessages(prev => [...prev, { role: 'assistant', content: errMsg }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, token, onPlay, onAddToQueue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-2xl h-[80vh] max-h-[700px] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/50">
          <div className="flex items-center gap-2">
            <span className="text-lg">✨</span>
            <h2 className="text-white font-semibold">AI Music Assistant</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
          {!openrouterConfigured ? (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
              <div className="text-4xl">🔑</div>
              <div className="text-white font-medium">API Key Required</div>
              <div className="text-slate-400 text-sm max-w-sm">
                To use the AI assistant, add your OpenRouter API key in{' '}
                <span className="text-cyan-400">Settings → Integrations</span>.
              </div>
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 text-sm underline"
              >
                Get a free OpenRouter key →
              </a>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
              <div className="text-4xl">✨</div>
              <div className="text-white font-medium">What would you like to listen to?</div>
              <div className="text-slate-400 text-sm max-w-sm">
                Try things like &quot;Play some jazz&quot;, &quot;Queue chill songs&quot;, or &quot;Create a workout playlist&quot;.
              </div>
              <div className="flex flex-wrap gap-2 justify-center mt-2">
                {['Play something chill', 'Find some rock music', 'Create a dinner party playlist'].map(s => (
                  <button
                    key={s}
                    onClick={() => { setInput(s); setTimeout(() => inputRef.current?.focus(), 0); }}
                    className="px-3 py-1.5 text-xs rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] ${msg.role === 'user'
                  ? 'bg-cyan-600/30 text-white rounded-2xl rounded-br-md px-4 py-2.5'
                  : 'text-slate-200'
                }`}>
                  {msg.role === 'assistant' && (
                    <div className="flex items-start gap-2">
                      <span className="text-sm mt-0.5 shrink-0">✨</span>
                      <div className="min-w-0">
                        <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
                        {msg.toolResults?.map((tr, j) => (
                          <ToolResultCards key={j} result={tr} onPlay={onPlay} onQueue={onAddToQueue} />
                        ))}
                      </div>
                    </div>
                  )}
                  {msg.role === 'user' && (
                    <div className="text-sm">{msg.content}</div>
                  )}
                </div>
              </div>
            ))
          )}

          {loading && (
            <div className="flex items-start gap-2">
              <span className="text-sm mt-0.5">✨</span>
              <div className="flex gap-1 py-2">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        {openrouterConfigured && (
          <div className="border-t border-slate-700/50 p-4">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your music..."
                disabled={loading}
                className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                className="px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
            </div>
            <div className="text-xs text-slate-500 mt-2 text-center">
              Powered by OpenRouter · Ctrl+J to toggle
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
