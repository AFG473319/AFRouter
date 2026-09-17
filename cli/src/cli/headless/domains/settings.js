const fs = require("fs");
const api = require("../../api/client");
const { required, jsonOrString } = require("../args");

const HELP = `settings <action> [flags]
  get                                  Safe settings dump (secrets stripped)
  set --key <k> --value <v>            Set one key (value parsed as JSON, fallback string)
  patch --json <json>                  PATCH arbitrary settings object
  password --current <c> --new <n>     Change dashboard password
  password-reset                       Reset password to default
  authmode-password                    Force authMode=password (OIDC lockout recovery)
  require-login                        Show login gate state
  require-login-on | require-login-off  Toggle login gate
  proxy-test --url <u>                 Test outbound proxy URL
  db-export --file <f>                 Export database backup to file
  db-import --file <f>                 Restore database from file
  version                              Version + update info
  update                               Trigger server-side update
  shutdown                             Graceful server shutdown`;

async function run(action, pos, opts) {
  switch (action) {
    case "get": {
      const r = await api.getSettings();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "set": {
      const key = required(opts, "key");
      if (opts.value === undefined || opts.value === true) return { usage: "settings set needs --key and --value" };
      const r = await api.updateSettings({ [key]: jsonOrString(opts.value) });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "patch": {
      let body;
      try {
        body = JSON.parse(required(opts, "json"));
      } catch {
        return { usage: "--json must be a valid JSON object" };
      }
      if (!body || Array.isArray(body) || typeof body !== "object") return { usage: "--json must be a valid JSON object" };
      const r = await api.updateSettings(body);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "password": {
      const r = await api.updateSettings({
        currentPassword: required(opts, "current"),
        newPassword: required(opts, "new"),
      });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "password-reset": {
      const r = await api.resetPassword();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "authmode-password": {
      const r = await api.updateSettings({ authMode: "password" });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "require-login": {
      const r = await api.getRequireLogin();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "require-login-on":
    case "require-login-off": {
      const r = await api.updateSettings({ requireLogin: action === "require-login-on" });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "proxy-test": {
      const r = await api.testProxy(required(opts, "url"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "db-export": {
      const file = required(opts, "file");
      const r = await api.exportDatabase();
      if (!r.success) return { error: r.error };
      try {
        fs.writeFileSync(file, JSON.stringify(r.data, null, 2));
      } catch (err) {
        return { error: `Write failed: ${err.message}` };
      }
      return { data: { file, ok: true } };
    }
    case "db-import": {
      const file = required(opts, "file");
      let payload;
      try {
        payload = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (err) {
        return { error: `Read failed: ${err.message}` };
      }
      const r = await api.importDatabase(payload);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "version": {
      const r = await api.getVersion();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "update": {
      const r = await api.triggerVersionUpdate();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "shutdown": {
      const r = await api.shutdownServer();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
