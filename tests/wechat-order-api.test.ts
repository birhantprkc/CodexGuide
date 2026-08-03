import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinatorMocks = vi.hoisted(() => ({
  closeConflictingPendingOrder: vi.fn(),
}));
const serviceMocks = vi.hoisted(() => ({
  closeBuyerWechatOrder: vi.fn(),
  getWechatBuyerOrderStatus: vi.fn(),
  prepareWechatNativeOrder: vi.fn(),
}));

vi.mock("../server/community-order-coordinator.js", () => coordinatorMocks);
vi.mock("../server/wechat-native-order-service.js", () => serviceMocks);

import handler from "../api/wechat-pay/order.js";
import { paidCommunitySessionCookie } from "../server/session.js";

const buyerKey = "d".repeat(64);
const orderId = "CGMTEST00000000000000001";
const request = (method: string, query = ""): Request =>
  new Request(`https://codexguide.ai/api/wechat-pay/order${query}`, {
    method,
    headers: {
      Cookie: paidCommunitySessionCookie(buyerKey).split(";")[0],
      Origin: "https://codexguide.ai",
    },
  });

describe("WeChat Native order endpoint", () => {
  beforeEach(() => {
    process.env.COMMUNITY_SESSION_SECRET = "session-secret".repeat(4);
    process.env.COMMUNITY_SITE_URL = "https://codexguide.ai";
    process.env.COMMUNITY_PAYMENT_ENABLED = "true";
    process.env.WECHAT_NATIVE_PAYMENT_ENABLED = "true";
    coordinatorMocks.closeConflictingPendingOrder.mockReset();
    coordinatorMocks.closeConflictingPendingOrder.mockResolvedValue(null);
    serviceMocks.closeBuyerWechatOrder.mockReset();
    serviceMocks.getWechatBuyerOrderStatus.mockReset();
    serviceMocks.prepareWechatNativeOrder.mockReset();
    serviceMocks.prepareWechatNativeOrder.mockResolvedValue({
      codeUrl: "weixin://wxpay/bizpayurl?pr=test",
      eligible: false,
      expiresAt: "2027-01-15T08:10:00.000Z",
      orderId,
    });
  });

  it("creates an order only when both rollout switches are enabled", async () => {
    const response = await handler.fetch(request("POST"));
    expect(response.status).toBe(200);
    expect(coordinatorMocks.closeConflictingPendingOrder).toHaveBeenCalledWith(
      buyerKey,
      "WECHAT_NATIVE",
    );
    expect(serviceMocks.prepareWechatNativeOrder).toHaveBeenCalledWith(buyerKey);
    await expect(response.json()).resolves.toMatchObject({ orderId, eligible: false });
  });

  it("blocks only new order creation when Native is disabled", async () => {
    process.env.WECHAT_NATIVE_PAYMENT_ENABLED = "false";
    const response = await handler.fetch(request("POST"));
    expect(response.status).toBe(503);
    expect(serviceMocks.prepareWechatNativeOrder).not.toHaveBeenCalled();
  });

  it("keeps local and reconciled status queries available when creation is disabled", async () => {
    process.env.COMMUNITY_PAYMENT_ENABLED = "false";
    serviceMocks.getWechatBuyerOrderStatus.mockResolvedValue({ id: orderId, status: "PAID" });
    const response = await handler.fetch(request("GET", `?id=${orderId}&reconcile=1`));
    expect(response.status).toBe(200);
    expect(serviceMocks.getWechatBuyerOrderStatus).toHaveBeenCalledWith(orderId, buyerKey, true);
    await expect(response.json()).resolves.toEqual({ eligible: true, orderId, status: "PAID" });
  });

  it("checks WeChat before closing a buyer-owned pending order", async () => {
    process.env.WECHAT_NATIVE_PAYMENT_ENABLED = "false";
    serviceMocks.closeBuyerWechatOrder.mockResolvedValue({ id: orderId, status: "CLOSED" });
    const response = await handler.fetch(request("DELETE", `?id=${orderId}`));
    expect(response.status).toBe(200);
    expect(serviceMocks.closeBuyerWechatOrder).toHaveBeenCalledWith(orderId, buyerKey);
  });

  it("does not create another order when a paid cross-channel order exists", async () => {
    coordinatorMocks.closeConflictingPendingOrder.mockResolvedValue({
      id: "CGALIPAY0000000000000001",
      status: "PAID",
    });
    const response = await handler.fetch(request("POST"));
    expect(response.status).toBe(200);
    expect(serviceMocks.prepareWechatNativeOrder).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ eligible: true });
  });
});
