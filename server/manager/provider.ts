import { spawn } from 'node:child_process';
import type { ManagerProvider } from '../../src/shared/manager.js';
export function providerArgs(provider: ManagerProvider, sessionId?: string): string[] {
  if (provider === 'claude')
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      'Bash,Read',
      '--allowedTools',
      'Bash(./office *),Read',
      ...(sessionId ? ['--resume', sessionId] : []),
    ];
  const flags = [
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'sandbox_workspace_write.network_access=true',
  ];
  return ['exec', ...(sessionId ? ['resume', ...flags, sessionId] : flags), '-'];
}
export interface ProviderResult {
  answer: string;
  sessionId?: string;
}
export async function runProvider(options: {
  provider: ManagerProvider;
  executable: string;
  cwd: string;
  prompt: string;
  sessionId?: string;
  onSession: (id: string) => void;
  onText?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ProviderResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDECODE;
    const child = spawn(options.executable, providerArgs(options.provider, options.sessionId), {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let line = '',
      stderr = '',
      answer = '',
      sessionId = options.sessionId,
      failed = '',
      bytes = 0,
      completed = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
          forceTimer ??= setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {}
          }, 3000);
        } catch {
          child.kill();
        }
      }
    };
    const timer = setTimeout(() => {
      failed = 'Manager request timed out; it was not retried.';
      kill();
    }, options.timeoutMs ?? 600_000);
    const abort = () => {
      failed = 'Manager request stopped; it was not retried.';
      kill();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const consume = (raw: string) => {
      try {
        const event = JSON.parse(raw);
        const nativeId =
          event.type === 'thread.started'
            ? event.thread_id
            : event.type === 'system' && event.subtype === 'init'
              ? event.session_id
              : undefined;
        if (nativeId && typeof nativeId === 'string') {
          sessionId = nativeId;
          options.onSession(nativeId);
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          answer = event.item.text;
          if (typeof answer === 'string') options.onText?.(answer.slice(0, 60000));
        }
        if (event.type === 'assistant') {
          const text = event.message?.content
            ?.filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
          if (text) options.onText?.(text.slice(0, 60000));
        }
        if (event.type === 'result') {
          if (event.is_error)
            failed = event.result || event.errors?.join('\n') || 'Claude request failed.';
          else {
            answer = event.result ?? '';
            completed = true;
          }
          if (event.session_id) {
            sessionId = event.session_id;
            options.onSession(sessionId!);
          }
        }
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed') failed = event.error?.message || 'Codex request failed.';
      } catch {
        /* Provider diagnostics are not protocol events. */
      }
    };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8_000_000) {
        failed = 'Manager output exceeded the limit.';
        kill();
        return;
      }
      line += chunk.toString();
      let end: number;
      while ((end = line.indexOf('\n')) >= 0) {
        consume(line.slice(0, end));
        line = line.slice(end + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.on('error', (e) => {
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      cleanup();
      if (line.trim()) consume(line);
      if (failed || code !== 0 || !completed || !answer.trim())
        reject(
          new Error(failed || `Agent exited (${code}). ${stderr || 'No final response received.'}`),
        );
      else resolve({ answer: answer.slice(0, 60_000), sessionId });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.prompt);
    if (options.signal?.aborted) abort();
  });
}
