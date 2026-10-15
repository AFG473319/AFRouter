// Merge the duplicate "agnesai" provider into "agnes".
//
// Two registry entries pointed at apihub.agnes-ai.com and shipped the same
// "Agnes 2.5 / 3.0" models. The sloppier duplicate (no priority, off-brand
// colour, a modelsFetcher on a token-gated endpoint, non-catalog media ids and
// an "agnes" alias that shadowed the real provider) was removed. "agnesai" is
// now an alias on the kept entry — see open-sse/providers/registry/agnes.js.
//
// Connections, combos and model aliases are all keyed by a stored provider id,
// so without rewriting them a saved "agnesai" credential would be orphaned and
// its combos would point at a provider that no longer exists (an alias only
// helps at request-routing time, not for these id-exact lookups).
const OLD_ID = "agnesai";
const NEW_ID = "agnes";

/** Rewrite a stored model reference: "agnesai/x" → "agnes/x", "agnesai" → "agnes". */
function rewriteModelRef(ref) {
  if (typeof ref !== "string" || !ref) return ref;
  if (ref === OLD_ID) return NEW_ID;
  if (ref.startsWith(`${OLD_ID}/`)) return `${NEW_ID}/${ref.slice(OLD_ID.length + 1)}`;
  return ref;
}

export default {
  version: 2,
  name: "agnesai-to-agnes",
  up(db) {
    // 1) Saved connections: the provider id column itself.
    db.run(`UPDATE providerConnections SET provider = ? WHERE provider = ?`, [NEW_ID, OLD_ID]);

    // 2) Combos: `models` is a JSON array of "provider/model" strings.
    for (const row of db.all(`SELECT id, models FROM combos`)) {
      let models;
      try {
        models = JSON.parse(row.models);
      } catch {
        continue;
      }
      if (!Array.isArray(models)) continue;

      let changed = false;
      const next = models.map((entry) => {
        const rewritten = rewriteModelRef(entry);
        if (rewritten !== entry) changed = true;
        return rewritten;
      });
      if (changed) db.run(`UPDATE combos SET models = ? WHERE id = ?`, [JSON.stringify(next), row.id]);
    }

    // 3) User-defined model aliases (kv scope "modelAliases"): value is a JSON
    //    string encoded like `"agnesai/model"`.
    for (const row of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) {
      let value;
      try {
        value = JSON.parse(row.value);
      } catch {
        continue;
      }
      const rewritten = rewriteModelRef(value);
      if (rewritten !== value) {
        db.run(`UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?`, [JSON.stringify(rewritten), row.key]);
      }
    }
  },
};
