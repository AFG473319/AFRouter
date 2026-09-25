// Regression: NVIDIA NIM (and any upstream that sunsets hosted models) answers
// 404/406 for a retired model id while every sibling model on the SAME api key
// keeps working. The generic path treated that as a 2-minute account cooldown, so
// a dead id was retried every 2 minutes forever AND the connection was marked
// "unavailable", taking the healthy models down with it.
import { describe, expect, it } from "vitest";
import {
  isRetiredModelError,
  getRetiredModelCooldownMs,
  isModelRetired,
  getRetiredStrikes,
  buildRetireModelUpdate,
  buildUnretireModelUpdate,
  listRetiredModels,
  collectRetiredModelsByModel,
} from "../../open-sse/services/retiredModels.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { RETIRED_MODEL_COOLDOWNS } from "../../open-sse/config/errorConfig.js";

describe("isRetiredModelError", () => {
  it("detects a NIM-style 404 for a gone model", () => {
    expect(isRetiredModelError(404, "The model moonshotai/kimi-k2.6 was not found")).toBe(true);
  });

  it("detects decommission wording on any status", () => {
    expect(isRetiredModelError(400, "This model has been decommissioned")).toBe(true);
    expect(isRetiredModelError(503, "model not available")).toBe(true);
  });

  it("detects 406 model-not-supported", () => {
    expect(isRetiredModelError(406, "model not supported")).toBe(true);
    // Still needs a body: a bare status with no message stays ambiguous.
    expect(isRetiredModelError(406, "")).toBe(false);
  });

  it("does NOT treat rate limits / capacity as retirement", () => {
    expect(isRetiredModelError(429, "rate limit reached")).toBe(false);
    expect(isRetiredModelError(503, "No capacity available")).toBe(false);
  });

  it("does NOT treat an auth failure as retirement", () => {
    expect(isRetiredModelError(401, "Invalid API key")).toBe(false);
    expect(isRetiredModelError(403, "insufficient quota")).toBe(false);
  });

  it("does NOT treat a request-scoped 400 as retirement", () => {
    const body = JSON.stringify({
      error: { message: "This model's maximum context length is 1048576 tokens" },
    });
    expect(isRetiredModelError(400, body)).toBe(false);
  });

  it("needs a body: a bare 404 with no message is not a retirement verdict", () => {
    expect(isRetiredModelError(404, "")).toBe(false);
    expect(isRetiredModelError(404, null)).toBe(false);
  });

  it("does not let a throttled account's 404 escalate into a month-long bypass", () => {
    // Status-only verdict must yield to account-scoped wording: some upstreams
    // answer 404 when the credential is throttled, and a 30-day model bypass
    // would take a good model out of rotation for a month.
    expect(isRetiredModelError(404, "rate limit reached for this account")).toBe(false);
    expect(isRetiredModelError(404, "quota exceeded")).toBe(false);
    expect(isRetiredModelError(404, "no capacity available")).toBe(false);
  });

  it("still retires when a retirement phrase accompanies the throttle wording", () => {
    // Explicit text beats the guard: naming the model as gone is the stronger signal.
    expect(isRetiredModelError(404, "rate limit: model not found")).toBe(true);
  });
});

describe("getRetiredModelCooldownMs", () => {
  it("escalates with consecutive strikes and caps at the last rung", () => {
    expect(getRetiredModelCooldownMs(1)).toBe(RETIRED_MODEL_COOLDOWNS[0]);
    expect(getRetiredModelCooldownMs(2)).toBe(RETIRED_MODEL_COOLDOWNS[1]);
    expect(getRetiredModelCooldownMs(3)).toBeGreaterThan(RETIRED_MODEL_COOLDOWNS[1]);
    // capped, never runs away
    expect(getRetiredModelCooldownMs(99)).toBe(RETIRED_MODEL_COOLDOWNS.at(-1));
  });

  it("outlives the old flat 2-minute 404 cooldown by a wide margin", () => {
    // The retired ladder must never fall back to the generic 2-minute lock,
    // otherwise a dead NIM id is retried every 2 minutes forever.
    const oldNotFoundCooldown = checkFallbackError(404, "not found").cooldownMs;
    for (const strikes of [1, 2, 3, 4, 5, 6]) {
      expect(getRetiredModelCooldownMs(strikes)).toBeGreaterThan(oldNotFoundCooldown);
    }
  });
});

describe("retired model connection state", () => {
  const MODEL = "moonshotai/kimi-k2.6";

  it("builds a flat-field update that also sets the model lock", () => {
    const update = buildRetireModelUpdate(MODEL, { strikes: 2, reason: "model not found" });

    expect(update[`retiredStrikes_${MODEL}`]).toBe(2);
    // Reusing modelLock_ is what makes existing routing/dashboard code skip it.
    expect(update[`modelLock_${MODEL}`]).toBe(update[`retiredModel_${MODEL}`]);
    expect(update.lastError).toBe("model not found");
  });

  it("is retrievable and expires", () => {
    const conn = buildRetireModelUpdate(MODEL, { strikes: 1, reason: "gone" });
    expect(isModelRetired(conn, MODEL)).toBe(true);
    expect(isModelRetired(conn, "other/model")).toBe(false);
    expect(getRetiredStrikes(conn, MODEL)).toBe(1);

    const expired = { [`retiredModel_${MODEL}`]: new Date(Date.now() - 1000).toISOString() };
    expect(isModelRetired(expired, MODEL)).toBe(false);
    expect(listRetiredModels(expired)).toEqual([]);
  });

  it("clears marker, strikes and lock on un-retire", () => {
    const update = buildUnretireModelUpdate(MODEL);
    expect(update[`retiredModel_${MODEL}`]).toBeNull();
    expect(update[`retiredStrikes_${MODEL}`]).toBeNull();
    expect(update[`modelLock_${MODEL}`]).toBeNull();
  });

  it("is a no-op without a model (never retire the account-wide lock)", () => {
    expect(buildRetireModelUpdate(null, { strikes: 1 })).toEqual({});
    expect(buildUnretireModelUpdate(null)).toEqual({});
  });
});

describe("collectRetiredModelsByModel", () => {
  const MODEL = "moonshotai/kimi-k2.6";

  it("treats a model retired on any connection as retired provider-wide", () => {
    const map = collectRetiredModelsByModel([
      { id: "a", ...buildRetireModelUpdate(MODEL, { strikes: 1 }) },
      { id: "b" },
    ]);
    expect(map.has(MODEL)).toBe(true);
    expect(map.get(MODEL).connectionId).toBe("a");
  });

  it("keeps the longest-running retirement horizon", () => {
    const short = { id: "a", ...buildRetireModelUpdate(MODEL, { strikes: 1 }) };
    const long = { id: "b", ...buildRetireModelUpdate(MODEL, { strikes: 5 }) };
    const map = collectRetiredModelsByModel([short, long]);
    expect(map.get(MODEL).connectionId).toBe("b");
    expect(map.get(MODEL).strikes).toBe(5);
  });

  it("returns an empty map for no connections", () => {
    expect(collectRetiredModelsByModel([]).size).toBe(0);
    expect(collectRetiredModelsByModel(null).size).toBe(0);
  });
});
