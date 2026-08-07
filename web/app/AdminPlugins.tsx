'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  configureAdminPlugin,
  deleteAdminPlugin,
  listAdminPluginRuns,
  listAdminPlugins,
  rescanAdminPlugins,
  runAdminPluginAction,
  setAdminPluginEnabled,
  testAdminPlugin,
  uploadAdminPlugin,
  type AdminPlugin,
  type AdminPluginAction,
  type AdminPluginRun,
  type PluginSchemaProperty,
} from './apiClient';
import { showConfirm } from './ConfirmModal';
import { useToastStore } from './Toast';
import { usePluginUpdates } from './useWebSocket';

function readableBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function errorText(error: unknown) {
  const value = error as { data?: { error?: string }; message?: string };
  return value?.data?.error || value?.message || 'Plugin operation failed';
}

function SchemaField({
  name,
  property,
  value,
  configuredSecret = false,
  onChange,
}: {
  name: string;
  property: PluginSchemaProperty;
  value: unknown;
  configuredSecret?: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = property.title || name;
  if (property.type === 'boolean') {
    return (
      <label className="flex items-start gap-3 rounded-lg border border-slate-700/50 bg-slate-950/30 px-3 py-3">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-cyan-500"
        />
        <span>
          <span className="block text-sm font-medium text-slate-200">{label}</span>
          {property.description && <span className="mt-1 block text-xs text-slate-500">{property.description}</span>}
        </span>
      </label>
    );
  }

  const baseClass = 'w-full rounded-lg border border-slate-600 bg-slate-950/50 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-cyan-500';
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-200">{label}</span>
      {property.enum ? (
        <select
          value={JSON.stringify(value ?? '')}
          onChange={(event) => onChange(JSON.parse(event.target.value))}
          className={baseClass}
        >
          {property.enum.map((option) => (
            <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{String(option)}</option>
          ))}
        </select>
      ) : (
        <input
          type={property.format === 'password' || configuredSecret ? 'password' : property.type === 'integer' || property.type === 'number' ? 'number' : 'text'}
          min={property.minimum}
          max={property.maximum}
          step={property.type === 'integer' ? 1 : property.type === 'number' ? 'any' : undefined}
          value={typeof value === 'string' || typeof value === 'number' ? value : ''}
          placeholder={configuredSecret && !value ? 'Saved — leave blank to keep it' : undefined}
          onChange={(event) => {
            if (property.type === 'integer' || property.type === 'number') {
              onChange(event.target.value === '' ? '' : Number(event.target.value));
            } else {
              onChange(event.target.value);
            }
          }}
          className={baseClass}
        />
      )}
      {property.description && <span className="mt-1.5 block text-xs text-slate-500">{property.description}</span>}
    </label>
  );
}

