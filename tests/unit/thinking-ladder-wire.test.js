import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { FORMAT_LEVELS } from "../../open-sse/providers/capabilities.js";
import { normalizeOpenAILevel } from "../../open-sse/translator/concerns/thinkingUnified.js";

// Every ladder value must be sendable or safely clamped by applyFormat — no
// level may be passed unmodified to a provider that rejects it with a 400.
describe("thinking ladder vs wire", () => {
  it("tokenrouter omits none/auto (it 400s on them)", () => {
    const model = "anthropic/claude-sonnet-4.6";
    expect(applyThinking("openai", model, { reasoning_effort: "none" }, "tokenrouter").reasoning_effort).toBeUndefined();
    expect(applyThinking("openai", model, { reasoning_effort: "max" }, "tokenrouter").reasoning_effort).toBe("max");
  });

  it("codex clamps none to minimal (backend 400s on none, #4031)", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-6-astra", { reasoning_effort: "none" }, "codex");
    expect(out.reasoning_effort).toBe("minimal");
  });

  it("claude-adaptive clamps xhigh to high when the model does not declare it", () => {
    const out = applyThinking("claude-adaptive", "claude-sonnet-4.6", { output_config: { effort: "xhigh" } }, "claude", undefined, { coerceLevels: false });
    expect(JSON.stringify(out)).not.toContain('"xhigh"');
  });

  it("mimo v2.5-pro max reconciles to its ceiling under coercion", () => {
    expect(normalizeOpenAILevel("max", ["none", "low", "medium", "high", "xhigh"], true)).toBe("xhigh");
  });

  it("every FORMAT_LEVELS ladder survives applyFormat without throwing", () => {
    for (const [format, levels] of Object.entries(FORMAT_LEVELS)) {
      for (const level of levels) {
        const body = level === "none"
          ? { reasoning_effort: "none" }
          : { reasoning_effort: level };
        expect(() => applyThinking(format, "probe-model", { ...body }, null), `${format}/${level}`).not.toThrow();
      }
    }
  });
});
