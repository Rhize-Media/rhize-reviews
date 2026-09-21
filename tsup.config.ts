import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", "next/index": "src/next/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: ["@vercel/blob", "@vercel/oidc"],
})
