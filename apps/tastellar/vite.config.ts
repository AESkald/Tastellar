import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_"],
  optimizeDeps: {
    include: [
      "@tauri-apps/api/core",
      "@tauri-apps/api/window",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-clipboard-manager",
    ],
  },
  build: { target: "safari15", sourcemap: true },
});
