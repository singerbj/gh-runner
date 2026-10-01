import { readFileSync } from "node:fs";
import { Container, Cpu, RefreshCw, Trash2 } from "lucide-static";
import { defineConfig } from "vitepress";

const REPO = "https://github.com/singerbj/gh-runner";

const { version } = JSON.parse(
  readFileSync(new URL("../../../packages/gh-runner/package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * Lucide icons for the home page features, by name. A feature sets
 * `lucide: <name>` in its frontmatter and gets the SVG inlined at build time.
 */
const ICONS: Readonly<Record<string, string>> = {
  container: Container,
  cpu: Cpu,
  "refresh-cw": RefreshCw,
  "trash-2": Trash2,
};

type Feature = { lucide?: string; icon?: string };

export default defineConfig({
  title: "gh-runner",
  description: "Your machine as a GitHub Actions runner, for as long as the command runs.",
  // GitHub Pages serves the site under /<repo>/. Change this if it moves to a
  // custom domain.
  base: "/gh-runner/",
  srcDir: "docs",
  outDir: "dist",
  cleanUrls: true,
  lastUpdated: false,

  transformPageData({ frontmatter }) {
    const features = frontmatter["features"] as Feature[] | undefined;
    for (const feature of features ?? []) {
      if (!feature.lucide) continue;
      const svg = ICONS[feature.lucide];
      if (!svg) throw new Error(`Unknown lucide icon "${feature.lucide}"; add it to ICONS`);
      feature.icon = svg;
    }
  },

  head: [
    [
      "link",
      {
        rel: "icon",
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%230d1117'/%3E%3Ctext x='50' y='68' font-size='58' text-anchor='middle' fill='%233fb950' font-family='monospace'%3E%3E_%3C/text%3E%3C/svg%3E",
      },
    ],
    ["meta", { property: "og:title", content: "gh-runner" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Your machine as a GitHub Actions runner, for as long as the command runs.",
      },
    ],
  ],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
      {
        text: `v${version}`,
        items: [
          { text: "Releases", link: `${REPO}/releases` },
          { text: "npm", link: "https://www.npmjs.com/package/@singerbj/gh-runner" },
        ],
      },
    ],

    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Platforms & labels", link: "/guide/platforms" },
        ],
      },
      {
        text: "Workflows",
        items: [
          { text: "Setting up a repo", link: "/guide/setup" },
          { text: "Out-of-minutes fallback", link: "/guide/fallback" },
          { text: "Setup with an AI agent", link: "/guide/ai-setup" },
        ],
      },
      {
        text: "Deploy",
        items: [{ text: "Always on with Docker", link: "/guide/docker" }],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/reference/cli" },
          { text: "Programmatic API", link: "/reference/api" },
          { text: "Security", link: "/reference/security" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: REPO },
      { icon: "npm", link: "https://www.npmjs.com/package/@singerbj/gh-runner" },
    ],

    search: { provider: "local" },

    editLink: {
      pattern: `${REPO}/edit/main/apps/web/docs/:path`,
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
    },
  },
});
