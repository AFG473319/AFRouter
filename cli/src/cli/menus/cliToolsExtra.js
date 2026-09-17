const api = require("../api/client");
const { prompt, confirm, pause } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { printJson } = require("../utils/output");
const { selectModelFromList } = require("../utils/modelSelector");
const { showMenuWithBack } = require("../utils/menuHelper");
const { getEndpoint } = require("../utils/endpoint");
const { copyToClipboard } = require("../utils/clipboard");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m"
};

const TOOL_NAMES = {
  cline: "Cline",
  kilo: "Kilo Code",
  cowork: "Claude Cowork",
  "deepseek-tui": "DeepSeek TUI",
  "deepseek-harness": "DeepSeek Harness",
  jcode: "jcode",
  "grok-build": "Grok Build",
  zcode: "ZCode",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  roo: "Roo",
  continue: "Continue",
  amp: "Amp CLI",
  qwen: "Qwen Code",
  devin: "Devin CLI",
  opendesign: "OpenDesign",
};

// Single-model tools: POST { baseUrl, apiKey, model }
const SINGLE_MODEL_TOOLS = ["cline", "kilo", "deepseek-tui"];
// Multi-model tools: POST { baseUrl, apiKey, models[] }
const MULTI_MODEL_TOOLS = ["cowork", "deepseek-harness", "jcode", "grok-build", "zcode"];
// Guide-only tools (extension/IDE-side config, no POST route)
const GUIDE_TOOLS = {
  copilot: [
    "Install the 'AFRouter for GitHub Copilot' VS Code extension.",
    "Run 'AFRouter: Configure Server' and enter the endpoint + API key below.",
    "In Copilot Chat, open the model picker → Manage Models → check AFRouter models.",
  ],
  cursor: [
    "Cursor Pro account required. Cursor routes via its own server — use Tunnel/Cloud endpoint.",
    "Settings → Models → enable 'OpenAI API key'.",
    "Base URL = endpoint below; API Key = your AFRouter key; add a custom model.",
  ],
  roo: [
    "Open Roo Settings → API Provider → Ollama.",
    "Base URL = endpoint below; API Key = your AFRouter key; pick a model.",
  ],
  continue: [
    "Open Continue config and add a model entry:",
    '{ "apiBase": "<endpoint>", "title": "<model>", "model": "<model>", "provider": "openai" }',
  ],
  amp: [
    'export OPENAI_API_KEY="<key>"',
    'export OPENAI_BASE_URL="<endpoint>"',
    'amp --model "<model>"',
  ],
  qwen: [
    "npm install -g @qwen-code/qwen-code",
    "Copy endpoint + key + model into ~/.qwen/settings.json (openai auth type).",
  ],
  devin: [
    "Local dependency — not routed. Install via cli.devin.ai and run 'devin auth login'.",
    "Then pick Devin CLI models under the Providers menu.",
  ],
  opendesign: [
    "Skills pack inside your host agent (Claude Code / Cursor / Codex / Gemini / OpenCode).",
    "No extra config — once the host routes through AFRouter, /opendesign traffic does too.",
  ],
};

async function getFirstApiKey() {
  const result = await api.getApiKeys();
  const keys = result.success ? (result.data.keys || []) : [];
  return keys.length > 0 ? keys[0].key : null;
}

function toolName(id) {
  return TOOL_NAMES[id] || id;
}

async function buildGenericHeader(tool) {
  const result = await api.getCliToolSettings(tool);
  if (!result.success) return `  ${COLORS.red}Failed to load settings${COLORS.reset}`;
  const d = result.data || {};
  if (d.installed === false) return `Status:   ${COLORS.red}✗ ${toolName(tool)} not installed${COLORS.reset}`;
  const blob = JSON.stringify(d);
  const configured = d.hasAFRouter === true || /afrouter|localhost|127\.0\.0\.1/i.test(blob);
  const lines = [configured
    ? `Status:   ${COLORS.green}✓ Configured${COLORS.reset}`
    : `Status:   ${COLORS.red}✗ Not configured${COLORS.reset} ${COLORS.dim}(run Quick Setup)${COLORS.reset}`];
  const urlMatch = blob.match(/"(?:baseUrl|baseURL|base_url)"\s*:\s*"([^"]+)"/);
  if (urlMatch) lines.push(`Endpoint: ${COLORS.cyan}${urlMatch[1]}${COLORS.reset}`);
  return lines.join("\n");
}

