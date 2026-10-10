import fs from "fs/promises";
import path from "path";
import { parse as parseJsonc, modify as jsoncModify, applyEdits, printParseErrorCode } from "jsonc-parser";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";

export class CliConfigParseError extends Error {
  constructor(file, detail) {
    super(`Cannot parse ${file}: ${detail}. Fix or remove the file, then retry. AFRouter did not modify it.`);
    this.name = "CliConfigParseError";
    this.status = 409;
  }
}

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// Returns the parsed value, or undefined when the file does not exist. Throws
// CliConfigParseError on malformed content so callers abort instead of wiping it.
export function parseConfigText(text, format, file = "config") {
  const body = stripBom(text);
  if (!body.trim()) return undefined;
  try {
    switch (format) {
      case "json": {
        const errors = [];
        const value = parseJsonc(body, errors, { allowTrailingComma: true, disallowComments: false });
        if (errors.length) throw new CliConfigParseError(file, printParseErrorCode(errors[0].error));
        return value;
      }
      case "json5":
        return JSON5.parse(body);
      case "toml":
        return parseToml(body);
      case "yaml":
        return YAML.parse(body);
      default:
        throw new Error(`Unknown config format: ${format}`);
    }
  } catch (error) {
    if (error instanceof CliConfigParseError) throw error;
    throw new CliConfigParseError(file, error.message.split("\n")[0]);
  }
}

export async function readConfig(filePath, format) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, raw: "", value: undefined };
    throw error;
  }
  return { exists: true, raw: text, value: parseConfigText(text, format, path.basename(filePath)) };
}

// Edit a JSON/JSONC file without losing comments or formatting. `edits` is a
// list of { path, value } (value undefined deletes the key).
export function editJsoncText(text, edits) {
  let next = stripBom(text || "{}");
  for (const { path: keyPath, value } of edits) {
    const changes = jsoncModify(next, keyPath, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    next = applyEdits(next, changes);
  }
  return next;
}

// Timestamped backup beside the original, written only when the file exists.
export async function backupFile(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${stamp}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

// Atomic write: temp file in the same directory, then rename. Files holding
// API keys get 0600 (ignored on Windows, where POSIX modes do not apply).
export async function writeConfigAtomic(filePath, content, { secret = false } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, { encoding: "utf-8", mode: secret ? 0o600 : 0o644 });
  await fs.rename(tmp, filePath);
  if (secret) await fs.chmod(filePath, 0o600).catch(() => {});
}

// Backup + atomic write in one step; every writer should go through this.
export async function writeWithBackup(filePath, content, options) {
  const backup = await backupFile(filePath);
  await writeConfigAtomic(filePath, content, options);
  return { backup };
}
