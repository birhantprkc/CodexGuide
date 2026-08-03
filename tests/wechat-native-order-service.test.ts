import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommunityOrder } from "../server/db.js";

const dbMocks = vi.hoisted(() => ({
  findCurrentOrder: vi.fn(),
  findOrderForBuyer: vi.fn(),
  insertPendingOrder: vi.fn(),
  markOrderClosed: vi.fn(),
  markOrderRefunded: vi.fn(),
  markWechatOrderPaid: vi.fn(),
  saveWechatNativeCode: vi.fn(),
  saveWechatRefund: vi.fn(),
}));
const payMocks = vi.hoisted(() => ({
  closeWechatOrder: vi.fn(),
  createWechatNativeOrder: vi.fn(),
  queryWechatOrder: vi.fn(),
  queryWechatRefund: vi.fn(),
  refundWechatOrder: vi.fn(),
  validatePaidTransaction: vi.fn(),
  validateWechatRefund: vi.fn(),
}));

vi.mock("../server/db.js", () => dbMocks);
vi.mock("../server/wechat-pay.js", () => payMocks);

import {
  closeBuyerWechatOrder,
  prepareWechatNativeOrder,
  queryWechatCommunityRefund,
  refundWechatCommunityOrder,
} from "../server/wechat-native-order-service.js";

const orderId = "CGMTEST00000000000000001";
const buyerKey = "e".repeat(64);
const baseOrder: CommunityOrder = {
  alipay_buyer_key: null,
  alipay_trade_no: null,
  amount_cents: 990,
  buyer_key: buyerKey,
  created_at: new Date(),
  currency: "CNY",
  id: orderId,
  paid_at: null,
  payment_product: "WECHAT_NATIVE",
  payment_provider: "WECHAT",
  prepay_expires_at: null,
  prepay_id: null,
  refund_request_no: null,
  refund_status: null,
  refunded_at: null,
  status: "PENDING",
  updated_at: new Date(),
  wechat_code_expires_at: null,
  wechat_code_url: null,
  wechat_refund_id: null,
  wechat_transaction_id: null,
};

describe("WeChat Native order state machine", () => {
  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) mock.mockReset();
    for (const mock of Object.values(payMocks)) mock.mockReset();
    dbMocks.markWechatOrderPaid.mockResolvedValue(true);
    payMocks.createWechatNativeOrder.mockResolvedValue("weixin://wxpay/bizpayurl?pr=test");
    payMocks.validatePaidTransaction.mockReturnValue("4200000000001");
  });

  it("recovers from a concurrent insert using the single active-order constraint", async () => {
    dbMocks.findCurrentOrder
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(baseOrder);
    dbMocks.insertPendingOrder.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "23505" }));

    const result = await prepareWechatNativeOrder(buyerKey);

    expect(result).toMatchObject({ eligible: false, orderId });
    expect(dbMocks.insertPendingOrder).toHaveBeenCalledTimes(1);
    expect(payMocks.createWechatNativeOrder).toHaveBeenCalledWith(orderId, expect.any(Date));
    expect(dbMocks.saveWechatNativeCode).toHaveBeenCalledWith(
      orderId,
      "weixin://wxpay/bizpayurl?pr=test",
      expect.any(Date),
    );
  });

  it("resolves a payment-versus-close race as PAID", async () => {
    dbMocks.findOrderForBuyer.mockResolvedValue(baseOrder);
    payMocks.queryWechatOrder
      .mockResolvedValueOnce({ trade_state: "USERPAYING" })
      .mockResolvedValueOnce({ trade_state: "SUCCESS" });
    payMocks.closeWechatOrder.mockRejectedValue(new Error("already paid"));

    const result = await closeBuyerWechatOrder(orderId, buyerKey);

    expect(result.status).toBe("PAID");
    expect(dbMocks.markOrderClosed).not.toHaveBeenCalled();
    expect(dbMocks.markWechatOrderPaid).toHaveBeenCalledWith(orderId, "4200000000001");
  });
});

describe("WeChat Native refund state machine", () => {
  const paidOrder: CommunityOrder = {
    ...baseOrder,
    paid_at: new Date(),
    status: "PAID",
    wechat_transaction_id: "4200000000001",
  };

  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) mock.mockReset();
    for (const mock of Object.values(payMocks)) mock.mockReset();
  });

  it("reuses WR{orderId} and keeps eligibility while refund is PROCESSING", async () => {
    payMocks.refundWechatOrder.mockResolvedValue({ status: "PROCESSING" });
    payMocks.validateWechatRefund.mockReturnValue({ refundId: "5030000000001", status: "PROCESSING" });

    const result = await refundWechatCommunityOrder(paidOrder, "用户申请退款");

    expect(result).toEqual({ refundRequestNo: `WR${orderId}`, status: "PROCESSING" });
    expect(payMocks.refundWechatOrder).toHaveBeenCalledWith(
      paidOrder,
      `WR${orderId}`,
      "用户申请退款",
    );
    expect(dbMocks.markOrderRefunded).not.toHaveBeenCalled();
  });

  it("does not revoke eligibility from the initial refund response even if it says SUCCESS", async () => {
    payMocks.refundWechatOrder.mockResolvedValue({ status: "SUCCESS" });
    payMocks.validateWechatRefund.mockReturnValue({ refundId: "5030000000001", status: "SUCCESS" });

    const result = await refundWechatCommunityOrder(paidOrder, "用户申请退款");

    expect(result.status).toBe("PROCESSING");
    expect(dbMocks.saveWechatRefund).toHaveBeenLastCalledWith(
      orderId,
      `WR${orderId}`,
      "PROCESSING",
      "5030000000001",
    );
    expect(dbMocks.markOrderRefunded).not.toHaveBeenCalled();
  });

  it("uses refund-query compensation and revokes eligibility only on SUCCESS", async () => {
    const processingOrder = {
      ...paidOrder,
      refund_request_no: `WR${orderId}`,
      refund_status: "PROCESSING" as const,
    };
    payMocks.queryWechatRefund.mockResolvedValue({ status: "SUCCESS" });
    payMocks.validateWechatRefund.mockReturnValue({ refundId: "5030000000001", status: "SUCCESS" });

    const result = await queryWechatCommunityRefund(processingOrder);

    expect(result).toEqual({ refundRequestNo: `WR${orderId}`, status: "REFUNDED" });
    expect(payMocks.queryWechatRefund).toHaveBeenCalledWith(`WR${orderId}`);
    expect(dbMocks.saveWechatRefund).toHaveBeenCalledWith(
      orderId,
      `WR${orderId}`,
      "SUCCESS",
      "5030000000001",
    );
    expect(dbMocks.markOrderRefunded).toHaveBeenCalledWith(orderId, `WR${orderId}`);
  });
});
