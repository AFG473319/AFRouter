// Agent harness Layer 2: browser discovery across platforms with a mocked filesystem.
import { describe, it, expect } from "vitest";
import { candidates, candidatesFor, chooseSpec, normalizeSpec, isPathSpec } from "../../scripts/agent/lib/browsers.mjs";

function fakeFs(files, dirs = {}) {
  const set = new Set(files);
  return {
    exists: (p) => set.has(p),
    readdir: (d) => {
      if (dirs[d]) return dirs[d];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    realpath: (p) => p,
  };
}

const none = () => null;

describe("candidates: Windows", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const userChrome = "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

  it("prefers Edge (ships with Windows 11), then Chrome, then Brave", () => {
    const fs = fakeFs([chrome, edge, brave, userChrome]);
    const list = candidates({ platform: "win32", env, home: "C:\\Users\\a", ...fs, regQuery: none, which: none });
    expect(list.map((c) => c.id)).toEqual(["edge", "chrome", "chrome", "brave"]);
    expect(list[0].path).toBe(edge);
  });

  it("finds browsers through the App Paths registry when not in standard folders", () => {
    const regEdge = "D:\\Apps\\Edge\\msedge.exe";
    const fs = fakeFs([regEdge]);
    const list = candidates({ platform: "win32", env, home: "C:\\Users\\a", ...fs, regQuery: (exe) => (exe === "msedge.exe" ? regEdge : null), which: none });
    expect(list).toEqual([{ id: "edge", path: regEdge, source: "registry" }]);
  });

  it("dedupes the same file found twice (case-insensitive on Windows)", () => {
    const fs = fakeFs([edge, edge.toUpperCase()]);
    const list = candidates({ platform: "win32", env, home: "C:\\Users\\a", ...fs, regQuery: () => edge.toUpperCase(), which: none });
    expect(list).toHaveLength(1);
  });

  it("picks up a Playwright-cached Chromium from %LOCALAPPDATA%", () => {
    const root = "C:\\Users\\a\\AppData\\Local\\ms-playwright";
    const exe = `${root}\\chromium-1200\\chrome-win64\\chrome.exe`;
    const fs = fakeFs([exe], { [root]: ["chromium-1100", "chromium-1200", "ffmpeg-1011"] });
    const list = candidates({ platform: "win32", env, home: "C:\\Users\\a", ...fs, regQuery: none, which: none });
    expect(list).toEqual([{ id: "playwright", path: exe, source: "playwright-cache" }]);
  });

  it("returns nothing on a machine with no Chromium-family browser", () => {
    expect(candidates({ platform: "win32", env, home: "C:\\Users\\a", ...fakeFs([]), regQuery: none, which: none })).toEqual([]);
  });
});

describe("candidates: macOS", () => {
  it("checks /Applications and ~/Applications, Chrome first", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const edge = "/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    const list = candidates({ platform: "darwin", env: {}, home: "/Users/a", ...fakeFs([edge, chrome]), which: none });
    expect(list.map((c) => c.path)).toEqual([chrome, edge]);
  });
});

describe("candidates: Linux", () => {
  it("uses PATH, then standard, snap and flatpak locations, flatpak last within a browser", () => {
    const which = (b) => ({ chromium: "/usr/bin/chromium", "google-chrome-stable": "/usr/bin/google-chrome-stable" })[b] || null;
    const files = ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/snap/bin/chromium", "/var/lib/flatpak/exports/bin/com.google.Chrome"];
    const list = candidates({ platform: "linux", env: { PATH: "/usr/bin" }, home: "/home/a", ...fakeFs(files), which });
    expect(list.map((c) => `${c.id}:${c.source}`)).toEqual(["chrome:PATH", "chrome:flatpak", "chromium:PATH", "chromium:snap"]);
  });

  it("honours PLAYWRIGHT_BROWSERS_PATH and the headless shell layout", () => {
    const root = "/opt/pw";
    const exe = "/opt/pw/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
    const list = candidates({ platform: "linux", env: { PLAYWRIGHT_BROWSERS_PATH: root }, home: "/home/a", ...fakeFs([exe], { [root]: ["chromium_headless_shell-1200"] }), which: none });
    expect(list).toEqual([{ id: "playwright", path: exe, source: "playwright-cache" }]);
  });

  it("collapses wrapper + real binary that resolve to the same file", () => {
    const fs = fakeFs(["/usr/bin/chromium", "/usr/lib/chromium/chromium"]);
    fs.realpath = () => "/usr/lib/chromium/chromium";
    const list = candidates({ platform: "linux", env: {}, home: "/home/a", ...fs, which: (b) => (b === "chromium" ? "/usr/bin/chromium" : null) });
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe("/usr/bin/chromium");
  });
});

describe("choosing a browser", () => {
  it("normalizes names and aliases", () => {
    expect(normalizeSpec(undefined)).toBe("auto");
    expect(normalizeSpec("MSEdge")).toBe("edge");
    expect(normalizeSpec("google-chrome")).toBe("chrome");
    expect(normalizeSpec("C:\\x\\chrome.exe")).toBe("C:\\x\\chrome.exe");
    expect(isPathSpec("brave")).toBe(false);
    expect(isPathSpec("/usr/bin/brave")).toBe(true);
  });

  it("precedence: flag > PATH env > name env > config > auto", () => {
    const env = { AFROUTER_HARNESS_BROWSER_PATH: "/p/chrome", AFROUTER_HARNESS_BROWSER: "edge" };
    const config = { browser: "brave", _file: "cfg.json" };
    expect(chooseSpec({ flag: "chromium", env, config })).toEqual({ spec: "chromium", from: "flag" });
    expect(chooseSpec({ env, config })).toEqual({ spec: "/p/chrome", from: "env:AFROUTER_HARNESS_BROWSER_PATH" });
    expect(chooseSpec({ env: { AFROUTER_HARNESS_BROWSER: "edge" }, config })).toEqual({ spec: "edge", from: "env:AFROUTER_HARNESS_BROWSER" });
    expect(chooseSpec({ env: {}, config })).toEqual({ spec: "brave", from: "config:cfg.json" });
    expect(chooseSpec({ env: {}, config: {} })).toEqual({ spec: "auto", from: "default" });
    expect(chooseSpec({ flag: true, env: {}, config: {} }).spec).toBe("auto");
  });

  it("a path spec is used as-is; a name filters the detected list", () => {
    expect(candidatesFor("/x/brave")).toEqual([{ id: "custom", path: "/x/brave", source: "user" }]);
    const opts = { platform: "linux", env: {}, home: "/h", ...fakeFs(["/opt/google/chrome/chrome", "/usr/bin/chromium"]), which: none };
    expect(candidatesFor("chromium", opts).map((c) => c.path)).toEqual(["/usr/bin/chromium"]);
    expect(candidatesFor("auto", opts)).toHaveLength(2);
  });
});
