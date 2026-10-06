import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OfficeStore } from '../server/store.js';
import { parseRecords } from '../server/adapters/normalize.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'office-mcp-'));
const store = new OfficeStore(dir);
const s = parseRecords(
  [
    { type: 'session_meta', payload: { id: 'test', cwd: '/tmp/test-project' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'MCP 계약 검증' }],
      },
    },
  ],
  { provider: 'codex', sourcePath: '/tmp/synthetic.jsonl', mtime: Date.now() },
);
store.upsert([s], 'codex');
store.close();
const client = new Client({ name: 'office-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist-desktop/mcp.cjs'],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ),
    AGENT_OFFICE_DATA_DIR: dir,
  },
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 4);
  assert.ok(tools.tools.every((t) => t.annotations?.readOnlyHint));
  const result = await client.callTool({ name: 'office_search', arguments: { query: '계약' } });
  assert.equal(result.isError, undefined);
  assert.ok(JSON.stringify(result).includes('codex:test'));
  const stale = await client.callTool({
    name: 'office_prepare_handoff',
    arguments: { id: 'codex:test', revision: 'old' },
  });
  assert.equal(stale.isError, true);
  const packet = await client.callTool({
    name: 'office_prepare_handoff',
    arguments: { id: 'codex:test', revision: s.revision },
  });
  assert.ok(JSON.stringify(packet).includes('MCP 계약'));
  console.log(
    JSON.stringify({
      ok: true,
      tools: 4,
      readOnly: true,
      search: true,
      handoff: true,
      staleRevisionRejected: true,
    }),
  );
} finally {
  await client.close();
  await rm(dir, { recursive: true, force: true });
}
