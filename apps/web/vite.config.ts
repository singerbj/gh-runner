import { defineConfig } from "vite";

export default defineConfig({
  // Relative so the same build works at a domain root and under a
  // /<repo>/ path on GitHub Pages.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
