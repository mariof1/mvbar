import crypto from 'node:crypto';

export type ClientInfo = {
  id: string;
  reported: boolean;
  type: string;
  version: string | null;
  device: string | null;
  platform: string | null;
  userAgent: string | null;
};

type HeaderRequest = {
  headers: Record<string, string | string[] | undefined>;
};

function header(req: HeaderRequest, name: string, maxLength: number) {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  const normalized = text?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function clientInfoFromRequest(req: HeaderRequest): ClientInfo {
  const userAgent = header(req, 'user-agent', 300);
  const declaredType = header(req, 'x-mvbar-client', 40)?.toLowerCase();
  const type = declaredType
    ?? (userAgent?.toLowerCase().includes('okhttp') ? 'android' : 'web');
  const version = header(req, 'x-mvbar-version', 80);
  const device = header(req, 'x-mvbar-device', 120);
  const platform = header(req, 'x-mvbar-platform', 120);
  const declaredId = header(req, 'x-mvbar-client-id', 128);
  const fallbackIdentity = [type, version, device, platform, userAgent].filter(Boolean).join('|');
  const id = declaredId
    ?? `auto_${crypto.createHash('sha256').update(fallbackIdentity || type).digest('hex').slice(0, 32)}`;

  return { id, reported: declaredId != null, type, version, device, platform, userAgent };
}

export function clientAuditMeta(info: ClientInfo) {
  return {
    clientId: info.id,
    clientType: info.type,
    appVersion: info.version,
    deviceName: info.device,
    platform: info.platform,
    userAgent: info.userAgent,
  };
}
