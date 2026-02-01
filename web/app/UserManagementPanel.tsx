'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  adminCreateUser,
  adminDeleteUser,
  adminForceLogout,
  adminResetPassword,
  adminSetUserRole,
  listAdminUsers
} from './apiClient';
import { useAuth } from './store';

export function UserManagementPanel() {
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const isAdmin = user?.role === 'admin';

  const [users, setUsers] = useState<Array<{ id: string; email: string; role: string }>>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  const [resetPassword, setResetPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) ?? null, [users, selectedUserId]);

  async function refresh() {
    if (!token || !isAdmin) return;
    setError(null);
    setNotice(null);
    try {
      const r = await listAdminUsers(token);
      setUsers(r.users);
      const first = selectedUserId || r.users[0]?.id || '';
      setSelectedUserId(first);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAdmin]);

  async function createUser() {
    if (!token) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const r = await adminCreateUser(token, { email: newEmail, password: newPassword, role: newIsAdmin ? 'admin' : 'user' });
      setNotice(`Created user: ${r.user.email}`);
      setNewEmail('');
      setNewPassword('');
      setNewIsAdmin(false);
      await refresh();
      setSelectedUserId(r.user.id);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function setRole(role: 'admin' | 'user') {
    if (!token || !selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminSetUserRole(token, selectedUser.id, role);
      setNotice(`Updated role: ${selectedUser.email} → ${role}`);
      await refresh();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function doResetPassword() {
    if (!token || !selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminResetPassword(token, selectedUser.id, resetPassword);
      setResetPassword('');
      setNotice(`Password reset + user logged out: ${selectedUser.email}`);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function forceLogout() {
    if (!token || !selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminForceLogout(token, selectedUser.id);
      setNotice(`Forced logout: ${selectedUser.email}`);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function deleteUser() {
    if (!token || !selectedUser) return;
    const ok = confirm(`Delete user ${selectedUser.email}? This cannot be undone.`);
    if (!ok) return;

    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminDeleteUser(token, selectedUser.id);
      setNotice(`Deleted user: ${selectedUser.email}`);
      setSelectedUserId('');
      await refresh();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  if (!token || !isAdmin) return null;

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
      <h2>Users</h2>

      <div style={{ display: 'grid', gap: 8, padding: 12, border: '1px solid #333', borderRadius: 10, background: '#0d0d0d' }}>
        <div style={{ fontWeight: 700 }}>Create user</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input
            placeholder="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            style={{ padding: 10 }}
          />
          <input
            placeholder="password (min 8 chars)"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            style={{ padding: 10 }}
          />
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, opacity: 0.9 }}>
          <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin(e.target.checked)} />
          Make admin
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={createUser} disabled={loading || !newEmail.trim() || newPassword.length < 8} style={{ padding: 10 }}>
            Create
          </button>
          <button onClick={refresh} disabled={loading} style={{ padding: 10, opacity: 0.85 }}>
            Refresh
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <label style={{ fontSize: 13, opacity: 0.85 }}>Select user</label>
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #333', background: '#0d0d0d', color: '#eee' }}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email} ({u.role})
            </option>
          ))}
        </select>
      </div>

      {selectedUser ? (
        <div style={{ display: 'grid', gap: 10, padding: 12, border: '1px solid #333', borderRadius: 10, background: '#0d0d0d' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
            <div>
              <div style={{ fontWeight: 800 }}>{selectedUser.email}</div>
              <div style={{ opacity: 0.75, fontSize: 12 }}>id: {selectedUser.id}</div>
            </div>
            <div style={{ opacity: 0.8, fontSize: 13 }}>role: {selectedUser.role}</div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button onClick={() => setRole('admin')} disabled={loading || selectedUser.role === 'admin'} style={{ padding: 10 }}>
              Make admin
            </button>
            <button onClick={() => setRole('user')} disabled={loading || selectedUser.role === 'user'} style={{ padding: 10, opacity: 0.9 }}>
              Remove admin
            </button>
            <button onClick={forceLogout} disabled={loading} style={{ padding: 10, opacity: 0.9 }}>
              Force logout
            </button>
            <button onClick={deleteUser} disabled={loading} style={{ padding: 10, background: '#2a0f0f', border: '1px solid #5a1b1b' }}>
              Delete user
            </button>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontWeight: 700 }}>Reset password</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                placeholder="new password (min 8 chars)"
                type="password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                style={{ padding: 10, minWidth: 260 }}
              />
              <button onClick={doResetPassword} disabled={loading} style={{ padding: 10 }}>
                Reset
              </button>
            </div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>Resetting password also logs the user out everywhere.</div>
          </div>
        </div>
      ) : null}

      {notice ? <p style={{ color: '#7dffb0' }}>{notice}</p> : null}
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
    </div>
  );
}
