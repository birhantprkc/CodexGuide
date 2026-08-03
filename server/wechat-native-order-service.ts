import { randomBytes } from "node:crypto";

import {
  findCurrentOrder,
  findOrderForBuyer,
  insertPendingOrder,
  markOrderClosed,
  markOrderRefunded,
  markWechatOrderPaid,
  saveWechatNativeCode,
  saveWechatRefund,
  type CommunityOrder,
  type RefundStatus,
} from "./db.js";
import { AppError } from "./errors.js";
import { COMMUNITY_PRICE_CENTS } from "./payment-constants.js";
import {
  closeWechatOrder,
  createWechatNativeOrder,
  queryWechatOrder,
  queryWechatRefund,
  refundWechatOrder,
  validatePaidTransaction,
  validateWechatRefund,
} from "./wechat-pay.js";

const ORDER_LIFETIME_MS = 10 * 60 * 1000;
const dateValue = (value: string | Date | null): number => (value ? new Date(value).getTime() : 0);
const createOrderId = (): string =>
  `CG${Date.now().toString(36)}${randomBytes(8).toString("hex")}`.toUpperCase();
const orderExpiry = (order: CommunityOrder): Date =>
  new Date(dateValue(order.created_at) + ORDER_LIFETIME_MS);
const hasUsableCode = (order: CommunityOrder): order is CommunityOrder & { wechat_code_url: string } =>
  Boolean(order.wechat_code_url) && dateValue(order.wechat_code_expires_at) > Date.now() + 15_000;

export type PreparedWechatNativeOrder =
  | { eligible: true; orderId: string }
  | { codeUrl: string; eligible: false; expiresAt: string; orderId: string };

export const reconcilePendingWechatOrder = async (
  order: CommunityOrder,
): Promise<CommunityOrder> => {
  if (
    order.payment_provider !== "WECHAT" ||
    order.payment_product !== "WECHAT_NATIVE" ||
    order.status !== "PENDING"
  ) {
    return order;
  }

  const transaction = await queryWechatOrder(order.id);
  if (transaction.trade_state === "SUCCESS") {
    const transactionId = validatePaidTransaction(transaction, order);
    if (!(await markWechatOrderPaid(order.id, transactionId))) {
      throw new AppError(409, "payment_state_conflict", "订单支付状态发生冲突，请联系支持。" );
    }
    return { ...order, status: "PAID", wechat_transaction_id: transactionId };
  }

  if (["CLOSED", "PAYERROR", "REVOKED"].includes(transaction.trade_state || "")) {
    await markOrderClosed(order.id);
    return { ...order, status: "CLOSED" };
  }
  return order;
};

