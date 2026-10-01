import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1320, height: 920 },
    colorScheme: "dark",
    screenshot: "only-on-failure",
  },
  outputDir: "./test-results",
  reporter: "list",
});
