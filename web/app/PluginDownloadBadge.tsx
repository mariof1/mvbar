export function PluginDownloadBadge({ mixed = false }: { mixed?: boolean }) {
  return (
    <span
      className="inline-flex flex-none items-center rounded-full border border-cyan-400/35 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-cyan-200"
      title={mixed ? 'Contains music downloaded by the Missing Music plugin' : 'Downloaded by the Missing Music plugin'}
      aria-label={mixed ? 'Contains plugin downloads' : 'Plugin download'}
    >
      Plugin
    </span>
  );
}
