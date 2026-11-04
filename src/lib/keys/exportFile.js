/**
 * Pure helpers for exporting AFRouter API keys.
 *
 * Kept free of request/DB/Next.js concerns so the file format (and its escaping
 * rules) can be unit-tested directly. Nothing here logs, caches or persists key
 * material — callers stream the returned string straight into the response.
 */

/** Upper bound on a single export so one request cannot build an unbounded file. */
export const MAX_EXPORT_KEYS = 500;

export const EXPORT_FORMATS = ["json", "csv"];

const CSV_COLUMNS = ["name", "key", "is_active", "created_at", "id"];

// Leading characters a spreadsheet interprets as a formula ("CSV injection").
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Validate the `ids` field of an export request.
 *
 * @param {unknown} rawIds - `null`/`undefined` means "every key"; otherwise an
 *   array of API key ids.
 * @returns {string[] | null} null for a full export, otherwise unique ids.
 * @throws {Error} when the value is malformed, empty or too large.
 */
export function parseExportIds(rawIds) {
  if (rawIds === undefined || rawIds === null) return null;
  if (!Array.isArray(rawIds)) throw new Error("ids must be an array of API key ids");

  const ids = [];
  const seen = new Set();
  for (const raw of rawIds) {
    if (typeof raw !== "string") throw new Error("ids must be an array of API key ids");
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  if (ids.length === 0) throw new Error("Select at least one API key to export");
  if (ids.length > MAX_EXPORT_KEYS) {
    throw new Error(`Cannot export more than ${MAX_EXPORT_KEYS} API keys at once`);
  }
  return ids;
}

/**
 * Filter the stored keys down to the requested ones (null = keep all).
 * Output keeps the DB order so exports are stable between runs.
 */
export function selectKeysForExport(keys, ids) {
  const list = Array.isArray(keys) ? keys : [];
  if (ids === null) return list;
  const wanted = new Set(ids);
  return list.filter((key) => key && wanted.has(key.id));
}

/**
 * Reduce stored rows to the fields worth exporting. `machineId` is dropped
 * because it is already embedded in the key and is not needed by consumers.
 */
export function toExportRecords(keys) {
  return (Array.isArray(keys) ? keys : []).map(({ id, name, key, isActive, createdAt }) => ({
    id,
    name,
    key,
    isActive: isActive !== false,
    createdAt,
  }));
}

export function buildExportPayload(records, exportedAt = new Date()) {
  return {
    application: "afrouter",
    exportedAt: exportedAt.toISOString(),
    count: records.length,
    keys: records,
  };
}

/**
 * Escape a single CSV cell: neutralize spreadsheet formulas first, then apply
 * RFC 4180 quoting so names containing quotes/newlines cannot break the file.
 */
export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (CSV_FORMULA_LEAD.test(text)) text = `'${text}`;
  if (/["\n\r,]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(records) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    lines.push([
      csvCell(record.name),
      csvCell(record.key),
      csvCell(record.isActive ? "true" : "false"),
      csvCell(record.createdAt),
      csvCell(record.id),
    ].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function buildExportFilename(format, exportedAt = new Date()) {
  const stamp = exportedAt.toISOString().replace(/[:.]/g, "-");
  return `afrouter-api-keys-${stamp}.${format === "csv" ? "csv" : "json"}`;
}

/**
 * Serialize records into the downloadable body plus its content type and a
 * filesystem-safe filename.
 */
export function serializeExport(records, format, exportedAt = new Date()) {
  if (format === "csv") {
    return {
      body: toCsv(records),
      contentType: "text/csv; charset=utf-8",
      filename: buildExportFilename("csv", exportedAt),
    };
  }
  return {
    body: `${JSON.stringify(buildExportPayload(records, exportedAt), null, 2)}\n`,
    contentType: "application/json; charset=utf-8",
    filename: buildExportFilename("json", exportedAt),
  };
}