async function genericQuickSetup(port, tool, multi) {
  const { endpoint } = await getEndpoint(port);
  const apiKey = await getFirstApiKey();
  if (!apiKey) {
    showStatus("No API keys found. Create one in API Keys menu first.", "error");
    await pause();
    return;
  }
  if (multi) {
    const first = await selectModelFromList(`Select Model ( ${toolName(tool)} )`, "", { excludeCombos: true });
    if (!first) return;
    const models = [first];
    while (true) {
      const more = await confirm(`Add another model? (current: ${models.length})`);
      if (!more) break;
      const next = await selectModelFromList(`Add Model #${models.length + 1}`, models.join(", "), { excludeCombos: true });
      if (!next) break;
      if (!models.includes(next)) models.push(next);
    }
    const result = await api.applyCliToolSettings(tool, { baseUrl: endpoint, apiKey, models });
    showStatus(result.success ? `${toolName(tool)} setup completed!` : `Failed: ${result.error}`, result.success ? "success" : "error");
  } else {
    const model = await selectModelFromList(`Select Model ( ${toolName(tool)} )`, "", { excludeCombos: true });
    if (!model) return;
    const result = await api.applyCliToolSettings(tool, { baseUrl: endpoint, apiKey, model });
    showStatus(result.success ? `${toolName(tool)} setup completed!` : `Failed: ${result.error}`, result.success ? "success" : "error");
  }
  await pause();
}

async function genericReset(tool) {
  const result = await api.resetCliToolSettings(tool);
  showStatus(result.success ? `${toolName(tool)} settings reset!` : `Failed: ${result.error}`, result.success ? "success" : "error");
  await pause();
}

/**
 * Generic managed-config tool submenu (single- or multi-model POST shape).
 */
async function showGenericToolMenu(port, tool, multi, breadcrumb = []) {
  await showMenuWithBack({
    title: `🔧 ${toolName(tool)} Settings`,
    breadcrumb,
    headerContent: () => buildGenericHeader(tool),
    refresh: async () => ({}),
    items: [
      { label: "⚡ Quick Setup", action: async () => { await genericQuickSetup(port, tool, multi); return true; } },
      { label: "View Raw Status (JSON)", action: async () => { const r = await api.getCliToolSettings(tool); printJson(r.success ? r.data : r); await pause(); return true; } },
      { label: "Reset to Default", action: async () => { await genericReset(tool); return true; } },
    ]
  });
}

/**
 * Guide-only tool: show endpoint + key + steps, offer copy actions.
 */
async function showGuideToolMenu(port, tool, breadcrumb = []) {
  const { endpoint } = await getEndpoint(port);
  const apiKey = await getFirstApiKey();
  await showMenuWithBack({
    title: `📖 ${toolName(tool)} Guide`,
    breadcrumb,
    headerContent: `Endpoint: ${endpoint}\nAPI Key:  ${apiKey ? `${apiKey.slice(0, 10)}...` : "(none — create one in API Keys)"}\n\n${(GUIDE_TOOLS[tool] || []).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    refresh: async () => ({}),
    items: [
      {
        label: "Copy Endpoint",
        action: async () => {
          const ok = copyToClipboard(endpoint);
          showStatus(ok ? "Endpoint copied!" : "Copy failed", ok ? "success" : "error");
          await pause();
          return true;
        }
      },
      {
        label: "Copy API Key",
        action: async () => {
          if (!apiKey) { showStatus("No API key available", "error"); await pause(); return true; }
          const ok = copyToClipboard(apiKey);
          showStatus(ok ? "Key copied!" : "Copy failed", ok ? "success" : "error");
          await pause();
          return true;
        }
      },
    ]
  });
}

// ─── MITM (Antigravity) ─────────────────────────────────────────────────────

async function showMitmMenu(breadcrumb = []) {
  await showMenuWithBack({
    title: "🕵️  MITM (Antigravity)",
    breadcrumb,
    headerContent: async () => {
      const res = await api.getMitmStatus("antigravity");
      if (!res.success) return "Status unavailable";
      const s = res.data;
      return `Running: ${s.running ? "yes" : "no"} • Cert: ${s.certTrusted ? "trusted" : "untrusted"}${s.port ? ` • Port: ${s.port}` : ""}`;
    },
    refresh: async () => ({}),
    items: [
      {
        label: "View Status (JSON)",
        action: async () => {
          const res = await api.getMitmStatus("antigravity");
          printJson(res.success ? res.data : res);
          await pause();
          return true;
        }
      },
      {
        label: "Model Alias Mapping (view / edit)",
        action: async () => { await handleMitmAlias(); return true; }
      },
    ]
  });
}

async function handleMitmAlias() {
  const res = await api.getMitmAlias("antigravity");
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  printJson(res.data);
  const edit = await confirm("\nEdit alias mapping?");
  if (!edit) { await pause(); return; }
  const alias = await prompt("Alias (e.g. gemini-3.8-flash-high): ");
  if (!alias) { showStatus("Cancelled", "warning"); await pause(); return; }
  const { selectModelFromList } = require("../utils/modelSelector");
  const model = await selectModelFromList("Select Target Model", "");
  if (!model) return;
  const upd = await api.updateMitmAlias("antigravity", { alias: alias.trim(), model });
  showStatus(upd.success ? `✓ ${alias} → ${model}` : `✗ Failed: ${upd.error}`, upd.success ? "success" : "error");
  await pause();
}

module.exports = {
  SINGLE_MODEL_TOOLS,
  MULTI_MODEL_TOOLS,
  GUIDE_TOOLS,
  toolName,
  showGenericToolMenu,
  showGuideToolMenu,
  showMitmMenu,
};
