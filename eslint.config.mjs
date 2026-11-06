import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Benchmark build output (NEXT_DIST_DIR for scripts/bench):
    ".next-bench/**",
    // Agent harness: isolated dev build and run artifacts (scripts/agent):
    ".next-agent/**",
    ".agent/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
