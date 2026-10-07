import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 970 },
    // Existing specs assert Korean copy; English coverage lives in i18n.spec.ts.
    locale: 'ko-KR',
    screenshot: 'only-on-failure',
    // Feature specs model a returning user; onboarding.spec.ts exercises a fresh profile.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5173',
          localStorage: [{ name: 'office:onboarding:v1:live', value: 'seen' }],
        },
      ],
    },
  },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
  reporter: 'list',
});
