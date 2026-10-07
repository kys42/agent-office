import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { Artifact } from '../src/shared/types.js';
import { parseArtifact } from '../src/shared/office.js';
import { redact } from './adapters/normalize.js';
import { localizeText } from '../src/shared/canonical.js';
const exec = promisify(execFile);
const cache = new Map<string, { at: number; value: Artifact }>();
export async function artifactDetails(urls: string[]): Promise<Artifact[]> {
  const items = urls
    .map(parseArtifact)
    .filter((x): x is Artifact => !!x)
    .slice(-8);
  const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
  const result: Artifact[] = [];
  for (const item of items) {
    const cached = cache.get(item.url);
    if (cached && Date.now() - cached.at < 300_000) {
      result.push(cached.value);
      continue;
    }
    let value = item;
    try {
      const { stdout } = await exec(
        gh,
        [
          'api',
          `repos/${item.repo}/${item.kind === 'pull' ? 'pulls' : 'issues'}/${item.number}`,
          '--jq',
          '{title, state, draft, merged_at}',
        ],
        { timeout: 3500, maxBuffer: 100_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      );
      const data = JSON.parse(stdout);
      if (typeof data.title === 'string' && ['open', 'closed'].includes(data.state))
        value = {
          ...item,
          title: redact(data.title, 200),
          state: data.merged_at ? 'merged' : data.draft ? 'draft' : data.state,
          verifiedAt: Date.now(),
        };
    } catch {
      /* Keep the real link useful when gh, permissions or network are unavailable. */
    }
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(item.url, { at: Date.now(), value });
    result.push(value);
  }
  // Cached canonical (like collected records); shown in the active language.
  return result.map((a) => (a.title ? { ...a, title: localizeText(a.title) } : a));
}
