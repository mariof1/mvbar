import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type ProbeHandle = { close(): Promise<void> };

export type WritableProbeFs = {
  open(target: string, flags: string, mode: number): Promise<ProbeHandle>;
  unlink(target: string): Promise<void>;
};

const defaultFs: WritableProbeFs = {
  open: (target, flags, mode) => open(target, flags, mode),
  unlink,
};

/**
 * Verify that a directory is genuinely writable by creating and removing a
 * private zero-byte probe file. Permission-only checks such as access(W_OK)
 * can disagree with the actual write operation for mounted filesystems, so
 * callers should use this result when deciding whether edit controls are safe
 * to expose.
 */
export async function probeWritableDirectory(
  target: string,
  fsOps: WritableProbeFs = defaultFs,
): Promise<boolean> {
  const probePath = path.join(target, `.mvbar-write-probe-${process.pid}-${randomUUID()}`);
  let handle: ProbeHandle | null = null;

  try {
    handle = await fsOps.open(probePath, 'wx', 0o600);
    await handle.close();
    handle = null;
    await fsOps.unlink(probePath);
    return true;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fsOps.unlink(probePath).catch(() => undefined);
  }
}
