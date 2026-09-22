import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import {
  isSystemOneModelRef,
  validateSystemOneProbe,
} from "../../src/app/api/models/test/ping.js";
import {
  validateSystemOneBody,
  extractSystemOneTokens,
  recordSystemOneLogs,
  POST,
} from "../../src/app/api/v1/systemone/route.js";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getSettings: vi.fn(),
  getConsistentMachineId: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getExecutor: vi.fn(),
  proxyAwareFetch: vi.fn(),
  saveRequestUsage: vi.fn(),
  saveRequestDetail: vi.fn(),
  trackPendingRequest: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/usageDb", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  saveRequestDetail: mocks.saveRequestDetail,
  trackPendingRequest: mocks.trackPendingRequest,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
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

function systemOneRequest(body) {
  return new Request("http://127.0.0.1:20128/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  model: "oc/jev-1.13-free",
  state: "Help! My payouts have been failing for 3 days.",
  questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } },
};

describe("Jev SystemOne models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.extractApiKey.mockReturnValue(undefined);
    mocks.clearAccountError.mockResolvedValue(undefined);
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.saveRequestDetail.mockResolvedValue(undefined);
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

describe("Jev SystemOne request logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.extractApiKey.mockReturnValue(undefined);
    mocks.clearAccountError.mockResolvedValue(undefined);
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.saveRequestDetail.mockResolvedValue(undefined);
  });

  it("extracts TypeSafe usage into prompt/completion token columns", () => {
    expect(
      extractSystemOneTokens({ usage: { input_tokens: 425, output_tokens: 73 } })
    ).toEqual({ prompt_tokens: 425, completion_tokens: 73 });
    expect(extractSystemOneTokens({ usage: { input_tokens: 10, output_tokens: null } })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 0,
    });
    expect(extractSystemOneTokens({})).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
    expect(extractSystemOneTokens(null)).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("writes usageHistory + request detail in the same shape as chat models", () => {
    const parsed = {
      model: "jev-1.13-free",
      answers: { is_urgent: { type: "noul", noul: 1 } },
      usage: { input_tokens: 425, output_tokens: 73 },
    };

    recordSystemOneLogs({
      provider: "opencode",
      model: "jev-1.13-free",
      connectionId: "conn-1",
      apiKey: undefined,
      clientBody: validBody,
      upstreamBody: { model: "jev-1.13-free", state: validBody.state, questions: validBody.questions },
      parsed,
      latencyMs: 120,
      status: "success",
    });

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage.mock.calls[0][0]).toMatchObject({
      provider: "opencode",
      model: "jev-1.13-free",
      connectionId: "conn-1",
      endpoint: "/v1/systemone",
      status: "ok",
      tokens: { prompt_tokens: 425, completion_tokens: 73 },
    });

    expect(mocks.saveRequestDetail).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestDetail.mock.calls[0][0]).toMatchObject({
      provider: "opencode",
      model: "jev-1.13-free",
      connectionId: "conn-1",
      status: "success",
      endpoint: "/v1/systemone",
      tokens: { prompt_tokens: 425, completion_tokens: 73 },
      response: { answers: parsed.answers },
      latency: { ttft: 120, total: 120 },
    });
  });

  it("still records a log row when upstream omits usage", () => {
    recordSystemOneLogs({
      provider: "opencode",
      model: "jev-1.13-free",
      connectionId: "conn-1",
      clientBody: validBody,
      upstreamBody: null,
      parsed: { model: "jev-1.13-free", answers: { is_urgent: { type: "noul", noul: 0.5 } } },
      latencyMs: 50,
      status: "success",
    });

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        status: "ok",
      })
    );
  });

  it("POST success records logs like other models", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode", model: "jev-1.13-free" });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      providerSpecificData: {},
    });
    mocks.getExecutor.mockReturnValue({
      buildUrl: () => "https://opencode.ai/zen/v1/systemone",
      buildHeaders: () => ({ "content-type": "application/json" }),
    });
    const parsed = {
      model: "jev-1.13-free",
      answers: { is_urgent: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 425, output_tokens: 73 },
    };
    mocks.proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await POST(systemOneRequest(validBody));
    expect(res.status).toBe(200);

    expect(mocks.trackPendingRequest).toHaveBeenCalledWith("jev-1.13-free", "opencode", "conn-1", true);
    expect(mocks.trackPendingRequest).toHaveBeenCalledWith("jev-1.13-free", "opencode", "conn-1", false, false);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode",
        model: "jev-1.13-free",
        connectionId: "conn-1",
        endpoint: "/v1/systemone",
        tokens: { prompt_tokens: 425, completion_tokens: 73 },
        status: "ok",
      })
    );
    expect(mocks.saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode",
        model: "jev-1.13-free",
        status: "success",
        endpoint: "/v1/systemone",
      })
    );
  });

  it("POST terminal failure still records an error detail row", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode", model: "jev-1.13-free" });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      providerSpecificData: {},
    });
    mocks.getExecutor.mockReturnValue({
      buildUrl: () => "https://opencode.ai/zen/v1/systemone",
      buildHeaders: () => ({}),
    });
    mocks.proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "upstream boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });

    const res = await POST(systemOneRequest(validBody));
    expect(res.status).toBe(500);
    expect(mocks.saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", model: "jev-1.13-free" })
    );
  });
});
