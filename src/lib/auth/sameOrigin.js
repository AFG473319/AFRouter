/**
 * Same-origin / CSRF guard for requests that disclose credentials.
 *
 * `fetch` from the dashboard always attaches an `Origin` header to a POST, and
 * browsers mark the initiator in `Sec-Fetch-Site`. Rejecting anything that is not
 * the dashboard's own origin stops a cross-site page (or a form on an attacker's
 * site) from triggering a credential export with the victim's session cookie.
 * Native callers (CLI token) send no `Origin`, which stays allowed.
 */
export function isSameOriginRequest(request) {
  const headers = request?.headers;
  if (!headers?.get) return false;

  const site = (headers.get("sec-fetch-site") || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;

  let origin = headers.get("origin");
  if (!origin) return true;

  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const host = (headers.get("x-forwarded-host") || headers.get("host") || "").toLowerCase();
  return Boolean(host) && originHost === host;
}
