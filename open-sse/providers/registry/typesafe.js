// TypeSafe AI — System One decisions API (https://typesafe.ai, docs: https://docs.typesafe.ai).
// Upstream serves all models on POST https://api.typesafe.ai/v1/systemone with
// {model, state, questions} and returns typed {model, answers, usage} — there is
// no chat/completions shape for Jev, so chat requests are rejected with a clear
// 400 (see chatCore guard). Bearer API key from https://console.typesafe.ai/keys.
// Pricing (docs/models.md): $42/Btok ($0.042/Mtok) input, output tokens free.
// New accounts get $5 in free credits. Model id: jev-1.13.0 (alias jev-latest).
export default {
  id: "typesafe",
  alias: "typesafe",
  uiAlias: "typesafe",
  hasFree: true,
  category: "freeTier",
  display: {
    name: "TypeSafe AI",
    icon: "psychology",
    color: "#14B8A6",
    textIcon: "TS",
    website: "https://typesafe.ai",
    notice: {
      text: "System One decisions API (Jev) — typed noul/choice/score judgments, not chat text. New accounts get $5 in free credits.",
      apiKeyUrl: "https://console.typesafe.ai/keys",
    },
  },
  authType: "apikey",
  authModes: [
    "apikey",
  ],
  transport: {
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    validateUrl: "https://api.typesafe.ai/v1/models",
  },
  // Every TypeSafe model is a decisions-only System One model — including
  // passthrough ids not listed below. Routing, ping, and request logs all
  // rely on this so TypeSafe behaves like registered Jev models.
  defaultTargetFormat: "systemone",
  models: [
    { id: "jev-1.13.0", name: "Jev 1.13", targetFormat: "systemone", contextLength: 64000 },
    { id: "jev-latest", name: "Jev Latest", targetFormat: "systemone", contextLength: 64000 },
  ],
  passthroughModels: true,
};
