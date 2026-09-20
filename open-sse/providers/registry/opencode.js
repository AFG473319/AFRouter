export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    // Upstream free-tier gate rejects stream:false with 403 FreeTierError
    // (verified live). Force SSE upstream; chatCore converts back to JSON
    // for non-streaming clients via the existing forced-SSE path.
    forceStream: true,
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
  },
  models: [
    // Muse Spark models are served by /zen/v1/responses; other passthrough
    // models default to /chat/completions. Declare special formats per-model.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    // Jev is a decisions-only System One model (TypeSafe): upstream serves it on
    // POST /zen/v1/systemone with {model, state, questions} and returns typed
    // {answers} — there is no chat/completions or responses shape for it, so
    // chat requests are rejected with a clear 400 (see chatCore guard).
    { id: "jev-1.13", name: "Jev 1.13", targetFormat: "systemone" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", targetFormat: "systemone" },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
