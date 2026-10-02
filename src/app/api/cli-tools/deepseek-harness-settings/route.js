// DeepSeek Harness CLI / `dsh web` — the `web` Cordis profile.
//
// Live config is the profile's own `$DSH_HOME/profiles/web/cordis.patch.yml`
// (NOT `settings.yaml`, which dsh imports once and then ignores). Shared logic
// lives in @/lib/dshSettingsRoute.js.
import { createDshSettingsHandlers } from "@/lib/dshSettingsRoute.js";
import { WEB_PROFILE } from "@/lib/dshProfilePatch.js";

const { GET, POST, DELETE } = createDshSettingsHandlers({
  profile: WEB_PROFILE,
  settingsUrl: "/api/cli-tools/deepseek-harness-settings",
});

export { GET, POST, DELETE };
