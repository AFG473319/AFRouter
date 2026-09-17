const api = require("../../api/client");
const { required } = require("../args");

const HELP = `chat --model <m> --prompt <text> [flags]
  Single non-streaming completion through the gateway (OpenAI-compatible).
  Flags: --system <s> --max-tokens <n> --temperature <t> --api-key <k>
  If --prompt is omitted, the prompt is read from stdin.`;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

async function run(action, pos, opts) {
  // chat is actionless: `chat --model ... --prompt ...`
  if (action && action !== "chat") return { usage: HELP };
  const model = required(opts, "model");
  let prompt = opts.prompt;
  if (prompt === undefined || prompt === true) {
    prompt = await readStdin();
  }
  if (!prompt) return { usage: "chat needs --prompt <text> or piped stdin" };
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  const body = { model, messages, stream: false };
  if (opts["max-tokens"] || opts.maxTokens) body.max_tokens = parseInt(opts["max-tokens"] || opts.maxTokens, 10);
  if (opts.temperature !== undefined) body.temperature = parseFloat(opts.temperature);
  let key = opts["api-key"] || opts.apiKey;
  if (!key) {
    // Gateway /v1/* needs an sk_afrouter key — reuse the first one automatically.
    const keys = await api.getApiKeys();
    const list = keys.success ? (keys.data.keys || []) : [];
    if (list.length === 0) return { error: "No API keys — create one first (keys create --name <n>) or pass --api-key" };
    key = list[0].key;
  }
  const r = await api.req("POST", "/v1/chat/completions", body, key);
  if (!r.success) return { error: r.error };
  return { data: r.data };
}

module.exports = { run, HELP };
