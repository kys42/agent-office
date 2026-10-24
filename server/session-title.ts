import { open, realpath, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { Session } from '../src/shared/types.js';
import {
  sessionTitleSchema,
  titleRequestSchema,
  type SessionTitleInfo,
} from '../src/shared/session-title.js';
import { defaultTerminalDeps } from '../desktop/terminals.js';
import { RelayJournal } from './federation/relay-journal.js';
import { codexMetadata } from './adapters/codex.js';

/** Mutation journal is separate from the read-only Office/exporter database. */
export class SessionTitles {
  private active = new Set<string>();
  private journal: RelayJournal;
  constructor(
    dir: string,
    private renamer = nativeSessionRenamer(),
  ) {
    this.journal = new RelayJournal(path.join(dir, 'session-titles'));
  }
  async call(
    get: () => Session,
    value: unknown,
    authorize: () => void | Promise<void>,
  ): Promise<SessionTitleInfo> {
    await authorize();
    const s = get();
    if (value === undefined) return this.renamer.info(s);
    const request = titleRequestSchema.parse(value);
    if (this.active.has(s.id)) throw Error('title-busy');
    this.active.add(s.id);
    try {
      const info = await this.renamer.info(s);
      if (!info.available) return info;
      await authorize();
      const previous = this.journal.claim(
        request.requestId,
        s.id,
        JSON.stringify([request.title, request.expected]),
      );
      if (previous !== 'new')
        return { ...info, status: previous === 'sent' ? 'renamed' : 'uncertain' };
      const verify = async () => {
        await authorize();
        const fresh = get();
        if (
          fresh.sourcePath !== s.sourcePath ||
          fresh.nativeId !== s.nativeId ||
          fresh.provider !== s.provider
        )
          throw Error('title-changed');
        const current = await this.renamer.info(fresh);
        if (!current.available || current.title !== request.expected) throw Error('title-changed');
        await authorize();
      };
      try {
        await verify();
        await this.renamer.rename(s, request.title, verify);
        this.journal.sent(request.requestId);
        return { available: true, title: request.title, status: 'renamed' };
      } catch {
        return { ...info, status: 'uncertain' };
      }
    } finally {
      this.active.delete(s.id);
    }
  }
}

export interface SessionRenamer {
  info(s: Session): Promise<SessionTitleInfo>;
  rename(s: Session, title: string, authorize: () => void | Promise<void>): Promise<void>;
}

/** A short-lived official app-server client. Never starts/resumes a turn or answers approvals. */
export function codexSetTitle(binary: string, home: string, id: string, name: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['app-server'], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let buffer = '',
      bytes = 0,
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      const kill = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1000);
      kill.unref();
      child.once('exit', () => clearTimeout(kill));
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(Error('title-unconfirmed')), 15000);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    child.on('error', () => finish(Error('title-unavailable')));
    child.stdin.on('error', () => finish(Error('title-unconfirmed')));
    child.on('exit', () => finish(Error('title-unconfirmed')));
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) return finish(Error('title-unconfirmed'));
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0 && !done) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.id === 1) {
            if (reply.error || !reply.result) return finish(Error('title-unavailable'));
            send({ method: 'initialized' });
            send({ id: 2, method: 'thread/name/set', params: { threadId: id, name } });
          } else if (reply.id === 2) {
            finish(reply.error || !reply.result ? Error('title-unconfirmed') : undefined);
          }
        } catch {
          finish(Error('title-unconfirmed'));
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'agent_office', version: '0.1.0' } },
    });
  });
}

