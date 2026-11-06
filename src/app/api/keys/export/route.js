import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { canAccessCredentialExport } from "@/dashboardGuard";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";
import {
  EXPORT_FORMATS,
  parseExportIds,
  selectKeysForExport,
  serializeExport,
  toExportRecords,
} from "@/lib/keys/exportFile";

export const dynamic = "force-dynamic";

// A plaintext export is a full credential dump, so cap how often one process will
// produce one. Best-effort per process — it raises the cost of walking away with
// every key from a stolen session, it is not a substitute for the auth gate.
const EXPORT_WINDOW_MS = 60_000;
const MAX_EXPORTS_PER_WINDOW = 10;
let windowStart = 0;
let windowCount = 0;

function isRateLimited(now) {
  if (now - windowStart > EXPORT_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount += 1;
  return windowCount > MAX_EXPORTS_PER_WINDOW;
}

function noStore(payload, status = 200, headers = {}) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      ...headers,
    },
  });
}

function requireDetails() {
  return { message: "Export requires an authenticated dashboard session" };
}

// POST /api/keys/export - download API keys as JSON or CSV.
// POST (not GET) keeps key material out of URLs, browser history and server logs.
// Body: { ids?: string[], format?: "json" | "csv" } — ids omitted means all keys.
export async function POST(request) {
  // 1. Authentication. A valid dashboard session or CLI token is required; the
  //    `requireLogin=false` convenience bypass only counts from loopback, so a
  //    tunnel/LAN visitor can never dump keys even when the dashboard is open.
  if (!(await canAccessCredentialExport(request))) {
    return noStore(requireDetails(), 403);
  }

  // 2. CSRF. Only the dashboard's own origin may start a download.
  if (!isSameOriginRequest(request)) {
    return noStore({ error: "Cross-origin export requests are rejected" }, 403);
  }

  // 3. Throttle repeated dumps.
  if (isRateLimited(Date.now())) {
    return noStore({ error: "Too many export requests. Try again shortly." }, 429, {
      "Retry-After": "60",
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return noStore({ error: "Invalid JSON body" }, 400);
  }

  const format = body?.format ?? "json";
  if (!EXPORT_FORMATS.includes(format)) {
    return noStore({ error: "format must be json or csv" }, 400);
  }

  let ids;
  try {
    ids = parseExportIds(body?.ids);
  } catch (error) {
    return noStore({ error: error.message }, 400);
  }

  let allKeys;
  try {
    allKeys = await getApiKeys();
  } catch (error) {
    console.log("Error exporting keys:", error);
    return noStore({ error: "Failed to export keys" }, 500);
  }

  const keys = selectKeysForExport(allKeys, ids);
  if (ids && keys.length === 0) {
    return noStore({ error: "No matching API keys found" }, 404);
  }
  const records = toExportRecords(keys);
  const { body: fileBody, contentType, filename } = serializeExport(records, format);

  // Audit trail: scope and count only — key material is never logged.
  console.log(
    `[keys-export] exported ${records.length} key(s) as ${format} (${ids ? "selected" : "all"})`
  );

  return new NextResponse(fileBody, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}
