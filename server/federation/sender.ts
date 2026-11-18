import type { Session, TerminalTarget } from '../../src/shared/types.js';
import {
  locateTerminal,
  terminalTarget,
  sendToTerminal,
  forgetTerminal,
} from '../../desktop/terminals.js';
import {
  findCodexDestination,
  sendToCodex,
  codexDestinationTarget,
} from '../../desktop/codex-send.js';
import { composerFor } from '../../desktop/composer/index.js';

/** Only the owning computer resolves native paths/processes. No handles come from the client. */
export interface PeerSender {
  target(session: Session): Promise<TerminalTarget | null>;
  send(session: Session, text: string, authorized: () => void): Promise<void>;
}
export const nativePeerSender: PeerSender = {
  async target(s) {
    if (s.provider === 'codex') {
      const destination = await findCodexDestination(s.nativeId, s.sourcePath);
      return destination ? codexDestinationTarget(destination) : null;
    }
    if (s.provider !== 'claude') return null;
    const live = await locateTerminal(s.nativeId);
    if (!live) return null;
    const target = terminalTarget(live);
    return { ...target, canFocus: false, focus: undefined, label: '' };
  },
  async send(s, text, authorized) {
    if (s.provider === 'codex') {
      const thread = await findCodexDestination(s.nativeId, s.sourcePath, { fresh: true });
      if (!thread) throw new Error('unavailable');
      await sendToCodex(thread, text, undefined, authorized);
      return;
    }
    if (s.provider !== 'claude') throw new Error('unsupported');
    const live = await locateTerminal(s.nativeId, { fresh: true });
    if (!live) throw new Error('unavailable');
    try {
      authorized();
      // No replaceDraft or clipboard backup: the existing adapter refuses occupied composers.
      await sendToTerminal(live, text, undefined, { composer: composerFor(s.provider) });
    } finally {
      forgetTerminal(live.process.sessionId);
    }
  },
};
