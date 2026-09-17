const api = require("../api/client");
const { prompt, confirm, pause } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { printJson, offerJsonView } = require("../utils/output");
const { showMenuWithBack } = require("../utils/menuHelper");

// ANSI colors
const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m"
};

const DEFAULT_PASSWORD = "123456";

/**
 * Show settings menu (tunnel + RTK + reset password)
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showSettingsMenu(breadcrumb = []) {
  await showMenuWithBack({
    title: "⚙️  Settings",
    breadcrumb,
    headerContent: async (data) => {
      const lines = [];

      // Tunnel section
      const tunnel = data?.tunnel || {};
      if (tunnel.enabled && tunnel.publicUrl) {
        lines.push(`  Endpoint: ${COLORS.green}${tunnel.publicUrl}/v1${COLORS.reset}`);
        lines.push(`  Tunnel:   ${COLORS.green}ON${COLORS.reset} ${COLORS.dim}(${tunnel.shortId})${COLORS.reset}`);
      } else {
        lines.push(`  Endpoint: http://localhost:20128/v1`);
        lines.push(`  Tunnel:   ${COLORS.red}OFF${COLORS.reset} ${COLORS.dim}(local only)${COLORS.reset}`);
      }

      // RTK section
      const rtkOn = data?.settings?.rtkEnabled !== false;
      lines.push(`  RTK:      ${rtkOn ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`} ${COLORS.dim}(Token Saver)${COLORS.reset}`);
      const headroomOn = data?.settings?.headroomEnabled === true;
      lines.push(`  Headroom: ${headroomOn ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`} ${COLORS.dim}(${data?.settings?.headroomUrl || "http://localhost:8787"})${COLORS.reset}`);

      // Auth mode section
      const authMode = data?.settings?.authMode || "password";
      const authColor = authMode === "password" ? COLORS.green : COLORS.yellow;
      lines.push(`  Auth:     ${authColor}${authMode.toUpperCase()}${COLORS.reset} ${COLORS.dim}(login mode)${COLORS.reset}`);

      return lines.join("\n");
    },
    refresh: async () => {
      const [tunnelRes, settingsRes, loginRes] = await Promise.all([
        api.getTunnelStatus(),
        api.getSettings(),
        api.getRequireLogin().catch(() => ({ success: false }))
      ]);
      return {
        tunnel: tunnelRes.success ? (tunnelRes.data || {}) : {},
        settings: settingsRes.success ? (settingsRes.data.settings || settingsRes.data || {}) : {},
        login: loginRes && loginRes.success ? loginRes.data : {}
      };
    },
    items: [
      {
        label: "Tunnel ON",
        action: async () => { await enableTunnel(); return true; }
      },
      {
        label: "Tunnel OFF",
        action: async () => { await disableTunnel(); return true; }
      },
      {
        label: (d) => {
          const on = d?.settings?.rtkEnabled !== false;
          return `Token Saver (RTK): ${on ? "ON" : "OFF"} → toggle`;
        },
        action: async (d) => { await toggleRtk(d?.settings?.rtkEnabled !== false); return true; }
      },
      {
        label: (d) => {
          const on = d?.settings?.headroomEnabled === true;
          return `Token Saver (Headroom): ${on ? "ON" : "OFF"} → toggle`;
        },
        action: async (d) => { await toggleHeadroom(d?.settings?.headroomEnabled === true); return true; }
      },
      {
        label: "🔑 Reset Password to Default",
        action: async () => { await resetPassword(); return true; }
      },
      {
        label: (d) => {
          const mode = d?.settings?.authMode || "password";
          return mode === "password" ? "🔓 Reset Auth Mode (already password)" : `🔓 Reset Auth Mode to Password (current: ${mode})`;
        },
        action: async () => { await resetAuthMode(); return true; }
      },
      {
        label: "🔑 Change Password",
        action: async () => { await changePassword(); return true; }
      },
      {
        label: (d) => `Require Login: ${d?.login?.requireLogin === false ? "OFF" : "ON"} → toggle`,
        action: async (d) => { await toggleRequireLogin(d?.login?.requireLogin === false); return true; }
      },
      {
        label: "🌐 Outbound Proxy (view / set / test)",
        action: async () => { await handleOutboundProxy(); return true; }
      },
      {
        label: (d) => `Observability: ${d?.settings?.observabilityEnabled === false ? "OFF" : "ON"} → toggle`,
        action: async (d) => { await toggleObservability(d?.settings?.observabilityEnabled === false); return true; }
      },
      {
        label: "🔐 SSO Status (OIDC / SAML)",
        action: async () => { await showSsoStatus(); return true; }
      },
      {
        label: "💾 Backup (export database)",
        action: async () => { await handleDbExport(); return true; }
      },
      {
        label: "📥 Restore (import database)",
        action: async () => { await handleDbImport(); return true; }
      },
      {
        label: "⬆️  Version Check / Update",
        action: async () => { await handleVersion(); return true; }
      },
      {
        label: "📄 View Settings (JSON)",
        action: async () => { await handleViewSettings(); return true; }
      },
      {
        label: "🛑 Shutdown Server",
        action: async () => { await handleShutdown(); return true; }
      }
    ]
  });
}

/**
 * Reset authMode to "password" via API. Used when OIDC is misconfigured
 * and user is locked out of dashboard. CLI bypasses auth via x-afr-cli-token.
 */
