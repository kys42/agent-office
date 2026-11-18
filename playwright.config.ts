import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { devPorts } from './server/dev-ports.ts';
// AGENT_OFFICE_UI_PORT / AGENT_OFFICE_API_PORT run the tests on their own dev server when another
// checkout already uses 5173/4318 (docs/development/QA.md).
const ports = devPorts();
const origin = `http://127.0.0.1:${ports.ui}`;
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30000,
  fullyParallel: false,
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 970 },
    // Existing specs assert Korean copy; English coverage lives in i18n.spec.ts.
    locale: 'ko-KR',
    screenshot: 'only-on-failure',
    // Feature specs model a returning user; onboarding.spec.ts exercises a fresh profile.
    storageState: {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [{ name: 'office:onboarding:v1:live', value: 'seen' }],
        },
      ],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: origin,
    reuseExistingServer: false,
    env: {
      AGENT_OFFICE_UI_PORT: String(ports.ui),
      AGENT_OFFICE_API_PORT: String(ports.api),
      AGENT_OFFICE_DATA_DIR: path.resolve('.local/ui-tests/data'),
      CLAUDE_CONFIG_DIR: path.resolve('.local/ui-tests/claude'),
      CODEX_HOME: path.resolve('.local/ui-tests/codex'),
      OPENCLAW_STATE_DIR: path.resolve('.local/ui-tests/openclaw'),
    },
  },
  reporter: 'list',
});
