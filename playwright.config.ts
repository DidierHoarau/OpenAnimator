import { defineConfig } from '@playwright/test'

/**
 * E2E suite driving the built Electron app (`npm run build` first). The suite
 * is serial: every instance shares the userData directory (recent projects,
 * library, recovery snapshots), and the app holds a single-instance lock.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  outputDir: '.tmp/e2e',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})
