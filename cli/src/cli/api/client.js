const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { machineIdSync } = require("node-machine-id");

// Default configuration
const DEFAULT_CONFIG = {
  host: "localhost",
  port: 20128,
  protocol: "http:",
  timeoutMs: 30000,
};

const CLI_TOKEN_HEADER = "x-afr-cli-token";
const CLI_TOKEN_SALT = "afr-cli-auth";
const APP_NAME = "afrouter";

function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

const MACHINE_ID_FILE = path.join(getDataDir(), "machine-id");
const AUTH_DIR = path.join(getDataDir(), "auth");
const CLI_SECRET_FILE = path.join(AUTH_DIR, "cli-secret");

let config = { ...DEFAULT_CONFIG };
let cachedCliToken = null;
let cachedCliSecret = null;

// Read raw machineId from shared file (written by server) → guarantees token match
function loadRawMachineId() {
  try {
    const raw = fs.readFileSync(MACHINE_ID_FILE, "utf8").trim();
    if (raw) return raw;
  } catch {}
  try { return machineIdSync(); } catch { return ""; }
}

// Random secret shared with server via file → token unpredictable from machineId alone.
function loadCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, "utf8").trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch {}
  cachedCliSecret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CLI_SECRET_FILE, cachedCliSecret, { mode: 0o600 });
  } catch {}
  return cachedCliSecret;
}

function getCliToken() {
  if (cachedCliToken !== null) return cachedCliToken;
  const raw = loadRawMachineId();
  const secret = loadCliSecret();
  cachedCliToken = raw ? crypto.createHash("sha256").update(raw + CLI_TOKEN_SALT + secret).digest("hex").substring(0, 16) : "";
  return cachedCliToken;
}

/**
 * Configure API client
 * @param {Object} options - Configuration options
 * @param {string} options.host - API host
 * @param {number} options.port - API port
 * @param {string} options.protocol - Protocol (http: or https:)
 */
function configure(options = {}) {
  config = { ...config, ...options };
}

/**
 * Make HTTP request to API
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {Object} body - Request body (optional)
 * @returns {Promise<Object>} Response with { success, data/error }
 */
