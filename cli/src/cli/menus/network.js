const api = require("../api/client");
const { prompt, confirm, pause } = require("../utils/input");
const { clearScreen, showStatus } = require("../utils/display");
const { printResult, printJson, offerJsonView, fmt } = require("../utils/output");
const { showMenuWithBack, showListMenu } = require("../utils/menuHelper");
const { getEndpoint } = require("../utils/endpoint");

/**
 * Endpoint & Network menu — endpoint URLs, proxy pools, tailscale,
 * headroom extras, pxpipe ops. Mirrors dashboard Endpoint + Proxy-Pools +
 * PxPipe pages (relay deploys stay dashboard-guided).
 * @param {number} port
 * @param {Array<string>} breadcrumb
 */
async function showNetworkMenu(port, breadcrumb = []) {
  await showMenuWithBack({
    title: "🌐 Endpoint & Network",
    breadcrumb,
    headerContent: async () => {
      const { endpoint } = await getEndpoint(port);
      return `Endpoint: ${endpoint}`;
    },
    refresh: async () => ({}),
    items: [
      { label: "Endpoint Info & Security", action: async () => { await handleEndpointInfo(port); return true; } },
      { label: "Proxy Pools (CRUD + health)", action: async () => { await showProxyPoolsMenu([...breadcrumb, "Proxy Pools"]); return true; } },
      { label: "Tailscale (check / install / on / off)", action: async () => { await handleTailscale(); return true; } },
      { label: "Headroom Extras", action: async () => { await handleHeadroomExtras(); return true; } },
      { label: "PxPipe (status / stats / logs / lifecycle)", action: async () => { await handlePxpipe([...breadcrumb, "PxPipe"]); return true; } },
    ]
  });
}

async function handleEndpointInfo(port) {
  clearScreen();
  console.log("\n🔗 Endpoint Info\n");
  const { endpoint } = await getEndpoint(port);
  const [loginRes, settingsRes, tunnelRes] = await Promise.all([
    api.getRequireLogin().catch(() => ({ success: false })),
    api.getSettings(),
    api.getTunnelStatus(),
  ]);
  const login = loginRes.success ? loginRes.data : {};
  const settings = settingsRes.success ? (settingsRes.data.settings || settingsRes.data || {}) : {};
  const tunnel = tunnelRes.success ? (tunnelRes.data.tunnel || tunnelRes.data || {}) : {};
  console.log(`  Local:    http://localhost:${port}/v1`);
  console.log(`  Active:   ${endpoint}`);
  if (tunnel.publicUrl || tunnel.tunnelUrl) console.log(`  Tunnel:   ${tunnel.publicUrl || tunnel.tunnelUrl}`);
  console.log(`  Login:    ${login.requireLogin === false ? "OFF" : "ON"}`);
  console.log(`  API key:  ${settings.requireApiKey === false ? "NOT required" : "required"}`);
  if (login.requireLogin !== false) console.log("\n  ⚠️  Exposing this endpoint publicly requires a non-default password.");
  const toggle = await confirm("\nToggle requireApiKey?");
  if (toggle) {
    const next = !(settings.requireApiKey !== false);
    const res = await api.updateSettings({ requireApiKey: next });
    showStatus(res.success ? `requireApiKey → ${next}` : `Failed: ${res.error}`, res.success ? "success" : "error");
  }
  await pause();
}

// ─── Proxy pools ────────────────────────────────────────────────────────────

async function showProxyPoolsMenu(breadcrumb = []) {
  await showListMenu({
    title: "🔀 Proxy Pools",
    breadcrumb,
    backLabel: "← Back to Network",
    fetchItems: async () => {
      const res = await api.getProxyPools();
      if (!res.success) {
        showStatus(`Failed: ${res.error}`, "error");
        await pause();
        return null;
      }
      return { items: res.data.pools || res.data || [] };
    },
    formatItem: (p) => `${p.isActive === false ? "✗ " : "✓ "}${p.name} [${p.type || "http"}]`,
    onSelect: async (pool) => {
      await showProxyPoolActions(pool, breadcrumb);
    },
    createAction: {
      label: "➕ Add Proxy Pool",
      action: async () => { await handleCreateProxyPool(); }
    }
  });
}

async function showProxyPoolActions(pool, breadcrumb = []) {
  await showMenuWithBack({
    title: `🔀 ${pool.name}`,
    breadcrumb: [...breadcrumb, pool.name],
    headerContent: `Type: ${pool.type || "http"}\nURL: ${pool.proxyUrl || "-"}\nActive: ${pool.isActive !== false ? "yes" : "no"}`,
    items: [
      {
        label: "Test Pool",
        action: async () => {
          showStatus("Testing...", "info");
          const res = await api.testProxyPool(pool.id);
          if (res.success) { showStatus("✓ Test done!", "success"); printJson(res.data); }
          else showStatus(`✗ Failed: ${res.error}`, "error");
          await pause();
          return true;
        }
      },
      {
        label: ( ) => pool.isActive === false ? "Enable Pool" : "Disable Pool",
        action: async () => {
          const res = await api.updateProxyPool(pool.id, { isActive: pool.isActive === false });
          if (res.success) {
            pool.isActive = pool.isActive === false;
            showStatus("✓ Updated!", "success");
          } else showStatus(`Failed: ${res.error}`, "error");
          await pause();
          return true;
        }
      },
      {
        label: "Edit Pool",
        action: async () => {
          console.log("\n(leave blank to keep current value)\n");
          const name = await prompt(`Name (${pool.name}): `);
          const proxyUrl = await prompt(`Proxy URL (${pool.proxyUrl || ""}): `);
          const updates = {};
          if (name && name.trim()) updates.name = name.trim();
          if (proxyUrl && proxyUrl.trim()) updates.proxyUrl = proxyUrl.trim();
          if (Object.keys(updates).length === 0) { showStatus("No changes.", "warning"); await pause(); return true; }
          const res = await api.updateProxyPool(pool.id, updates);
          showStatus(res.success ? "✓ Updated!" : `Failed: ${res.error}`, res.success ? "success" : "error");
          await pause();
          return true;
        }
      },
      {
        label: "View as JSON",
        action: async () => {
          const res = await api.getProxyPoolById(pool.id);
          printJson(res.success ? res.data : res);
          await pause();
          return true;
        }
      },
      {
        label: "Delete Pool",
        action: async () => {
          const ok = await confirm(`Delete pool "${pool.name}"?`);
          if (ok) {
            const res = await api.deleteProxyPool(pool.id);
            showStatus(res.success ? "Deleted!" : `Failed: ${res.error}`, res.success ? "success" : "error");
            await pause();
            return false;
          }
          return true;
        }
      },
    ]
  });
}

