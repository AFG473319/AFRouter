// Server log reading: byte offsets let a command report only what *it* caused.
import fs from "node:fs";

const ERROR_RE = /(⨯|\bError\b|\bERROR\b|TypeError|ReferenceError|SyntaxError|Unhandled|uncaught|Failed to compile|Module not found|EADDRINUSE|ECONNREFUSED|\[error\]|✖)/;
const WARN_RE = /(⚠|\bwarn(ing)?\b|\bWARN\b|deprecated)/i;
// Known-benign noise for the isolated sandbox.
const IGNORE_RE = /(Slow filesystem detected|See more: https:\/\/nextjs\.org\/docs\/app\/guides\/local-development|Experiments \(use with caution\)|DATA_DIR\] .*fallback|modelCatalog\].*(fetch|sync).*fail)/i;

export function logSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function readSince(file, offset = 0) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.max(0, size - offset);
    const buf = Buffer.alloc(Math.min(len, 2_000_000));
    fs.readSync(fd, buf, 0, buf.length, Math.max(offset, size - buf.length));
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

export function classify(text, { limit = 40, maxLen = 500 } = {}) {
  const lines = text.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || IGNORE_RE.test(line)) continue;
    if (ERROR_RE.test(line)) {
      // Keep the first stack frame with the message: it usually names the file.
      const next = lines[i + 1] && /^\s+at\s/.test(lines[i + 1]) ? ` | ${lines[i + 1].trim()}` : "";
      errors.push((line + next).slice(0, maxLen));
    } else if (WARN_RE.test(line)) warnings.push(line.slice(0, maxLen));
  }
  return { errors: dedupe(errors).slice(-limit), warnings: dedupe(warnings).slice(-limit) };
}

function dedupe(arr) {
  const seen = new Map();
  for (const l of arr) {
    const key = l.replace(/\d+(\.\d+)?m?s\b/g, "#").replace(/\b\d{2}:\d{2}:\d{2}(\.\d+)?/g, "#");
    seen.set(key, (seen.get(key) ? `${l} (repeated)` : l));
  }
  return [...seen.values()];
}
