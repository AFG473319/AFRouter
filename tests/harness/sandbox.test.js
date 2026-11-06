// Agent harness: isolation guarantees, route mapping, change detection, outline, fake upstream.
import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { buildEnv, assertSafeDataDir, realDataDir } from "../../scripts/agent/lib/server.mjs";
import { routeFromPageFile, routesForChangedFiles, apiRoutesForChangedFiles, resolveRoute } from "../../scripts/agent/lib/routes.mjs";
import { parseHunks, inRanges } from "../../scripts/agent/lib/changed.mjs";
import { outlineHtml } from "../../scripts/agent/lib/page.mjs";
import { nextErrorMarkers } from "../../scripts/agent/lib/outline.mjs";
import { summarizeResults } from "../../scripts/agent/lib/vitest.mjs";
import { resolveSpec } from "../../scripts/agent/lib/related.mjs";
import { createFakeUpstream } from "../../scripts/agent/lib/fakeUpstream.mjs";
import { assertReadOnlySql } from "../../scripts/agent/lib/state.mjs";
import { RESERVED_PORTS, freePort } from "../../scripts/agent/lib/proc.mjs";

describe("sandbox isolation", () => {
  const paths = { dataDir: "/tmp/afr/data", homeDir: "/tmp/afr/home" };

  it("points every home/data variable at the sandbox and drops secrets from the parent env", () => {
    const parent = { PATH: "/usr/bin", HOME: "/home/real", JWT_SECRET: "real", DATA_DIR: "/home/real/.afrouter", OPENCODE_CONFIG: "/home/real/oc.json", HTTPS_PROXY: "http://p:1" };
    const env = buildEnv({ parentEnv: parent, paths, port: 41234, platform: "linux" });
    expect(env).toMatchObject({ HOME: "/tmp/afr/home", USERPROFILE: "/tmp/afr/home", DATA_DIR: "/tmp/afr/data", PORT: "41234", HOSTNAME: "127.0.0.1", NEXT_DIST_DIR: ".next-agent", PATH: "/usr/bin", HTTPS_PROXY: "http://p:1" });
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.INITIAL_PASSWORD).toMatch(/^[0-9a-f]{24}$/);
  });

  it("redirects APPDATA/LOCALAPPDATA on Windows", () => {
    const env = buildEnv({ parentEnv: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, paths: { dataDir: "C:\\t\\data", homeDir: "C:\\t\\home" }, port: 1, platform: "win32" });
    expect(env.APPDATA).toBe(path.join("C:\\t\\home", "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(path.join("C:\\t\\home", "AppData", "Local"));
  });

  it("refuses the real data dir and Unix paths on Windows (dataDir.js would silently fall back)", () => {
    const winEnv = { APPDATA: "C:\\Users\\a\\AppData\\Roaming" };
    expect(realDataDir("win32", winEnv, "C:\\Users\\a")).toBe("C:\\Users\\a\\AppData\\Roaming\\afrouter");
    expect(() => assertSafeDataDir("C:\\Users\\a\\AppData\\Roaming\\afrouter", { platform: "win32", env: winEnv, home: "C:\\Users\\a" })).toThrow(/real AFRouter data dir/);
    expect(() => assertSafeDataDir("C:\\Users\\a\\AppData\\Roaming\\AFROUTER\\db", { platform: "win32", env: winEnv, home: "C:\\Users\\a" })).toThrow(/real/);
    expect(() => assertSafeDataDir("/var/lib/afrouter", { platform: "win32", env: winEnv, home: "C:\\Users\\a" })).toThrow();
    expect(assertSafeDataDir("C:\\Temp\\afrouter-agent\\x\\data", { platform: "win32", env: winEnv, home: "C:\\Users\\a" })).toBe(true);
    expect(() => assertSafeDataDir("/home/a/.afrouter", { platform: "linux", env: {}, home: "/home/a" })).toThrow(/real/);
    expect(() => assertSafeDataDir("relative/data", { platform: "linux", env: {}, home: "/home/a" })).toThrow(/absolute/);
  });

  it("never hands out the user's real AFRouter port", async () => {
    expect(RESERVED_PORTS.has(20128)).toBe(true);
    const p = await freePort();
    expect(RESERVED_PORTS.has(p)).toBe(false);
  });

  it("only allows read-only SQL in state --sql", () => {
    expect(() => assertReadOnlySql("SELECT * FROM settings")).not.toThrow();
    expect(() => assertReadOnlySql("pragma table_info(settings)")).not.toThrow();
    expect(() => assertReadOnlySql("DELETE FROM settings")).toThrow();
    expect(() => assertReadOnlySql("SELECT 1; DROP TABLE settings")).toThrow();
  });
});

describe("routes", () => {
  it("strips route groups and keeps dynamic segments", () => {
    expect(routeFromPageFile("(dashboard)/dashboard/providers/page.js")).toBe("/dashboard/providers");
    expect(routeFromPageFile("(dashboard)/dashboard/providers/[id]/page.js")).toBe("/dashboard/providers/[id]");
    expect(routeFromPageFile("page.js")).toBe("/");
  });

  it("maps changed files to the pages and API routes they affect", () => {
    const pages = [
      { route: "/dashboard/providers", file: "src/app/(dashboard)/dashboard/providers/page.js" },
      { route: "/dashboard/usage", file: "src/app/(dashboard)/dashboard/usage/page.js" },
    ];
    expect(routesForChangedFiles(["src/app/(dashboard)/dashboard/usage/components/Chart.js", "src/shared/components/Card.js", "open-sse/x.js"], pages).sort()).toEqual(["/dashboard", "/dashboard/usage"]);
    expect(apiRoutesForChangedFiles(["src/app/api/keys/route.js", "src/app/api/keys/[id]/route.js", "src/lib/x.js"])).toEqual(["/api/keys", "/api/keys/[id]"]);
  });

  it("fills dynamic routes from the seeded sandbox, or skips them", () => {
    expect(resolveRoute("/dashboard/providers/[id]", { providerId: "openai-compatible-chat-1" })).toBe("/dashboard/providers/openai-compatible-chat-1");
    expect(resolveRoute("/dashboard/media-providers/combo/[id]", {})).toBeNull();
    expect(resolveRoute("/dashboard", {})).toBe("/dashboard");
  });
});

describe("changed lines", () => {
  it("parses -U0 hunks for the new side", () => {
    const diff = ["diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js", "@@ -1,0 +2,3 @@", "+a", "@@ -10 +14 @@", "-b", "+c", "@@ -20,2 +23,0 @@"].join("\n");
    const r = parseHunks(diff);
    expect(r["x.js"]).toEqual([[2, 4], [14, 14]]);
    expect(inRanges(r["x.js"], 3)).toBe(true);
    expect(inRanges(r["x.js"], 10)).toBe(false);
  });
});

describe("outline", () => {
  it("renders landmarks, names, values and states compactly", () => {
    const html = `<html><head><title>T</title></head><body>
      <nav><a href="/a"><span class="material-symbols-outlined">dns</span>Providers</a></nav>
      <main><h1>Title</h1><p>Some text</p>
        <label for="n">Name</label><input id="n" value="abc">
        <input type="password" aria-label="Pass" value="secret">
        <input type="checkbox" aria-label="On" checked>
        <button disabled>Save</button><button><span class="material-symbols-outlined">menu</span></button>
        <div hidden><button>Hidden</button></div><script>var x</script>
      </main></body></html>`;
    const o = outlineHtml(html);
    expect(o.title).toBe("T");
    expect(o.lines).toEqual([
      "- navigation",
      '  - link "Providers" /a',
      "- main",
      '  - heading[1] "Title"',
      "  - text: Some text",
      '  - text: Name',
      '  - textbox "Name" value="abc"',
      '  - textbox "Pass" value="••••"',
      '  - checkbox "On" [checked]',
      '  - button "Save" [disabled]',
      '  - button "menu"',
    ]);
  });

  it("collapses repeated blocks (responsive duplicate navs)", () => {
    const nav = "<nav><a href='/1'>One</a><a href='/2'>Two</a><a href='/3'>Three</a><a href='/4'>Four</a></nav>";
    const o = outlineHtml(`<body>${nav}${nav}</body>`);
    expect(o.lines.filter((l) => l.includes('link "One"'))).toHaveLength(1);
    expect(o.lines.at(-1)).toMatch(/repeat of an earlier 4-line block/);
  });

  it("masks key-looking textbox values", () => {
    const o = outlineHtml('<input aria-label="k" value="sk-abcdefghijklmnopqrstu">');
    expect(o.lines[0]).toBe('- textbox "k" value="sk-abc…rstu"');
  });

  it("detects Next error markers", () => {
    expect(nextErrorMarkers('<html id="__next_error__"><template data-next-error-message="boom" data-next-error-digest="123">')).toEqual(["next-error-page", "error: boom", "digest: 123"]);
    expect(nextErrorMarkers("<html><body>fine</body></html>")).toEqual([]);
  });
});

describe("vitest results vs known-fails baseline", () => {
  it("separates regressions from known failures and load errors", () => {
    const json = {
      numPassedTests: 5, numFailedTests: 2, numTotalTests: 7,
      testResults: [
        { name: "/r/tests/unit/a.test.js", status: "failed", assertionResults: [{ status: "failed", fullName: "a known", failureMessages: ["x"] }, { status: "failed", fullName: "a new", failureMessages: ["Error: nope\n at"] }] },
        { name: "C:\\r\\tests\\unit\\b.test.js", status: "failed", message: "Cannot find module", assertionResults: [] },
      ],
    };
    const s = summarizeResults(json, new Set(["tests/unit/a.test.js :: a known"]));
    expect(s.regressions).toBe(2);
    expect(s.knownFailures).toBe(1);
    expect(s.failures[0]).toMatchObject({ id: "tests/unit/a.test.js :: a new", message: "Error: nope" });
    expect(s.failures[1].id).toBe("tests/unit/b.test.js :: (file failed to load)");
  });
});

describe("related tests import resolution", () => {
  it("resolves relative, @/ and open-sse specifiers with extension inference", () => {
    const exists = (p) => p.endsWith(path.join("src", "lib", "x.js")) || p.endsWith(path.join("open-sse", "y", "index.js")) || p.endsWith(path.join("tests", "z.js"));
    expect(resolveSpec("@/lib/x", "/r/src/a.js", exists)).toMatch(/src[\\/]lib[\\/]x\.js$/);
    expect(resolveSpec("open-sse/y", "/r/tests/t.test.js", exists)).toMatch(/open-sse[\\/]y[\\/]index\.js$/);
    expect(resolveSpec("./z.js", "/r/tests/t.test.js", exists)).toBe(path.resolve("/r/tests/z.js"));
    expect(resolveSpec("react", "/r/src/a.js", exists)).toBeNull();
  });
});

describe("fake upstream", () => {
  const { server } = createFakeUpstream();
  let base;
  afterAll(() => new Promise((r) => server.close(r)));

  it("serves scenarios selected by model name and records requests", async () => {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    const post = (model, extra = {}) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...extra }) });

    const ok = await (await post("fake-ok")).json();
    expect(ok.choices[0].message.content).toBe("fake reply: hello");
    expect((await post("fake-429")).status).toBe(429);
    expect((await post("fake-500")).status).toBe(500);
    const tools = await (await post("fake-tools", { tools: [{ type: "function", function: { name: "lookup" } }] })).json();
    expect(tools.choices[0].message.tool_calls[0].function.name).toBe("lookup");
    const stream = await (await post("fake-malformed", { stream: true })).text();
    expect(stream).toContain('data: {"broken": ');
    expect(stream.trim().endsWith("data: [DONE]")).toBe(true);

    const rec = await (await fetch(`${base}/__requests`)).json();
    expect(rec.requests.at(-1)).toMatchObject({ model: "fake-malformed", stream: true, messages: 1, hasAuth: true });
    expect(JSON.stringify(rec)).not.toContain("Bearer x");
  });
});
