import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  imageBlock,
  isAttachmentId,
  parseStoredImages,
  sniffImage,
  withImagePaths,
} from '../src/shared/attachments.js';
import { AttachmentError, AttachmentStore } from '../desktop/attachments.js';
import {
  afterImages,
  claudeCodeComposer,
  codexQueueComposer,
  composerFor,
  promptHoldsImages,
} from '../desktop/composer/index.js';
import {
  sendToTerminal,
  terminalTarget,
  TerminalInputError,
  type LiveTerminal,
  type TerminalDeps,
} from '../desktop/terminals.js';
import { codexTurnInput } from '../desktop/codex-desktop.js';
import { queueToCodex } from '../desktop/codex-queue.js';
import { codexDestinationTarget, codexImages } from '../desktop/codex-send.js';
import { setLocale } from '../src/shared/i18n/index.js';

process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00');
const WEBP = new TextEncoder().encode('RIFF\x10\x00\x00\x00WEBPVP8 ');

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-attachments-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Images are told by their first bytes, never by a name or a claimed type', () => {
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(JPG), 'jpg');
  assert.equal(sniffImage(GIF), 'gif');
  assert.equal(sniffImage(new TextEncoder().encode('GIF87a..')), 'gif');
  assert.equal(sniffImage(WEBP), 'webp');
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\x10\x00\x00\x00WAVE')), null);
  assert.equal(
    sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')),
    null,
  );
  assert.equal(sniffImage(new TextEncoder().encode('BM')), null);
  assert.equal(sniffImage(PNG.subarray(0, 7)), null);
  assert.equal(sniffImage(new Uint8Array()), null);
});

test('Where images can be attached: desktop, this office, and a target that takes them', () => {
  const claude = { images: 'attach' as const };
  assert.equal(imageBlock(claude, { desktop: true }), null);
  assert.equal(imageBlock({ images: 'path' }, { desktop: true }), null);
  assert.equal(imageBlock(claude, { desktop: false }), 'desktop');
  assert.equal(imageBlock(claude, { desktop: true, demo: true }), 'desktop');
  assert.equal(imageBlock(claude, { desktop: true, remote: true }), 'remote');
  assert.equal(imageBlock({ ...claude, remoteOffice: 'Kim' }, { desktop: true }), 'remote');
  assert.equal(imageBlock({}, { desktop: true }), 'target');
  assert.equal(imageBlock(null, { desktop: true }), 'target');
});

test('Path-only targets get the message, then one path per line', () => {
  assert.equal(withImagePaths('hi', []), 'hi');
  assert.equal(withImagePaths('hi', ['/a.png', '/b.jpg']), 'hi\n\n/a.png\n/b.jpg');
  assert.equal(withImagePaths('', ['/a.png']), '/a.png');
});

test('The store keeps checked bytes under a random id and resolves only its own files', async () => {
  await withDir(async (dir) => {
    const store = new AttachmentStore(path.join(dir, 'attachments'));
    const { id } = await store.save(PNG);
    assert.ok(isAttachmentId(id));
    const file = await store.resolve(id);
    assert.equal(file, path.join(dir, 'attachments', `${id}.png`));
    assert.equal((await stat(file!)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dir, 'attachments'))).mode & 0o777, 0o700);
    assert.equal(
      await store.resolve((await store.save(WEBP)).id).then((f) => path.extname(f!)),
      '.webp',
    );

    for (const bad of [
      'not-an-image',
      new TextEncoder().encode('<svg/>'),
      [0x89, 0x50],
      new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0xff),
    ])
      await assert.rejects(store.save(bad), AttachmentError);

    // Ids are bare UUIDs: no extension, path or traversal is ever looked up.
    for (const bad of [`${id}.png`, `../${id}`, id.toUpperCase(), '/etc/passwd', '', 42, null])
      assert.equal(await store.resolve(bad), null);
    // A link named like an id is not a file this store wrote.
    const linked = '11111111-2222-4333-8444-555555555555';
    await symlink(file!, path.join(dir, 'attachments', `${linked}.png`));
    assert.equal(await store.resolve(linked), null);
  });
});

