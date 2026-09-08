import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(appRoot, "src"),
  publicDir: false,
  resolve: {
    alias: {
      path: "path-browserify",
    },
  },
  build: {
    outDir: path.join(appRoot, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pet: path.join(appRoot, "src", "index.html"),
        main: path.join(appRoot, "src", "main.html"),
        agent: path.join(appRoot, "src", "agent.html"),
      },
    },
  },
  plugins: [
    {
      name: "copy-pet-assets",
      async closeBundle() {
        await cp(path.join(appRoot, "src", "assets"), path.join(appRoot, "dist", "assets"), {
          recursive: true,
        });
      },
    },
  ],
});