export function nativeSessionRenamer(
  options: { claudeRoot?: string; codexHome?: string; codexBinary?: string } = {},
): SessionRenamer {
  const codexHome =
    options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const claudeRoot =
    options.claudeRoot ??
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
  const supported = (s: Session) =>
    !s.remote &&
    ['claude', 'codex'].includes(s.provider) &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s.nativeId) &&
    s.id === `${s.provider}:${s.nativeId}` &&
    ['root', 'fork'].includes(s.relation?.kind ?? 'root') &&
    !['internal', 'scheduled'].includes(s.origin?.kind ?? '') &&
    (s.sourcePaths?.length ?? 1) <= 1;
  const source = async (s: Session, write = false) => {
    if (!supported(s)) throw Error('unsupported-title');
    const root = s.provider === 'claude' ? claudeRoot : path.join(codexHome, 'sessions');
    const relative = path.relative(root, s.sourcePath);
    if (
      !relative ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative) ||
      !s.sourcePath.endsWith('.jsonl') ||
      /(?:^|[\\/])subagents[\\/]/.test(relative)
    )
      throw Error('invalid-source');
    if (s.provider === 'claude' && path.basename(s.sourcePath) !== `${s.nativeId}.jsonl`)
      throw Error('invalid-source');
    // Logical paths may pass through an authorized relocated folder; hold the resolved inode.
    const physical = await realpath(s.sourcePath);
    const file = await open(
      physical,
      write ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw Error('invalid-source');
      const head = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
      await file.read(head, 0, head.length, 0);
      let matched = false;
      for (const line of head.toString('utf8').split('\n').slice(0, -1)) {
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const id =
          s.provider === 'codex'
            ? r.type === 'session_meta'
              ? r.payload?.id
              : undefined
            : r.sessionId;
        if (id) {
          if (id !== s.nativeId) throw Error('identity-mismatch');
          matched = true;
        }
      }
      if (!matched) throw Error('identity-missing');
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  };
  const binary = async () => {
    const candidates = options.codexBinary
      ? [options.codexBinary]
      : [
          '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
          defaultTerminalDeps().bin('codex'),
          ...[
            path.join(os.homedir(), '.local/bin'),
            ...(process.env.PATH ?? '').split(path.delimiter),
          ]
            .filter((dir) => path.isAbsolute(dir))
            .map((dir) => path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex')),
        ];
    for (const file of candidates) {
      if (!path.isAbsolute(file)) continue;
      try {
        await access(file, constants.X_OK);
        return file;
      } catch {
        /* next installed CLI */
      }
    }
    throw Error('codex-unavailable');
  };
  return {
    async info(s) {
      if (!supported(s))
        return { available: false, title: s.title, reason: 'unsupported', status: 'ready' };
      try {
        const file = await source(s);
        let title = s.title;
        try {
          if (s.provider === 'codex') {
            await binary();
            title = (await codexMetadata(codexHome)).get(s.nativeId)?.title ?? title;
          } else {
            // Inspect the latest title without loading a full conversation into memory.
            const size = (await file.stat()).size;
            const start = Math.max(0, size - 256 * 1024);
            const tail = Buffer.alloc(size - start);
            await file.read(tail, 0, tail.length, start);
            const lines = tail.toString('utf8').split('\n');
            for (const line of lines.slice(start ? 1 : 0, -1)) {
              try {
                const record = JSON.parse(line);
                if (
                  record.type === 'custom-title' &&
                  record.sessionId === s.nativeId &&
                  typeof record.customTitle === 'string'
                )
                  title = record.customTitle;
              } catch {
                /* partial record */
              }
            }
          }
        } finally {
          await file.close();
        }
        return { available: true, title, status: 'ready' };
      } catch {
        return { available: false, title: s.title, reason: 'source', status: 'ready' };
      }
    },
    async rename(s, raw, authorize) {
      const title = sessionTitleSchema.parse(raw);
      const file = await source(s, s.provider === 'claude');
      try {
        const opened = await file.stat();
        const verifySource = async () => {
          await authorize();
          const current = await stat(s.sourcePath);
          if (current.dev !== opened.dev || current.ino !== opened.ino)
            throw Error('source-changed');
        };
        if (s.provider === 'codex') {
          const executable = await binary();
          await verifySource();
          await codexSetTitle(executable, codexHome, s.nativeId, title);
        } else {
          // Official SDK owns the title record format. A scoped store prevents its default
          // all-project lookup from selecting another copy of the same UUID or config root.
          const { renameSession } = await import('@anthropic-ai/claude-agent-sdk/core');
          await renameSession(s.nativeId, title, {
            dir: s.cwd ?? claudeRoot,
            sessionStore: {
              load: async () => {
                throw Error('unsupported-store-operation');
              },
              append: async (key, entries) => {
                if (
                  key.sessionId !== s.nativeId ||
                  entries.length !== 1 ||
                  entries[0].type !== 'custom-title'
                )
                  throw Error('unsupported-title-record');
                await verifySource();
                const stat = await file.stat();
                const tail = Buffer.alloc(1);
                if (stat.size) await file.read(tail, 0, 1, stat.size - 1);
                // Do not append to a partial JSONL write; the person can retry once it completes.
                if (stat.size && tail[0] !== 10) throw Error('source-busy');
                await file.write(JSON.stringify(entries[0]) + '\n');
                await file.sync();
              },
            },
          });
        }
      } finally {
        await file.close();
      }
    },
  };
}