async function resetAuthMode() {
  const ok = await confirm("Reset auth mode to PASSWORD (disable OIDC)?");
  if (!ok) {
    showStatus("Cancelled", "info");
    await pause();
    return;
  }

  const result = await api.updateSettings({ authMode: "password" });
  if (result.success) {
    showStatus("Auth mode reset to password. OIDC disabled.", "success");
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }
  await pause();
}

/**
 * Enable tunnel via API
 */
async function enableTunnel() {
  showStatus("Creating tunnel...", "info");
  const result = await api.enableTunnel();

  if (result.success) {
    const { publicUrl, shortId, alreadyRunning } = result.data || {};
    if (alreadyRunning) {
      showStatus(`Tunnel already running: ${publicUrl}`, "success");
    } else {
      showStatus(`Tunnel enabled: ${publicUrl} (${shortId})`, "success");
    }
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }

  await pause();
}

/**
 * Disable tunnel via API
 */
async function disableTunnel() {
  const result = await api.disableTunnel();

  if (result.success) {
    showStatus("Tunnel disabled", "success");
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }

  await pause();
}

/**
 * Toggle RTK (Token Saver) via API
 * @param {boolean} currentlyOn
 */
async function toggleRtk(currentlyOn) {
  const next = !currentlyOn;
  const result = await api.updateSettings({ rtkEnabled: next });
  if (result.success) {
    showStatus(`Token Saver ${next ? "enabled" : "disabled"}`, "success");
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }
  await pause();
}

async function toggleHeadroom(currentlyOn) {
  const next = !currentlyOn;
  const result = await api.updateSettings({ headroomEnabled: next });
  if (result.success) {
    showStatus(`Headroom ${next ? "enabled" : "disabled"}`, "success");
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }
  await pause();
}

/**
 * Reset dashboard password to default via server API (writes the live SQLite DB).
 * After reset, user can log in with the default password "123456".
 */
async function resetPassword() {
  const ok = await confirm(`Reset dashboard password to default "${DEFAULT_PASSWORD}"?`);
  if (!ok) {
    showStatus("Cancelled", "info");
    await pause();
    return;
  }

  const result = await api.resetPassword();
  if (result.success) {
    showStatus(`Password reset. Default: ${DEFAULT_PASSWORD}`, "success");
  } else {
    showStatus(`Failed to reset password: ${result.error}`, "error");
  }
  await pause();
}

/**
 * Change dashboard password (PATCH /api/settings {newPassword, currentPassword}).
 */
async function changePassword() {
  const currentPassword = await prompt("Current password: ");
  if (!currentPassword) { showStatus("Cancelled", "info"); await pause(); return; }
  const newPassword = await prompt("New password: ");
  if (!newPassword) { showStatus("Cancelled", "info"); await pause(); return; }
  const result = await api.updateSettings({ currentPassword, newPassword });
  showStatus(result.success ? "Password changed!" : `Failed: ${result.error}`, result.success ? "success" : "error");
  await pause();
}

/**
 * Toggle dashboard login gate (PATCH /api/settings {requireLogin}).
 * @param {boolean} currentlyOff
 */
async function toggleRequireLogin(currentlyOff) {
  const next = currentlyOff ? true : false;
  const ok = await confirm(`Turn dashboard login ${next ? "ON" : "OFF"}?`);
  if (!ok) { showStatus("Cancelled", "info"); await pause(); return; }
  const result = await api.updateSettings({ requireLogin: next });
  showStatus(result.success ? `Require-login ${next ? "enabled" : "disabled"}` : `Failed: ${result.error}`, result.success ? "success" : "error");
  await pause();
}

/**
 * View / set / test outbound proxy.
 */
