import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ findOrderById: vi.fn() }));
const alipayMocks = vi.hoisted(() => ({
  queryAlipayCommunityRefund: vi.fn(),
  refundAlipayCommunityOrder: vi.fn(),
}));
const wechatMocks = vi.hoisted(() => ({
  queryWechatCommunityRefund: vi.fn(),
  refundWechatCommunityOrder: vi.fn(),
}));

vi.mock("../server/db.js", () => dbMocks);
vi.mock("../server/alipay-order-service.js", () => alipayMocks);
vi.mock("../server/wechat-native-order-service.js", () => wechatMocks);

import ordersHandler from "../api/admin/orders.js";
import refundsHandler from "../api/admin/refunds.js";
import { adminSessionCookie } from "../server/session.js";

const orderId = "CGMTEST00000000000000001";
const adminCookie = (): string => adminSessionCookie().split(";")[0];
const paidOrder = (provider: "ALIPAY" | "WECHAT") => ({
  amount_cents: 990,
  buyer_key: "secret-buyer-key",
  created_at: new Date("2027-01-15T08:00:00.000Z"),
  id: orderId,
  paid_at: new Date("2027-01-15T08:01:00.000Z"),
  payment_product: provider === "WECHAT" ? "WECHAT_NATIVE" : "ALIPAY_WEB",
  payment_provider: provider,
  refund_status: null,
  refunded_at: null,
  status: "PAID",
});

describe("community admin order and refund endpoints", () => {
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = "admin-secret".repeat(4);
    dbMocks.findOrderById.mockReset();
    for (const mock of Object.values(alipayMocks)) mock.mockReset();
    for (const mock of Object.values(wechatMocks)) mock.mockReset();
  });

  it("requires an administrator session before looking up orders", async () => {
    const response = await ordersHandler.fetch(
      new Request(`https://codexguide.ai/api/admin/orders?id=${orderId}`),
    );
    expect(response.status).toBe(401);
    expect(dbMocks.findOrderById).not.toHaveBeenCalled();
  });

  it("returns safe exact-order fields without exposing the buyer key", async () => {
    dbMocks.findOrderById.mockResolvedValue(paidOrder("WECHAT"));
    const response = await ordersHandler.fetch(
      new Request(`https://codexguide.ai/api/admin/orders?id=${orderId}`, {
        headers: { Cookie: adminCookie() },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(dbMocks.findOrderById).toHaveBeenCalledWith(orderId);
    expect(body).toMatchObject({ orderId, paymentProvider: "WECHAT", status: "PAID" });
    expect(body.buyerKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret-buyer-key");
  });

  it.each(["ALIPAY", "WECHAT"] as const)(
    "dispatches a %s refund through the matching provider",
    async (provider) => {
      dbMocks.findOrderById.mockResolvedValue(paidOrder(provider));
      const target = provider === "WECHAT"
        ? wechatMocks.refundWechatCommunityOrder
        : alipayMocks.refundAlipayCommunityOrder;
      target.mockResolvedValue({ refundRequestNo: `R${orderId}`, status: "PROCESSING" });
      const response = await refundsHandler.fetch(
        new Request("https://codexguide.ai/api/admin/refunds", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie(),
            Origin: "https://codexguide.ai",
          },
          body: JSON.stringify({ orderId, reason: "用户申请退款" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(target).toHaveBeenCalledWith(expect.objectContaining({ id: orderId }), "用户申请退款");
    },
  );

  it("keeps WeChat refund-query compensation available while new payments are disabled", async () => {
    process.env.COMMUNITY_PAYMENT_ENABLED = "false";
    process.env.WECHAT_NATIVE_PAYMENT_ENABLED = "false";
    dbMocks.findOrderById.mockResolvedValue(paidOrder("WECHAT"));
    wechatMocks.queryWechatCommunityRefund.mockResolvedValue({
      refundRequestNo: `WR${orderId}`,
      status: "REFUNDED",
    });
    const response = await refundsHandler.fetch(
      new Request(`https://codexguide.ai/api/admin/refunds?id=${orderId}`, {
        headers: { Cookie: adminCookie() },
      }),
    );
    expect(response.status).toBe(200);
    expect(wechatMocks.queryWechatCommunityRefund).toHaveBeenCalled();
  });
});
