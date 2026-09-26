import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getCustomModels: vi.fn(), addCustomModel: vi.fn(), deleteCustomModel: vi.fn(),
  getProviderConnections: vi.fn(), getModelAliases: vi.fn(),
}));
vi.mock("@/models", () => db);
vi.mock("@/lib/db/index.js", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
import { GET as listModels } from "../../src/app/api/models/route.js";
import { POST, GET } from "../../src/app/api/models/custom/route.js";

const entry = {
  id: "stealth/union-alpha", name: "Union Alpha", context_length: 262144,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  top_provider: { max_completion_tokens: 131072 },
  supported_parameters: ["tools", "reasoning"],
};
const nvidiaEntry = {
  id: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning",
  modalities: { input: ["text", "image"], output: ["text"] },
  tool_call: true, reasoning: true, limit: { context: 262144, output: 262144 },
};
const save = (providerAlias = "nous", extra = {}) => POST(new Request("http://localhost/api/models/custom", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ providerAlias, id: entry.id, ...extra }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  db.getModelAliases.mockResolvedValue({});
  db.addCustomModel.mockResolvedValue(true);
  db.getProviderConnections.mockResolvedValue([{ apiKey: "test-only-key" }]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [entry] })));
});
afterEach(() => vi.unstubAllGlobals());

describe("custom model catalog enrichment", () => {
  it("uses the Nous catalog and saved credentials and persists numeric specs", async () => {
    expect((await save()).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith("https://inference-api.nousresearch.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer test-only-key" }),
    }));
    expect(db.addCustomModel).toHaveBeenCalledWith(expect.objectContaining({
      providerAlias: "nous", id: entry.id, name: "Union Alpha",
      caps: expect.objectContaining({ vision: true, reasoning: true, contextWindow: 262144, maxOutput: 131072 }),
    }));
  });
  it("uses OpenRouter's public catalog without sending credentials", async () => {
    await save("openrouter");
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.objectContaining({ headers: { Accept: "application/json" } }));
    expect(db.getProviderConnections).not.toHaveBeenCalled();
  });
  it("enriches NVIDIA models from the models.dev provider catalog", async () => {
    fetch.mockResolvedValue(Response.json({ nvidia: { models: { [nvidiaEntry.id]: nvidiaEntry } } }));
    const response = await POST(new Request("http://localhost/api/models/custom", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerAlias: "nvidia", id: nvidiaEntry.id }),
    }));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith("https://models.dev/api.json", expect.objectContaining({ headers: { Accept: "application/json" } }));
    expect(db.getProviderConnections).not.toHaveBeenCalled();
    expect(db.addCustomModel).toHaveBeenCalledWith(expect.objectContaining({
      providerAlias: "nvidia", id: nvidiaEntry.id, name: nvidiaEntry.name,
      caps: expect.objectContaining({ vision: true, tools: true, reasoning: true, contextWindow: 262144, maxOutput: 262144 }),
    }));
  });
  it("fills in Kilo Code specs from its public catalog instead of the 200K floor", async () => {
    await save("kilocode");
    expect(fetch).toHaveBeenCalledWith("https://api.kilo.ai/api/gateway/models", expect.objectContaining({
      headers: { Accept: "application/json" },
    }));
    expect(db.getProviderConnections).not.toHaveBeenCalled();
    expect(db.addCustomModel).toHaveBeenCalledWith(expect.objectContaining({
      providerAlias: "kilocode", id: entry.id, name: "Union Alpha",
      caps: expect.objectContaining({ contextWindow: 262144, maxOutput: 131072, vision: true }),
    }));
  });
  it("does not let the modal's unchecked defaults mask catalog capabilities", async () => {
    await save("nous", { caps: { vision: false, reasoning: false } });
    expect(db.addCustomModel.mock.calls[0][0].caps.vision).toBe(true);
  });
  it.each(["offline", "missing", "malformed", "http-error"])("keeps saving with existing defaults on %s", async (failure) => {
    if (failure === "offline") fetch.mockRejectedValue(new Error("offline"));
    if (failure === "missing") fetch.mockResolvedValue(Response.json({ data: [{ ...entry, id: `${entry.id}:free` }] }));
    if (failure === "malformed") fetch.mockResolvedValue(Response.json({ data: {} }));
    if (failure === "http-error") fetch.mockResolvedValue(new Response(null, { status: 503 }));
    expect((await save("nous", { caps: { vision: false } })).status).toBe(200);
    expect(db.addCustomModel).toHaveBeenCalledWith({ providerAlias: "nous", id: entry.id, type: "llm", name: undefined, caps: { vision: false } });
  });
  it("round-trips catalog specs through the custom model list", async () => {
    db.addCustomModel.mockImplementation(async (model) => {
      db.getCustomModels.mockResolvedValue([model]);
      return true;
    });
    await save();
    const listed = await (await GET()).json();
    expect(listed.models[0].caps).toMatchObject({ contextWindow: 262144, maxOutput: 131072, vision: true });
    const dashboard = await (await listModels()).json();
    expect(dashboard.models.find((m) => m.fullModel === `nous/${entry.id}`).caps)
      .toMatchObject({ contextWindow: 262144, maxOutput: 131072, vision: true });
  });
  it("uses OAuth credentials and canonical provider ID for Nous", async () => {
    db.getProviderConnections.mockResolvedValue([{ accessToken: "test-oauth-token" }]);
    await save("nous-portal");
    expect(db.getProviderConnections).toHaveBeenCalledWith({ provider: "nous-portal", isActive: true });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer test-oauth-token");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });
  it("preserves supplied flags for fields missing from a partial catalog", async () => {
    fetch.mockResolvedValue(Response.json({ data: [{ id: entry.id, context_length: 262144 }] }));
    await save("nous", { caps: { reasoning: true } });
    expect(db.addCustomModel.mock.calls[0][0].caps).toEqual({ reasoning: true, contextWindow: 262144 });
  });
  it("honors declared false and ignores invalid limits", async () => {
    fetch.mockResolvedValue(Response.json({ data: [{ id: entry.id, context_length: -1,
      top_provider: { max_completion_tokens: "invalid" }, architecture: { input_modalities: ["text"] }, supported_parameters: [] }] }));
    await save("nous", { caps: { vision: true, reasoning: true } });
    const caps = db.addCustomModel.mock.calls[0][0].caps;
    expect(caps).toMatchObject({ vision: false, reasoning: false, tools: false });
    expect(caps).not.toHaveProperty("contextWindow");
    expect(caps).not.toHaveProperty("maxOutput");
  });
  it("does not guess sources for unsupported providers", async () => {
    await save("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});
