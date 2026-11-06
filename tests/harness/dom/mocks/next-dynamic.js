import { createElement, lazy, Suspense } from "react";

export default function dynamic(loader, opts = {}) {
  const Lazy = lazy(async () => {
    const mod = await loader();
    return { default: mod?.default || mod };
  });
  return function DynamicComponent(props) {
    return createElement(Suspense, { fallback: opts.loading ? createElement(opts.loading) : null }, createElement(Lazy, props));
  };
}
