/**
 * Unit tests for the canonical reasoning ladder and the level reconciler.
 *
 * The reconciler is what makes combo/fallback honour a caller's intent: the
 * request carries an abstract level, and each candidate spells it in its own
 * vocabulary. The scenario in `combo fallback` below is the acceptance case.
 */

import { describe, it, expect } from "vitest";
import {
  THINKING_LEVELS,
  EFFORT_LEVELS,
  levelRank,
  nearestLevel,
  resolveLevelFor,
  INTENT_ALIASES,
} from "../../open-sse/translator/concerns/thinking.js";

describe("canonical ladder", () => {
  it("is ordered weakest→strongest with `none` first", () => {
    expect(THINKING_LEVELS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(levelRank("none")).toBe(0);
    expect(levelRank("max")).toBe(6);
  });

  it("keeps EFFORT_LEVELS as the ladder minus the terminal `none`", () => {
    expect(EFFORT_LEVELS).toEqual(THINKING_LEVELS.slice(1));
  });

  it("returns null for off-ladder values instead of guessing a rank", () => {
    for (const bad of ["auto", "instant", "thinking", "turbo", "", null, undefined, 5]) {
      expect(levelRank(bad)).toBeNull();
    }
  });
});

describe("nearestLevel", () => {
  it("returns the requested level when it is supported", () => {
    expect(nearestLevel("high", ["low", "medium", "high", "max"])).toBe("high");
  });

  it("lands on the ceiling when the request is above it", () => {
    // The acceptance case: `max` on a candidate whose ceiling is `xhigh`.
    expect(nearestLevel("max", ["minimal", "low", "medium", "high", "xhigh"])).toBe("xhigh");
  });

  it("lands on the floor when the request is below it", () => {
    expect(nearestLevel("none", ["low", "medium", "high"])).toBe("low");
    expect(nearestLevel("minimal", ["high", "max"])).toBe("high");
  });

  it("prefers the stronger level on an exact tie", () => {
    // medium sits equidistant between low and high.
    expect(nearestLevel("medium", ["low", "high"])).toBe("high");
    expect(nearestLevel("high", ["medium", "xhigh"])).toBe("xhigh");
  });

  it("is order-independent (no reliance on how the set is listed)", () => {
    expect(nearestLevel("max", ["xhigh", "medium", "low"])).toBe("xhigh");
    expect(nearestLevel("max", ["low", "medium", "xhigh"])).toBe("xhigh");
  });

  it("passes through unchanged when the candidate has no declared set", () => {
    expect(nearestLevel("max", null)).toBe("max");
    expect(nearestLevel("max", [])).toBe("max");
  });

  it("passes through values that name no strength", () => {
    expect(nearestLevel("auto", ["low", "high"])).toBe("auto");
    expect(nearestLevel(undefined, ["low", "high"])).toBe(undefined);
  });

  it("ignores supported entries that are off-ladder", () => {
    expect(nearestLevel("max", ["high", "instant", "thinking"])).toBe("high");
  });
});

describe("resolveLevelFor", () => {
  it("is a PASS-THROUGH unless coercion is explicitly opted into", () => {
    // The single-model invariant: the level was chosen for this model, so it is
    // sent verbatim even when the declared set does not list it. The sets are
    // partly name-pattern derived — zai declares [none, thinking] while its wire
    // takes low/high — so coercing against them by default rewrites levels that
    // used to be sent as-is. That is a regression, not a fix.
    expect(resolveLevelFor("max", ["minimal", "low", "high"])).toBe("max");
    expect(resolveLevelFor("high", ["none", "thinking"])).toBe("high");
    expect(resolveLevelFor("ultra", ["low", "high"])).toBe("ultra");
  });

  it("coerces only when asked", () => {
    expect(resolveLevelFor("max", ["minimal", "low", "high"], { coerce: true })).toBe("high");
  });

  it("treats `ultra` as intent for the strongest available, under coercion", () => {
    expect(INTENT_ALIASES.ultra).toBe("max");
    expect(resolveLevelFor("ultra", ["low", "high", "max"], { coerce: true })).toBe("max");
    // On a candidate without `max`, ultra still reconciles rather than passing
    // through as a value the upstream would reject.
    expect(resolveLevelFor("ultra", ["minimal", "low", "high"], { coerce: true })).toBe("high");
  });

  it("prefers an exact `ultra` when the candidate declares it", () => {
    // Under coercion the goal is a value the target can express, so an exact
    // declared `ultra` is kept — the exact match is the best answer available
    // and still lies within what this candidate accepts.
    expect(resolveLevelFor("ultra", ["low", "max", "ultra"], { coerce: true })).toBe("ultra");
    // Without coercion nothing is projected: the level is sent verbatim.
    expect(resolveLevelFor("ultra", ["low", "max", "ultra"])).toBe("ultra");
  });

  it("leaves `auto` and unknown values alone even under coercion", () => {
    expect(resolveLevelFor("auto", ["low", "high"], { coerce: true })).toBe("auto");
    expect(resolveLevelFor("banana", ["low", "high"], { coerce: true })).toBe("banana");
  });
});

describe("combo fallback", () => {
  // The end-to-end acceptance case: user asks for `max`; the primary's ceiling
  // is xhigh so it gets xhigh; it fails; the fallback supports max so it gets
  // the user's actual request. The intent never changed — only its encoding.
  const primary = ["minimal", "low", "medium", "high", "xhigh"];
  const fallback = ["low", "medium", "high", "xhigh", "max"];
  const combo = { coerce: true };

  it("resolves the intent per candidate rather than freezing it once", () => {
    expect(resolveLevelFor("max", primary, combo)).toBe("xhigh");
    expect(resolveLevelFor("max", fallback, combo)).toBe("max");
  });

  it("keeps the intent fixed while the encoding adapts", () => {
    const requested = "max";
    const first = resolveLevelFor(requested, primary, combo);
    const second = resolveLevelFor(requested, fallback, combo);
    expect(requested).toBe("max");
    expect(first).not.toBe(second);
    // Both land on the strongest level their candidate offers.
    expect(levelRank(first)).toBe(levelRank("xhigh"));
    expect(levelRank(second)).toBe(levelRank("max"));
  });

  it("is a no-op for a single model, which is the invariant that matters", () => {
    // The picker only ever offers levels the model declares, so a plain request
    // resolves to itself — a coercion firing here would mean a declaration bug.
    const declared = ["minimal", "low", "medium", "high", "xhigh", "max"];
    for (const level of declared) {
      expect(resolveLevelFor(level, declared)).toBe(level);
    }
  });
});
