// Agent harness: JSON output contract (bound/out), argv parsing, SSE parsing, Next MCP framing.
import { describe, it, expect, vi } from "vitest";
import { bound, byteLength, clampDeep, truncateString, MAX_BYTES } from "../../scripts/agent/lib/bound.mjs";
import { emit } from "../../scripts/agent/lib/out.mjs";
import { parseArgs, list, num } from "../../scripts/agent/lib/args.mjs";
import { parseSse, assemble } from "../../scripts/agent/lib/chat.mjs";
import { parseRpc, summarizeNextErrors } from "../../scripts/agent/lib/nextMcp.mjs";
import { classify } from "../../scripts/agent/lib/logs.mjs";
import { summarize, authHeaders, isLlmPath } from "../../scripts/agent/lib/http.mjs";

const big = (n, s = "x".repeat(400)) => Array.from({ length: n }, (_, i) => `${i} ${s}`);

describe("bound", () => {
  it("leaves small results untouched", () => {
    const r = { ok: true, cmd: "x", outline: ["- main"] };
    expect(bound(r)).toEqual(r);
  });

  it("stays under the byte cap and sheds noise before locators", () => {
    const r = { ok: false, cmd: "page", logTail: big(200), console: big(200), outline: big(30, "o".repeat(100)) };
    const out = bound(r);
    expect(byteLength(out)).toBeLessThanOrEqual(MAX_BYTES);
    expect(out.outline.length).toBe(30); // refs survive
    const fields = out.omitted.map((o) => o.field);
    expect(fields).toContain("logTail");
    expect(out.omitted.every((o) => typeof o.hint === "string")).toBe(true);
  });

  it("keeps the newest log lines", () => {
    const out = bound({ ok: true, logTail: big(400) }, { maxBytes: 4000 });
    const last = out.logTail[out.logTail.length - 1];
    expect(last.startsWith("399 ")).toBe(true);
  });

  it("shrinks nested per-page fields, largest page first", () => {
    const r = { ok: true, pages: [{ route: "/a", outline: big(10, "a".repeat(50)), console: big(100) }, { route: "/b", outline: ["- main"], console: big(5) }] };
    const out = bound(r, { maxBytes: 6000 });
    expect(byteLength(out)).toBeLessThanOrEqual(6000);
    expect(out.pages[1].route).toBe("/b");
    expect(out.omitted.some((o) => o.field.startsWith("pages[0].console"))).toBe(true);
  });

  it("falls back to verdict fields when nothing else fits", () => {
    const out = bound({ ok: false, cmd: "check", error: "boom", weird: big(500) }, { maxBytes: 300 });
    expect(out).toMatchObject({ ok: false, cmd: "check", error: "boom" });
    expect(out.omitted.at(-1).field).toBe("*");
  });

  it("clamps long strings and arrays individually", () => {
    expect(truncateString("a".repeat(2000)).length).toBeLessThan(1600);
    const c = clampDeep({ arr: Array.from({ length: 400 }, (_, i) => i) });
    expect(c.arr.length).toBe(301);
    expect(c.arr.at(-1)).toMatch(/\+100 more/);
  });
});

describe("emit", () => {
  it("prints exactly one JSON line and sets exit code on failure", () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    const prev = process.exitCode;
    try {
      emit({ ok: false, cmd: "t" });
      expect(writes).toHaveLength(1);
      expect(writes[0].trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(writes[0])).toMatchObject({ ok: false, cmd: "t" });
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = prev;
    }
  });
});

describe("parseArgs", () => {
  it("parses positionals, flags, values, negation, short flags and passthrough", () => {
    const a = parseArgs(["api", "POST", "/api/keys", "--data", '{"name":"x"}', "--no-stream", "--pretty", "-t", "my test", "--files=a.js,b.js", "--", "--raw"]);
    expect(a._).toEqual(["api", "POST", "/api/keys"]);
    expect(a.data).toBe('{"name":"x"}');
    expect(a.stream).toBe(false);
    expect(a.pretty).toBe(true);
    expect(a.testName).toBe("my test");
    expect(list(a.files)).toEqual(["a.js", "b.js"]);
    expect(a.passthrough).toEqual(["--raw"]);
  });

  it("collects repeated flags and camel-cases names", () => {
    const a = parseArgs(["--header", "a: 1", "--header", "b: 2", "--update-baseline"]);
    expect(a.header).toEqual(["a: 1", "b: 2"]);
    expect(a.updateBaseline).toBe(true);
    expect(num("5", 1)).toBe(5);
    expect(num(true, 1)).toBe(1);
  });
});

describe("SSE parsing (chat)", () => {
  it("assembles OpenAI chunks and spots malformed ones", () => {
    const text = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"broken": ',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"total_tokens":3}}',
      "data: [DONE]",
    ].join("\n\n");
    const a = assemble(parseSse(text));
    expect(a).toMatchObject({ text: "Hello", finish: "stop", malformed: 1, done: true, usage: { total_tokens: 3 } });
  });

  it("assembles Anthropic events including tool use", () => {
    const text = [
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"lookup"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    ].join("\n\n");
    expect(assemble(parseSse(text))).toMatchObject({ text: "hi", finish: "tool_use", toolCalls: ["lookup"] });
  });
});

describe("Next /_next/mcp", () => {
  it("parses SSE-framed and plain JSON-RPC", () => {
    expect(parseRpc('event: message\ndata: {"result":{"ok":1}}\n\n')).toEqual({ result: { ok: 1 } });
    expect(parseRpc('{"result":2}')).toEqual({ result: 2 });
  });

  it("summarizes error payloads of either shape", () => {
    expect(summarizeNextErrors("No errors detected")).toEqual([]);
    expect(summarizeNextErrors({ errors: [{ type: "build", message: "Module not found", source: "src/x.js" }] })).toEqual(["build: Module not found: src/x.js"]);
  });
});

describe("server log classification", () => {
  it("keeps errors with their first stack frame and ignores sandbox noise", () => {
    const log = ["⚠ Slow filesystem detected. The benchmark took 230ms.", " GET /api/health 200 in 5ms", "TypeError: x is not a function", "    at foo (src/a.js:1:2)", "⚠ something deprecated"].join("\n");
    const c = classify(log);
    expect(c.errors).toEqual(["TypeError: x is not a function | at foo (src/a.js:1:2)"]);
    expect(c.warnings).toHaveLength(1);
  });
});

describe("http helpers", () => {
  it("redacts secrets and shrinks lists", () => {
    const s = summarize({ apiKey: "sk-123", nested: { password: "p", ok: 1 }, list: Array.from({ length: 30 }, (_, i) => i) });
    expect(s.apiKey).toBe("[redacted]");
    expect(s.nested).toEqual({ password: "[redacted]", ok: 1 });
    expect(s.list).toHaveLength(21);
  });

  it("uses the API key for LLM paths and the session cookie elsewhere", () => {
    const state = { apiKey: "k", token: "t" };
    expect(isLlmPath("/v1/chat/completions")).toBe(true);
    expect(isLlmPath("/api/v1beta/models")).toBe(true);
    expect(isLlmPath("/api/keys")).toBe(false);
    expect(authHeaders(state, "/v1/models")).toEqual({ authorization: "Bearer k" });
    expect(authHeaders(state, "/api/keys")).toEqual({ cookie: "auth_token=t" });
    expect(authHeaders(state, "/api/keys", "none")).toEqual({});
  });
});
