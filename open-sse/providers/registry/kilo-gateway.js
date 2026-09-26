export default {
  id: "kilo-gateway",
  alias: "kgw",
  aliases: [
    "kilo-gateway",
    "kilogateway",
  ],
  uiAlias: "kgw",
  category: "freeTier",
  display: {
    name: "Kilo Gateway",
    icon: "login",
    color: "#8B5CF6",
    textIcon: "KG",
    website: "https://kilo.ai",
    notice: {
      apiKeyUrl: "https://kilo.ai/dashboard?tab=apiKeys",
    },
  },
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.kilo.ai/api/gateway/chat/completions",
    validateUrl: "https://api.kilo.ai/api/gateway/models",
  },
  // Seed snapshot, verified against the live catalog (GET /api/gateway/models).
  // Kilo rejects an unlisted id with "The requested model ... does not exist",
  // so the `:free` suffix that used to sit on kat-coder is gone: only the paid
  // id exists. contextLength is display metadata; routing caps resolve through
  // the capabilities tables.
  models: [
    { id: "kilo-auto/free", name: "Kilo Auto Free", contextLength: 256000 },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B (Free)", contextLength: 262144 },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (Free)", contextLength: 1000000 },
    { id: "kwaipilot/kat-coder-pro-v2.5", name: "Kat Coder Pro v2.5", contextLength: 262144 },
    { id: "kilo-auto/frontier", name: "Kilo Auto Frontier", contextLength: 1000000 },
    { id: "kilo-auto/balanced", name: "Kilo Auto Balanced", contextLength: 1000000 },
  ],
};
