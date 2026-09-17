const api = require("../api/client");
const { prompt, pause } = require("../utils/input");
const { clearScreen, showStatus } = require("../utils/display");
const { printResult, printJson, offerJsonView } = require("../utils/output");
const { showMenuWithBack } = require("../utils/menuHelper");

const VOICE_PROVIDERS = ["edge-tts", "local-device", "elevenlabs", "minimax", "inworld", "deepgram", "gemini"];

/**
 * MITM & Media menu — MITM status shortcut + TTS voice catalogs.
 * @param {Array<string>} breadcrumb
 */
async function showMitmMediaMenu(breadcrumb = []) {
  await showMenuWithBack({
    title: "🎙️  MITM & Media",
    breadcrumb,
    headerContent: "MITM proxy status + text-to-speech voice catalogs.",
    refresh: async () => ({}),
    items: [
      {
        label: "MITM Status (Antigravity)",
        action: async () => {
          const res = await api.getMitmStatus("antigravity");
          if (res.success) printJson(res.data);
          else showStatus(`Failed: ${res.error}`, "error");
          await pause();
          return true;
        }
      },
      {
        label: "MITM Alias Mapping (view / edit)",
        action: async () => {
          const res = await api.getMitmAlias("antigravity");
          if (!res.success) {
            showStatus(`Failed: ${res.error}`, "error");
            await pause();
            return true;
          }
          printJson(res.data);
          await pause();
          return true;
        }
      },
      {
        label: "TTS Voices Browser",
        action: async () => { await handleTtsVoices(); return true; }
      },
    ]
  });
}

async function handleTtsVoices() {
  clearScreen();
  console.log("\n🎙️  TTS Voices\n");
  VOICE_PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  const input = await prompt("\nProvider (number, default 1): ");
  const num = parseInt(input, 10);
  const provider = VOICE_PROVIDERS[(isNaN(num) ? 1 : num) - 1] || "edge-tts";
  let extra = "";
  if (provider === "elevenlabs") {
    extra = await prompt("ElevenLabs API key: ");
    if (!extra) { showStatus("API key required for ElevenLabs", "warning"); await pause(); return; }
  }
  const lang = await prompt("Language filter (e.g. en, Enter to skip): ");
  showStatus("Loading voices...", "info");
  let res = await api.getTtsVoices(provider, lang && lang.trim() ? lang.trim() : undefined);
  if (!res.success && provider === "elevenlabs") {
    // retry with apiKey query param (server reads ?apiKey=)
    res = await api.req("GET", `/api/media-providers/tts/voices?provider=elevenlabs&apiKey=${encodeURIComponent(extra)}${lang && lang.trim() ? `&lang=${encodeURIComponent(lang.trim())}` : ""}`);
  }
  if (!res.success) {
    showStatus(`Failed: ${res.error}`, "error");
    await pause();
    return;
  }
  const voices = res.data.voices || (Array.isArray(res.data) ? res.data : []);
  printResult({
    headers: ["ID", "Name", "Lang", "Gender"],
    rows: voices.slice(0, 80).map(v => [
      v.id || "?",
      (v.name || "").slice(0, 30),
      v.locale || v.lang || "-",
      v.gender || "-",
    ]),
    jsonData: res.data,
    emptyMessage: "No voices returned.",
  });
  if (voices.length > 80) console.log(`  … ${voices.length - 80} more (View as JSON for full list)`);
  await offerJsonView(res.data);
  await pause();
}

module.exports = { showMitmMediaMenu };
