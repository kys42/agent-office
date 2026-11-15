import { gt, prerelease, valid } from 'semver';
import { z } from 'zod';

const repository = 'kys42/agent-office';
const release = z.object({
  draft: z.literal(false),
  prerelease: z.literal(false),
  tag_name: z.string().max(128),
});

/** One anonymous request per app launch, shared by renderer reloads. No office data leaves the app. */
export function startupRelease(current: string, request: typeof fetch = fetch) {
  let pending: Promise<{ version: string; url: string } | null> | undefined;
  async function check() {
    if (!valid(current)) return null;
    try {
      const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null; // Includes a repo that hasn't published its first release.
      const result = release.safeParse(await response.json());
      if (!result.success) return null;
      const tag = result.data.tag_name;
      const version = valid(tag);
      if (!version || prerelease(version) || !gt(version, current)) return null;
      return {
        version,
        url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
      };
    } catch {
      return null; // Offline, rate limited, or invalid response: keep the office usable.
    }
  }
  return () => (pending ??= check());
}
