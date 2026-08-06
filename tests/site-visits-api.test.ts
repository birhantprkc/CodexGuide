import { beforeEach, describe, expect, it, vi } from "vitest";

const visitMocks = vi.hoisted(() => ({
  readSiteVisitStats: vi.fn(),
  recordSiteVisit: vi.fn(),
}));

vi.mock("../server/site-visits.js", async () => {
  const actual = await vi.importActual<typeof import("../server/site-visits.js")>(
    "../server/site-visits.js",
  );
  return { ...actual, ...visitMocks };
});

import handler from "../api/site/visits.js";
import { isAutomatedVisitor, visitorHash } from "../server/site-visits.js";

const BROWSER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

const visitRequest = (init: RequestInit = {}): Request =>
  new Request("https://codexguide.ai/api/site/visits", {
    ...init,
    headers: { "user-agent": BROWSER_AGENT, ...(init.headers as Record<string, string>) },
  });

describe("homepage visit counter endpoint", () => {
  beforeEach(() => {
    visitMocks.readSiteVisitStats.mockReset();
    visitMocks.recordSiteVisit.mockReset();
    visitMocks.readSiteVisitStats.mockResolvedValue({ today: 12, total: 3456 });
    visitMocks.recordSiteVisit.mockResolvedValue({ today: 13, total: 3457 });
  });

  it("reads the counters without recording on GET", async () => {
    const response = await handler.fetch(visitRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ today: 12, total: 3456 });
    expect(visitMocks.recordSiteVisit).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("keeps the recording response private to avoid caching a write", async () => {
    const response = await handler.fetch(
      visitRequest({ method: "POST", headers: { origin: "https://codexguide.ai" } }),
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("records a visit for a same-origin browser request", async () => {
    const response = await handler.fetch(
      visitRequest({ method: "POST", headers: { origin: "https://codexguide.ai" } }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ today: 13, total: 3457 });
    expect(visitMocks.recordSiteVisit).toHaveBeenCalledWith(
      visitorHash("unknown", BROWSER_AGENT),
    );
  });

  it("rejects cross-origin writes", async () => {
    const response = await handler.fetch(
      visitRequest({ method: "POST", headers: { origin: "https://evil.example.com" } }),
    );

    expect(response.status).toBe(403);
    expect(visitMocks.recordSiteVisit).not.toHaveBeenCalled();
  });

  it("does not count crawler traffic", async () => {
    const response = await handler.fetch(
      visitRequest({
        method: "POST",
        headers: { origin: "https://codexguide.ai", "user-agent": "Googlebot/2.1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ today: 12, total: 3456 });
    expect(visitMocks.recordSiteVisit).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods", async () => {
    const response = await handler.fetch(visitRequest({ method: "DELETE" }));

    expect(response.status).toBe(405);
  });
});

describe("visitor fingerprinting", () => {
  it("keeps the digest stable per visitor and separate across visitors", () => {
    const first = visitorHash("203.0.113.7", BROWSER_AGENT);

    expect(first).toHaveLength(64);
    expect(first).toBe(visitorHash("203.0.113.7", BROWSER_AGENT));
    expect(first).not.toBe(visitorHash("203.0.113.8", BROWSER_AGENT));
    expect(first).not.toContain("203.0.113.7");
  });

  it("flags crawlers and empty user agents", () => {
    expect(isAutomatedVisitor(BROWSER_AGENT)).toBe(false);
    expect(isAutomatedVisitor("")).toBe(true);
    expect(isAutomatedVisitor("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
    expect(isAutomatedVisitor("curl/8.7.1")).toBe(true);
  });
});
