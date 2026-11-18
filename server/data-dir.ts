import path from 'node:path';
import os from 'node:os';

/** Shared by Electron, standalone collectors and the read-only MCP process. No auto-migration. */
export function officeDataDir(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
) {
  if (env.AGENT_OFFICE_DATA_DIR) return env.AGENT_OFFICE_DATA_DIR;
  if (platform === 'win32')
    return path.win32.join(
      env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'),
      'Agent Office',
    );
  // Preserve the historical path on other platforms; Linux migration is a separate change.
  return path.join(home, 'Library', 'Application Support', 'Agent Office');
}