function makeRequest(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve) => {
    const httpModule = config.protocol === "https:" ? https : http;
    
    const options = {
      hostname: config.host,
      port: config.port,
      path: path,
      method: method,
      headers: {
        "Content-Type": "application/json",
        [CLI_TOKEN_HEADER]: getCliToken(),
        ...extraHeaders,
      },
    };

    // Add Content-Length for POST/PUT requests
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      const bodyString = JSON.stringify(body);
      options.headers["Content-Length"] = Buffer.byteLength(bodyString);
    }

    const req = httpModule.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          
          // Check if response indicates error
          if (res.statusCode >= 400 || parsed.error) {
            resolve({
              success: false,
              error: parsed.error || `HTTP ${res.statusCode}`,
              statusCode: res.statusCode,
            });
          } else {
            resolve({
              success: true,
              data: parsed,
              statusCode: res.statusCode,
            });
          }
        } catch (err) {
          resolve({
            success: false,
            error: `Failed to parse response: ${err.message}`,
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({
        success: false,
        error: `Network error: ${err.message}`,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        success: false,
        error: "Request timeout",
      });
    });

    // Set timeout (configurable; long generations need more than the default)
    req.setTimeout(config.timeoutMs || 30000);

    // Write body if present
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// ============================================================================
// PROVIDERS API
// ============================================================================

/**
 * Get all providers
 * @returns {Promise<Object>} { success, data: { connections } }
 */
async function getProviders() {
  return makeRequest("GET", "/api/providers");
}

/**
 * Get provider by ID
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { connection } }
 */
async function getProviderById(id) {
  return makeRequest("GET", `/api/providers/${id}`);
}

/**
 * Test provider connection
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { valid, error } }
 */
async function testProvider(id) {
  return makeRequest("POST", `/api/providers/${id}/test`);
}

/**
 * Delete provider
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { message } }
 */
async function deleteProvider(id) {
  return makeRequest("DELETE", `/api/providers/${id}`);
}

/**
 * Get provider models
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { provider, connectionId, models } }
 */
async function getProviderModels(id) {
  return makeRequest("GET", `/api/providers/${id}/models`);
}

// ============================================================================
// OAUTH API
// ============================================================================

/**
 * Get OAuth authorization URL
 * @param {string} provider - Provider ID
 * @returns {Promise<Object>} { success, data: { authUrl, codeVerifier, state, redirectUri } }
 */
async function getOAuthAuthUrl(provider) {
  // Codex requires fixed port 1455 and path /auth/callback
  const redirectUri = provider === "codex" 
    ? "http://localhost:1455/auth/callback"
    : "http://localhost:20128/callback";
  return makeRequest("GET", `/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
}

/**
 * Exchange OAuth authorization code for token
 * @param {string} provider - Provider ID
 * @param {Object} data - { code, redirectUri, codeVerifier, state }
 * @returns {Promise<Object>} { success, data }
 */
async function exchangeOAuthCode(provider, data) {
  return makeRequest("POST", `/api/oauth/${provider}/exchange`, data);
}

/**
 * Get OAuth device code
 * @param {string} provider - Provider ID
 * @returns {Promise<Object>} { success, data: { device_code, user_code, verification_uri, verification_uri_complete, codeVerifier, extraData } }
 */
async function getOAuthDeviceCode(provider) {
  return makeRequest("GET", `/api/oauth/${provider}/device-code`);
}

/**
 * Poll OAuth token using device code
 * @param {string} provider - Provider ID
 * @param {Object} data - { deviceCode, codeVerifier, extraData }
 * @returns {Promise<Object>} { success, data: { pending } }
 */
async function pollOAuthToken(provider, data) {
  return makeRequest("POST", `/api/oauth/${provider}/poll`, data);
}

/**
 * Create API key provider connection
 * @param {Object} data - { provider, name, apiKey }
 * @returns {Promise<Object>} { success, data }
 */
async function createApiKeyProvider(data) {
  return makeRequest("POST", "/api/providers", data);
}

/**
 * Update provider connection
 * @param {string} id - Connection ID
 * @param {Object} data - { name, priority, defaultModel, isActive }
 * @returns {Promise<Object>} { success, data: { connection } }
 */
async function updateConnection(id, data) {
  return makeRequest("PUT", `/api/providers/${id}`, data);
}

// ============================================================================
// API KEYS API
// ============================================================================

/**
 * Get all API keys
 * @returns {Promise<Object>} { success, data: { keys } }
 */
async function getApiKeys() {
  return makeRequest("GET", "/api/keys");
}

/**
 * Create new API key
 * @param {string} name - Key name
 * @returns {Promise<Object>} { success, data: { key, name, id, machineId } }
 */
async function createApiKey(name) {
  return makeRequest("POST", "/api/keys", { name });
}

/**
 * Delete API key
 * @param {string} id - Key ID
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function deleteApiKey(id) {
  return makeRequest("DELETE", `/api/keys/${id}`);
}

// ============================================================================
// COMBOS API
// ============================================================================

/**
 * Get all combos
 * @returns {Promise<Object>} { success, data: { combos } }
 */
async function getCombos() {
  return makeRequest("GET", "/api/combos");
}

/**
 * Get combo by ID
 * @param {string} id - Combo ID
 * @returns {Promise<Object>} { success, data: combo }
 */
async function getComboById(id) {
  return makeRequest("GET", `/api/combos/${id}`);
}

/**
 * Create new combo
 * @param {Object} data - Combo data { name, models }
 * @returns {Promise<Object>} { success, data: combo }
 */
async function createCombo(data) {
  return makeRequest("POST", "/api/combos", data);
}

/**
 * Update combo
 * @param {string} id - Combo ID
 * @param {Object} data - Update data { name?, models? }
 * @returns {Promise<Object>} { success, data: combo }
 */
async function updateCombo(id, data) {
  return makeRequest("PUT", `/api/combos/${id}`, data);
}

/**
 * Delete combo
 * @param {string} id - Combo ID
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function deleteCombo(id) {
  return makeRequest("DELETE", `/api/combos/${id}`);
}

// ============================================================================
// CLI TOOLS API
// ============================================================================

/**
 * Get CLI tool settings
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @returns {Promise<Object>} { success, data: { installed, hasAFRouter, ... } }
 */
async function getCliToolSettings(tool) {
  return makeRequest("GET", `/api/cli-tools/${tool}-settings`);
}

/**
 * Apply CLI tool settings (POST)
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @param {Object} body - Payload depends on tool
 * @returns {Promise<Object>} { success, data }
 */
async function applyCliToolSettings(tool, body) {
  return makeRequest("POST", `/api/cli-tools/${tool}-settings`, body);
}

/**
 * Reset CLI tool settings (DELETE)
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @returns {Promise<Object>} { success, data }
 */
async function resetCliToolSettings(tool) {
  return makeRequest("DELETE", `/api/cli-tools/${tool}-settings`);
}

// ============================================================================
// SETTINGS API
// ============================================================================

/**
 * Get settings
 * @returns {Promise<Object>} { success, data: settings }
 */
async function getSettings() {
  return makeRequest("GET", "/api/settings");
}

/**
 * Update settings
 * @param {Object} data - Settings data
 * @returns {Promise<Object>} { success, data: settings }
 */
async function updateSettings(data) {
  return makeRequest("PATCH", "/api/settings", data);
}

/**
 * Reset dashboard password to default (clears stored hash server-side)
 * @returns {Promise<Object>} { success }
 */
async function resetPassword() {
  return makeRequest("POST", "/api/auth/reset-password");
}

// ============================================================================
// MODELS API
// ============================================================================

/**
 * Get all models (internal API)
 * @returns {Promise<Object>} { success, data: { models } }
 */
async function getModels() {
  return makeRequest("GET", "/api/models");
}

/**
 * Get available models from active providers + combos (OpenAI compatible)
 * @returns {Promise<Object>} { success, data: { object, data: [...models] } }
 */
async function getAvailableModels() {
  return makeRequest("GET", "/v1/models");
}

// ============================================================================
// PROVIDER NODES API (custom providers)
// ============================================================================

async function getProviderNodes() {
  return makeRequest("GET", "/api/provider-nodes");
}

async function createProviderNode(data) {
  return makeRequest("POST", "/api/provider-nodes", data);
}

async function updateProviderNode(id, data) {
  return makeRequest("PUT", `/api/provider-nodes/${id}`, data);
}

async function deleteProviderNode(id) {
  return makeRequest("DELETE", `/api/provider-nodes/${id}`);
}

async function validateProviderNode(data) {
  return makeRequest("POST", "/api/provider-nodes/validate", data);
}

// ============================================================================
// TUNNEL API
// ============================================================================

/**
 * Get tunnel status
 * @returns {Promise<Object>} { success, data: { enabled, tunnelUrl, shortId, running } }
 */
async function getTunnelStatus() {
  return makeRequest("GET", "/api/tunnel/status");
}

/**
 * Enable tunnel
 * @returns {Promise<Object>} { success, data: { tunnelUrl, shortId } }
 */
async function enableTunnel() {
  return makeRequest("POST", "/api/tunnel/enable");
}

/**
 * Disable tunnel
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function disableTunnel() {
  return makeRequest("POST", "/api/tunnel/disable");
}

// ============================================================================
// GENERIC PASSTHROUGH (powers new TUI menus without per-endpoint boilerplate)
// ============================================================================

/**
 * Generic request helper — thin wrapper over makeRequest.
 * @param {string} method
 * @param {string} path
 * @param {Object|null} body
 */
async function req(method, path, body = null, bearer = null) {
  return makeRequest(method, path, body, bearer ? { Authorization: `Bearer ${bearer}` } : {});
}

// ============================================================================
// PROVIDERS++ (batch test, validate, suggested models, per-model test)
// ============================================================================

async function testProvidersBatch(mode, providerId) {
  return makeRequest("POST", "/api/providers/test-batch", providerId ? { mode, providerId } : { mode });
}

async function validateProvider(data) {
  return makeRequest("POST", "/api/providers/validate", data);
}

async function getSuggestedModels(query) {
  return makeRequest("GET", `/api/providers/suggested-models${query ? `?${query}` : ""}`);
}

async function testProviderModels(id, models) {
  return makeRequest("POST", `/api/providers/${id}/test-models`, { models });
}

async function addProviderModel(id, model) {
  return makeRequest("POST", `/api/providers/${id}/models`, model);
}

// OAuth bulk/token imports (server accepts pasted token payloads)
async function oauthImport(provider, action, data) {
  return makeRequest("POST", `/api/oauth/${provider}/${action}`, data);
}

// ============================================================================
// MODELS DOMAIN (catalog, ping, availability, alias, custom, disabled, pricing)
// ============================================================================

async function testModel(data) {
  return makeRequest("POST", "/api/models/test", data);
}

async function getModelAvailability(query) {
  return makeRequest("GET", `/api/models/availability${query ? `?${query}` : ""}`);
}

async function getModelAliases() {
  return makeRequest("GET", "/api/models/alias");
}

async function setModelAlias(alias, model) {
  return makeRequest("PUT", "/api/models/alias", { alias, model });
}

async function deleteModelAlias(alias) {
  return makeRequest("DELETE", `/api/models/alias?alias=${encodeURIComponent(alias)}`);
}

async function getCustomModels() {
  return makeRequest("GET", "/api/models/custom");
}

async function addCustomModel(data) {
  return makeRequest("POST", "/api/models/custom", data);
}

async function deleteCustomModel(id, providerAlias, type = "llm") {
  if (!id || !providerAlias) return { success: false, error: "id and providerAlias are required" };
  return makeRequest("DELETE", `/api/models/custom?id=${encodeURIComponent(id)}&providerAlias=${encodeURIComponent(providerAlias)}&type=${encodeURIComponent(type)}`);
}

async function getDisabledModels(providerAlias) {
  return makeRequest("GET", `/api/models/disabled${providerAlias ? `?providerAlias=${encodeURIComponent(providerAlias)}` : ""}`);
}

async function setDisabledModels(providerAlias, ids) {
  return makeRequest("POST", "/api/models/disabled", { providerAlias, ids });
}

async function syncModelCatalog() {
  return makeRequest("POST", "/api/models/catalog-sync", {});
}

async function getPricing() {
  return makeRequest("GET", "/api/pricing");
}

async function getTags() {
  return makeRequest("GET", "/api/tags");
}

// ============================================================================
// COMBOS++ (presets)
// ============================================================================

async function getComboPresets(source) {
  return makeRequest("GET", `/api/combos/presets?source=${encodeURIComponent(source)}`);
}

async function createComboPresets(source) {
  return makeRequest("POST", "/api/combos/presets", { source });
}

// ============================================================================
// USAGE & QUOTA
// ============================================================================

async function getUsageStats(period = "7d") {
  return makeRequest("GET", `/api/usage/stats?period=${encodeURIComponent(period)}`);
}

async function getUsageChart(period = "7d") {
  return makeRequest("GET", `/api/usage/chart?period=${encodeURIComponent(period)}`);
}

async function getUsageHistory(query) {
  return makeRequest("GET", `/api/usage/history${query ? `?${query}` : ""}`);
}

async function getUsageLogs() {
  return makeRequest("GET", "/api/usage/logs");
}

async function getRequestLogs(query) {
  return makeRequest("GET", `/api/usage/request-logs${query ? `?${query}` : ""}`);
}

async function getRequestDetails(query) {
  // Paginated table: page, pageSize, provider, model, connectionId, status, startDate, endDate
  return makeRequest("GET", `/api/usage/request-details${query ? `?${query}` : ""}`);
}

async function getUsageProviders() {
  return makeRequest("GET", "/api/usage/providers");
}

async function getConnectionUsage(connectionId) {
  return makeRequest("GET", `/api/usage/${encodeURIComponent(connectionId)}`);
}

async function resetCodexCredits(connectionId) {
  return makeRequest("POST", `/api/usage/${encodeURIComponent(connectionId)}/codex-reset-credits`, {});
}

// ============================================================================
// KEYS+
// ============================================================================

async function getApiKeyById(id) {
  return makeRequest("GET", `/api/keys/${id}`);
}

async function updateApiKey(id, data) {
  return makeRequest("PUT", `/api/keys/${id}`, data);
}

async function getRequireLogin() {
  return makeRequest("GET", "/api/settings/require-login");
}

// ============================================================================
// SETTINGS & SYSTEM++
// ============================================================================

async function testProxy(url) {
  return makeRequest("POST", "/api/settings/proxy-test", { url });
}

async function exportDatabase() {
  return makeRequest("GET", "/api/settings/database");
}

async function importDatabase(payload) {
  return makeRequest("POST", "/api/settings/database", payload);
}

async function getVersion() {
  return makeRequest("GET", "/api/version");
}

async function triggerVersionUpdate() {
  return makeRequest("POST", "/api/version/update", {});
}

async function shutdownServer() {
  return makeRequest("POST", "/api/shutdown", {});
}

// ============================================================================
// PROXY POOLS
// ============================================================================

async function getProxyPools() {
  return makeRequest("GET", "/api/proxy-pools");
}

async function createProxyPool(data) {
  return makeRequest("POST", "/api/proxy-pools", data);
}

async function getProxyPoolById(id) {
  return makeRequest("GET", `/api/proxy-pools/${id}`);
}

async function updateProxyPool(id, data) {
  return makeRequest("PUT", `/api/proxy-pools/${id}`, data);
}

async function deleteProxyPool(id) {
  return makeRequest("DELETE", `/api/proxy-pools/${id}`);
}

async function testProxyPool(id) {
  return makeRequest("POST", `/api/proxy-pools/${id}/test`, {});
}

// ============================================================================
// HEADROOM / PXPIPE
// ============================================================================

async function getHeadroomStatus() {
  return makeRequest("GET", "/api/headroom/status");
}

async function startHeadroom() {
  return makeRequest("POST", "/api/headroom/start", {});
}

async function stopHeadroom() {
  return makeRequest("POST", "/api/headroom/stop", {});
}

async function restartHeadroom() {
  return makeRequest("POST", "/api/headroom/restart", {});
}

async function getPxpipeStatus() {
  return makeRequest("GET", "/api/pxpipe/status");
}

async function getPxpipeStats(period) {
  return makeRequest("GET", `/api/pxpipe/stats${period ? `?period=${encodeURIComponent(period)}` : ""}`);
}

async function getPxpipeLogs() {
  return makeRequest("GET", "/api/pxpipe/logs");
}

async function startPxpipe() {
  return makeRequest("POST", "/api/pxpipe/start", {});
}

async function stopPxpipe() {
  return makeRequest("POST", "/api/pxpipe/stop", {});
}

async function restartPxpipe() {
  return makeRequest("POST", "/api/pxpipe/restart", {});
}

async function installPxpipe() {
  return makeRequest("POST", "/api/pxpipe/install", {});
}

async function getPxpipeHealth() {
  return makeRequest("GET", "/api/pxpipe/health");
}

async function getTailscaleCheck() {
  return makeRequest("GET", "/api/tunnel/tailscale-check");
}

async function installTailscale() {
  return makeRequest("POST", "/api/tunnel/tailscale-install", {});
}

async function enableTailscale() {
  return makeRequest("POST", "/api/tunnel/tailscale-enable", {});
}

async function disableTailscale() {
  return makeRequest("POST", "/api/tunnel/tailscale-disable", {});
}

async function getHeadroomExtras() {
  return makeRequest("GET", "/api/headroom/extras");
}

// ============================================================================
// CLI-TOOLS+ (batch statuses; per-tool GET/POST/DELETE reuse existing fns)
// ============================================================================

async function getAllCliToolStatuses() {
  return makeRequest("GET", "/api/cli-tools/all-statuses");
}

// ============================================================================
// MITM & MEDIA
// ============================================================================

async function getMitmStatus(tool) {
  return makeRequest("GET", `/api/cli-tools/${tool}-mitm`);
}

async function getMitmAlias(tool) {
  return makeRequest("GET", `/api/cli-tools/${tool}-mitm/alias`);
}

async function updateMitmAlias(tool, data) {
  return makeRequest("PUT", `/api/cli-tools/${tool}-mitm/alias`, data);
}

async function getTtsVoices(provider, lang) {
  const q = [`provider=${encodeURIComponent(provider || "edge-tts")}`];
  if (lang) q.push(`lang=${encodeURIComponent(lang)}`);
  return makeRequest("GET", `/api/media-providers/tts/voices?${q.join("&")}`);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  configure,
  makeRequest,
  req,
  
  // Providers
  getProviders,
  getProviderById,
  testProvider,
  deleteProvider,
  getProviderModels,
  
  // Connection aliases
  testConnection: testProvider,
  deleteConnection: deleteProvider,
  updateConnection,
  
  // OAuth
  getOAuthAuthUrl,
  exchangeOAuthCode,
  getOAuthDeviceCode,
  pollOAuthToken,
  createApiKeyProvider,
  
  // API Keys
  getApiKeys,
  createApiKey,
  deleteApiKey,
  
  // Combos
  getCombos,
  getComboById,
  createCombo,
  updateCombo,
  deleteCombo,
  
  // CLI Tools
  getCliToolSettings,
  applyCliToolSettings,
  resetCliToolSettings,

  // Settings
  getSettings,
  updateSettings,
  resetPassword,
  
  // Tunnel
  getTunnelStatus,
  enableTunnel,
  disableTunnel,
  
  // Models
  getModels,
  getAvailableModels,

  // Provider Nodes (custom providers)
  getProviderNodes,
  createProviderNode,
  updateProviderNode,
  deleteProviderNode,
  validateProviderNode,

  // Providers++
  testProvidersBatch,
  validateProvider,
  getSuggestedModels,
  testProviderModels,
  addProviderModel,
  oauthImport,

  // Models domain
  testModel,
  getModelAvailability,
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  getCustomModels,
  addCustomModel,
  deleteCustomModel,
  getDisabledModels,
  setDisabledModels,
  syncModelCatalog,
  getPricing,
  getTags,

  // Combos++
  getComboPresets,
  createComboPresets,

  // Usage & quota
  getUsageStats,
  getUsageChart,
  getUsageHistory,
  getUsageLogs,
  getRequestLogs,
  getRequestDetails,
  getUsageProviders,
  getConnectionUsage,
  resetCodexCredits,

  // Keys+
  getApiKeyById,
  updateApiKey,
  getRequireLogin,

  // Settings & system++
  testProxy,
  exportDatabase,
  importDatabase,
  getVersion,
  triggerVersionUpdate,
  shutdownServer,

  // Proxy pools
  getProxyPools,
  createProxyPool,
  getProxyPoolById,
  updateProxyPool,
  deleteProxyPool,
  testProxyPool,

  // Headroom / PxPipe
  getHeadroomStatus,
  startHeadroom,
  stopHeadroom,
  restartHeadroom,
  getPxpipeStatus,
  getPxpipeStats,
  getPxpipeLogs,
  startPxpipe,
  stopPxpipe,
  restartPxpipe,
  installPxpipe,
  getPxpipeHealth,
  getTailscaleCheck,
  installTailscale,
  enableTailscale,
  disableTailscale,
  getHeadroomExtras,

  // CLI-tools+
  getAllCliToolStatuses,

  // MITM & media
  getMitmStatus,
  getMitmAlias,
  updateMitmAlias,
  getTtsVoices,
};