function PluginActionPanel({ token, plugin, action }: { token: string; plugin: AdminPlugin; action: AdminPluginAction }) {
  const defaults = useMemo(() => Object.fromEntries(
    Object.entries(action.inputSchema?.properties ?? {}).map(([key, property]) => [key, property.default ?? (property.type === 'boolean' ? false : '')])
  ), [action]);
  const [input, setInput] = useState<Record<string, unknown>>(defaults);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const result = await runAdminPluginAction(token, plugin.id, action.id, input);
      setOutput(result.output);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h5 className="font-medium text-violet-200">{action.name}</h5>
          {action.description && <p className="mt-1 text-xs text-slate-400">{action.description}</p>}
        </div>
        <button
          onClick={() => void run()}
          disabled={running || !plugin.enabled}
          className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
        >
          {running ? 'Running…' : 'Run action'}
        </button>
      </div>
      {Object.entries(action.inputSchema?.properties ?? {}).length > 0 && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {Object.entries(action.inputSchema?.properties ?? {}).map(([key, property]) => (
            <SchemaField key={key} name={key} property={property} value={input[key]} onChange={(value) => setInput((current) => ({ ...current, [key]: value }))} />
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {output !== null && <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-black/30 p-3 text-xs text-slate-300">{JSON.stringify(output, null, 2)}</pre>}
    </div>
  );
}
function PluginCard({ token, plugin, refresh }: { token: string; plugin: AdminPlugin; refresh: () => Promise<void> }) {
  const showToast = useToastStore((state) => state.show);
  const defaults = useMemo(() => Object.fromEntries(
    Object.entries(plugin.configSchema?.properties ?? {}).map(([key, property]) => [key, plugin.config[key] ?? property.default ?? (property.type === 'boolean' ? false : '')])
  ), [plugin]);
  const [config, setConfig] = useState<Record<string, unknown>>(defaults);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<AdminPluginRun[] | null>(null);

  useEffect(() => setConfig(defaults), [defaults]);

  async function saveConfig() {
    setBusy('config');
    setError(null);
    try {
      await configureAdminPlugin(token, plugin.id, config);
      showToast(`${plugin.name} configuration saved`, 'success', 'top-right');
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled() {
    if (!plugin.enabled) {
      const permissionText = plugin.permissions.length
        ? plugin.permissions.map((permission) => `${permission.key}${permission.detail ? ` (${permission.detail})` : ''}`).join(', ')
        : 'No host permissions requested';
      const confirmed = await showConfirm({
        title: `Enable ${plugin.name}?`,
        message: `This runs third-party WebAssembly code with these declared permissions: ${permissionText}.`,
        confirmLabel: 'Approve and enable',
      });
      if (!confirmed) return;
    }
    setBusy('enabled');
    setError(null);
    try {
      await setAdminPluginEnabled(token, plugin, !plugin.enabled);
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function validate() {
    setBusy('test');
    setError(null);
    try {
      const result = await testAdminPlugin(token, plugin.id);
      showToast(`${plugin.name} loaded successfully (${result.exports.length} exports)`, 'success', 'top-right');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function toggleRuns() {
    if (runs !== null) {
      setRuns(null);
      return;
    }
    setBusy('runs');
    try {
      setRuns((await listAdminPluginRuns(token, plugin.id)).runs);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const confirmed = await showConfirm({
      title: `Remove ${plugin.name}?`,
      message: 'The package, isolated plugin files, configuration, and plugin-owned KV data will be removed. Your MVBar library and users are not changed.',
      confirmLabel: 'Remove plugin',
      danger: true,
    });
    if (!confirmed) return;
    setBusy('remove');
    try {
      await deleteAdminPlugin(token, plugin.id);
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(null);
    }
  }

  return (
    <article className="rounded-2xl border border-slate-700/50 bg-slate-800/30 p-5 shadow-lg shadow-black/10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-white">{plugin.name}</h3>
            <span className="rounded-full bg-slate-700/70 px-2 py-0.5 text-xs text-slate-300">v{plugin.version}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${plugin.enabled ? 'bg-emerald-500/15 text-emerald-300' : plugin.present ? 'bg-slate-600/40 text-slate-300' : 'bg-red-500/15 text-red-300'}`}>
              {plugin.enabled ? 'Enabled' : plugin.present ? 'Disabled' : 'Missing package'}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">by {plugin.author} · <span className="font-mono text-xs">{plugin.id}</span></p>
          {plugin.description && <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">{plugin.description}</p>}
          {plugin.homepage && <a href={plugin.homepage} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-cyan-400 hover:underline">Plugin homepage ↗</a>}
        </div>
        <button
          onClick={() => void toggleEnabled()}
          disabled={Boolean(busy) || !plugin.present}
          className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40 ${plugin.enabled ? 'bg-slate-600 hover:bg-slate-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
        >
          {busy === 'enabled' ? 'Checking…' : plugin.enabled ? 'Disable' : 'Review & enable'}
        </button>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-700/40 bg-slate-950/20 p-4">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Requested permissions</h4>
          {plugin.permissions.length === 0 ? <p className="mt-3 text-sm text-slate-500">No MVBar host permissions requested.</p> : (
            <div className="mt-3 space-y-2">
              {plugin.permissions.map((permission) => (
                <div key={permission.key} className={`rounded-lg border px-3 py-2 ${permission.broad ? 'border-amber-500/30 bg-amber-500/10' : permission.supported ? 'border-slate-700/50 bg-slate-900/30' : 'border-red-500/30 bg-red-500/10'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-slate-200">{permission.key}</span>
                    {!permission.supported && <span className="text-xs text-red-300">not granted by MVBar</span>}
                    {permission.broad && <span className="text-xs text-amber-300">broad access</span>}
                  </div>
                  {permission.reason && <p className="mt-1 text-xs text-slate-400">{permission.reason}</p>}
                  {permission.detail && <p className="mt-1 text-xs text-slate-500">{permission.detail}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-700/40 bg-slate-950/20 p-4">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Runtime</h4>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
            <dt className="text-slate-500">Package</dt><dd className="truncate font-mono text-slate-300">{plugin.filename}</dd>
            <dt className="text-slate-500">SHA-256</dt><dd className="truncate font-mono text-slate-300" title={plugin.packageSha256}>{plugin.packageSha256.slice(0, 16)}…</dd>
            <dt className="text-slate-500">Exports</dt><dd className="text-slate-300">{plugin.exports.length}</dd>
            <dt className="text-slate-500">Last call</dt><dd className="text-slate-300">{plugin.lastLoadedAt ? new Date(plugin.lastLoadedAt).toLocaleString() : 'Never'}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void validate()} disabled={Boolean(busy) || !plugin.present} className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40">{busy === 'test' ? 'Loading…' : 'Validate package'}</button>
            <button onClick={() => void toggleRuns()} disabled={Boolean(busy)} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/50 disabled:opacity-40">{runs === null ? 'Recent runs' : 'Hide runs'}</button>
            <button onClick={() => void remove()} disabled={Boolean(busy)} className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 hover:bg-red-500/20 disabled:opacity-40">{busy === 'remove' ? 'Removing…' : 'Remove'}</button>
          </div>
        </section>
      </div>

      {plugin.configSchema && Object.keys(plugin.configSchema.properties ?? {}).length > 0 && (
        <section className="mt-5 rounded-xl border border-slate-700/40 bg-slate-950/20 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h4 className="font-semibold text-white">Configuration</h4><p className="mt-1 text-xs text-slate-500">Secrets are stored server-side and are never returned to the browser.</p></div>
            <button onClick={() => void saveConfig()} disabled={Boolean(busy)} className="rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-40">{busy === 'config' ? 'Saving…' : 'Save configuration'}</button>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {Object.entries(plugin.configSchema.properties ?? {}).map(([key, property]) => (
              <SchemaField
                key={key}
                name={key}
                property={property}
                value={config[key]}
                configuredSecret={plugin.configuredSecrets.includes(key)}
                onChange={(value) => setConfig((current) => ({ ...current, [key]: value }))}
              />
            ))}
          </div>
        </section>
      )}

      {plugin.actions.length > 0 && (
        <section className="mt-5 space-y-3">
          <div><h4 className="font-semibold text-white">Admin actions</h4><p className="mt-1 text-xs text-slate-500">Actions run only when an administrator invokes them.</p></div>
          {plugin.actions.map((action) => <PluginActionPanel key={action.id} token={token} plugin={plugin} action={action} />)}
        </section>
      )}

      {runs !== null && (
        <section className="mt-5 rounded-xl border border-slate-700/40 bg-black/20 p-4">
          <h4 className="font-semibold text-white">Recent plugin calls</h4>
          {runs.length === 0 ? <p className="mt-3 text-sm text-slate-500">No calls recorded yet.</p> : (
            <div className="mt-3 max-h-80 space-y-2 overflow-auto">
              {runs.map((run) => (
                <div key={run.id} className="rounded-lg border border-slate-700/40 bg-slate-900/40 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-slate-300">{run.export_name}</span><span className={run.ok ? 'text-emerald-400' : 'text-red-400'}>{run.ok ? 'OK' : 'Failed'} · {run.duration_ms} ms</span></div>
                  <div className="mt-1 text-slate-500">{new Date(run.created_at).toLocaleString()}</div>
                  {run.error && <div className="mt-2 text-red-300">{run.error}</div>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {(error || plugin.lastError) && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error || plugin.lastError}</div>}
    </article>
  );
}

export function AdminPlugins({ token }: { token: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [plugins, setPlugins] = useState<AdminPlugin[]>([]);
  const [executionEnabled, setExecutionEnabled] = useState(true);
  const [uploadLimit, setUploadLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pluginLastUpdate = usePluginUpdates((state) => state.lastUpdate);

  const load = useCallback(async () => {
    try {
      const result = await listAdminPlugins(token);
      setPlugins(result.plugins);
      setExecutionEnabled(result.executionEnabled);
      setUploadLimit(result.uploadLimitBytes);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load, pluginLastUpdate]);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.ndp')) {
      setError('Select a .ndp plugin package.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      await uploadAdminPlugin(token, file);
      await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function rescan() {
    setRescanning(true);
    setError(null);
    try {
      const result = await rescanAdminPlugins(token);
      if (result.errors.length) setError(result.errors.map((entry) => `${entry.filename}: ${entry.error}`).join('\n'));
      await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setRescanning(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 to-violet-500/5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <h2 className="text-xl font-semibold text-white">Sandboxed plugins</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">Install Navidrome-compatible <span className="font-mono text-cyan-300">.ndp</span> WebAssembly packages or MVBar extensions. Plugins run outside the core process, start disabled, and receive only the permissions shown before enablement.</p>
          </div>
          <button onClick={() => void rescan()} disabled={rescanning} className="rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700/60 disabled:opacity-50">{rescanning ? 'Scanning…' : 'Rescan folder'}</button>
        </div>
        {!executionEnabled && <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">Plugin execution is disabled globally by <span className="font-mono">PLUGINS_ENABLED</span>. Packages and configuration remain manageable.</div>}
        <div
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]); }}
          className={`mt-5 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${dragging ? 'border-cyan-400 bg-cyan-500/10' : 'border-slate-600 bg-slate-950/20'}`}
        >
          <input ref={fileInput} type="file" accept=".ndp,application/zip" className="hidden" onChange={(event) => void upload(event.target.files?.[0])} />
          <p className="text-sm text-slate-300">Drop an <span className="font-mono">.ndp</span> package here, or</p>
          <button onClick={() => fileInput.current?.click()} disabled={uploading} className="mt-3 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50">{uploading ? 'Validating and installing…' : 'Choose package'}</button>
          {uploadLimit > 0 && <p className="mt-2 text-xs text-slate-500">Maximum package size: {readableBytes(uploadLimit)}</p>}
        </div>
      </section>

      {error && <div className="whitespace-pre-wrap rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
      {loading ? (
        <div className="flex h-48 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" /></div>
      ) : plugins.length === 0 ? (
        <div className="rounded-2xl border border-slate-700/40 bg-slate-800/20 px-6 py-12 text-center"><p className="text-slate-300">No plugins installed.</p><p className="mt-2 text-sm text-slate-500">You can also copy .ndp files directly into the configured server plugin directory, then rescan.</p></div>
      ) : (
        <div className="space-y-5">{plugins.map((plugin) => <PluginCard key={plugin.id} token={token} plugin={plugin} refresh={load} />)}</div>
      )}

      <section className="rounded-xl border border-slate-700/40 bg-slate-900/30 p-4 text-xs leading-relaxed text-slate-400">
        Removing or disabling every plugin restores vanilla MVBar behavior. Plugins cannot change the core executable, database schema, user accounts, or music library through the plugin API; isolated storage is removed with the package.
      </section>
    </div>
  );
}
