const api = require("../api/client");
const { prompt, confirm, pause } = require("../utils/input");
const { clearScreen, showStatus } = require("../utils/display");
const { printResult, printJson, offerJsonView, fmt } = require("../utils/output");
const { showMenuWithBack, showListMenu } = require("../utils/menuHelper");

/**
 * Main Models menu — mirrors the dashboard's model catalog tooling.
 * @param {Array<string>} breadcrumb
 */
async function showModelsMenu(breadcrumb = []) {
  await showMenuWithBack({
    title: "🧠 Models",
    breadcrumb,
    headerContent: async () => {
      const res = await api.getAvailableModels();
      const models = res.success ? (res.data.data || []) : [];
      const combos = models.filter(m => m.owned_by === "combo").length;
      return `Catalog: ${models.length} live models (${combos} combos) via /v1/models`;
    },
    refresh: async () => ({}),
    items: [
      { label: "Browse Catalog", action: async () => { await handleBrowseCatalog(); return true; } },
      { label: "Live Ping (test a model)", action: async () => { await handlePingModel(); return true; } },
      { label: "Availability Badges", action: async () => { await handleAvailability(); return true; } },
      { label: "Aliases (CRUD)", action: async () => { await showAliasMenu([...breadcrumb, "Aliases"]); return true; } },
      { label: "Custom Models (CRUD)", action: async () => { await showCustomModelsMenu([...breadcrumb, "Custom Models"]); return true; } },
      { label: "Disabled Models", action: async () => { await handleDisabledModels(); return true; } },
      { label: "Sync Catalog", action: async () => { await handleSyncCatalog(); return true; } },
      { label: "Pricing Table", action: async () => { await handlePricing(); return true; } },
      { label: "Tags", action: async () => { await handleTags(); return true; } },
    ]
  });
}

/**
 * Browse /api/models + /v1/models with keyword filter.
 */
async function handleBrowseCatalog() {
  clearScreen();
  console.log("\n🧠 Model Catalog\n");
  const filter = await prompt("Filter keyword (Enter for all): ");
  showStatus("Loading catalog...", "info");
  const [internal, live] = await Promise.all([api.getModels(), api.getAvailableModels()]);
  const liveIds = new Set(live.success ? (live.data.data || []).map(m => m.id) : []);
  let items = [];
  if (internal.success) {
    items = internal.data.models || internal.data || [];
  }
  if (!Array.isArray(items)) items = [];
  if (filter && filter.trim()) {
    const q = filter.trim().toLowerCase();
    items = items.filter(m => JSON.stringify(m).toLowerCase().includes(q));
  }
  const rows = items.slice(0, 100).map(m => {
    if (typeof m === "string") return [m, liveIds.has(m) ? "✓ live" : ""];
    const id = m.id || `${m.provider || ""}/${m.model || ""}`;
    return [id, liveIds.has(id) ? "✓ live" : (m.provider || m.owned_by || "")];
  });
  printResult({
    headers: ["Model", "Status/Provider"],
    rows,
    jsonData: { models: items },
    emptyMessage: "No models in catalog.",
  });
  if (items.length > 100) console.log(`  … ${items.length - 100} more (use a filter or View as JSON)`);
  await offerJsonView({ models: items });
  await pause();
}

/**
 * Live ping a model (POST /api/models/test).
 */
async function handlePingModel() {
  clearScreen();
  console.log("\n📡 Live Model Ping\n");
  const { selectModelFromList } = require("../utils/modelSelector");
  const model = await selectModelFromList("Select Model to Ping", "");
  if (!model) return;
  showStatus(`Pinging ${model}...`, "info");
  const res = await api.testModel({ model });
  if (res.success) {
    showStatus("✓ Ping OK", "success");
    printJson(res.data);
  } else {
    showStatus(`✗ Ping failed: ${res.error}`, "error");
  }
  await pause();
}

/**
 * Availability badges (GET /api/models/availability).
 */
async function handleAvailability() {
  clearScreen();
  console.log("\n✅ Model Availability\n");
  showStatus("Loading...", "info");
  const res = await api.getModelAvailability();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const d = res.data.availability || res.data;
  if (Array.isArray(d)) {
    printResult({
      headers: ["Model", "Available"],
      rows: d.map(a => [a.id || a.model || JSON.stringify(a), a.available === false ? "✗" : "✓"]),
      jsonData: res.data,
    });
  } else {
    printJson(res.data);
  }
  await offerJsonView(res.data);
  await pause();
}

/**
 * Alias CRUD (GET/PUT/DELETE /api/models/alias).
 */
