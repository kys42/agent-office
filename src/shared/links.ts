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

/**
 * A file on this computer named by a link in session text ("[report](/Users/me/x.md)",
 * "~/notes.md", file:///…, C:\…): the path to offer, or null. Opening it is the desktop app's
 * call on the person's click (documents open, anything else is only shown in its folder).
 */
export function fileLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value || value.length > 4096 || value.includes('\0')) return null;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host && url.host !== 'localhost') return null;
      value = decodeURIComponent(url.pathname);
      // file:///C:/x → C:/x
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    } catch {
      return null;
    }
  }
  if (value.startsWith('//')) return null;
  if (value.startsWith('/') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(value))
    return value;
  return null;
}

/** Kinds of file a click opens in its default app; anything else is shown in its folder. */
export const OPENABLE_FILE =
  /\.(md|markdown|txt|log|csv|tsv|json|jsonl|ya?ml|toml|html?|pdf|png|jpe?g|gif|webp|svg|heic|mp4|mov|webm|mp3|wav)$/i;
