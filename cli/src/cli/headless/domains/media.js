const api = require("../../api/client");

const HELP = `media <action> [flags]
  voices [--provider <edge-tts|local-device|elevenlabs|minimax|inworld|deepgram|gemini>] [--lang <code>]
    List TTS voices (ElevenLabs needs --api-key)`;

async function run(action, pos, opts) {
  if (action === "voices") {
    const provider = opts.provider || "edge-tts";
    let path = `/api/media-providers/tts/voices?provider=${encodeURIComponent(provider)}`;
    if (opts.lang) path += `&lang=${encodeURIComponent(opts.lang)}`;
    if (opts["api-key"] || opts.apiKey) path += `&apiKey=${encodeURIComponent(opts["api-key"] || opts.apiKey)}`;
    const r = await api.req("GET", path);
    if (!r.success) return { error: r.error };
    return { data: r.data };
  }
  return { usage: HELP };
}

module.exports = { run, HELP };
