// DOM lane for the agent harness: client components rendered in happy-dom with Testing
// Library, no browser. Separate from tests/vitest.config.js (node env) so DOM setup never
// slows the main suite. Used by `npm run agent -- render|flow|test --dom` and *.dom.test.js.
import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "../..");
const mock = (name) => resolve(here, "dom/mocks", name);

export default defineConfig({
  // Root at the repo so src/ is inside it: runtime dynamic imports of app files resolve.
  root: repo,
  server: { fs: { allow: [repo] } },
  // src/ keeps JSX in .js files; tell the transformer so.
  oxc: { include: /\.(js|jsx|mjs)$/, exclude: /node_modules/, lang: "jsx", jsx: { runtime: "automatic" } },
  test: {
    environment: "happy-dom",
    globals: true,
    environmentOptions: { happyDOM: { url: process.env.AFR_HARNESS_URL || "http://127.0.0.1:3000/dashboard" } },
    include: process.env.AFR_HARNESS_JOB ? ["tests/harness/dom/runner.harness.js"] : ["tests/**/*.dom.test.js"],
    exclude: ["**/node_modules/**", "**/.claude/**", ".next*/**", ".agent/**"],
    setupFiles: [resolve(here, "dom/setup.js")],
    css: false,
    pool: "forks",
    maxWorkers: 2,
    testTimeout: Number(process.env.AFR_HARNESS_TIMEOUT_MS || 60_000),
    // Inline Testing Library so its react/react-dom imports go through the aliases below.
    server: { deps: { inline: [/src\//, /open-sse\//, /@testing-library\/react/] } },
  },
  resolve: {
    alias: [
      // One React: tests/ has its own copy (Testing Library peer); the app uses the root one.
      { find: /^react$/, replacement: resolve(repo, "node_modules/react") },
      { find: /^react\/(.*)$/, replacement: resolve(repo, "node_modules/react") + "/$1" },
      { find: /^react-dom$/, replacement: resolve(repo, "node_modules/react-dom") },
      { find: /^react-dom\/(.*)$/, replacement: resolve(repo, "node_modules/react-dom") + "/$1" },
      { find: /^next\/navigation$/, replacement: mock("next-navigation.js") },
      { find: /^next\/link$/, replacement: mock("next-link.js") },
      { find: /^next\/image$/, replacement: mock("next-image.js") },
      { find: /^next\/dynamic$/, replacement: mock("next-dynamic.js") },
      { find: /^next\/font\/google$/, replacement: mock("next-font.js") },
      { find: /^next\/headers$/, replacement: mock("next-headers.js") },
      { find: /^open-sse\//, replacement: resolve(repo, "open-sse") + "/" },
      { find: "open-sse", replacement: resolve(repo, "open-sse") },
      { find: /^@\//, replacement: resolve(repo, "src") + "/" },
    ],
  },
});
