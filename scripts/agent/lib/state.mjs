// Read-only view of the sandbox: the temp SQLite DB and the files the app wrote under the
// temp DATA_DIR and fake HOME (CLI-tool config routes write ~/.claude, ~/.codex, ... there).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { summarize } from "./http.mjs";
import { HarnessError } from "./out.mjs";

const require = createRequire(import.meta.url);

export function dbPath(state) {
  return path.join(state.dataDir, "db", "data.sqlite");
}

export async function openReadOnly(file) {
  if (!fs.existsSync(file)) throw new HarnessError(`no database yet at ${file}`);
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      driver: "node:sqlite",
      all: (sql, ...params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch (e) {
    if (e instanceof HarnessError) throw e;
    // sql.js reads a snapshot of the main file (uncheckpointed WAL pages are not visible).
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(file));
    return {
      driver: "sql.js",
      all: (sql, ...params) => {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
      close: () => db.close(),
    };
  }
}

const READ_ONLY_SQL = /^\s*(select|pragma|with|explain)\b/i;

export function assertReadOnlySql(sql) {
  if (!READ_ONLY_SQL.test(sql) || /;\s*\S/.test(sql.trim().replace(/;\s*$/, ""))) {
    throw new HarnessError("state --sql accepts a single SELECT/PRAGMA/WITH statement");
  }
}

function parseJsonColumns(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && /^[[{]/.test(v)) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        /* not json */
      }
    }
    out[k] = v;
  }
  return out;
}

export async function inspect(state, { table, sql, limit = 20 } = {}) {
  const db = await openReadOnly(dbPath(state));
  try {
    if (sql) {
      assertReadOnlySql(sql);
      const rows = db.all(sql).slice(0, limit).map(parseJsonColumns);
      return { driver: db.driver, rows: summarize(rows) };
    }
    const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
    if (table) {
      if (!tables.includes(table)) throw new HarnessError(`unknown table ${table}`, { tables });
      const total = db.all(`SELECT COUNT(*) AS n FROM "${table}"`)[0].n;
      const rows = db.all(`SELECT * FROM "${table}" LIMIT ?`, limit).map(parseJsonColumns);
      return { driver: db.driver, table, total, rows: summarize(rows) };
    }
    const counts = {};
    for (const t of tables) counts[t] = db.all(`SELECT COUNT(*) AS n FROM "${t}"`)[0].n;
    let settings;
    if (tables.includes("settings")) {
      const row = db.all("SELECT data FROM settings WHERE id = 1")[0];
      if (row) {
        const s = JSON.parse(row.data);
        settings = summarize({ requireLogin: s.requireLogin, requireApiKey: s.requireApiKey, authMode: s.authMode, rtkEnabled: s.rtkEnabled, keys: Object.keys(s).length });
      }
    }
    const check = db.all("PRAGMA quick_check")[0];
    return { driver: db.driver, integrity: Object.values(check || {})[0], tables: counts, settings };
  } finally {
    db.close();
  }
}

export function listFiles(state, { maxEntries = 200 } = {}) {
  const roots = { data: state.dataDir, home: state.homeDir };
  const out = {};
  for (const [label, root] of Object.entries(roots)) {
    const entries = [];
    const walk = (dir, depth) => {
      if (depth > 6 || entries.length >= maxEntries) return;
      let list = [];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const p = path.join(dir, e.name);
        const relp = path.relative(root, p).split(path.sep).join("/");
        if (e.isDirectory()) walk(p, depth + 1);
        else entries.push(`${relp} (${fs.statSync(p).size}b)`);
      }
    };
    walk(root, 0);
    out[label] = entries;
  }
  return out;
}

export function readSandboxFile(state, spec) {
  // spec: "home:.claude/settings.json" or "data:model-catalog.json"
  const m = String(spec).match(/^(home|data):(.+)$/);
  if (!m) throw new HarnessError("use --file home:<path> or --file data:<path>");
  const root = m[1] === "home" ? state.homeDir : state.dataDir;
  const full = path.resolve(root, m[2]);
  if (!full.startsWith(path.resolve(root))) throw new HarnessError("path escapes the sandbox");
  const text = fs.readFileSync(full, "utf8");
  try {
    return { file: full, json: summarize(JSON.parse(text)) };
  } catch {
    return { file: full, text: text.slice(0, 4000), bytes: text.length };
  }
}
