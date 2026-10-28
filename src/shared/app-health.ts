/** Support information deliberately excludes paths, hostnames, sessions and credentials. */
export interface AppHealth {
  version: string;
  platform: string;
  arch: string;
  commit: string | null;
  builtAt: string | null;
  signature: 'developer-id' | 'ad-hoc' | 'unverified' | 'development' | 'unavailable';
  teamId: string | null;
}
export type PrivacyPane = 'files' | 'network' | 'accessibility';
export const PRIVACY_PANES: Record<PrivacyPane, string> = {
  files: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  network: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
export function privacyPane(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(PRIVACY_PANES, value)
    ? PRIVACY_PANES[value as PrivacyPane]
    : null;
}
export function buildDetails(value: unknown): Pick<AppHealth, 'commit' | 'builtAt'> {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    commit:
      typeof raw.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(raw.sourceCommit)
        ? raw.sourceCommit
        : null,
    builtAt:
      typeof raw.builtAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(raw.builtAt) &&
      Number.isFinite(Date.parse(raw.builtAt))
        ? raw.builtAt
        : null,
  };
}
