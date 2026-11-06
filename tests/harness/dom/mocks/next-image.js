import { createElement, forwardRef } from "react";

const Image = forwardRef(function Image({ src, alt = "", fill: _f, priority: _p, quality: _q, placeholder: _ph, blurDataURL: _b, loader: _l, unoptimized: _u, ...rest }, ref) {
  return createElement("img", { ...rest, ref, alt, src: typeof src === "object" ? src?.src : src });
});
export default Image;
