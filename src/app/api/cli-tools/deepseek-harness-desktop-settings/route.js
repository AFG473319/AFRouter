// DeepSeek Harness Desktop App — the `desktop` Cordis profile.
//
// The Desktop app and `dsh web` are separate Cordis profiles with separate
// config files, so this route writes `$DSH_HOME/profiles/desktop/cordis.patch.yml`
// and never touches the web profile's patch. Credentials are shared
// (`$DSH_HOME/.credentials.yaml`). Shared logic in @/lib/dshSettingsRoute.js.
import { createDshSettingsHandlers } from "@/lib/dshSettingsRoute.js";
import { DESKTOP_PROFILE } from "@/lib/dshProfilePatch.js";

const { GET, POST, DELETE } = createDshSettingsHandlers({
  profile: DESKTOP_PROFILE,
  settingsUrl: "/api/cli-tools/deepseek-harness-desktop-settings",
});

export { GET, POST, DELETE };
