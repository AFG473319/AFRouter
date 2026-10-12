// Shared reader for the reasoning effort LADDER published by OpenRouter-shaped
// catalogs — currently Nous Portal (`reasoning.supported_efforts`), which spells
// its efforts in exactly our wire vocabulary (none/minimal/low/medium/high/
// xhigh/max), so unlike Kilo's display-labelled `opencode.variants` they need no
// renaming, only canonical-ladder filtering.
//
// Deliberately its own module: sync.js (daily catalog sync) and customSpecs.js
// (custom-model save) both need it, and customSpecs.js pulls in the database —
// a direct sync.js → customSpecs.js import drags SQLite into the sync's import
// graph. The only dependency here is the pure constants file.
import { REASONING_EFFORT_LEVELS } from "@/shared/constants/models.js";

// Returns the ordered ladder, or undefined when the model publishes none, so
// "reasons but no selectable magnitude" stays distinguishable from a real ladder.
//
// `reasoning.mandatory: true` means thinking cannot be switched off, so `none`
// is dropped — a ladder that offers `none` to a model that rejects it is worse
// than no ladder at all. A mandatory model whose only value is `none` therefore
// has no usable ladder and reports undefined.
export function openRouterEffortValues(model) {
  const efforts = model?.reasoning?.supported_efforts;
  if (!Array.isArray(efforts)) return undefined;
  const canonical = efforts.filter((e) => typeof e === "string" && REASONING_EFFORT_LEVELS.includes(e));
  const unique = [...new Set(canonical)];
  if (!unique.length) return undefined;
  if (model?.reasoning?.mandatory === true) {
    const disableable = unique.filter((e) => e !== "none");
    return disableable.length ? disableable : undefined;
  }
  return unique;
}
