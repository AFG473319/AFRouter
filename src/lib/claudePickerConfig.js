/**
 * Claude Code `/model` picker rows, shared by /api/cli-tools/claude-settings and
 * the dashboard card so the file we write and the Manual Config preview cannot
 * drift (same contract as `piConfig.js` / `ompConfig.js`).
 *
 * Why this exists: the Claude Code card used to express *only* the four family
 * mappings — `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`. Each of those
 * env vars pins exactly one model per alias, so a user could add one model per
 * family and nothing else. Claude Code's own docs give a way past that limit:
 *
 *   - `ANTHROPIC_CUSTOM_MODEL_OPTION` (+`_NAME`, `_DESCRIPTION`) adds exactly
 *     ONE extra entry to the picker. One. The env var cannot scale.
 *   - `modelPicker` in settings.json is the scalable one: an `options` ARRAY of
 *     `{ model, label?, description? }` rows, appended in written order after
 *     the built-in lineup (or replacing it with `replaceBuiltInOptions: true`).
 *     Each row's `model` is taken verbatim, so it accepts anything `--model`
 *     accepts — an alias, an Anthropic model ID, or a gateway id such as
 *     `cc/claude-opus-5`. Requires Claude Code v2.1.242 or later.
 *
 * Refs (official docs, read 2026-10):
 *   - https://code.claude.com/docs/en/settings-reference#modelpicker
 *   - https://code.claude.com/docs/en/model-config#add-a-custom-model-option
 *   - https://code.claude.com/docs/en/model-config#available-models
 *
 * Ownership and scope, mirroring the Pi/OMP integrations:
 *   - We own exactly one key on the document: `modelPicker.options`. We never
 *     write `replaceBuiltInOptions` or `behavesAs`, and we PRESERVE them when a
 *     user set them by hand — the apply/remove helpers only ever replace the
 *     `options` array, so a Reset cannot clobber the rest of the picker config.
 *   - Claude Code reads `modelPicker` from user settings (`~/.claude/settings.json`,
 *     where this integration writes), managed settings, and `--settings` — and
 *     ignores it in project and local settings, so a cloned repo cannot relabel
 *     the picker. Every other key Claude Code reads from that file (env, hooks,
 *     permissions, …) is untouched by these helpers.
 *   - There is no ledger here, unlike ZCode/OpenCode/Pi/OMP: `modelPicker` is a
 *     single document key rather than per-model entries, so there is nothing
 *     granular to reclaim and nothing to attribute. Reset removes our options.
 *
 * Deliberately NOT written, and why:
 *   - `label`/`description` are only written when non-empty. Claude Code has
 *     its own fallbacks (the built-in name for a model it knows, else the model
 *     id; a generic second line), so defaults beat an invented label.
 *   - `behavesAs`: only meaningful for a model newer than the installed Claude
 *     Code. We cannot know which side is short of which, and a wrong value makes
 *     Claude Code apply another model's capabilities/effort defaults.
 *   - No cap on label/description length: the docs specify none, and truncating
 *     silently would hide what the user typed from the picker. The only bound is
 *     CLAUDE_PICKER_MAX_ROWS, which keeps the file itself bounded.
 *
 * Pure module (no Node builtins) so the client-side card can import it too.
 */

/** Rows we will write. Generous, and only a bound on the file we own. */
export const CLAUDE_PICKER_MAX_ROWS = 50;

/** First Claude Code version that reads `modelPicker` (docs: v2.1.242+). */
export const CLAUDE_MODEL_PICKER_MIN_VERSION = "2.1.242";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Trim, and treat anything that is not a string as absent. */
const asText = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Normalize one picker row to `{ model, label?, description? }`.
 *
 * Returns null for anything not usable: a missing/blank `model` (the only field
 * Claude Code requires) is dropped rather than written as an empty row, which
 * would sit in the picker doing nothing. `model` is kept verbatim otherwise —
 * including a typed `[1m]` context marker, which Claude Code matches against the
 * model name.
 */
export const sanitizePickerRow = (row) => {
  if (!isObject(row)) return null;
  const model = asText(row.model);
  if (!model) return null;
  const entry = { model };
  const label = asText(row.label);
  if (label) entry.label = label;
  const description = asText(row.description);
  if (description) entry.description = description;
  return entry;
};

/**
 * Normalize a whole row list: drop unusable rows, dedupe by `model` (a repeated
 * id would just be a duplicate picker row), and cap the length so the settings
 * file stays bounded. Order is preserved — the docs render rows in written
 * order, so the user's ordering is the point.
 */
export const sanitizePickerRows = (rows) => {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const entry = sanitizePickerRow(row);
    if (!entry) continue;
    if (seen.has(entry.model)) continue;
    seen.add(entry.model);
    result.push(entry);
    if (result.length >= CLAUDE_PICKER_MAX_ROWS) break;
  }
  return result;
};

/** The rows a Claude Code settings file currently asks the picker to list. */
export const readPickerRows = (settings) => sanitizePickerRows(settings?.modelPicker?.options);

/** The `modelPicker` value our rows produce, or null when there is nothing to write. */
export const buildModelPicker = (rows) => {
  const options = sanitizePickerRows(rows);
  return options.length > 0 ? { options } : null;
};

/**
 * Set our picker rows on a Claude Code settings document, returning the same
 * object mutated (the callers already work on a private copy).
 *
 * - rows: the full new list. An empty list removes our key entirely when the
 *   `modelPicker` object holds nothing else, so a reset leaves the file as it
 *   was found; when a user has set their own keys on it (e.g.
 *   `replaceBuiltInOptions: true`), those survive and only our `options` goes.
 * - Any other key on `modelPicker` is preserved on both paths.
 */
export const applyModelPicker = (settings, rows) => {
  const next = isObject(settings) ? settings : {};
  const options = sanitizePickerRows(rows);
  const existing = isObject(next.modelPicker) ? next.modelPicker : null;

  if (options.length === 0) {
    if (!existing) return next;
    const { options: _drop, ...rest } = existing;
    if (Object.keys(rest).length === 0) delete next.modelPicker;
    else next.modelPicker = rest;
    return next;
  }

  next.modelPicker = { ...existing, options };
  return next;
};

/** Reset alias: remove our rows and leave any user-owned `modelPicker` keys. */
export const resetModelPicker = (settings) => applyModelPicker(settings, []);

/**
 * Whether a settings file's picker lineup hides the built-in rows. Only ever
 * read, never written — see the `behavesAs`/ownership notes in the header.
 */
export const readReplaceBuiltInOptions = (settings) => settings?.modelPicker?.replaceBuiltInOptions === true;
