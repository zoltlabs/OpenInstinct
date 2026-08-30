import { describe, expect, it } from "vitest";
import { config } from "../proxy";

describe("web proxy boundaries", () => {
  it("keeps service probes and unauthenticated ingestion outside session refresh", () => {
    expect(config.matcher[0]).toContain("api/health");
    expect(config.matcher[0]).toContain("api/webhooks/blooio");
    expect(config.matcher[0]).toContain("api/internal/consume");
  });
});
