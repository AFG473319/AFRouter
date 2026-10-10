import { parse as parseTomlStrict } from "smol-toml";

export const GROK_SUBAGENT_TYPES = ["general-purpose", "explore", "plan"];

// Sections we write are tagged with this description so re-apply/reset can find
// and clean them up even after the slot naming scheme changes (legacy slots were
// named `afrouter` / `afrouter-<type>`).
export const GROK_OWNED_MARKER = "Routed via AFRouter gateway";

const UNSET_SENTINEL = "__afrouter_unset__";
const MODELS_SECTION = "models";
const SUBAGENT_MODELS_SECTION = "subagents.models";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tomlString = (value) => JSON.stringify(String(value));

const sectionRegExp = (section) =>
  new RegExp(
    `^\\[${escapeRegExp(section)}\\][ \\t]*\\r?\\n((?:(?!\\[)[^\\r\\n]*\\r?\\n?)*)`,
    "m",
  );

// Enumerates every `[model.<slot>]` section. Slots are always written as bare keys.
const MODEL_SECTION_GLOBAL = /^\[model\.([A-Za-z0-9_-]+)\][ \t]*\r?\n((?:(?!\[)[^\r\n]*\r?\n?)*)/gm;

// `default_reasoning_effort` is a root-level key, so it must stay above the first
// `[table]` header (TOML assigns every key after a header to that table). Parsing
// the document roots this reliably instead of the old `[models]` regex, which
// could append a second `[models]` table when the first one was absent.
function getModelsDefaultEffort(toml) {
  let parsed = null;
  try {
    parsed = parseTomlStrict(toml);
  } catch {
    // A document the strict parser rejects still has to be editable: fall back to
    // a plain scan of the `[models]` block instead of aborting the Apply.
    const match = toml.match(sectionRegExp(MODELS_SECTION));
    const body = match?.[1] || "";
    const field = body.match(
      new RegExp(`^[ \\t]*default_reasoning_effort[ \\t]*=[ \\t]*"([^"]*)"`, "m"),
    );
    return field?.[1] || null;
  }
  const value = parsed?.models?.default_reasoning_effort;
  return typeof value === "string" && value ? value : null;
}

function deleteRootField(toml, key) {
  const re = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[^\\r\\n]*\\r?\\n?`, "m");
  return toml.replace(re, "");
}

function upsertRootField(toml, section, key, value) {
  const insideSection = sectionRegExp(section);
  const match = toml.match(insideSection);
  const line = `${key} = ${tomlString(value)}`;
  if (!match) {
    const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
    return `${prefix}\n[${section}]\n${line}\n`;
  }
  const body = match[1] || "";
  const fieldRegExp = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"[^"]*"`, "m");
  const nextBody = fieldRegExp.test(body) ? body.replace(fieldRegExp, line) : `${line}\n${body}`;
  return toml.replace(match[0], `[${section}]\n${nextBody}`);
}

const previousDefaultRegExp = /^# afrouter-prev-default = "([^"]*)"[ \t]*\r?\n?/m;const previousSubagentRegExp = (type) =>
  new RegExp(
    `^# afrouter-prev-subagent-${escapeRegExp(type)} = "([^"]*)"[ \\t]*\\r?\\n?`,
    "m",
  );

// `openai/gpt-5` -> `openai-gpt-5`; the slot is a config key, the real model id
// stays in the `model` field.
export function grokSlotForModel(model, used) {
  const base =
    String(model).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  let slot = base;
  let n = 2;
  while (used?.has(slot)) slot = `${base}-${n++}`;
  return slot;
}

function getSectionField(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return null;
  const field = match[1].match(
    new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"([^"]*)"`, "m"),
  );
  return field ? field[1] : null;
}

function getSectionNumber(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return null;
  const field = match[1].match(
    new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*([0-9]+(?:\\.[0-9]+)?)`, "m"),
  );
  if (!field) return null;
  const value = Number(field[1]);
  return Number.isFinite(value) ? value : null;
}

function setSectionField(toml, section, key, value) {
  const match = toml.match(sectionRegExp(section));
  const line = `${key} = ${tomlString(value)}`;
  if (!match) {
    const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
    return `${prefix}\n[${section}]\n${line}\n`;
  }

  const body = match[1] || "";
  const fieldRegExp = new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"[^"]*"`,
    "m",
  );
  const nextBody = fieldRegExp.test(body)
    ? body.replace(fieldRegExp, line)
    : `${line}\n${body}`;
  return toml.replace(match[0], `[${section}]\n${nextBody}`);
}