async function handleOutboundProxy() {
  const cur = await api.getSettings();
  const s = cur.success ? (cur.data.settings || cur.data || {}) : {};
  console.log("\n🌐 Outbound Proxy\n");
  console.log(`  Enabled: ${s.outboundProxyEnabled === true ? "ON" : "OFF"}`);
  console.log(`  URL:     ${s.outboundProxyUrl || "(none)"}`);
  console.log(`  NoProxy: ${s.outboundNoProxy || "(none)"}`);
  const url = await prompt("\nNew proxy URL (Enter to keep): ");
  const updates = {};
  if (url && url.trim()) {
    updates.outboundProxyUrl = url.trim();
    updates.outboundProxyEnabled = true;
  } else if (url !== null && url.trim() === "") {
    // keep
  }
  if (Object.keys(updates).length > 0) {
    const res = await api.updateSettings(updates);
    showStatus(res.success ? "Proxy updated!" : `Failed: ${res.error}`, res.success ? "success" : "error");
  }
  const testUrl = (updates.outboundProxyUrl || s.outboundProxyUrl || "");
  if (testUrl) {
    const test = await confirm(`Test proxy ${testUrl}?`);
    if (test) {
      showStatus("Testing proxy...", "info");
      const r = await api.testProxy(testUrl);
      showStatus(r.success ? "✓ Proxy works!" : `✗ Failed: ${r.error}`, r.success ? "success" : "error");
      if (r.success) printJson(r.data);
    }
  }
  await pause();
}

/**
 * Toggle observability (PATCH /api/settings {observabilityEnabled}).
 * @param {boolean} currentlyOff
 */
async function toggleObservability(currentlyOff) {
  const next = currentlyOff ? true : false;
  const result = await api.updateSettings({ observabilityEnabled: next });
  showStatus(result.success ? `Observability ${next ? "enabled" : "disabled"}` : `Failed: ${result.error}`, result.success ? "success" : "error");
  await pause();
}

/**
 * Show OIDC/SAML SSO config state (read-only in TUI; edits stay web-only).
 */
async function showSsoStatus() {
  const cur = await api.getSettings();
  if (!cur.success) {
    showStatus(`Failed: ${cur.error}`, "error");
    await pause();
    return;
  }
  const s = cur.data.settings || cur.data || {};
  console.log("\n🔐 SSO Status\n");
  console.log(`  authMode: ${s.authMode || "password"}`);
  console.log(`  OIDC:     ${(s.oidcIssuer || s.oidcClientId) ? `configured (${s.oidcIssuer || "?"})` : "not configured"}`);
  console.log(`  SAML:     ${(s.samlEntryPoint || s.samlIssuer) ? "configured" : "not configured"}`);
  console.log("\n  (SSO editing stays in the dashboard — use Reset Auth Mode above for lockout recovery.)");
  await offerJsonView({ authMode: s.authMode, oidcIssuer: s.oidcIssuer, samlEntryPoint: s.samlEntryPoint });
  await pause();
}

/**
 * Export database backup to a file (GET /api/settings/database; CLI is trusted).
 */
async function handleDbExport() {
  const fs = require("fs");
  const defPath = `afrouter-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const filePath = (await prompt(`Export file path (default: ${defPath}): `)) || defPath;
  showStatus("Exporting database...", "info");
  const res = await api.exportDatabase();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(res.data, null, 2));
    showStatus(`✓ Backup saved to ${filePath}`, "success");
  } catch (err) {
    showStatus(`Write failed: ${err.message}`, "error");
  }
  await pause();
}

/**
 * Import database backup from a file (POST /api/settings/database).
 */
async function handleDbImport() {
  const fs = require("fs");
  const filePath = await prompt("Backup file path: ");
  if (!filePath) { showStatus("Cancelled", "info"); await pause(); return; }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    showStatus(`Read failed: ${err.message}`, "error");
    await pause();
    return;
  }
  const ok = await confirm("Restore will OVERWRITE current data. Continue?");
  if (!ok) { showStatus("Cancelled", "info"); await pause(); return; }
  const res = await api.importDatabase(payload);
  showStatus(res.success ? "✓ Database restored!" : `Failed: ${res.error}`, res.success ? "success" : "error");
  await pause();
}

/**
 * Version check + updater trigger.
 */
async function handleVersion() {
  showStatus("Checking version...", "info");
  const res = await api.getVersion();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  printJson(res.data);
  if (res.data.hasUpdate) {
    const go = await confirm("\nUpdate available. Trigger server-side update?");
    if (go) {
      const upd = await api.triggerVersionUpdate();
      showStatus(upd.success ? "✓ Update triggered!" : `Failed: ${upd.error}`, upd.success ? "success" : "error");
    }
  }
  await pause();
}

/**
 * Dump safe settings as JSON.
 */
async function handleViewSettings() {
  const res = await api.getSettings();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
  } else {
    printJson(res.data);
  }
  await pause();
}

/**
 * Graceful server shutdown (POST /api/shutdown).
 */
async function handleShutdown() {
  const ok = await confirm("Shutdown the AFRouter server?");
  if (!ok) { showStatus("Cancelled", "info"); await pause(); return; }
  const res = await api.shutdownServer();
  showStatus(res.success ? "Shutdown requested. TUI will lose connection." : `Failed: ${res.error}`, res.success ? "success" : "error");
  await pause();
}

module.exports = { showSettingsMenu };