async function showAliasMenu(breadcrumb = []) {
  await showListMenu({
    title: "🏷️  Model Aliases",
    breadcrumb,
    backLabel: "← Back to Models",
    fetchItems: async () => {
      const res = await api.getModelAliases();
      if (!res.success) {
        showStatus(`Failed: ${res.error}`, "error");
        await pause();
        return null;
      }
      const a = res.data.aliases || {};
      const items = Array.isArray(a)
        ? a
        : Object.entries(a).map(([alias, model]) => ({ alias, model }));
      return { items };
    },
    formatItem: (item) => `${item.alias} → ${item.model}`,
    onSelect: async (item) => {
      const ok = await confirm(`Delete alias "${item.alias}"?`);
      if (ok) {
        const res = await api.deleteModelAlias(item.alias);
        showStatus(res.success ? "Alias deleted!" : `Failed: ${res.error}`, res.success ? "success" : "error");
        await pause();
      }
    },
    createAction: {
      label: "➕ Set Alias",
      action: async () => {
        clearScreen();
        console.log("\n➕ Set Model Alias\n");
        const alias = await prompt("Alias: ");
        if (!alias) { showStatus("Cancelled", "warning"); await pause(); return; }
        const { selectModelFromList } = require("../utils/modelSelector");
        const model = await selectModelFromList("Select Target Model", "");
        if (!model) return;
        const res = await api.setModelAlias(alias.trim(), model);
        showStatus(res.success ? `✓ ${alias} → ${model}` : `✗ Failed: ${res.error}`, res.success ? "success" : "error");
        await pause();
      }
    }
  });
}

/**
 * Custom model definitions (GET/POST/DELETE /api/models/custom).
 */
async function showCustomModelsMenu(breadcrumb = []) {
  await showListMenu({
    title: "🧩 Custom Models",
    breadcrumb,
    backLabel: "← Back to Models",
    fetchItems: async () => {
      const res = await api.getCustomModels();
      if (!res.success) {
        showStatus(`Failed: ${res.error}`, "error");
        await pause();
        return null;
      }
      return { items: res.data.models || [] };
    },
    formatItem: (m) => (typeof m === "string" ? m : `${m.providerAlias || m.provider || ""}/${m.id || m.model || "?"}`),
    onSelect: async (m) => {
      const id = typeof m === "string" ? m : (m.id || m.model);
      const ok = await confirm(`Delete custom model "${id}"?`);
      if (ok) {
        const res = await api.deleteCustomModel(id);
        showStatus(res.success ? "Deleted!" : `Failed: ${res.error}`, res.success ? "success" : "error");
        await pause();
      }
    },
    createAction: {
      label: "➕ Add Custom Model",
      action: async () => {
        clearScreen();
        console.log("\n➕ Add Custom Model\n");
        const providerAlias = await prompt("Provider alias (e.g. cc): ");
        if (!providerAlias) { showStatus("Cancelled", "warning"); await pause(); return; }
        const id = await prompt("Model ID: ");
        if (!id) { showStatus("Cancelled", "warning"); await pause(); return; }
        const name = await prompt("Display name (optional): ");
        const body = { providerAlias: providerAlias.trim(), id: id.trim() };
        if (name && name.trim()) body.name = name.trim();
        const res = await api.addCustomModel(body);
        showStatus(res.success ? "✓ Added!" : `✗ Failed: ${res.error}`, res.success ? "success" : "error");
        await pause();
      }
    }
  });
}

/**
 * Disabled models: view + replace set per provider alias.
 */
async function handleDisabledModels() {
  clearScreen();
  console.log("\n🚫 Disabled Models\n");
  const providerAlias = await prompt("Provider alias (Enter for all): ");
  const res = await api.getDisabledModels(providerAlias && providerAlias.trim() ? providerAlias.trim() : undefined);
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const d = res.data.disabled || res.data;
  if (res.data.ids) {
    console.log(`  Disabled for ${providerAlias}: ${(res.data.ids || []).join(", ") || "(none)"}`);
  } else {
    printJson(d);
  }
  if (providerAlias && providerAlias.trim()) {
    const edit = await confirm("\nReplace disabled set for this provider?");
    if (edit) {
      const idsInput = await prompt("Disabled model IDs (comma-separated, empty = enable all): ");
      const ids = idsInput ? idsInput.split(",").map(s => s.trim()).filter(Boolean) : [];
      const upd = await api.setDisabledModels(providerAlias.trim(), ids);
      showStatus(upd.success ? "✓ Updated!" : `✗ Failed: ${upd.error}`, upd.success ? "success" : "error");
    }
  }
  await pause();
}

/**
 * Trigger catalog sync (POST /api/models/catalog-sync).
 */
async function handleSyncCatalog() {
  showStatus("Syncing model catalog...", "info");
  const res = await api.syncModelCatalog();
  showStatus(res.success ? "✓ Catalog sync triggered!" : `✗ Failed: ${res.error}`, res.success ? "success" : "error");
  if (res.success) printJson(res.data);
  await pause();
}

/**
 * Pricing table (GET /api/pricing).
 */
async function handlePricing() {
  clearScreen();
  console.log("\n💰 Pricing Table\n");
  const res = await api.getPricing();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const rows = res.data.pricing || res.data.models || res.data;
  if (Array.isArray(rows)) {
    printResult({
      headers: ["Model", "Input", "Output"],
      rows: rows.map(p => [
        p.id || p.model || JSON.stringify(p),
        p.input !== undefined ? fmt(p.input) : (p.inputPrice || "-"),
        p.output !== undefined ? fmt(p.output) : (p.outputPrice || "-"),
      ]),
      jsonData: res.data,
    });
  } else {
    printJson(res.data);
  }
  await offerJsonView(res.data);
  await pause();
}

/**
 * Tags (GET /api/tags).
 */
async function handleTags() {
  clearScreen();
  console.log("\n🏷️  Tags\n");
  const res = await api.getTags();
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
  } else {
    printJson(res.data);
  }
  await pause();
}

module.exports = { showModelsMenu };
