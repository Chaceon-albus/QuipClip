import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath } from "vite";
// This import also adds the `test` key to the Vite config type.
import { configDefaults } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

// The agent workspace of this checkout. The watcher tests absolute paths, and an agent
// worktree is itself under `.claude`, so a `**/.claude/**` glob would ignore every file
// of a dev server that runs in a worktree. Match only this root's own `.claude`.
const agentDir = normalizePath(path.resolve(import.meta.dirname, ".claude"));
const isAgentPath = (file: string) =>
  file === agentDir || file.startsWith(`${agentDir}/`);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or
  // `tauri build`.
  //
  // 1. Prevent Vite from hiding Rust errors.
  clearScreen: false,
  // 2. Tauri expects a fixed port and must fail if that port is not free.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. Tell Vite not to watch `src-tauri` or the agent worktrees under `.claude`.
      ignored: ["**/src-tauri/**", isAgentPath],
    },
  },

  build: {
    // Tauri loads the bundle from the application, not over a network, so the 500 kB
    // web default does not apply and code splitting saves no download time. The limit
    // stays as an alarm for an unexpected size increase, set about 40 percent above the
    // current entry chunk. When the warning fires, find what grew before you raise the
    // limit again.
    chunkSizeWarningLimit: 1200,
  },

  test: {
    // Agent worktrees under `.claude` are full copies of the repository. Keep their
    // test files out of this run, and keep the default excludes.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
}));
