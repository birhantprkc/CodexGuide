import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ findCurrentOrder: vi.fn() }));
const alipayMocks = vi.hoisted(() => ({ closeBuyerAlipayOrder: vi.fn() }));
const wechatMocks = vi.hoisted(() => ({ closeBuyerWechatOrder: vi.fn() }));

vi.mock("../server/db.js", () => dbMocks);
vi.mock("../server/alipay-order-service.js", () => alipayMocks);
vi.mock("../server/wechat-native-order-service.js", () => wechatMocks);

import { closeConflictingPendingOrder } from "../server/community-order-coordinator.js";

const buyerKey = "f".repeat(64);

describe("cross-provider order coordination", () => {
  beforeEach(() => {
    dbMocks.findCurrentOrder.mockReset();
    alipayMocks.closeBuyerAlipayOrder.mockReset();
    wechatMocks.closeBuyerWechatOrder.mockReset();
  });

  it("closes an Alipay pending order before switching to WeChat Native", async () => {
    const current = {
      id: "CGALIPAY0000000000000001",
      payment_product: "ALIPAY_WEB",
      payment_provider: "ALIPAY",
      status: "PENDING",
    };
    dbMocks.findCurrentOrder.mockResolvedValue(current);
    alipayMocks.closeBuyerAlipayOrder.mockResolvedValue({ ...current, status: "CLOSED" });

    await closeConflictingPendingOrder(buyerKey, "WECHAT_NATIVE");

    expect(alipayMocks.closeBuyerAlipayOrder).toHaveBeenCalledWith(current.id, buyerKey);
    expect(wechatMocks.closeBuyerWechatOrder).not.toHaveBeenCalled();
  });

  it("closes a WeChat pending order before switching to Alipay", async () => {
    const current = {
      id: "CGWECHAT0000000000000001",
      payment_product: "WECHAT_NATIVE",
      payment_provider: "WECHAT",
      status: "PENDING",
    };
    dbMocks.findCurrentOrder.mockResolvedValue(current);
    wechatMocks.closeBuyerWechatOrder.mockResolvedValue({ ...current, status: "CLOSED" });

    await closeConflictingPendingOrder(buyerKey, "ALIPAY_WEB");

    expect(wechatMocks.closeBuyerWechatOrder).toHaveBeenCalledWith(current.id, buyerKey);
    expect(alipayMocks.closeBuyerAlipayOrder).not.toHaveBeenCalled();
  });

  it.each([
    {
      current: { payment_product: "WECHAT_NATIVE", payment_provider: "WECHAT", status: "PENDING" },
      target: "WECHAT_NATIVE",
    },
    {
      current: { payment_product: "ALIPAY_WEB", payment_provider: "ALIPAY", status: "PAID" },
      target: "WECHAT_NATIVE",
    },
  ] as const)("does not close a same-product or paid order", async ({ current, target }) => {
    dbMocks.findCurrentOrder.mockResolvedValue({ id: "CGCURRENT0000000000000001", ...current });
    await closeConflictingPendingOrder(buyerKey, target);
    expect(alipayMocks.closeBuyerAlipayOrder).not.toHaveBeenCalled();
    expect(wechatMocks.closeBuyerWechatOrder).not.toHaveBeenCalled();
  });
});