function deleteSectionField(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return toml;
  const fieldRegExp = new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[^\\r\\n]*\\r?\\n?`,
    "m",
  );
  const nextBody = (match[1] || "").replace(fieldRegExp, "");
  if (!nextBody.trim()) return toml.replace(match[0], "").replace(/\n{3,}/g, "\n\n");
  return toml.replace(match[0], `[${section}]\n${nextBody}`);
}

function parseModelSection(toml, slot) {
  const match = toml.match(sectionRegExp(`model.${slot}`));
  if (!match) return null;
  const contextWindow = getSectionNumber(toml, `model.${slot}`, "context_window");
  const maxCompletionTokens = getSectionNumber(toml, `model.${slot}`, "max_completion_tokens");
  return {
    slot,
    model: getSectionField(toml, `model.${slot}`, "model"),
    base_url: getSectionField(toml, `model.${slot}`, "base_url"),
    name: getSectionField(toml, `model.${slot}`, "name"),
    api_key: getSectionField(toml, `model.${slot}`, "api_key"),
    api_backend: getSectionField(toml, `model.${slot}`, "api_backend"),
    context_window: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    max_completion_tokens:
      Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0 ? maxCompletionTokens : null,
  };
}

const fmtTokens = (n) =>
  n % 1000 === 0 ? `${Math.round(n / 1000)}K` : n.toLocaleString("en-US");

// Grok has no native fields for vision/reasoning; surface them in the
// description (which doubles as the ownership marker — keep the marker first).
function buildDescription({ contextWindow, maxOutput, vision, reasoning }) {
  const parts = [];
  if (vision) parts.push("vision");
  if (reasoning) parts.push("reasoning");
  if (Number.isFinite(contextWindow) && contextWindow > 0) parts.push(`${fmtTokens(contextWindow)} context`);
  if (Number.isFinite(maxOutput) && maxOutput > 0) parts.push(`${fmtTokens(maxOutput)} max output`);
  return parts.length > 0 ? `${GROK_OWNED_MARKER} · ${parts.join(" · ")}` : GROK_OWNED_MARKER;
}

function buildModelSection({ slot, model, baseUrl, apiKey, contextWindow, maxOutput, vision, reasoning, effort }) {
  const lines = [
    `[model.${slot}]`,
    `model = ${tomlString(model)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `name = ${tomlString(model)}`,
    `description = ${tomlString(buildDescription({ contextWindow, maxOutput, vision, reasoning }))}`,
    `api_backend = "chat_completions"`,
  ];
  if (apiKey) lines.push(`api_key = ${tomlString(apiKey)}`);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    lines.push(`context_window = ${Math.floor(contextWindow)}`);
  }
  if (Number.isFinite(maxOutput) && maxOutput > 0) {
    lines.push(`max_completion_tokens = ${Math.floor(maxOutput)}`);
  }
  // docs.x.ai/build/settings/reference [model.<id>]: supports_reasoning_effort
  // (bool) and reasoning_effort (effort level) are real per-model controls when
  // supported. Both are omitted for non-reasoning models rather than written false,
  // so a non-reasoning model never advertises a control it cannot honour.
  if (reasoning === true) {
    lines.push("supports_reasoning_effort = true");
    if (effort) lines.push(`reasoning_effort = ${tomlString(effort)}`);
  }
  return `${lines.join("\n")}\n`;
}

function upsertModelSection(toml, config) {
  const regexp = sectionRegExp(`model.${config.slot}`);
  const section = buildModelSection(config);
  if (regexp.test(toml)) return toml.replace(regexp, section);
  const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
  return `${prefix}\n${section}`;
}

function isOwnedSlot(toml, slot) {
  if (!slot) return false;
  const match = toml.match(sectionRegExp(`model.${slot}`));
  return Boolean(match && (match[1] || "").includes(GROK_OWNED_MARKER));
}

