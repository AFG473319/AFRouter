/**
 * Acceptance: a combo/fallback honours the requested reasoning effort on the
 * candidate that actually serves it.
 *
 * The user's brief: "user sends a request with max effort, the main model on the
 * combo has xhigh, so we'll route to xhigh automatically, the model fails, the
 * fallback has max, so we'll use max effort for this one."
 *
 * The level is an abstract INTENT carried by the request; each candidate spells
 * it in its own vocabulary. `coerceLevels: true` is set only for combo members
 * and fallback targets — a plain single-model request sends the level verbatim,
 * because it was chosen for that model.
 */
import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const apply = (format, model, body, provider, coerceLevels) => {
  const b = JSON.parse(JSON.stringify(body));
  applyThinking(format, model, b, provider, undefined, { coerceLevels });
  return b;
};

describe("combo fallback reconciles the requested effort per candidate", () => {
  it("routes `max` to the primary's xhigh ceiling", () => {
    // openai/gpt-5 declares [none, minimal, low, medium, high, xhigh] — no max.
    const out = apply("openai", "gpt-5", { reasoning_effort: "max" }, "openai", true);
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("sends the same `max` verbatim to a fallback that declares it", () => {
    // codex/gpt-5.6-sol declares up to max.
    const out = apply("openai", "gpt-5.6-sol", { reasoning_effort: "max" }, "codex", true);
    expect(out.reasoning_effort).toBe("max");
  });

  it("keeps the intent fixed while only the encoding changes", () => {
    const requested = "max";
    const primary = apply("openai", "gpt-5", { reasoning_effort: requested }, "openai", true);
    const fallback = apply("openai", "gpt-5.6-sol", { reasoning_effort: requested }, "codex", true);
    // The caller's intent is untouched; the two candidates just spell it differently.
    expect(requested).toBe("max");
    expect(primary.reasoning_effort).toBe("xhigh");
    expect(fallback.reasoning_effort).toBe("max");
  });
});

describe("coercion is opt-in (single-model invariant)", () => {
  // codebuddy-cn/hy3 declares [low, high] — `medium` is not in its set.
  it("sends an unlisted level verbatim for a single model", () => {
    const out = apply("openai", "hy3", { reasoning_effort: "medium" }, "codebuddy-cn", false);
    expect(out.reasoning_effort).toBe("medium");
  });

  it("reconciles the same level onto the candidate's nearest when coerced", () => {
    // medium ties between low and high; the stronger level wins, so a fallback
    // is never silently under-thought.
    const out = apply("openai", "hy3", { reasoning_effort: "medium" }, "codebuddy-cn", true);
    expect(out.reasoning_effort).toBe("high");
  });

  it("never lets `none` participate in nearest-level matching", () => {
    // `none` is terminal: a candidate that can disable must receive it exactly,
    // never be coerced onto a magnitude. openai/gpt-5 declares `none`.
    const out = apply("openai", "gpt-5", { reasoning_effort: "none" }, "openai", true);
    expect(out.reasoning_effort).toBe("none");
  });
});