test("A thumbnail is read back by id, from the store's own image files only", async () => {
  await withDir(async (dir) => {
    const store = new AttachmentStore(dir);
    const { id } = await store.save(PNG);
    assert.deepEqual(await store.preview(id), { type: 'image/png', bytes: PNG });
    for (const bad of [`${id}.png`, '../x', '/etc/passwd', 7])
      assert.equal(await store.preview(bad), null);
    // A file changed behind the store's back (no longer that image) is not shown.
    await writeFile(path.join(dir, `${id}.png`), 'not an image');
    assert.equal(await store.preview(id), null);
    const linked = '11111111-2222-4333-8444-555555555555';
    await writeFile(path.join(dir, 'real.png'), PNG);
    await symlink(path.join(dir, 'real.png'), path.join(dir, `${linked}.png`));
    assert.equal(await store.preview(linked), null);
    assert.equal(await store.preview('22222222-3333-4444-8555-666666666666'), null);
  });
});

test('A draft keeps image ids and names only, and drops anything malformed', () => {
  const a = '11111111-2222-4333-8444-555555555555';
  const b = '22222222-3333-4444-8555-666666666666';
  assert.deepEqual(parseStoredImages(null), []);
  assert.deepEqual(parseStoredImages('not json'), []);
  assert.deepEqual(parseStoredImages('{"id":"x"}'), []);
  assert.deepEqual(
    parseStoredImages(
      JSON.stringify([
        { id: a, name: 'shot.png' },
        { id: a, name: 'again' },
        { id: '/etc/passwd', name: 'x' },
        { id: `${b}.png` },
        { id: b, name: 42 },
        null,
      ]),
    ),
    [
      { id: a, name: 'shot.png' },
      { id: b, name: '' },
    ],
  );
  const many = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => ({
    id: `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`,
    name: '',
  }));
  assert.equal(parseStoredImages(JSON.stringify(many)).length, MAX_IMAGES);
});

test('A send names ids: in order, each once, a handful at most, every one still there', async () => {
  await withDir(async (dir) => {
    const store = new AttachmentStore(dir);
    const a = (await store.save(PNG)).id;
    const b = (await store.save(JPG)).id;
    assert.deepEqual(await store.resolveAll(undefined), []);
    assert.deepEqual(await store.resolveAll([b, a]), [
      path.join(dir, `${b}.jpg`),
      path.join(dir, `${a}.png`),
    ]);
    await assert.rejects(store.resolveAll([a, a]), AttachmentError);
    await assert.rejects(store.resolveAll('a'), AttachmentError);
    await assert.rejects(
      store.resolveAll(Array.from({ length: MAX_IMAGES + 1 }, () => a)),
      AttachmentError,
    );
    await assert.rejects(store.resolveAll([a, '/tmp/x.png']), AttachmentError);
    await rm(path.join(dir, `${b}.jpg`));
    await assert.rejects(store.resolveAll([a, b]), /더 이상 찾을 수 없어요/);
  });
});

test('Cleanup removes only old files of the store', async () => {
  await withDir(async (dir) => {
    const store = new AttachmentStore(dir);
    const fresh = (await store.save(PNG)).id;
    const old = (await store.save(GIF)).id;
    const week = 7 * 24 * 60 * 60 * 1000;
    const then = new Date(Date.now() - week - 60_000);
    await utimes(path.join(dir, `${old}.gif`), then, then);
    await writeFile(path.join(dir, 'notes.txt'), 'keep');
    await utimes(path.join(dir, 'notes.txt'), then, then);
    assert.equal(await store.cleanup(), 1);
    assert.deepEqual((await readdir(dir)).sort(), [`${fresh}.png`, 'notes.txt'].sort());
    assert.equal(await new AttachmentStore(path.join(dir, 'missing')).cleanup(), 0);
    assert.ok((await lstat(path.join(dir, `${fresh}.png`))).isFile());
  });
});

// ---- Claude Code: pasted image paths become [Image #N] ------------------------------------

