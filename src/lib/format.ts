export const compact = (n: number | null) =>
  n === null
    ? '—'
    : n >= 1e6
      ? (n / 1e6).toFixed(1) + 'M'
      : n >= 1e3
        ? (n / 1e3).toFixed(1) + 'k'
        : String(n);
export const ago = (at: number) => {
  const m = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return m < 1
    ? '방금'
    : m < 60
      ? `${m}분 전`
      : m < 1440
        ? `${Math.floor(m / 60)}시간 전`
        : `${Math.floor(m / 1440)}일 전`;
};
export const time = (at: number) =>
  new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
export const date = (at: number) =>
  new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
export const shortPath = (s: string | null) =>
  s?.replace(/^\/Users\/[^/]+/, '~') ?? '아직 확인되지 않았어요';
