const api = require("../../api/client");
const { requiredId, required } = require("../args");

const HELP = `network <action> [flags]
  endpoint                             Active endpoint URLs + gates
  tunnel-on | tunnel-off               Cloudflare tunnel lifecycle
  tailscale-check | tailscale-install | tailscale-enable | tailscale-disable
  pools                                List proxy pools
  pool-add --name <n> --url <u> [--type <http|vercel|cloudflare|deno>]
  pool-edit <id> [--name <n>] [--url <u>]
  pool-test <id>                       Health-check a pool
  pool-toggle <id>                     Enable/disable a pool
  pool-del <id>                        Delete a pool
  headroom                             Headroom status
  headroom-start | headroom-stop | headroom-restart
  headroom-extras                      Headroom extras
  pxpipe                               PxPipe status
  pxpipe-stats [--period <p>]          PxPipe stats
  pxpipe-logs                          PxPipe logs
  pxpipe-start | pxpipe-stop | pxpipe-restart | pxpipe-install`;

async function run(action, pos, opts) {
  switch (action) {
    case "endpoint": {
      const [login, settings, tunnel] = await Promise.all([
        api.getRequireLogin().catch(() => ({ success: false })),
        api.getSettings(),
        api.getTunnelStatus(),
      ]);
      return {
        data: {
          login: login.success ? login.data : null,
          settings: settings.success ? settings.data : { error: settings.error },
          tunnel: tunnel.success ? tunnel.data : { error: tunnel.error },
        },
      };
    }
    case "tunnel-on": {
      const r = await api.enableTunnel();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "tunnel-off": {
      const r = await api.disableTunnel();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "tailscale-check": {
      const r = await api.getTailscaleCheck();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "tailscale-install": {
      const r = await api.installTailscale();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "tailscale-enable": {
      const r = await api.enableTailscale();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "tailscale-disable": {
      const r = await api.disableTailscale();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pools": {
      const r = await api.getProxyPools();
      if (!r.success) return { error: r.error };
      const pools = r.data.pools || r.data || [];
      return {
        data: { pools },
        table: {
          headers: ["ID", "Name", "Type", "Active"],
          rows: pools.map(p => [p.id, p.name, p.type || "http", p.isActive === false ? "no" : "yes"]),
          empty: "(no proxy pools)",
        },
      };
    }
    case "pool-add": {
      const r = await api.createProxyPool({
        name: required(opts, "name"),
        proxyUrl: required(opts, "url"),
        type: opts.type || "http",
      });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pool-edit": {
      const updates = {};
      if (opts.name) updates.name = opts.name;
      if (opts.url) updates.proxyUrl = opts.url;
      if (Object.keys(updates).length === 0) return { usage: "network pool-edit <id> needs --name and/or --url" };
      const r = await api.updateProxyPool(requiredId(pos), updates);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pool-test": {
      const r = await api.testProxyPool(requiredId(pos));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pool-toggle": {
      const cur = await api.getProxyPoolById(requiredId(pos));
      if (!cur.success) return { error: cur.error };
      const pool = cur.data.pool || cur.data;
      const r = await api.updateProxyPool(requiredId(pos), { isActive: pool.isActive === false });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pool-del": {
      const r = await api.deleteProxyPool(requiredId(pos));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "headroom": {
      const r = await api.getHeadroomStatus();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "headroom-start": {
      const r = await api.startHeadroom();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "headroom-stop": {
      const r = await api.stopHeadroom();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "headroom-restart": {
      const r = await api.restartHeadroom();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "headroom-extras": {
      const r = await api.getHeadroomExtras();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pxpipe": {
      const r = await api.getPxpipeStatus();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pxpipe-stats": {
      const r = await api.getPxpipeStats(opts.period || "7d");
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pxpipe-logs": {
      const r = await api.getPxpipeLogs();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pxpipe-start": {
      const r = await api.startPxpipe();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pxpipe-stop": {
      const r = await api.stopPxpipe();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pxpipe-restart": {
      const r = await api.restartPxpipe();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pxpipe-install": {
      const r = await api.installPxpipe();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
