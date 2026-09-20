import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import {
  isSystemOneModelRef,
  validateSystemOneProbe,
} from "../../src/app/api/models/test/ping.js";
import { validateSystemOneBody } from "../../src/app/api/v1/systemone/route.js";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

describe("Jev SystemOne models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("registers only the free jev id with the systemone target format", () => {
    expect(getModelTargetFormat("oc", "jev-1.13-free")).toBe("systemone");
    // The paid jev-1.13 needs a Zen API key, so it must not be advertised
    // under the noAuth OpenCode Free provider.
    expect(getModelTargetFormat("oc", "jev-1.13")).toBeNull();
    // Normal models keep their own format — the guard must not catch them.
    expect(getModelTargetFormat("oc", "jev-1.13-free")).not.toBe("openai-responses");
    expect(getModelTargetFormat("oc", "muse-spark-1.3-contributor-free")).toBe("openai-responses");
  });

  it("detects systemone refs without catching normal models", () => {
    expect(isSystemOneModelRef("oc/jev-1.13")).toBe(false);
    expect(isSystemOneModelRef("oc/jev-1.13-free")).toBe(true);
    expect(isSystemOneModelRef("oc/jev-1.13-free(high)")).toBe(true);
    expect(isSystemOneModelRef("oc/muse-spark-1.3-contributor-free")).toBe(false);
    expect(isSystemOneModelRef("openai/gpt-5")).toBe(false);
    expect(isSystemOneModelRef("jev-1.13")).toBe(false);
    expect(isSystemOneModelRef("")).toBe(false);
  });

  it("validates typed systemone answers, not chat choices", () => {
    expect(validateSystemOneProbe({ answers: { ping: { type: "noul", noul: 0.97 } } })).toBe(true);
    expect(
      validateSystemOneProbe({ answers: { dept: { type: "choice", choice: "billing", probabilities: { billing: 1 } } } })
    ).toBe(true);
    expect(validateSystemOneProbe({ answers: { risk: { type: "score", score: 1.05 } } })).toBe(true);
    expect(validateSystemOneProbe({ choices: [{ message: { content: "hi" } }] })).toBe(false);
    expect(validateSystemOneProbe({ answers: {} })).toBe(false);
    expect(validateSystemOneProbe({ answers: { ping: { type: "noul", noul: 7 } } })).toBe(false);
    expect(validateSystemOneProbe(null)).toBe(false);
  });

  it("validates systemone request bodies", () => {
    const good = {
      model: "oc/jev-1.13-free",
      state: "Help! My payouts have been failing for 3 days.",
      questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } },
    };
    expect(validateSystemOneBody(good)).toBeNull();
    expect(validateSystemOneBody({ ...good, questions: {} })).toMatch(/at least one/);
    expect(validateSystemOneBody({ ...good, state: undefined })).toMatch(/Missing state/);
    expect(validateSystemOneBody({ ...good, questions: { q: { type: "chat", instructions: "x" } } })).toMatch(/noul, choice, score/);
    expect(
      validateSystemOneBody({ ...good, questions: { q: { type: "choice", instructions: "x", criteria: {} } } })
    ).toMatch(/non-empty criteria map/);
    expect(
      validateSystemOneBody({ ...good, questions: { q: { type: "score", instructions: "x", criteria: ["low"] } } })
    ).toMatch(/2 to 10/);
    expect(validateSystemOneBody({ ...good, model: undefined })).toMatch(/Missing model/);
  });

  it("routes the opencode executor to /zen/v1/systemone for Jev", () => {
    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("jev-1.13-free")).toBe("https://opencode.ai/zen/v1/systemone");
    expect(ex.buildUrl("gpt-5.5")).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("leaves systemone bodies untouched in transformRequest", () => {
    const ex = new OpenCodeExecutor();
    const sysBody = {
      model: "jev-1.13-free",
      state: "ping",
      questions: { ping: { type: "noul", instructions: "Is this a check?" } },
    };
    const out = ex.transformRequest("jev-1.13-free", sysBody, false, {});
    expect(out.tools).toBeUndefined();
    expect(out.stream).toBeUndefined();
    expect(out.questions.ping.type).toBe("noul");
  });

  it("pings Jev via /api/v1/systemone and expects typed answers", async () => {
    const calls = [];
    global.fetch = vi.fn((url, opts) => {
      calls.push([String(url), opts]);
      return Promise.resolve(
        new Response(
          JSON.stringify({ model: "jev-1.13.0", answers: { ping: { type: "noul", noul: 0.99 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    });

    const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
    const result = await pingModelByKind("oc/jev-1.13-free", "llm", "http://127.0.0.1:20128");

    expect(result.ok).toBe(true);
    expect(result.note).toBe("systemone decision probe");
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toContain("/api/v1/systemone");
    const sent = JSON.parse(calls[0][1].body);
    expect(sent.questions.ping.type).toBe("noul");
    expect(sent.state).toBeTruthy();
  });

  it("fails the Jev ping when upstream returns no typed answers", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
    const result = await pingModelByKind("oc/jev-1.13-free", "llm", "http://127.0.0.1:20128");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no typed answers/);
  });
});
