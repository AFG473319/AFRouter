const api = require("../../api/client");
const { requiredId } = require("../args");

const HELP = `usage <action> [flags]
  stats [--period <today|24h|7d|30d|60d|all>]   Aggregated stats (default 7d)
  chart [--period <p>]               Time-series data
  logs                               Latest request logs
  requests [--provider <p>] [--model <m>] [--status <s>] [--page <n>] [--page-size <n>]
  history                            Usage history
  providers                          Providers with recorded usage
  connection <id>                    Per-connection usage`;

function periodOf(opts) {
  return opts.period || "7d";
}

async function run(action, pos, opts) {
  switch (action) {
    case "stats": {
      const r = await api.getUsageStats(periodOf(opts));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "chart": {
      const r = await api.getUsageChart(periodOf(opts));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "logs": {
      const r = await api.getRequestLogs();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "requests": {
      const q = [`page=${opts.page || 1}`, `pageSize=${opts["page-size"] || opts.pageSize || 20}`];
      if (opts.provider) q.push(`provider=${encodeURIComponent(opts.provider)}`);
      if (opts.model) q.push(`model=${encodeURIComponent(opts.model)}`);
      if (opts.status) q.push(`status=${encodeURIComponent(opts.status)}`);
      const r = await api.getRequestDetails(q.join("&"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "history": {
      const r = await api.getUsageHistory();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "providers": {
      const r = await api.getUsageProviders();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "connection": {
      const r = await api.getConnectionUsage(requiredId(pos));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
