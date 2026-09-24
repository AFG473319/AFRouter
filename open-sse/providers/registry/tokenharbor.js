// Token Harbor — universal AI gateway (https://tokenharbor.ai).
// OpenAI-compatible chat endpoint with a bearer Universal Key (thk_live_…).
// The /v1/models catalog is authenticated, so the dashboard connection route
// fetches it with the saved key; static models below keep the provider useful
// before the first model refresh and passthroughModels permits future catalog IDs.
export default {
  id: "tokenharbor",
  alias: "th",
  aliases: ["token-harbor"],
  uiAlias: "th",
  category: "apikey",
  hasFree: true,
  display: {
    name: "Token Harbor",
    icon: "anchor",
    color: "#111827",
    textIcon: "TH",
    website: "https://tokenharbor.ai",
    notice: {
      text: "One Universal Key for GPT, Claude, Gemini, DeepSeek, Qwen, GLM, and more. Selected :free models are available on the free tier.",
      apiKeyUrl: "https://tokenharbor.ai/dashboard/api-keys",
    },
  },
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://tokenharbor.ai/v1/chat/completions",
    validateUrl: "https://tokenharbor.ai/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "th-orchestra", name: "TH Orchestra", contextLength: 200000 },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", contextLength: 1000000 },
    { id: "claude-opus-5", name: "Claude Opus 5", contextLength: 1000000 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
    { id: "claude-fable-5.1", name: "Claude Fable 5.1", contextLength: 1000000 },
    { id: "gpt-6-astra", name: "GPT-6 Astra", contextLength: 1050000 },
    { id: "gpt-6-sol", name: "GPT-6 Sol", contextLength: 1050000 },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextLength: 1050000 },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", contextLength: 1000000 },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1048576 },
    { id: "deepseek-v4-flash:free", name: "DeepSeek V4 Flash (Free)", contextLength: 1048576, isFree: true },
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)", contextLength: 1048576, isFree: true },
    { id: "qwen3.8-max", name: "Qwen3.8 Max", contextLength: 200000 },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", contextLength: 200000 },
    { id: "qwen3.8-flash:free", name: "Qwen3.8 Flash (Free)", contextLength: 200000, isFree: true },
    { id: "glm-5.3", name: "GLM 5.3", contextLength: 200000 },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextLength: 1000000 },
    { id: "kimi-k3", name: "Kimi K3", contextLength: 1048576 },
    { id: "grok-4.7", name: "Grok 4.7", contextLength: 500000 },
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", contextLength: 1048576 },
  ],
  serviceKinds: ["llm"],
  passthroughModels: true,
};
