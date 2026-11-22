import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "glyphq-analytics",
    compatibilityDate: "2026-11-22",
    entrypoint,
    domains: ["analytics.glyphq.org"],
    env: {
      DOWNLOAD_COUNTER: bindings.durableObject({
        worker: "glyphq-analytics",
        exportName: "DownloadCounter",
      }),
    },
    exports: {
      DownloadCounter: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
