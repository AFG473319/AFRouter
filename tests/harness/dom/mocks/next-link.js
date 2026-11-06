import { createElement, forwardRef } from "react";
import { harness } from "../state.js";

const Link = forwardRef(function Link({ href, children, prefetch: _p, replace, scroll: _s, shallow: _sh, legacyBehavior: _l, passHref: _ph, onClick, ...rest }, ref) {
  const url = typeof href === "string" ? href : `${href?.pathname || ""}${href?.search || ""}`;
  return createElement("a", {
    ...rest, ref, href: url,
    onClick: (e) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      e.preventDefault();
      harness.navigate(url, replace ? "replace" : "push");
    },
  }, children);
});
export default Link;
