/**
 * Links found in session text are untrusted. Only ordinary web pages open, and only on the
 * person's click: http(s), no embedded credentials, bounded length. Anything else (file:,
 * app schemes such as vscode:// or codex://, javascript:) is shown as text.
 */
export function webLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
