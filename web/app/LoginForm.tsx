'use client';

import { useState, useEffect } from 'react';
import { login, me, apiFetch } from './apiClient';
import { useAuth } from './store';

export function LoginForm() {
  const setAuth = useAuth((s) => s.setAuth);
  const clear = useAuth((s) => s.clear);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [isPending, setIsPending] = useState(false);

  // Check if Google OAuth is enabled and handle URL params
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/auth/google/enabled', { method: 'GET' });
        setGoogleEnabled(r.enabled);
      } catch {
        setGoogleEnabled(false);
      }
    })();

    // Check URL params for OAuth results
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('pending') === 'true') {
        setIsPending(true);
      }
      if (params.get('error')) {
        const errorCode = params.get('error');
        const errorMessages: Record<string, string> = {
          'google_auth_cancelled': 'Google sign-in was cancelled',
          'google_auth_no_code': 'Google sign-in failed - no authorization code',
          'google_auth_no_email': 'Google account has no email address',
          'google_auth_failed': 'Google sign-in failed',
          'admin_cannot_use_google': 'Admin accounts cannot use Google sign-in',
          'account_rejected': 'Your account has been rejected by an administrator',
        };
        setError(errorMessages[errorCode!] || 'Sign-in failed');
      }
      // Clean up URL
      if (params.get('pending') || params.get('error')) {
        window.history.replaceState({}, '', '/');
      }
    }
  }, []);

  async function handleLogin() {
    setError(null);
    setLoading(true);
    try {
      const r = await login(email, password);
      if (!r.ok) throw new Error('login failed');
      const m = await me();
      if (!m.ok || !m.user) throw new Error('login cookie missing');
      setAuth(m.user);
    } catch (e: any) {
      clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleLogin();
  };

  const handleGoogleSignIn = () => {
    window.location.href = '/api/auth/google';
  };

  // Show pending approval message
  if (isPending) {
    return (
      <div className="text-center space-y-4">
        <div className="w-16 h-16 mx-auto bg-yellow-500/20 rounded-full flex items-center justify-center">
          <svg className="w-8 h-8 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-white">Waiting for Approval</h2>
        <p className="text-white/70">
          Your account has been created and is awaiting administrator approval.
          Please check back later.
        </p>
        <button
          onClick={() => setIsPending(false)}
          className="text-cyan-400 hover:text-cyan-300 text-sm"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <h2 className="text-xl font-semibold text-white mb-6">Sign in</h2>
        <div>
          <label className="block text-sm font-medium text-white/70 mb-2">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition"
            placeholder="you@example.com"
            autoComplete="username"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-white/70 mb-2">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition"
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 px-4 bg-cyan-500 hover:bg-cyan-400 disabled:bg-cyan-500/50 text-black font-semibold rounded-lg transition-colors"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        {error && (
          <p className="text-red-400 text-sm text-center">{error}</p>
        )}
      </form>

      {googleEnabled && (
        <>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/20"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-slate-900 text-white/50">or</span>
            </div>
          </div>

          <button
            onClick={handleGoogleSignIn}
            className="w-full py-3 px-4 bg-white hover:bg-gray-100 text-gray-700 font-medium rounded-lg transition-colors flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Continue with Google
          </button>
        </>
      )}
    </div>
  );
}