const RULE = '─'.repeat(60);
const claudeScreen = (typed: string) =>
  ['⏺ Done.', '', `${RULE} ao ─`, `❯ ${typed.split('\n').join('\n  ')}`.trimEnd(), RULE].join('\n');
const P1 = '/Users/me/Library/Application Support/Agent Office/attachments/a.png';
const P2 = '/Users/me/Library/Application Support/Agent Office/attachments/b.jpg';

test('The prompt must show exactly one [Image #N] (or the path itself) per pasted image', () => {
  assert.equal(afterImages('[Image #1] [Image #2]look', [P1, P2]), 'look');
  assert.equal(afterImages('[Image #3][Image #4]', [P1, P2]), '');
  // Claude did not attach (a refused read): the path stays as text, and that is what it gets.
  assert.equal(afterImages(`${P1} ${P2}`, [P1, P2]), '');
  assert.equal(afterImages(`[Image #1] ${P2}`, [P1, P2]), '');
  // One image short, the same id twice, or something else first: no match.
  assert.equal(afterImages('[Image #1]', [P1, P2]), null);
  assert.equal(afterImages('[Image #1] [Image #1]', [P1, P2]), null);
  assert.equal(afterImages('hi [Image #1] [Image #2]', [P1, P2]), null);
  assert.equal(afterImages('[Pasted text #1] [Image #2]', [P1, P2]), null);
  assert.equal(afterImages('[Image #0]', [P1]), null);

  const holds = (typed: string, text: string, strict = false) =>
    promptHoldsImages(claudeScreen(typed), text, [P1, P2], strict);
  assert.ok(holds('[Image #1] [Image #2]look at this', 'look at this'));
  assert.ok(holds('[Image #1] [Image #2]', ''));
  assert.ok(!holds('[Image #1] [Image #2]look at this!', 'look at this'));
  assert.ok(!holds('[Image #1] [Image #2] [Image #3]look', 'look'));
  assert.ok(!holds('[Image #1]look', 'look'));
  assert.ok(!holds('[Image #1] [Image #2]', 'look'));
  assert.ok(!holds('[Image #1] [Image #2]draft look', 'look'));
  // A long text collapsed into Claude's own placeholder, unless only the exact text may pass.
  assert.ok(holds('[Image #1] [Image #2][Pasted text #3 +12 lines]', 'a\n'.repeat(13)));
  assert.ok(!holds('[Image #1] [Image #2][Pasted text #3 +12 lines]', 'a\n'.repeat(13), true));
  assert.ok(!holds('[Image #1] [Image #2][Pasted text #3 +12 lines]', ''));
  // Not on a dialog.
  assert.ok(!promptHoldsImages('Do you want to proceed?\n ❯ 1. Yes', '', [P1]));
});

const SESSION = '6dfc48fb-f723-4025-aab6-eaa73f743e5b';
const START = 'Tue Oct  6 13:05:12 2026';
const SOCKET = '/private/tmp/tmux-501/default';
const HANDLE = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';
const tmuxLive = (): LiveTerminal => ({
  process: { pid: 4242, sessionId: SESSION, procStart: START, status: 'idle', updatedAt: 0 },
  host: { kind: 'tmux', socket: SOCKET, pane: '%3', label: 'work:1.0' },
});
const orcaLive = (): LiveTerminal => ({
  process: { pid: 4242, sessionId: SESSION, procStart: START, status: 'idle', updatedAt: 0 },
  host: { kind: 'orca', handle: HANDLE, title: '✳ ao' },
});

/**
 * A fake Claude Code behind tmux or Orca. A paste is handled as 2.1.310 does: split at spaces
 * before `/` and at line breaks; image paths become `[Image #N]` (joined by a space), the rest
 * is inserted as is. `attach`: how many of the pasted images it attaches (`refuse`: none, the
 * paste goes in as text).
 */
