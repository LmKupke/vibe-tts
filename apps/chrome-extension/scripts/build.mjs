import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { build as viteBuild } from "vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(appRoot, "dist");
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const viteResult = await viteBuild({
  configFile: resolve(appRoot, "vite.config.ts"),
  build: watch ? { watch: {} } : undefined,
});

const bundleOptions = {
  bundle: true,
  sourcemap: true,
  platform: "browser",
  target: "chrome120",
  format: "iife",
  logLevel: "info",
};

const background = await esbuild.context({
  ...bundleOptions,
  entryPoints: [resolve(appRoot, "src/background/index.ts")],
  outfile: resolve(dist, "background.js"),
});
const content = await esbuild.context({
  ...bundleOptions,
  entryPoints: [resolve(appRoot, "src/content/index.ts")],
  outfile: resolve(dist, "content.js"),
});
const mermaid = await esbuild.context({
  ...bundleOptions,
  entryPoints: [resolve(appRoot, "src/content/mermaid-entry.ts")],
  outfile: resolve(dist, "mermaid.js"),
  minify: true,
  sourcemap: false,
  legalComments: "inline",
});

if (watch) {
  await Promise.all([background.watch(), content.watch(), mermaid.watch()]);
} else {
  await Promise.all([background.rebuild(), content.rebuild(), mermaid.rebuild()]);
  await Promise.all([background.dispose(), content.dispose(), mermaid.dispose()]);
}

await cp(resolve(appRoot, "public/manifest.json"), resolve(dist, "manifest.json"));

if (!watch && "close" in viteResult && typeof viteResult.close === "function") {
  await viteResult.close();
}
