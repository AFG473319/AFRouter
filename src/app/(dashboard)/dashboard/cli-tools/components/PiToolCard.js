"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Toggle, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import { buildProviderEntry, PI_DEFAULT_API_KEY } from "@/lib/piConfig.js";

const ENDPOINT = "/api/cli-tools/pi-settings";

export default function PiToolCard({ tool, isExpanded, onToggle, baseUrl, apiKeys, activeProviders, cloudEnabled, initialStatus, tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl }) {
  const [status, setStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [selectedModels, setSelectedModels] = useState([]);
  // Startup-pin intent is derived from settings.json and only overridden once
  // the user touches the toggle, so the control can never show a stale state
  // after Apply/Reset refresh the status.
  const [setDefaultOverride, setSetDefaultOverride] = useState(null);
  const [defaultModelOverride, setDefaultModelOverride] = useState(null);
  const selectedModelsRef = useRef([]);

  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded) {
      if (!status) checkStatus();
      fetchModelAliases();
    }
  }, [isExpanded]);

  // Reflect Pi's existing startup pin so the toggle never lies about what
  // settings.json already says. Derived, not mirrored into state.
  const isAFRouterDefault = !!status?.pi?.isDefault;
  const setDefault = setDefaultOverride ?? isAFRouterDefault;
  const defaultModel =
    defaultModelOverride ?? (isAFRouterDefault ? status?.pi?.defaultModel || "" : "");
  const setSetDefault = setSetDefaultOverride;

  // Hydrate chips from ALL models currently under the provider (user-added
  // included), not just AFRouter-managed ones — the card must reflect the real
  // config. Signature-guarded so a status refresh never clobbers an in-progress
  // selection, and skipped while the model modal is open.
  const hydratedSignature = useRef("");
  useEffect(() => {
    const entryModels = status?.pi?.models;
    if (!Array.isArray(entryModels) || modalOpen) return;
    const signature = [...entryModels].sort().join("|");
    if (signature !== hydratedSignature.current) {
      hydratedSignature.current = signature;
      setSelectedModels(entryModels);
    }
  }, [status, modalOpen]);

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  };

  const currentBaseUrl = status?.pi?.baseURL || "";

  const getConfigStatus = () => {
    if (!status?.installed) return null;
    if (status.corrupt) return "corrupt";
    if (!status.hasAFRouter) return "not_configured";
    return matchKnownEndpoint(status.pi?.baseURL || "", { tunnelPublicUrl, tailscaleUrl }) ? "configured" : "other";
  };

  const configStatus = getConfigStatus();

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getKeyToUse = () =>
    (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? PI_DEFAULT_API_KEY : selectedApiKey);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const res = await fetch(ENDPOINT);
      const data = await res.json();
      setStatus(data);
    } catch (error) {
      setStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  };

  const handleApply = async (adoptBootstrap = false) => {
    setApplying(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: getKeyToUse(),
          models: selectedModels,
          ...(adoptBootstrap ? { adoptBootstrap: true } : {}),
          // Only send the pin when asked, and only with a model that is really
          // going to be written — the route falls back to the first one.
          ...(setDefault ? { setDefault: true, defaultModel } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        const unverifiedNote = Array.isArray(data.unverified) && data.unverified.length > 0
          ? ` Unverified (not in catalog, conservative specs): ${data.unverified.join(", ")}.`
          : "";
        const candidateNote = Array.isArray(data.skippedCandidates) && data.skippedCandidates.length > 0
          ? ` Left untouched (added outside AFRouter, not recorded): ${data.skippedCandidates.join(", ")}.`
          : "";
        setMessage({
          type: "success",
          text: (data.message || "Pi settings applied!")
            + " Pi reloads models.json each time you open /model — no restart needed."
            + unverifiedNote
            + candidateNote,
        });
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        const candidateNote = Array.isArray(data.skippedCandidates) && data.skippedCandidates.length > 0
          ? ` Left untouched (not recorded as AFRouter-added): ${data.skippedCandidates.join(", ")}.`
          : "";
        setMessage({ type: "success", text: (data.message || "AFRouter models removed from Pi!") + candidateNote });
        setSelectedModels([]);
        setSetDefaultOverride(false);
        setDefaultModelOverride("");
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const removeModel = async (model) => {
    try {
      const res = await fetch(`${ENDPOINT}?model=${encodeURIComponent(model)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      // Only drop the chip when the server actually removed it — models added
      // outside AFRouter are ledger-protected and must stay listed.
      if (res.ok && data.removed > 0) {
        setSelectedModels((prev) => selectedModelsRef.current.filter((m) => m !== model));
      }
      checkStatus();
    } catch (error) {
      console.log("Error removing model:", error);
    }
  };

  const managedModels = status?.pi?.afrouterModels || [];
  const candidateModels = status?.pi?.bootstrapCandidates || [];
  const unverifiedModels = status?.pi?.unverified || [];

  // Snippet mirrors exactly what the route writes, through the same shared
  // builder, so a remotely-pasted config behaves identically under a later
  // dashboard Reset. Conservative specs (no catalog here) keep it honest.
  const getManualConfigs = () => {
    const modelsToShow = selectedModels.length > 0 ? selectedModels : ["provider/model-id"];
    const modelsDoc = { providers: { afrouter: buildProviderEntry({
      baseUrl: getEffectiveBaseUrl(),
      apiKey: getKeyToUse() || "<API_KEY_FROM_DASHBOARD>",
      models: modelsToShow,
    }) } };
    const configs = [
      {
        filename: "~/.pi/agent/models.json",
        content: JSON.stringify(modelsDoc, null, 2),
      },
    ];
    if (setDefault) {
      configs.push({
        filename: "~/.pi/agent/settings.json",
        content: JSON.stringify(
          { defaultProvider: "afrouter", defaultModel: defaultModel || modelsToShow[0] },
          null,
          2,
        ),
      });
    }
    return configs;
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/pi.svg" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
              {configStatus === "corrupt" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-red-500/10 text-red-600 dark:text-red-400 rounded-full">Config unreadable</span>}
              {status?.pi?.isDefault && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-primary/10 text-primary rounded-full">Default</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checking && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Pi...</span>
            </div>
          )}

          {!checking && status && !status.installed && (
            <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-yellow-500">warning</span>
                <div className="flex-1">
                  <p className="font-medium text-yellow-600 dark:text-yellow-400">Pi not detected locally</p>
                  <p className="text-sm text-text-muted">Install it with <code className="bidi-ltr">npm install -g @earendil-works/pi-coding-agent</code>, or launch it once so it creates <code className="bidi-ltr">~/.pi/agent/</code>. Manual Config works for remote machines too.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 pl-9">
                <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                  <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                  Manual Config
                </Button>
              </div>
            </div>
          )}

          {!checking && status?.corrupt && (
            <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <span className="material-symbols-outlined text-red-500">error</span>
              <div className="flex-1">
                <p className="font-medium text-red-600 dark:text-red-400">Pi models.json is unreadable</p>
                <p className="text-sm text-text-muted">{status.configPath} does not contain valid JSON. Restore the latest <code className="bidi-ltr">models.json.bak-*</code> backup next to it, or fix the file by hand — AFRouter will not write to it until it parses.</p>
              </div>
            </div>
          )}

          {!checking && status?.installed && !status.corrupt && (
            <>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getEffectiveBaseUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                    currentUrl={currentBaseUrl}
                  />
                </div>

                {status?.pi?.baseURL && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {status.pi.baseURL} <span className="opacity-60">(api: {status.pi.api})</span>
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-2">
                  <span className="w-32 shrink-0 text-sm font-semibold text-text-main text-right pt-1">Models</span>
                  <span className="material-symbols-outlined text-text-muted text-[14px] mt-1.5">arrow_forward</span>
                  <div className="flex-1 flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5 min-h-[28px] px-2 py-1.5 bg-surface rounded border border-border">
                      {selectedModels.length === 0 ? (
                        <span className="text-xs text-text-muted">No models under the afrouter provider — add one below</span>
                      ) : (
                        selectedModels.map((model) => {
                          const managed = managedModels.includes(model);
                          return (
                            <span
                              key={model}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${managed ? "bg-primary/10 text-primary border-primary/40" : "bg-black/5 dark:bg-white/5 text-text-muted border-transparent"}`}
                              title={managed ? "AFRouter-managed model" : "Added outside AFRouter — remove it inside Pi"}
                            >
                              {model}
                              {managed && (
                                <button onClick={() => removeModel(model)} className="ml-0.5 hover:text-red-500">
                                  <span className="material-symbols-outlined text-[12px]">close</span>
                                </button>
                              )}
                            </span>
                          );
                        })
                      )}
                    </div>
                    <button onClick={() => setModalOpen(true)} disabled={!activeProviders?.length} className={`self-start px-2 py-1 rounded border text-xs transition-colors ${activeProviders?.length ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Add Model</button>
                    <span className="text-xs text-text-muted">
                      Pi reads contextWindow, maxTokens, input and reasoning from models.json, so it sizes compaction, image encoding and the /thinking picker for you.
                    </span>
                    {candidateModels.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1.5 text-xs text-yellow-700 dark:text-yellow-300">
                        <span>Added under the afrouter provider but not recorded ({candidateModels.join(", ")}) — Reset will not touch them.</span>
                        <button
                          onClick={() => handleApply(true)}
                          disabled={applying || selectedModels.length === 0}
                          className="rounded border border-yellow-500/50 px-2 py-0.5 hover:bg-yellow-500/20 disabled:opacity-50"
                        >
                          Adopt as mine
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-2">
                  <span className="w-32 shrink-0 text-sm font-semibold text-text-main text-right pt-1.5">Startup</span>
                  <span className="material-symbols-outlined text-text-muted text-[14px] mt-2">arrow_forward</span>
                  <div className="flex-1 flex flex-col gap-2">
                    <Toggle
                      checked={setDefault}
                      onChange={setSetDefault}
                      size="sm"
                      label="Make AFRouter Pi's default provider"
                      description="Writes defaultProvider (and defaultModel) into settings.json, so pi starts on AFRouter with no /model step. Leave off to keep Pi's current startup model and only add AFRouter to the picker."
                    />
                    {setDefault && (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-text-muted">Startup model</span>
                        <select
                          value={defaultModel}
                          onChange={(e) => setDefaultModelOverride(e.target.value)}
                          className="rounded border border-border bg-surface px-2 py-1.5 text-xs text-text-main"
                        >
                          <option value="">First selected model ({selectedModels[0] || "none"})</option>
                          {selectedModels.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                        <span className="text-xs text-text-muted">
                          Pi also lets you save this in-session with <code className="bidi-ltr">/model</code> then <code className="bidi-ltr">Ctrl+S</code>.
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {unverifiedModels.length > 0 && (
                  <div className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                    <span className="material-symbols-outlined text-[14px]">info</span>
                    <span>Unverified specs (not in catalog, using conservative limits): {unverifiedModels.join(", ")}</span>
                  </div>
                )}

                <div className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-surface/40 text-text-muted">
                  <span className="material-symbols-outlined text-[14px]">folder_open</span>
                  <span className="min-w-0 break-all">
                    <span className="opacity-70">models.json: </span><span className="bidi-ltr">{status.configPath}</span>
                    {status.agentDir && status.agentDir !== status.configPath?.replace(/[\\/]models\.json$/, "") && (
                      <><br /><span className="opacity-70">agent dir: </span><span className="bidi-ltr">{status.agentDir}</span></>
                    )}
                  </span>
                </div>
              </div>

              {message && (
                <div className={`flex items-start gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApply} disabled={selectedModels.length === 0} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleReset} disabled={!status.hasAFRouter} loading={restoring}>
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
          onSelect={(model) => {
            if (!selectedModels.includes(model.value)) {
              setSelectedModels([...selectedModels, model.value]);
            }
          }}
          onDeselect={(model) => {
            setSelectedModels(selectedModelsRef.current.filter((m) => m !== model.value));
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          title="Add Model for Pi"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Pi - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
