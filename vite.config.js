import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const isGitHubPages = process.env.VITE_GITHUB_PAGES === "true";

const githubPagesBuildOptions = isGitHubPages
  ? {
      // Pages publishes the app shell only; the local Nimble model stays out of its artifact.
      publicDir: false,
      plugins: [
        {
          name: "emit-pages-service-worker",
          async generateBundle() {
            this.emitFile({
              type: "asset",
              fileName: "sw.js",
              source: await readFile(
                fileURLToPath(new URL("./public/sw.js", import.meta.url)),
              ),
            });
          },
        },
      ],
    }
  : {};

export default defineConfig({
  base: isGitHubPages ? "/jevweb/" : "/",
  ...githubPagesBuildOptions,
  optimizeDeps: {
    include: ["@wllama/wllama"],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  worker: {
    format: "es",
  },
});
