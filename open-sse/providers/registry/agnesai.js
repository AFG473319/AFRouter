// AgnesAI — free omni-modal AI gateway (https://agnes-ai.com, docs: https://wiki.agnes-ai.com).
// OpenAI-compatible at https://apihub.agnes-ai.com/v1 (chat, responses, messages,
// images); Bearer API key from the Agnes AI Platform console.
// Pricing (wiki.agnes-ai.com/en/docs/pricing): the Flash text/image/video models
// are currently $0; agnes-2.5-pro / agnes-2.5-pro-beta are paid.
export default {
  id: "agnesai",
  alias: "agnesai",
  aliases: [
    "agnes",
  ],
  uiAlias: "agnesai",
  hasFree: true,
  category: "freeTier",
  display: {
    name: "AgnesAI",
    icon: "auto_awesome",
    color: "#111827",
    textIcon: "AG",
    website: "https://agnes-ai.com",
    notice: {
      text: "Free Flash models ($0 text, image & video) on an OpenAI-compatible gateway. Get an API key from the Agnes AI Platform console.",
      apiKeyUrl: "https://platform.agnes-ai.com",
    },
  },
  authType: "apikey",
  authModes: [
    "apikey",
  ],
  transport: {
    baseUrl: "https://apihub.agnes-ai.com/v1/chat/completions",
    validateUrl: "https://apihub.agnes-ai.com/v1/models",
  },
  models: [
    { id: "agnes-3.0-flash", name: "Agnes 3.0 Flash (Free)", contextLength: 524288, isFree: true },
    { id: "agnes-2.5-flash", name: "Agnes 2.5 Flash (Free)", contextLength: 524288, isFree: true },
    { id: "agnes-2.5-pro", name: "Agnes 2.5 Pro", contextLength: 1048576 },
    { id: "agnes-2.5-pro-beta", name: "Agnes 2.5 Pro Beta", contextLength: 1048576 },
    { id: "agnes-image-2.5-flash", name: "Agnes Image 2.5 Flash (Free)", kind: "image", params: ["n", "size"], isFree: true },
    { id: "agnes-image-2.1-flash", name: "Agnes Image 2.1 Flash (Free)", kind: "image", params: ["n", "size"], isFree: true },
    { id: "agnes-image-2.0-flash", name: "Agnes Image 2.0 Flash (Free)", kind: "image", params: ["n", "size"], isFree: true },
    { id: "agnes-video-2.5-flash", name: "Agnes Video 2.5 Flash (Free)", kind: "video", params: ["duration", "aspect_ratio", "resolution"], isFree: true },
    { id: "agnes-video-v2.0", name: "Agnes Video V2.0 (Free)", kind: "video", params: ["duration", "aspect_ratio", "resolution"], isFree: true },
    { id: "agnes-video-2.5", name: "Agnes Video 2.5", kind: "video", params: ["duration", "aspect_ratio", "resolution"] },
  ],
  serviceKinds: ["llm", "image", "video"],
  imageConfig: {
    baseUrl: "https://apihub.agnes-ai.com/v1/images/generations",
  },
  modelsFetcher: { url: "https://apihub.agnes-ai.com/v1/models", type: "openai" },
  passthroughModels: true,
};
