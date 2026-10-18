import { m } from '../shared/i18n';

// Same-origin HTTP adapter. Shared chat components do not know this transport.
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? m().mobile.badCode
        : status === 429
          ? m().mobile.rateLimit
          : m().mobile.connectionSend,
    );
  }
}
export async function mobileRequest<T>(route: string, value: unknown = {}): Promise<T> {
  const res = await fetch(`/mobile/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Office-Mobile': '1' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}
// randomUUID requires HTTPS; getRandomValues also works on the encrypted tailnet HTTP link.
export function createRequestId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const s = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
