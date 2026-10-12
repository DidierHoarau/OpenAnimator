import { defineConfig } from '@playwright/test'

/**
 * E2E suite driving the built Electron app (`npm run build` first). The suite
 * is serial (the app holds a single-instance lock); every test gets a fresh
 * instance with its own private userData directory, so recent projects,
 * library data and recovery snapshots cannot leak across tests.
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
