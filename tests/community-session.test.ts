import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ findCurrentOrder: vi.fn() }));
vi.mock("../server/db.js", () => dbMocks);

import handler from "../api/auth/community/session.js";
import {
  alipaySessionCookie,
  communitySessionCookie,
  paidCommunitySessionCookie,
  readPaidCommunitySession,
} from "../server/session.js";

const cookieValue = (setCookie: string): string => setCookie.split(";")[0];

describe("provider-neutral paid community session", () => {
  beforeEach(() => {
    process.env.COMMUNITY_SESSION_SECRET = "session-secret".repeat(4);
    process.env.COMMUNITY_BUYER_HMAC_SECRET = "buyer-secret".repeat(4);
    dbMocks.findCurrentOrder.mockReset();
  });

  it("reuses an existing Alipay buyer key", async () => {
    const buyerKey = "a".repeat(64);
    const response = await handler.fetch(
      new Request("https://codexguide.ai/api/auth/community/session", {
        headers: { Cookie: cookieValue(alipaySessionCookie(buyerKey)) },
      }),
    );
    const request = new Request("https://codexguide.ai", {
      headers: { Cookie: cookieValue(response.headers.get("set-cookie") || "") },
    });

    expect(response.status).toBe(200);
    expect(readPaidCommunitySession(request)?.buyerKey).toBe(buyerKey);
  });

  it("reuses a historical WeChat buyer key", async () => {
    const buyerKey = "b".repeat(64);
    const response = await handler.fetch(
      new Request("https://codexguide.ai/api/auth/community/session", {
        headers: { Cookie: cookieValue(communitySessionCookie("openid", buyerKey)) },
      }),
    );
    const request = new Request("https://codexguide.ai", {
      headers: { Cookie: cookieValue(response.headers.get("set-cookie") || "") },
    });

    expect(readPaidCommunitySession(request)?.buyerKey).toBe(buyerKey);
  });

  it("selects the paid legacy identity when both old provider cookies exist", async () => {
    const alipayKey = "a".repeat(64);
    const wechatKey = "b".repeat(64);
    dbMocks.findCurrentOrder.mockImplementation(async (buyerKey: string) =>
      buyerKey === wechatKey ? { status: "PAID" } : { status: "PENDING" },
    );
    const response = await handler.fetch(
      new Request("https://codexguide.ai/api/auth/community/session", {
        headers: {
          Cookie: [
            cookieValue(alipaySessionCookie(alipayKey)),
            cookieValue(communitySessionCookie("openid", wechatKey)),
          ].join("; "),
        },
      }),
    );
    const request = new Request("https://codexguide.ai", {
      headers: { Cookie: cookieValue(response.headers.get("set-cookie") || "") },
    });
    expect(readPaidCommunitySession(request)?.buyerKey).toBe(wechatKey);
  });

  it("keeps an existing generic session and rejects a tampered one", async () => {
    const buyerKey = "c".repeat(64);
    const original = cookieValue(paidCommunitySessionCookie(buyerKey));
    const response = await handler.fetch(
      new Request("https://codexguide.ai/api/auth/community/session", {
        headers: { Cookie: original },
      }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();

    const [name, value] = original.split("=");
    const tampered = `${name}=x${value.slice(1)}`;
    const tamperedResponse = await handler.fetch(
      new Request("https://codexguide.ai/api/auth/community/session", {
        headers: { Cookie: tampered },
      }),
    );
    expect(tamperedResponse.status).toBe(200);
    expect(tamperedResponse.headers.get("set-cookie")).toContain("codexguide_paid_community=");
  });
});