function fakeClaude(
  sessionsDir: string,
  options: { attach?: number | 'refuse'; slow?: number } = {},
) {
  const pastes: string[] = [];
  let typed = '';
  let next = 0;
  let pending: { text: string; reads: number } | null = null;
  const paste = (text: string) => {
    pastes.push(text);
    const parts = text
      .split(/ (?=\/)/)
      .flatMap((p) => p.split('\n'))
      .filter((p) => p.trim());
    const images = parts.filter((p) => /\.(png|jpe?g|gif|webp)$/i.test(p));
    if (!images.length || options.attach === 'refuse') {
      typed += text;
      return;
    }
    const count = Math.min(images.length, options.attach ?? images.length);
    const shown = Array.from({ length: count }, () => `[Image #${++next}]`).join(' ');
    // Reading and resizing takes a moment: the images show up after a few screen reads.
    pending = { text: shown, reads: options.slow ?? 1 };
  };
  const screen = () => {
    if (pending && pending.reads-- <= 0) {
      typed += pending.text;
      pending = null;
    }
    return claudeScreen(typed);
  };
  let loaded = '';
  const calls: { file: string; args: string[] }[] = [];
  const deps: TerminalDeps = {
    sessionsDir,
    codexHome: '/nonexistent',
    alive: (pid) => pid === 4242,
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    run: async (file, args, runOptions) => {
      calls.push({ file, args });
      if (file === '/bin/ps') {
        if (args.includes('lstart=')) return `${START}\n`;
        if (args.includes('stat=,pgid=,tpgid=')) return 'S+ 4242 4242\n';
        return '';
      }
      if (file === '/bin/tmux') {
        if (args.some((a) => a.startsWith('#{pane_in_mode}'))) return '0 40\n';
        if (args.includes('load-buffer')) loaded = runOptions?.input ?? '';
        if (args.includes('paste-buffer')) paste(loaded);
        if (args.includes('send-keys') && args.includes('Enter')) typed = '';
        if (args.includes('capture-pane')) return screen();
        return '';
      }
      if (file === '/bin/orca' && args[1] === 'read')
        return JSON.stringify({
          ok: true,
          result: { terminal: { tail: screen().split('\n'), source: 'screen' } },
        });
      if (file === '/bin/orca' && args[1] === 'send') {
        const text = args.find((a) => a.startsWith('--text='));
        if (text) paste(text.slice(7).replace(/\x1b\[20[01]~/g, ''));
        if (args.includes('--enter')) typed = '';
        return JSON.stringify({ ok: true, result: { send: { accepted: true } } });
      }
      return '';
    },
  };
  return { deps, calls, pastes, typed: () => typed };
}

async function withRecord(fn: (dir: string) => Promise<void>) {
  await withDir(async (dir) => {
    await writeFile(
      path.join(dir, '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: SESSION, procStart: START, status: 'idle' }),
    );
    await fn(dir);
  });
}

const entered = (calls: { file: string; args: string[] }[]) =>
  calls.some((c) => c.args.includes('Enter') || c.args.includes('--enter'));

test('Images go first as one paste of their paths, then the text, then Enter', async () => {
  for (const live of [tmuxLive(), orcaLive()])
    await withRecord(async (dir) => {
      const claude = fakeClaude(dir, { slow: 3 });
      const result = await sendToTerminal(live, '이 화면 봐줘', claude.deps, { images: [P1, P2] });
      assert.equal(result.status, 'sent');
      assert.deepEqual(claude.pastes, [`${P1} ${P2}`, '이 화면 봐줘']);
      assert.ok(entered(claude.calls));
      assert.equal(claude.typed(), '');
    });
});

test('An image-only send pastes no text; a path Claude would not read is sent as text', async () => {
  await withRecord(async (dir) => {
    const claude = fakeClaude(dir);
    assert.equal(
      (await sendToTerminal(tmuxLive(), '  ', claude.deps, { images: [P1] })).status,
      'sent',
    );
    assert.deepEqual(claude.pastes, [P1]);
  });
  await withRecord(async (dir) => {
    const claude = fakeClaude(dir, { attach: 'refuse' });
    const result = await sendToTerminal(tmuxLive(), 'hi', claude.deps, { images: [P1] });
    assert.equal(result.status, 'sent');
    assert.deepEqual(claude.pastes, [P1, 'hi']);
  });
});

test('No text and no Enter unless every image shows up as attached', async () => {
  await withRecord(async (dir) => {
    const claude = fakeClaude(dir, { attach: 1 });
    await assert.rejects(
      sendToTerminal(tmuxLive(), 'hi', claude.deps, { images: [P1, P2] }),
      (e: Error) => e instanceof TerminalInputError && /첨부된 걸 확인하지 못해/.test(e.message),
    );
    assert.deepEqual(claude.pastes, [`${P1} ${P2}`]);
    assert.ok(!entered(claude.calls));
  });
  // Never shows up at all (an older Claude, a slow disk): the same, after a few seconds' looks.
  await withRecord(async (dir) => {
    const claude = fakeClaude(dir, { slow: 1000 });
    await assert.rejects(sendToTerminal(tmuxLive(), 'hi', claude.deps, { images: [P1] }));
    assert.ok(!entered(claude.calls));
  });
});

test('Images are refused before anything is typed where they cannot be pasted safely', async () => {
  await withRecord(async (dir) => {
    for (const images of [['relative/a.png'], ['/a b /c.png'], ['/a.png\n/b.png']]) {
      const claude = fakeClaude(dir);
      await assert.rejects(
        sendToTerminal(tmuxLive(), 'hi', claude.deps, { images }),
        /이미지를 보낼 수 없어요/,
      );
      assert.deepEqual(claude.pastes, []);
    }
    const claude = fakeClaude(dir);
    await assert.rejects(
      sendToTerminal(tmuxLive(), 'hi', claude.deps, { images: [P1], composer: codexQueueComposer }),
    );
    assert.deepEqual(claude.pastes, []);
  });
});

test('Adapters say how images reach each agent; targets carry it to the view', () => {
  assert.equal(claudeCodeComposer.capabilities(null).images, 'attach');
  assert.equal(codexQueueComposer.capabilities(null).images, 'path');
  assert.equal(composerFor('openclaw').capabilities(null).images, undefined);
  assert.equal(terminalTarget(tmuxLive()).images, 'attach');
  assert.equal(terminalTarget(orcaLive()).images, 'attach');
  assert.equal(codexImages('desktop'), 'attach');
  assert.equal(codexImages('queue'), 'path');
  assert.equal(
    codexDestinationTarget({ threadId: SESSION, transport: 'desktop' }).images,
    'attach',
  );
  assert.equal(codexDestinationTarget({ threadId: SESSION, transport: 'queue' }).images, 'path');
  assert.equal(codexDestinationTarget(null).images, undefined);
});

test('Codex Desktop gets local image items before the text; the queue gets paths in the text', async () => {
  assert.deepEqual(codexTurnInput('see', [P1]), [
    { type: 'localImage', path: P1 },
    { type: 'text', text: 'see', text_elements: [] },
  ]);
  assert.deepEqual(codexTurnInput('', [P1, P2]), [
    { type: 'localImage', path: P1 },
    { type: 'localImage', path: P2 },
  ]);
  assert.deepEqual(codexTurnInput('see'), [{ type: 'text', text: 'see', text_elements: [] }]);

  const runs: string[][] = [];
  const deps = {
    run: async (_file: string, args: string[]) => {
      runs.push(args);
      return `Queued message for thread ${SESSION}`;
    },
    bin: () => '/bin/codex',
  } as unknown as TerminalDeps;
  await queueToCodex({ threadId: SESSION }, ' 봐줘 ', deps, [P1, P2]);
  await queueToCodex({ threadId: SESSION }, '', deps, [P1]);
  assert.deepEqual(runs, [
    ['queue', `--thread=${SESSION}`, `--message=봐줘\n\n${P1}\n${P2}`],
    ['queue', `--thread=${SESSION}`, `--message=${P1}`],
  ]);
  await assert.rejects(queueToCodex({ threadId: SESSION }, '', deps), TerminalInputError);
});