async function handleCreateProxyPool() {
  clearScreen();
  console.log("\n➕ Add Proxy Pool\n");
  const name = await prompt("Name: ");
  if (!name) { showStatus("Cancelled", "warning"); await pause(); return; }
  console.log("\nType: 1) http  2) vercel  3) cloudflare  4) deno");
  const typeInput = await prompt("Type (1-4, default 1): ");
  const types = ["http", "vercel", "cloudflare", "deno"];
  const type = types[(parseInt(typeInput, 10) || 1) - 1] || "http";
  const proxyUrl = await prompt("Proxy URL: ");
  if (!proxyUrl) { showStatus("Cancelled", "warning"); await pause(); return; }
  const res = await api.createProxyPool({ name: name.trim(), type, proxyUrl: proxyUrl.trim() });
  showStatus(res.success ? "✓ Pool created!" : `✗ Failed: ${res.error}`, res.success ? "success" : "error");
  await pause();
}

// ─── Tailscale ──────────────────────────────────────────────────────────────

async function handleTailscale() {
  clearScreen();
  console.log("\n🔒 Tailscale\n");
  showStatus("Checking status...", "info");
  const res = await api.getTailscaleCheck();
  if (res.success) printJson(res.data);
  else showStatus(`Check failed: ${res.error}`, "error");
  await showMenuWithBack({
    title: "🔒 Tailscale Actions",
    breadcrumb: [],
    items: [
      { label: "Install Tailscale", action: async () => { const r = await api.installTailscale(); showStatus(r.success ? "✓ Install done!" : `Failed: ${r.error}`, r.success ? "success" : "error"); await pause(); return true; } },
      { label: "Enable Tailscale", action: async () => { const r = await api.enableTailscale(); showStatus(r.success ? "✓ Enabled!" : `Failed: ${r.error}`, r.success ? "success" : "error"); await pause(); return true; } },
      { label: "Disable Tailscale", action: async () => { const r = await api.disableTailscale(); showStatus(r.success ? "✓ Disabled!" : `Failed: ${r.error}`, r.success ? "success" : "error"); await pause(); return true; } },
    ]
  });
}

// ─── Headroom extras ────────────────────────────────────────────────────────

async function handleHeadroomExtras() {
  clearScreen();
  console.log("\n🛰️  Headroom Extras\n");
  const res = await api.getHeadroomExtras();
  if (!res.success) showStatus(`Failed: ${res.error}`, "error");
  else {
    printJson(res.data);
    await offerJsonView(res.data);
  }
  await pause();
}

// ─── PxPipe ─────────────────────────────────────────────────────────────────

async function handlePxpipe(breadcrumb = []) {
  await showMenuWithBack({
    title: "🗜️  PxPipe",
    breadcrumb,
    headerContent: async () => {
      const res = await api.getPxpipeStatus();
      if (!res.success) return "Status unavailable";
      const s = res.data;
      return `Running: ${s.running ? "yes" : "no"} • Enabled: ${s.enabled ? "yes" : "no"} • Uptime: ${s.uptime ?? "-"}`;
    },
    refresh: async () => ({}),
    items: [
      {
        label: "Stats",
        action: async () => {
          const period = await require("../utils/output").pickPeriod("7d");
          const res = await api.getPxpipeStats(period);
          if (res.success) { printJson(res.data); await offerJsonView(res.data); }
          else showStatus(`Failed: ${res.error}`, "error");
          await pause();
          return true;
        }
      },
      {
        label: "Recent Logs",
        action: async () => {
          const res = await api.getPxpipeLogs();
          if (res.success) printJson(res.data);
          else showStatus(`Failed: ${res.error}`, "error");
          await pause();
          return true;
        }
      },
      { label: "Start", action: async () => { const r = await api.startPxpipe(); showStatus(r.success ? "✓ Started!" : `Failed: ${r.error}`, r.success ? "success" : "error"); await pause(); return true; } },
      { label: "Stop", action: async () => { const r = await api.stopPxpipe(); showStatus(r.success ? "✓ Stopped!" : `Failed: ${r.error}`, r.success ? "success" : "error"); await pause(); return true; } },
      { label: "Restart", action: async () => { const r = await api.restartPxpipe(); showStatus(r.success ? "✓ Restarted!" : `Failed: ${r.error}`, r.success ? "success" : "error"); await pause(); return true; } },
      { label: "Install Binary", action: async () => { const r = await api.installPxpipe(); showStatus(r.success ? "✓ Installed!" : `Failed: ${r.error}`, r.success ? "success" : "error"); await pause(); return true; } },
    ]
  });
}

module.exports = { showNetworkMenu };
