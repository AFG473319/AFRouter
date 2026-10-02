import { describe, it, expect, vi, afterAll } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

const realFetch = global.fetch;
afterAll(() => {
  global.fetch = realFetch;
});

const feed = (free) => ({
  ok: true,
  json: async () => ({
    recommended: [],
    free,
    clinePass: [],
    clineCloud: [],
  }),
});

const { GET } = await import("../../src/app/api/providers/cline/free-models/route.js");

describe("GET /api/providers/cline/free-models", () => {
  it("returns the feed's free[] models", async () => {
    global.fetch = () =>
      Promise.resolve(
        feed([
          { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash", description: "Fast", tags: [] },
          { id: "stealth/space-bunny-alpha", name: "space-bunny-alpha", description: "", tags: [] },
        ])
      );
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
      { id: "stealth/space-bunny-alpha", name: "space-bunny-alpha" },
    ]);
  });

  it("502s when the feed is unreachable", async () => {
    global.fetch = () => Promise.reject(new Error("offline test"));
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it("502s on a non-OK upstream response", async () => {
    global.fetch = () => Promise.resolve({ ok: false, status: 500 });
    const res = await GET();
    expect(res.status).toBe(502);
  });
});
