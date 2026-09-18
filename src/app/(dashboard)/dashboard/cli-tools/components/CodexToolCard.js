"use client";

import { useState, useEffect } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import { buildCodexCatalog, codexProvider, normalizeCodexBaseUrl, stringifyCodexConfig } from "@/shared/codexCatalog";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { fetchCodexStatus } from "@/shared/codexStatus";

export default function CodexToolCard({ tool, isExpanded, onToggle, baseUrl, apiKeys, activeProviders, cloudEnabled, initialStatus, tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl }) {
  const [codexStatus, setCodexStatus] = useState(initialStatus || null);
  const [checkingCodex, setCheckingCodex] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [apiKeyChoice, setSelectedApiKey] = useState(null);
  const selectedApiKey = apiKeyChoice ?? apiKeys?.[0]?.key ?? "";
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedModels, setSelectedModels] = useState([]);
  const [removedModels, setRemovedModels] = useState([]);
  const [customModel, setCustomModel] = useState("");
  const { getCaps } = useModelCaps();
  const [subagentModel, setSubagentModel] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [subagentModalOpen, setSubagentModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);

  useEffect(() => {
    if (!isExpanded) return;
    let cancelled = false;
    fetchCodexStatus().then((status) => {
      if (!cancelled) setCodexStatus(status);
    });
    fetch("/api/models/alias").then((response) => response.json()).then((data) => {
      if (!cancelled) setModelAliases(data.aliases || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isExpanded]);

  const [hydratedStatus, setHydratedStatus] = useState(null);
  if (codexStatus !== hydratedStatus) {
    setHydratedStatus(codexStatus);
    if (codexStatus?.codex && !draftDirty) {
      setSelectedModels(codexStatus.codex.models || []);
      setSelectedModel(codexStatus.codex.activeModel || "");
      setSubagentModel(codexStatus.codex.subagentModel || "");
      setRemovedModels([]);
    }
  }

  const currentBaseUrl = codexStatus?.codex?.baseUrl || "";

  const getConfigStatus = () => {
    if (!codexStatus?.installed) return null;
    if (!codexStatus.hasAFRouter) return "not_configured";
    return codexStatus.codex?.activeModel ? "configured" : "other";
  };

  const configStatus = getConfigStatus();

  const getEffectiveBaseUrl = () => {
    return normalizeCodexBaseUrl(customBaseUrl || baseUrl);
  };

  const getDisplayUrl = () => customBaseUrl || baseUrl;

  const checkCodexStatus = async () => {
    setCheckingCodex(true);
    try {
      setCodexStatus(await fetchCodexStatus());
    } finally {
      setCheckingCodex(false);
    }
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setMessage(null);
    try {
      // Use sk_afrouter for localhost if no key, otherwise use selected key
      const keyToUse = (selectedApiKey && selectedApiKey.trim())
        ? selectedApiKey
        : (!cloudEnabled ? "sk_afrouter" : selectedApiKey);

      const res = await fetch("/api/cli-tools/codex-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          models: selectedModels,
          activeModel: selectedModel,
          removeModels: removedModels,
          subagentModel
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Remember the endpoint so it stays selectable next time
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setMessage({ type: "success", text: `${data.message}${data.unverified?.length ? ` Unverified models use conservative defaults: ${data.unverified.join(", ")}.` : ""}` });
        setDraftDirty(false);
        await checkCodexStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleResetSettings = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/codex-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        setSelectedModel("");
        setSelectedModels([]);
        setRemovedModels([]);
        setSubagentModel("");
        setDraftDirty(false);
        await checkCodexStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const handleModelSelect = (model) => {
    const id = model.value.trim();
    if (!id || /\s/.test(id)) return;
    setDraftDirty(true);
    setSelectedModels((previous) => [...new Set([...previous, id])]);
    setRemovedModels((previous) => previous.filter((value) => value !== id));
    setSelectedModel((previous) => previous || id);
    setCustomModel("");
  };

  const removeModel = (id) => {
    setDraftDirty(true);
    const remaining = selectedModels.filter((value) => value !== id);
    setSelectedModels(remaining);
    setRemovedModels((previous) => [...new Set([...previous, id])]);
    if (selectedModel === id) setSelectedModel(remaining[0] || "");
    if (subagentModel === id) setSubagentModel("");
  };

  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_afrouter" : "<API_KEY_FROM_DASHBOARD>");

    let provider;
    try { provider = codexProvider(getEffectiveBaseUrl(), keyToUse); }
    catch { return [{ filename: "Endpoint", content: "Select a valid HTTP(S) endpoint first." }]; }
    const catalogPath = codexStatus?.catalogPath || "/absolute/path/to/.codex/afrouter-models.json";
    const allModels = [...new Set([...selectedModels, ...(subagentModel ? [subagentModel] : [])])];
    const specs = Object.fromEntries(allModels.map((id) => [id, codexStatus?.codex?.specs?.[id] || getCaps(id) || {}]));
    const configContent = stringifyCodexConfig({
      model: selectedModel || allModels[0] || "provider/model-id",
      catalogPath,
      provider,
      subagentModel,
    });
    return [
      {
        filename: codexStatus?.configPath || "$CODEX_HOME/config.toml (default ~/.codex/config.toml)",
        content: `# Merge into your config; do not replace unrelated settings.\n# Remove global context/compaction/reasoning overrides to use per-model metadata.\n# On another machine, update model_catalog_json to its absolute catalog path.\n${configContent}`,
      },
      { filename: catalogPath, content: JSON.stringify(buildCodexCatalog(allModels, specs), null, 2) },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/codex.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checkingCodex && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Codex CLI...</span>
            </div>
          )}

          {!checkingCodex && codexStatus?.installed === false && !codexStatus?.error && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Codex CLI not detected locally</p>
                    <p className="text-sm text-text-muted">Manual configuration is still available if afrouter is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInstallGuide(!showInstallGuide)}>
                    <span className="material-symbols-outlined text-[18px] mr-1">{showInstallGuide ? "expand_less" : "help"}</span>
                    {showInstallGuide ? "Hide" : "How to Install"}
                  </Button>
                </div>
              </div>
              {showInstallGuide && (
                <div className="p-4 bg-surface border border-border rounded-lg">
                  <h4 className="font-medium mb-3">Installation Guide</h4>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-text-muted mb-1">macOS / Linux / Windows:</p>
                      <code className="block px-3 py-2 bg-black/5 dark:bg-white/5 rounded font-mono text-xs">npm install -g @openai/codex</code>
                    </div>
                    <p className="text-text-muted">After installation, run <code className="px-1 bg-black/5 dark:bg-white/5 rounded">codex</code> to verify.</p>
                    <div className="pt-2 border-t border-border">
                      <p className="text-text-muted text-xs">
                        Codex reads custom providers from <code className="px-1 bg-black/5 dark:bg-white/5 rounded">~/.codex/config.toml</code>.
                        Click &quot;Apply&quot; to auto-configure.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {codexStatus?.configPath && <p className="text-xs text-text-muted">Config path: <span className="bidi-ltr" data-i18n-skip>{codexStatus.configPath}</span></p>}
          {codexStatus?.error && (
            <div role="alert" className="flex flex-col gap-2 text-sm text-red-500">
              <p>{codexStatus.error}</p>
              <Button variant="outline" size="sm" onClick={checkCodexStatus} disabled={checkingCodex} loading={checkingCodex}>Retry check</Button>
            </div>
          )}
          {!checkingCodex && !codexStatus?.corrupt && (
            <>
              <fieldset disabled={applying || restoring} className="flex flex-col gap-2">
                {/* Endpoint (selector) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getDisplayUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                    currentUrl={currentBaseUrl}
                  />
                </div>

                {/* Current configured */}
                {codexStatus?.hasAFRouter && (() => {
                  return currentBaseUrl ? (
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                      <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                      <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                      <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                        {currentBaseUrl}
                      </span>
                    </div>
                  ) : null;
                })()}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-text-main">AFRouter Models</span>
                  <div className="flex flex-wrap gap-2 rounded border border-border p-2">
                    {selectedModels.length === 0 && <span className="text-xs text-text-muted">No models selected</span>}
                    {selectedModels.map((id) => (
                      <span key={id} className={`inline-flex max-w-full items-center gap-1 rounded border px-2 py-1 text-xs ${id === selectedModel ? "border-primary text-primary" : "border-border text-text-muted"}`}>
                        <button type="button" onClick={() => { setDraftDirty(true); setSelectedModel(id); }} title="Set as default" aria-pressed={id === selectedModel} className="bidi-ltr truncate" data-i18n-skip>{id === selectedModel ? "\u2605 " : ""}{id}</button>
                        <button type="button" onClick={() => removeModel(id)} aria-label={`Remove ${id}`} className="ms-1 hover:text-red-500">{"\u00d7"}</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input aria-label="Custom model ID" value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="provider/model-id or combo" className="bidi-ltr min-w-0 flex-1 rounded border border-border bg-surface px-2 text-xs" />
                    <Button size="sm" variant="outline" disabled={!customModel.trim()} onClick={() => handleModelSelect({ value: customModel })}>Add</Button>
                    <Button size="sm" variant="outline" disabled={!activeProviders?.length} onClick={() => setModalOpen(true)}>Add Model</Button>
                  </div>
                  <p className="text-xs text-text-muted">Click a model to make it the default. Changes are saved with Apply. Fully quit and reopen Codex to refresh its model picker.</p>
                  <p className="text-xs text-text-muted">Specs come from the AFRouter catalog. Unknown models and combos use a 128K text-only fallback. Output limits stay enforced by the gateway; unsupported Codex capabilities are not advertised.</p>
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-end sm:text-sm">Default Model</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="relative w-full min-w-0">
                    <select aria-label="Default Model" value={selectedModel} onChange={(event) => { setDraftDirty(true); setSelectedModel(event.target.value); }} className="bidi-ltr w-full rounded border border-border bg-surface px-2 py-2 text-xs" data-i18n-skip>
                      <option value="" disabled>Select a model</option>
                      {selectedModels.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                  </div>
                  <button onClick={() => setModalOpen(true)} disabled={!activeProviders?.length} className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${activeProviders?.length ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Select Model</button>
                </div>

                {/* Subagent Model */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Subagent Model</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="relative w-full min-w-0">
                    <input
                      type="text"
                      value={subagentModel}
                      onChange={(event) => { setDraftDirty(true); setSubagentModel(event.target.value); }}
                      placeholder={selectedModel || "provider/model-id (defaults to main model)"}
                      className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                    />
                    {subagentModel && (
                      <button
                        onClick={() => { setDraftDirty(true); setSubagentModel(""); }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors"
                        title="Clear (will use main model)"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => setSubagentModalOpen(true)}
                    disabled={!activeProviders?.length}
                    className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${activeProviders?.length ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}
                  >
                    Select Model
                  </button>
                </div>
              </fieldset>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApplySettings} disabled={(!selectedApiKey && cloudEnabled) || !selectedModels.includes(selectedModel) || restoring || !codexStatus?.installed} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleResetSettings} disabled={restoring || applying || !codexStatus?.hasAFRouter} loading={restoring}>
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={handleModelSelect}
          onDeselect={(model) => removeModel(model.value)}
          selectedModel={null}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add AFRouter Models for Codex"
        />
      )}

      {subagentModalOpen && (
        <ModelSelectModal
          isOpen={subagentModalOpen}
          onClose={() => setSubagentModalOpen(false)}
          onSelect={(model) => { setDraftDirty(true); setSubagentModel(model.value); setSubagentModalOpen(false); }}
          selectedModel={subagentModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select Subagent Model for Codex"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Codex CLI - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
