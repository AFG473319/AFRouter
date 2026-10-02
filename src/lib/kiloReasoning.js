// Kilo Gateway / Kilo Code reasoning levels.
//
// Kilo's catalog (GET https://api.kilo.ai/api/gateway/models) publishes a
// per-model variant map:
//
//   opencode:
//     variants:
//       thinking: { reasoning: { enabled: true, effort: "high" } }
//       instant:  { reasoning: { enabled: true, effort: "none" } }
//
// Two things make this more than a level list, and both matter:
//
//  1. It is a display-name → WIRE-VALUE map, not a level list. `thinking` and
//     `instant` are Kilo's own UI labels for `high` and `none`; a variant's KEY
//     and its `effort` differ by design (measured: 127 `thinking→high`,
//     97 `instant→none` across the live catalog). So these are aliases to be
//     resolved at the PICKER — the label the user sees carries its own wire
//     value — and never coerced by nearest-level matching at dispatch. That is
//     what keeps "displayed level == sent level" true for a single model.
//
//  2. `reasoning.enabled` is a separate axis from `effort`. A variant can be
//     listed yet disabled, and offering a disabled level would send a setting
//     Kilo does not honour. Disabled variants are dropped here.
//
// `none` (whether spelled `none` or `instant`) is additionally treated as the
// terminal "disable thinking" value, matching the canonical ladder: it is
// offered only when the model actually declares it.
//
// Pure — no Node builtins — so the server filters and the client picker can
// share one implementation.

// Level order used only to present Kilo's levels weakest→strongest. Kilo's
// display keys (`instant`, `thinking`) are not on the canonical ladder, so this
// ranks them explicitly rather than importing the router's ladder; `effort`
// values ARE canonical and rank through that same order.
const DISPLAY_ORDER = [
  "instant",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "thinking",
  "xhigh",
  "max",
];

const orderOf = (key) => {
  const i = DISPLAY_ORDER.indexOf(key);
  return i === -1 ? DISPLAY_ORDER.length : i;
};

/**
 * Map one Kilo catalog entry to its reasoning levels.
 *
 * @param entry - one item of the catalog's `data` array.
 * @returns `null` when Kilo declares no reasoning for the model, otherwise
 *   `{ levels: [{ level, effort }], canDisable }` where `level` is the label to
 *   display and `effort` the value to put on the wire. `levels` is `[]` when the
 *   model reasons but exposes no effort control (`reasoning_effort` absent).
 */
export function kiloReasoningLevels(entry) {
  const parameters = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters : null;
  const variants = entry?.opencode?.variants;
  const hasVariants = variants && typeof variants === "object" && !Array.isArray(variants);

  // No variants and no declared reasoning parameter → this model does not reason.
  if (!hasVariants && !parameters?.includes("reasoning") && !parameters?.includes("reasoning_effort")) {
    return null;
  }

  if (!hasVariants) {
    // Reasons, but Kilo publishes no effort control for it. An empty level list
    // means "no selectable effort" — not "no reasoning".
    return { levels: [], canDisable: false };
  }

  const levels = [];
  for (const [key, variant] of Object.entries(variants)) {
    const reasoning = variant?.reasoning;
    // A listed-but-disabled variant is not a selectable level.
    if (reasoning?.enabled !== true) continue;
    const effort = typeof reasoning.effort === "string" && reasoning.effort ? reasoning.effort : key;
    levels.push({ level: key, effort });
  }
  if (levels.length === 0) return { levels: [], canDisable: false };

  levels.sort((a, b) => orderOf(a.level) - orderOf(b.level) || a.level.localeCompare(b.level));

  return {
    levels,
    // Whether any variant disables thinking. Kilo expresses "off" as a level
    // whose effort is `none`, so its presence IS the disable capability.
    canDisable: levels.some((l) => l.effort === "none"),
  };
}

// The wire-value list for a model — what the router should treat as this
// candidate's supported set. Display keys are deliberately NOT included: the
// router reconciles canonical levels at dispatch, while the picker handles
// display aliases.
export const kiloEffortValues = (entry) =>
  kiloReasoningLevels(entry)?.levels.map((l) => l.effort) ?? null;
