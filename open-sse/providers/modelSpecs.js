// resolveModelSpec — the single source of truth for per-model specs.
//
// Wraps getCapabilitiesForModel (which already applies the ONLY level
// precedence: exact Codex registry entry → PATTERN_THINKING override →
// discovered models.dev ladder → thinkingFormat default, with the
// thinkingCanDisable filter and the Kiro null case) and projects it into the
// shape CLI-tool writers need.
//
// Returned shape:
//   { reasoning, reasoningLevels, canDisable, defaultLevel,
//     contextWindow, maxOutput, vision, pdf, audioInput, videoInput,
//     imageOutput, audioOutput, search, tools,
//     thinkingFormat, thinkingEffortSupported, thinkingRange }
//
// Rules:
// - `reasoningLevels` is ordered low→high (`none` first when present,
//   `ultra` last), deduplicated. `none` appears ONLY when the model can
//   disable thinking.
// - When the model reasons but exposes NO known effort control, `reasoning`
//   is true and `reasoningLevels` is OMITTED (undefined). Consumers must offer
//   a reasoning toggle only and must NOT invent levels. (Previously the
//   L.base fallback invented [none,low,medium,high] for unknown formats.)
// - Non-reasoning models omit `reasoningLevels`.
// - `defaultLevel` is the strongest declared level (`max` > `xhigh` > `high`
//   …), or undefined when no levels are known.
// - `contextWindow` / `maxOutput` always finite (DEFAULT floor when unknown).
// - Combos keep the UNION of member levels (capabilities.js): the dispatcher
//   re-encodes the chosen level onto the serving member's nearest supported
//   level (translateRequest coerceLevels=true → resolveLevelFor), so a level
//   one seat rejects is never sent verbatim.
// - Kilo (kiloReasoning.js) and DeepSeek Harness (dshModelSpecs.js) are
//   deliberately more precise on top of this: Kilo maps its live catalog
//   display→wire variants, DSH maps `none`→`off:null`. Both consume this
//   resolver's ladder as input and agree with it; they only narrow/rename,
//   never widen.
import { getCapabilitiesForModel } from "./capabilities.js";

const DEFAULT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function resolveModelSpec(provider, model) {
  const caps = getCapabilitiesForModel(provider, model);
  const levels = Array.isArray(caps.reasoningLevels) && caps.reasoningLevels.length
    ? caps.reasoningLevels
    : undefined;
  let defaultLevel;
  if (levels) {
    for (let i = DEFAULT_ORDER.length - 1; i >= 0; i--) {
      if (levels.includes(DEFAULT_ORDER[i])) { defaultLevel = DEFAULT_ORDER[i]; break; }
    }
    defaultLevel = defaultLevel ?? levels[levels.length - 1];
  }
  const spec = {
    reasoning: caps.reasoning === true,
    canDisable: caps.thinkingCanDisable !== false,
    contextWindow: caps.contextWindow,
    maxOutput: caps.maxOutput,
    vision: caps.vision === true,
    pdf: caps.pdf === true,
    audioInput: caps.audioInput === true,
    videoInput: caps.videoInput === true,
    imageOutput: caps.imageOutput === true,
    audioOutput: caps.audioOutput === true,
    search: caps.search === true,
    tools: caps.tools === true,
    thinkingFormat: caps.thinkingFormat || null,
    thinkingEffortSupported: caps.thinkingEffortSupported === true,
    thinkingRange: caps.thinkingRange || null,
  };
  if (levels) spec.reasoningLevels = levels;
  if (defaultLevel) spec.defaultLevel = defaultLevel;
  return spec;
}
