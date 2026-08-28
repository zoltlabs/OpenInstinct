import { describe, expect, it } from "vitest";
import { deploymentTargetSchema, requiredCli } from "../src/deployment";

describe("deployment profiles", () => {
  it("keeps the default Vercel target to two provider CLIs", () => {
    expect(requiredCli("vercel")).toEqual(["supabase", "vercel"]);
  });

  it("requires Wrangler only for the advanced Cloudflare profile", () => {
    expect(deploymentTargetSchema.parse("vercel-cloudflare")).toBe(
      "vercel-cloudflare",
    );
    expect(requiredCli("vercel-cloudflare")).toEqual([
      "supabase",
      "vercel",
      "wrangler",
    ]);
  });
});
