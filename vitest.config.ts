import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the TypeScript source, not a stale dist/.
      "@homelab/shared": fileURLToPath(new URL("packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
