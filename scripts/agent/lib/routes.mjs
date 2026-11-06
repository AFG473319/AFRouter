// Discover App Router pages from src/app and map changed files to the routes they affect.
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.mjs";

const APP_DIR = path.join(REPO_ROOT, "src", "app");

// Sample params for dynamic dashboard routes (resolved against the seeded sandbox).
export const DYNAMIC_SAMPLES = {
  "/dashboard/providers/[id]": (s) => s?.providerId,
  "/dashboard/cli-tools/[toolId]": () => "claude",
  "/dashboard/media-providers/[kind]": () => "embedding",
  "/dashboard/media-providers/[kind]/[id]": () => null,
  "/dashboard/media-providers/combo/[id]": () => null,
};

export function routeFromPageFile(relFile) {
  // relFile: path relative to src/app using "/" separators, ending in page.js
  const dir = relFile.replace(/\\/g, "/").replace(/(^|\/)page\.(js|jsx|mjs)$/, "");
  const segs = dir.split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return `/${segs.join("/")}`.replace(/\/+$/, "") || "/";
}

export function listPages(appDir = APP_DIR) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/^page\.(js|jsx|mjs)$/.test(ent.name)) {
        const rel = path.relative(appDir, p).split(path.sep).join("/");
        const route = routeFromPageFile(rel);
        out.push({ route, file: path.relative(REPO_ROOT, p).split(path.sep).join("/"), dynamic: route.includes("[") });
      }
    }
  };
  walk(appDir);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

export function resolveRoute(route, state) {
  if (!route.includes("[")) return route;
  const sample = DYNAMIC_SAMPLES[route];
  const value = sample ? sample(state) : null;
  if (!value) return null;
  return route.replace(/\[[^\]]+\]/, encodeURIComponent(value));
}

// Which routes does a changed file touch? Files inside a route's directory map to the
// nearest page at or above them; shared UI maps to /dashboard as a smoke target.
export function routesForChangedFiles(files, pages = listPages()) {
  const routes = new Set();
  for (const f of files) {
    const norm = f.replace(/\\/g, "/");
    if (!norm.startsWith("src/")) continue;
    if (norm.startsWith("src/app/") && !norm.startsWith("src/app/api/")) {
      let dir = path.posix.dirname(norm);
      let match = null;
      while (dir.startsWith("src/app")) {
        match = pages.find((p) => path.posix.dirname(p.file) === dir);
        if (match) break;
        dir = path.posix.dirname(dir);
      }
      if (match) routes.add(match.route);
    } else if (/^src\/(shared|store|i18n)\//.test(norm) || /\.css$/.test(norm)) {
      routes.add("/dashboard");
    }
  }
  return [...routes];
}

export function apiRoutesForChangedFiles(files) {
  return files
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => /^src\/app\/api\/.+\/route\.js$/.test(f))
    .map((f) => f.replace(/^src\/app/, "").replace(/\/route\.js$/, ""));
}
