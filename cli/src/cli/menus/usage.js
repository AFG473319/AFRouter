const api = require("../api/client");
const { prompt, confirm, pause } = require("../utils/input");
const { clearScreen, showStatus } = require("../utils/display");
const { printResult, printJson, offerJsonView, pickPeriod, fmt } = require("../utils/output");
const { showMenuWithBack } = require("../utils/menuHelper");

/**
 * Usage & Quota menu — mirrors dashboard Usage + Quota pages.
 * @param {Array<string>} breadcrumb
 */
async function showUsageMenu(breadcrumb = []) {
  let period = "7d";
  await showMenuWithBack({
    title: "📊 Usage & Quota",
    breadcrumb,
    headerContent: async () => {
      const res = await api.getUsageStats(period);
      if (!res.success) return `Period: ${period} (stats unavailable)`;
      const s = res.data;
      const line = `Period: ${period} • Requests: ${fmt(s.requests ?? s.totalRequests)} • Tokens: ${fmt(s.tokens ?? s.totalTokens)} • Cost: ${s.cost ?? s.totalCost ?? "-"}`;
      return line;
    },
    refresh: async () => ({}),
    items: [
      {
        label: () => `Period: ${period} → change`,
        action: async () => { period = await pickPeriod(period); return true; }
      },
      { label: "Overview (stats)", action: async () => { await handleOverview(period); return true; } },
      { label: "Chart Summary", action: async () => { await handleChart(period); return true; } },
      { label: "Request Logs (latest 200)", action: async () => { await handleRequestLogs(); return true; } },
      { label: "Request Details (paginated + filters)", action: async () => { await handleRequestDetails([...breadcrumb, "Request Details"]); return true; } },
      { label: "History", action: async () => { await handleHistory(); return true; } },
      { label: "Providers / Quota", action: async () => { await handleProvidersQuota([...breadcrumb, "Providers"]); return true; } },
      { label: "Per-Connection Usage", action: async () => { await handlePerConnectionUsage(); return true; } },
    ]
  });
}

async function handleOverview(period) {
  clearScreen();
  console.log(`\n📊 Usage Overview (${period})\n`);
  const res = await api.getUsageStats(period);
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const s = res.data;
  const entries = Object.entries(s).filter(([k]) => !["chart", "history", "logs"].includes(k));
  if (entries.length > 0 && typeof s === "object") {
    printResult({
      headers: ["Metric", "Value"],
      rows: entries.map(([k, v]) => [k, typeof v === "number" ? fmt(v) : (typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v ?? "-"))]),
      jsonData: s,
    });
  } else {
    printJson(s);
  }
  await offerJsonView(s);
  await pause();
}

async function handleChart(period) {
  clearScreen();
  console.log(`\n📈 Chart Data (${period})\n`);
  const res = await api.getUsageChart(period);
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const d = res.data;
  const points = d.points || d.data || d.series || [];
  if (Array.isArray(points) && points.length > 0) {
    const keys = Object.keys(points[0]).filter(k => typeof points[0][k] === "number");
    const summary = keys.map(k => {
      const vals = points.map(p => p[k]);
      return [k, fmt(Math.min(...vals)), fmt(Math.max(...vals)), fmt(vals.reduce((a, b) => a + b, 0))];
    });
    printResult({ headers: ["Metric", "Min", "Max", "Total"], rows: summary, jsonData: d });
    console.log(`\n  Buckets: ${points.length}`);
  } else {
    printJson(d);
  }
  await offerJsonView(d);
  await pause();
}

function logRow(l) {
  if (typeof l === "string") return [l];
  return [
    l.id || l.requestId || "?",
    l.provider || l.model?.split?.("/")[0] || "?",
    l.model || "?",
    l.status || (l.error ? "error" : "ok"),
    l.tokens !== undefined ? fmt(l.tokens) : (l.totalTokens !== undefined ? fmt(l.totalTokens) : "-"),
    l.createdAt || l.timestamp || "-",
  ];
}