function listOwnedSections(toml) {
  const result = [];
  for (const match of toml.matchAll(MODEL_SECTION_GLOBAL)) {
    const [, slot, body] = match;
    if (!body.includes(GROK_OWNED_MARKER)) continue;
    result.push(parseModelSection(toml, slot));
  }
  return result;
}

// Remove owned sections that are not in `keepSlots`; leaves user-authored
// sections (no marker) untouched.
function sweepOwnedSections(toml, keepSlots) {
  const next = toml.replace(MODEL_SECTION_GLOBAL, (full, slot, body) =>
    keepSlots.has(slot) || !body.includes(GROK_OWNED_MARKER) ? full : "",
  );
  return next.replace(/\n{3,}/g, "\n\n");
}

function insertMarker(toml, marker) {
  MODEL_SECTION_GLOBAL.lastIndex = 0;
  for (const match of toml.matchAll(MODEL_SECTION_GLOBAL)) {
    if (match[2].includes(GROK_OWNED_MARKER)) {
      const index = match.index;
      return `${toml.slice(0, index)}${marker}${toml.slice(index)}`;
    }
  }
  const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
  return `${prefix}${marker}`;
}

function rememberPreviousDefault(toml) {
  if (previousDefaultRegExp.test(toml)) return toml;
  const current = getSectionField(toml, MODELS_SECTION, "default");
  if (!current || isOwnedSlot(toml, current)) return toml;
  return insertMarker(toml, `# afrouter-prev-default = ${tomlString(current)}\n`);
}

function restorePreviousDefault(toml) {
  const previous = toml.match(previousDefaultRegExp)?.[1] || "grok-build";
  let next = toml.replace(previousDefaultRegExp, "");
  if (isOwnedSlot(next, getSectionField(next, MODELS_SECTION, "default"))) {
    next = setSectionField(next, MODELS_SECTION, "default", previous);
  }
  return next;
}

function rememberPreviousSubagent(toml, type) {
  const regexp = previousSubagentRegExp(type);
  if (regexp.test(toml)) return toml;
  const current = getSectionField(toml, SUBAGENT_MODELS_SECTION, type);
  const previous = current == null ? UNSET_SENTINEL : current;
  return insertMarker(
    toml,
    `# afrouter-prev-subagent-${type} = ${tomlString(previous)}\n`,
  );
}

function restorePreviousSubagent(toml, type) {
  const regexp = previousSubagentRegExp(type);
  const previous = toml.match(regexp)?.[1] || UNSET_SENTINEL;
  let next = toml.replace(regexp, "");
  // Only undo mappings that point at a section we own.
  if (!isOwnedSlot(next, getSectionField(next, SUBAGENT_MODELS_SECTION, type))) {
    return next;
  }
  if (previous === UNSET_SENTINEL) {
    return deleteSectionField(next, SUBAGENT_MODELS_SECTION, type);
  }
  return setSectionField(next, SUBAGENT_MODELS_SECTION, type, previous);
}

/**
 * Apply the selected models and optional per-type subagent overrides while
 * preserving all unrelated TOML.
 *
 * `models` is an ordered list of `{ model, contextWindow }`; the first entry
 * becomes `[models] default`. Every entry gets its own `[model.<slot>]` section
 * (slot derived from the model id, display name = the model id itself) so Grok
 * Build's model picker can switch between them without touching AFRouter.
 * Subagent overrides reuse an existing slot when the model matches one of the
 * main models, otherwise they get a section of their own.
 * `subagentModels === undefined` leaves existing subagent config untouched for
 * API compatibility. `model`/`contextWindow` (single model) are still accepted
 * as a legacy fallback for `models`.
 */
