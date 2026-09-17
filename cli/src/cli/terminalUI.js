const api = require("./api/client");
const { showMenuWithBack } = require("./utils/menuHelper");
const { showProvidersMenu } = require("./menus/providers");
const { showApiKeysMenu } = require("./menus/apiKeys");
const { showCombosMenu } = require("./menus/combos");
const { showModelsMenu } = require("./menus/models");
const { showUsageMenu } = require("./menus/usage");
const { showNetworkMenu } = require("./menus/network");
const { showSettingsMenu } = require("./menus/settings");
const { showCliToolsMenu } = require("./menus/cliTools");
const { showMitmMediaMenu } = require("./menus/mitmMedia");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m"
};

// Cached header (SWR): show last value instantly, refresh in background.
let cachedHeader = "";
let fetchingHeader = false;

function renderHeader(port, keys, tunnel) {
  const tunnelEnabled = tunnel && tunnel.enabled === true;
  const lines = [];
  if (tunnelEnabled && tunnel.publicUrl) {
    lines.push(`Endpoint: ${COLORS.green}${tunnel.publicUrl}/v1${COLORS.reset}`);
    lines.push(`Tunnel:   ${COLORS.green}ON${COLORS.reset} ${COLORS.dim}(${tunnel.shortId})${COLORS.reset}`);
  } else {
    lines.push(`Endpoint: http://localhost:${port}/v1`);
    lines.push(`Tunnel:   ${COLORS.red}OFF${COLORS.reset} ${COLORS.dim}(local only)${COLORS.reset}`);
  }
  if (!keys || keys.length === 0) {
    lines.push(`Key:      ${COLORS.dim}No API keys yet${COLORS.reset}`);
  } else {
    lines.push(`Key:      ${COLORS.cyan}${keys[0].key}${COLORS.reset}`);
    keys.slice(1).forEach(k => lines.push(`          ${COLORS.cyan}${k.key}${COLORS.reset}`));
  }
  return lines.join("\n");
}

async function refreshHeaderBg(port) {
  if (fetchingHeader) return;
  fetchingHeader = true;
  try {
    const [keysResult, tunnelResult] = await Promise.all([
      api.getApiKeys(),
      api.getTunnelStatus()
    ]);
    const keys = keysResult.success ? (keysResult.data.keys || []) : [];
    const tunnel = tunnelResult.success ? (tunnelResult.data || {}) : {};
    cachedHeader = renderHeader(port, keys, tunnel);
  } finally {
    fetchingHeader = false;
  }
}

function getHeader(port) {
  // Kick off background refresh; return cache (or placeholder on first call).
  refreshHeaderBg(port);
  return cachedHeader || `Endpoint: http://localhost:${port}/v1\nTunnel:   ${COLORS.dim}...${COLORS.reset}\nKey:      ${COLORS.dim}...${COLORS.reset}`;
}

/**
 * Start Terminal UI
 * @param {number} port - Server port number
 */
async function startTerminalUI(port) {
  // Configure API client
  api.configure({ port });

  const basePath = ["AFRouter"];

  // Prime header cache before first render
  await refreshHeaderBg(port);

  // Main menu
  await showMenuWithBack({
    title: "📡 AFRouter Terminal UI",
    breadcrumb: basePath,
    headerContent: () => getHeader(port),
    items: [
      {
        label: "Providers",
        action: async () => {
          await showProvidersMenu([...basePath, "Providers"]);
          return true; // Continue
        }
      },
      {
        label: "API Keys",
        action: async () => {
          await showApiKeysMenu(port, [...basePath, "API Keys"]);
          return true;
        }
      },
      {
        label: "Combos",
        action: async () => {
          await showCombosMenu([...basePath, "Combos"]);
          return true;
        }
      },
      {
        label: "Models",
        action: async () => {
          await showModelsMenu([...basePath, "Models"]);
          return true;
        }
      },
      {
        label: "Usage & Quota",
        action: async () => {
          await showUsageMenu([...basePath, "Usage & Quota"]);
          return true;
        }
      },
      {
        label: "Endpoint & Network",
        action: async () => {
          await showNetworkMenu(port, [...basePath, "Endpoint & Network"]);
          return true;
        }
      },
      {
        label: "MITM & Media",
        action: async () => {
          await showMitmMediaMenu([...basePath, "MITM & Media"]);
          return true;
        }
      },
      {
        label: "CLI Tools",
        action: async () => {
          await showCliToolsMenu(port, [...basePath, "CLI Tools"]);
          return true;
        }
      },
      {
        label: "Settings",
        action: async () => {
          await showSettingsMenu([...basePath, "Settings"]);
          return true;
        }
      }
    ],
    backLabel: "← Back to Interface Menu"
  });
}

module.exports = { startTerminalUI };
