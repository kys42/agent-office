/**
 * Ports of the development servers (`npm run dev`): the Vite UI and the collector it proxies
 * `/api` to. Defaults 5173 and 4318; `AGENT_OFFICE_UI_PORT` / `AGENT_OFFICE_API_PORT` move them so
 * another checkout's dev server on the defaults is left alone (and never tested by mistake).
 * Shared by vite.config.ts, server/dev.ts and playwright.config.ts. No other imports: the Vite
 * and Playwright configs load it.
 */
export const DEFAULT_UI_PORT = 5173;
export const DEFAULT_API_PORT = 4318;

function port(name: string, raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // A typo must not quietly fall back to a default another checkout may be using.
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`${name} must be a port number (1-65535), got "${raw}"`);
  return n;
}

export function devPorts(env: Record<string, string | undefined> = process.env) {
  const ui = port('AGENT_OFFICE_UI_PORT', env.AGENT_OFFICE_UI_PORT, DEFAULT_UI_PORT);
  const api = port('AGENT_OFFICE_API_PORT', env.AGENT_OFFICE_API_PORT, DEFAULT_API_PORT);
  if (ui === api) throw new Error(`AGENT_OFFICE_UI_PORT and AGENT_OFFICE_API_PORT are both ${ui}`);
  return { ui, api };
}
