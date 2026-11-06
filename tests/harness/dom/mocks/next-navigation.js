// next/navigation for happy-dom renders. Navigation is recorded, not performed, so flows can
// assert where the app tried to go (expectUrl) without a Next runtime.
import { harness } from "../state.js";

const router = {
  push: (href) => harness.navigate(href, "push"),
  replace: (href) => harness.navigate(href, "replace"),
  back: () => harness.navigate("(back)", "back"),
  forward: () => harness.navigate("(forward)", "forward"),
  refresh: () => harness.navigate(harness.pathname, "refresh"),
  prefetch: () => {},
};

export const useRouter = () => router;
export const usePathname = () => harness.pathname;
export const useSearchParams = () => new URLSearchParams(harness.search);
export const useParams = () => harness.params;
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export function notFound() {
  const e = new Error("NEXT_NOT_FOUND");
  e.digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  throw e;
}
export function redirect(href) {
  harness.navigate(href, "redirect");
  const e = new Error(`NEXT_REDIRECT ${href}`);
  e.digest = "NEXT_REDIRECT";
  throw e;
}
export const permanentRedirect = redirect;
export const RedirectType = { push: "push", replace: "replace" };