export function applyGrokBuildConfig(
  toml,
  { baseUrl, apiKey, model, contextWindow, models, subagentModels },
) {
  const rawList =
    Array.isArray(models) && models.length > 0
      ? models
      : [{ model, contextWindow }];
  const seen = new Set();
  const usedSlots = new Set();
  const entries = [];
  for (const entry of rawList) {
    const id = typeof entry === "string" ? entry : entry?.model;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const slot = grokSlotForModel(id, usedSlots);
    usedSlots.add(slot);
    entries.push({
      slot,
      model: id,
      ...(typeof entry === "object" ? entry : {}),
    });
  }
  if (entries.length === 0) return toml;

  let next = rememberPreviousDefault(toml);

  const subagentEntries = [];
  for (const type of GROK_SUBAGENT_TYPES) {
    const selected = subagentModels?.[type];
    const id = typeof selected === "string" ? selected : selected?.model;
    if (id) {
      subagentEntries.push({
        type,
        model: id,
        ...(typeof selected === "object" ? selected : {}),
      });
    } else if (subagentModels && typeof subagentModels === "object") {
      // blank override => inherit / restore previous mapping
      next = restorePreviousSubagent(next, type);
    }
  }

  // Slots for subagent models not already covered by the main list.
  for (const sub of subagentEntries) {
    if (!seen.has(sub.model)) {
      seen.add(sub.model);
      const slot = grokSlotForModel(sub.model, usedSlots);
      usedSlots.add(slot);
      sub.slot = slot;
    }
  }

  // Callers that leave subagent overrides untouched keep the sections their
  // current mappings point at.
  if (!(subagentModels && typeof subagentModels === "object")) {
    for (const type of GROK_SUBAGENT_TYPES) {
      const mapping = getSectionField(next, SUBAGENT_MODELS_SECTION, type);
      if (mapping && isOwnedSlot(next, mapping)) usedSlots.add(mapping);
    }
  }

  next = sweepOwnedSections(next, usedSlots);
  for (const entry of entries) {
    next = upsertModelSection(next, { ...entry, baseUrl, apiKey });
  }
  next = setSectionField(next, MODELS_SECTION, "default", entries[0].slot);

  // [models].default_reasoning_effort — Grok Build's global default for the
  // picker's active model. Only written when the default model actually reasons,
  // and always reset when it does not, so a stale value is never inherited.
  const primaryEntry = entries[0];
  if (primaryEntry.reasoning === true && primaryEntry.effort) {
    // Read the current value through the parser rather than `deleteSectionField`
    // + append, which could leave two `[models]` tables behind.
    if (getModelsDefaultEffort(next) !== primaryEntry.effort) {
      next = deleteSectionField(next, MODELS_SECTION, "default_reasoning_effort");
      next = upsertRootField(next, MODELS_SECTION, "default_reasoning_effort", primaryEntry.effort);
    }
  } else if (getModelsDefaultEffort(next) !== null) {
    next = deleteSectionField(next, MODELS_SECTION, "default_reasoning_effort");
  }

  for (const sub of subagentEntries) {
    const slot = sub.slot || entries.find((e) => e.model === sub.model)?.slot;
    next = rememberPreviousSubagent(next, sub.type);
    if (sub.slot) {
      next = upsertModelSection(next, { ...sub, baseUrl, apiKey });
    }
    next = setSectionField(next, SUBAGENT_MODELS_SECTION, sub.type, slot);
  }

  return next;
}

export function resetGrokBuildConfig(toml) {
  let next = toml;
  for (const type of GROK_SUBAGENT_TYPES) {
    next = restorePreviousSubagent(next, type);
  }
  // Restore before sweeping: the default check needs to still see our sections.
  next = restorePreviousDefault(next);
  next = sweepOwnedSections(next, new Set());
  return next.replace(/\n{3,}/g, "\n\n");
}

export function parseGrokBuildConfig(toml) {
  const owned = listOwnedSections(toml);
  const defaultSlot = getSectionField(toml, MODELS_SECTION, "default");

  const subagentModels = {};
  const subagentMappings = {};
  for (const type of GROK_SUBAGENT_TYPES) {
    const mapping = getSectionField(toml, SUBAGENT_MODELS_SECTION, type);
    subagentMappings[type] = mapping;
    subagentModels[type] =
      mapping && isOwnedSlot(toml, mapping) ? parseModelSection(toml, mapping) : null;
  }

  // Main models: everything owned except sections that only exist as a
  // subagent override target (the default always counts as a main model).
  const subMapped = new Set(
    Object.values(subagentMappings).filter((slot) => slot && slot !== defaultSlot),
  );
  const models = owned.filter(
    (entry) => entry.slot === defaultSlot || !subMapped.has(entry.slot),
  );

  return {
    model: models.find((entry) => entry.slot === defaultSlot) || models[0] || null,
    models,
    default: defaultSlot,
    subagentModels,
    subagentMappings,
  };
}
