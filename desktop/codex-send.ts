import {
  codexOriginCache,
  codexTarget,
  findCodexThread,
  queueToCodex,
  readCodexOrigin,
} from './codex-queue.js';
import { desktopOwnsThread, sendToCodexDesktop } from './codex-desktop.js';
import { defaultTerminalDeps, TerminalInputError, type TerminalDeps } from './terminals.js';
import type { TerminalHost } from './terminal-host.js';
import type { TerminalTarget } from '../src/shared/types.js';
import { m } from '../src/shared/i18n/index.js';

export interface CodexDestination {
  threadId: string;
  transport: 'queue' | 'desktop';
}
const origin = codexOriginCache();
const cache = new Map<string, { at: number; value: Promise<boolean> }>();
export async function findCodexDestination(
  nativeId: string,
  sourcePath?: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<CodexDestination | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId) ||
    !sourcePath
  )
    return null;
  const known = await (options.fresh || options.deps
    ? readCodexOrigin(sourcePath)
    : origin(sourcePath));
  if (!known || known.subagent) return null;
  if (known.originator === 'codex-tui')
    return (await findCodexThread(nativeId, sourcePath, options))
      ? { threadId: nativeId, transport: 'queue' }
      : null;
  if (known.originator !== 'Codex Desktop') return null;
  const home = (options.deps ?? defaultTerminalDeps()).codexHome;
  const key = `${home}\0${nativeId}`;
  let entry = cache.get(key);
  if (!entry || options.fresh || options.deps || Date.now() - entry.at > 3000) {
    entry = { at: Date.now(), value: desktopOwnsThread(home, nativeId) };
    cache.set(key, entry);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return (await entry.value) ? { threadId: nativeId, transport: 'desktop' } : null;
}
export function codexDestinationTarget(
  destination: CodexDestination | null,
  host?: TerminalHost,
): TerminalTarget {
  if (destination?.transport !== 'desktop') return codexTarget(host, !!destination);
  return {
    kind: 'codex',
    label: 'Codex Desktop',
    status: 'desktop',
    canSend: true,
    canFocus: false,
    desktop: true,
    queues: false,
  };
}
export async function sendToCodex(
  destination: CodexDestination,
  text: unknown,
  deps = defaultTerminalDeps(),
  beforeSend: () => void = () => {},
) {
  if (destination.transport === 'desktop')
    return sendToCodexDesktop(deps.codexHome, destination.threadId, text, 15000, beforeSend);
  try {
    beforeSend();
    return await queueToCodex(destination, text, deps);
  } catch (error) {
    if (error instanceof TerminalInputError) throw error;
    throw new TerminalInputError(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? m().desktop.terminal.codexMissing
        : m().desktop.terminal.codexUnconfirmed,
    );
  }
}