async function handleRequestLogs() {
  clearScreen();
  console.log("\n🧾 Request Logs (latest 200)\n");
  const res = await api.getRequestLogs();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const logs = res.data.logs || res.data.requests || (Array.isArray(res.data) ? res.data : []);
  printResult({
    headers: ["ID", "Provider", "Model", "Status", "Tokens", "Time"],
    rows: logs.slice(0, 50).map(logRow),
    jsonData: res.data,
    emptyMessage: "No request logs.",
  });
  if (logs.length > 50) console.log(`  … ${logs.length - 50} more (View as JSON for full list)`);
  await offerJsonView(res.data);
  await pause();
}

async function handleRequestDetails(breadcrumb = []) {
  clearScreen();
  console.log("\n🔍 Request Details\n");
  const provider = await prompt("Filter provider (Enter to skip): ");
  const model = await prompt("Filter model (Enter to skip): ");
  const status = await prompt("Filter status (Enter to skip): ");
  const q = ["page=1", "pageSize=20"];
  if (provider && provider.trim()) q.push(`provider=${encodeURIComponent(provider.trim())}`);
  if (model && model.trim()) q.push(`model=${encodeURIComponent(model.trim())}`);
  if (status && status.trim()) q.push(`status=${encodeURIComponent(status.trim())}`);
  const res = await api.getRequestDetails(q.join("&"));
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const rows = res.data.requests || res.data.rows || res.data.data || [];
  printResult({
    headers: ["ID", "Provider", "Model", "Status", "Tokens", "Time"],
    rows: (Array.isArray(rows) ? rows : []).map(logRow),
    jsonData: res.data,
    emptyMessage: "No matching requests.",
  });
  console.log(`\n  Page 1 • Total: ${res.data.total ?? res.data.count ?? "?"}`);
  await offerJsonView(res.data);
  await pause();
}

async function handleHistory() {
  clearScreen();
  console.log("\n🕘 Usage History\n");
  const res = await api.getUsageHistory();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  printJson(res.data);
  await pause();
}

async function handleProvidersQuota(breadcrumb = []) {
  clearScreen();
  console.log("\n🏭 Providers / Quota\n");
  const [provRes, connRes] = await Promise.all([api.getUsageProviders(), api.getProviders()]);
  if (!provRes.success) {
    showStatus(`Failed: ${provRes.error}`, "error");
    await pause();
    return;
  }
  const providers = provRes.data.providers || [];
  const connections = connRes.success ? (connRes.data.connections || []) : [];
  const counts = {};
  connections.forEach(c => {
    const p = c.provider || c.providerId;
    counts[p] = (counts[p] || 0) + 1;
  });
  printResult({
    headers: ["Provider", "Connections", "Active"],
    rows: providers.map(p => {
      const id = typeof p === "string" ? p : (p.id || "?");
      const name = typeof p === "string" ? p : (p.name || p.id);
      const conns = connections.filter(c => (c.provider || c.providerId) === id);
      const active = conns.filter(c => c.isActive !== false).length;
      return [name, fmt(conns.length || counts[id] || 0), fmt(active)];
    }),
    jsonData: provRes.data,
    emptyMessage: "No providers with recorded usage.",
  });
  await offerJsonView(provRes.data);
  await pause();
}

async function handlePerConnectionUsage() {
  clearScreen();
  console.log("\n🔌 Per-Connection Usage\n");
  const res = await api.getProviders();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const connections = res.data.connections || [];
  if (connections.length === 0) {
    showStatus("No connections.", "warning");
    await pause();
    return;
  }
  connections.forEach((c, i) => console.log(`  ${i + 1}. ${c.name || c.email || "Unnamed"} [${c.provider || c.providerId}]`));
  const input = await prompt("\nSelect connection (number): ");
  const num = parseInt(input, 10);
  if (isNaN(num) || num < 1 || num > connections.length) { showStatus("Cancelled", "warning"); await pause(); return; }
  const conn = connections[num - 1];
  const usage = await api.getConnectionUsage(conn.id);
  if (!usage.success) {
    showStatus(`Failed: ${usage.error}`, "error");
  } else {
    printJson(usage.data);
    if ((conn.provider || conn.providerId) === "codex") {
      const reset = await confirm("\nReset Codex credits for this connection?");
      if (reset) {
        const r = await api.resetCodexCredits(conn.id);
        showStatus(r.success ? "✓ Credits reset!" : `✗ Failed: ${r.error}`, r.success ? "success" : "error");
      }
    }
  }
  await pause();
}

module.exports = { showUsageMenu };
