import { describe, expect, it } from "vitest";
import { supabaseSchedulerConfigSchema } from "../src/scheduler";

describe("Supabase scheduler configuration", () => {
  it("accepts only HTTPS endpoints and strong bearer secrets", () => {
    expect(
      supabaseSchedulerConfigSchema.safeParse({
        consumerUrl: "https://openinstinct.example/api/internal/consume",
        internalApiSecret: "a".repeat(32),
      }).success,
    ).toBe(true);
    expect(
      supabaseSchedulerConfigSchema.safeParse({
        consumerUrl: "http://openinstinct.example/api/internal/consume",
        internalApiSecret: "short",
      }).success,
    ).toBe(false);
  });
});
