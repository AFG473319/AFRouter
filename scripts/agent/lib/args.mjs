// Tiny argv parser: positionals, --flag, --key value, --key=value, -t value, and "--"
// passthrough. Repeated keys become arrays. No dependency, predictable on Windows shells.
const SHORT = { t: "testName", h: "help", p: "pretty" };

export function parseArgs(argv) {
  const out = { _: [], passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.passthrough = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value;
      if (eq !== -1) value = a.slice(eq + 1);
      else if (key.startsWith("no-")) {
        key = key.slice(3);
        value = false;
      } else if (i + 1 < argv.length && !/^-[-a-zA-Z]/.test(argv[i + 1])) {
        value = argv[++i];
      } else value = true;
      add(out, camel(key), value);
    } else if (/^-[a-zA-Z]$/.test(a)) {
      const key = SHORT[a[1]] || a[1];
      const takesValue = key === "testName";
      add(out, key, takesValue && i + 1 < argv.length ? argv[++i] : true);
    } else {
      out._.push(a);
    }
  }
  return out;
}

function add(out, key, value) {
  if (key in out && key !== "_") {
    out[key] = [].concat(out[key], value);
  } else out[key] = value;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function num(v, fallback) {
  if (v === undefined || v === true || v === false) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function list(v) {
  if (v === undefined || v === false) return [];
  return [].concat(v).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
}