export const prepareWechatNativeOrder = async (
  buyerKey: string,
): Promise<PreparedWechatNativeOrder> => {
  let current = await findCurrentOrder(buyerKey);
  if (current?.status === "PAID") return { eligible: true, orderId: current.id };
  if (
    current?.status === "PENDING" &&
    (current.payment_provider !== "WECHAT" || current.payment_product !== "WECHAT_NATIVE")
  ) {
    throw new AppError(409, "payment_method_conflict", "已有另一支付方式的待支付订单，请刷新后切换。" );
  }

  if (current?.status === "PENDING" && hasUsableCode(current)) {
    return {
      codeUrl: current.wechat_code_url,
      eligible: false,
      expiresAt: new Date(current.wechat_code_expires_at!).toISOString(),
      orderId: current.id,
    };
  }

  if (current?.status === "PENDING" && orderExpiry(current).getTime() <= Date.now()) {
    current = await reconcilePendingWechatOrder(current);
    if (current.status === "PAID") return { eligible: true, orderId: current.id };
    if (current.status === "PENDING") {
      await closeWechatOrder(current.id);
      await markOrderClosed(current.id);
      current = null;
    }
  }

  if (!current || current.status !== "PENDING") {
    try {
      current = await insertPendingOrder(
        createOrderId(),
        buyerKey,
        COMMUNITY_PRICE_CENTS,
        "WECHAT",
        "WECHAT_NATIVE",
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      current = await findCurrentOrder(buyerKey);
      if (!current) throw error;
      if (current.status === "PAID") return { eligible: true, orderId: current.id };
      if (current.payment_product !== "WECHAT_NATIVE") {
        throw new AppError(409, "payment_method_conflict", "已有另一支付方式的待支付订单，请刷新后切换。" );
      }
    }
  }

  const expiresAt = orderExpiry(current);
  const codeUrl = await createWechatNativeOrder(current.id, expiresAt);
  await saveWechatNativeCode(current.id, codeUrl, expiresAt);
  return { codeUrl, eligible: false, expiresAt: expiresAt.toISOString(), orderId: current.id };
};

export const getWechatBuyerOrderStatus = async (
  orderId: string,
  buyerKey: string,
  reconcile = false,
): Promise<CommunityOrder> => {
  const order = await findOrderForBuyer(orderId, buyerKey);
  if (
    !order ||
    order.payment_provider !== "WECHAT" ||
    order.payment_product !== "WECHAT_NATIVE"
  ) {
    throw new AppError(404, "order_not_found", "未找到对应微信订单。" );
  }
  if (!reconcile || order.status !== "PENDING") return order;
  return reconcilePendingWechatOrder(order);
};

export const closeBuyerWechatOrder = async (
  orderId: string,
  buyerKey: string,
): Promise<CommunityOrder> => {
  let order = await getWechatBuyerOrderStatus(orderId, buyerKey, true);
  if (order.status !== "PENDING") return order;

  try {
    await closeWechatOrder(order.id);
    await markOrderClosed(order.id);
    return { ...order, status: "CLOSED" };
  } catch (error) {
    order = await reconcilePendingWechatOrder(order);
    if (order.status === "PAID") return order;
    throw error;
  }
};

type RefundResult = { refundRequestNo: string; status: RefundStatus | "REFUNDED" };

const persistRefundResult = async (
  order: CommunityOrder,
  refundRequestNo: string,
  refundStatus: RefundStatus,
  refundId: string | null,
): Promise<RefundResult> => {
  if (refundStatus === "SUCCESS") {
    await saveWechatRefund(order.id, refundRequestNo, refundStatus, refundId);
    await markOrderRefunded(order.id, refundRequestNo);
    return { refundRequestNo, status: "REFUNDED" };
  }

  await saveWechatRefund(order.id, refundRequestNo, refundStatus, refundId);
  return { refundRequestNo, status: refundStatus };
};

export const refundWechatCommunityOrder = async (
  order: CommunityOrder,
  reason: string,
): Promise<RefundResult> => {
  if (
    order.payment_provider !== "WECHAT" ||
    order.payment_product !== "WECHAT_NATIVE" ||
    order.status !== "PAID"
  ) {
    throw new AppError(409, "order_not_refundable", "该订单当前无法通过微信退款。" );
  }

  const refundRequestNo = order.refund_request_no || `WR${order.id}`;
  await saveWechatRefund(order.id, refundRequestNo, "PROCESSING", order.wechat_refund_id);
  const result = await refundWechatOrder(order, refundRequestNo, reason);
  const refund = validateWechatRefund(result, order, refundRequestNo);
  await saveWechatRefund(order.id, refundRequestNo, "PROCESSING", refund.refundId);
  return { refundRequestNo, status: "PROCESSING" };
};

export const queryWechatCommunityRefund = async (
  order: CommunityOrder,
): Promise<RefundResult> => {
  if (!order.refund_request_no) {
    throw new AppError(409, "refund_not_found", "该订单没有可查询的退款申请。" );
  }
  const result = await queryWechatRefund(order.refund_request_no);
  const refund = validateWechatRefund(result, order, order.refund_request_no);
  return persistRefundResult(
    order,
    order.refund_request_no,
    refund.status,
    refund.refundId,
  );
};
