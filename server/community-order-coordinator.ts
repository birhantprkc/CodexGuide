import { closeBuyerAlipayOrder } from "./alipay-order-service.js";
import { findCurrentOrder, type CommunityOrder, type PaymentProduct } from "./db.js";
import { closeBuyerWechatOrder } from "./wechat-native-order-service.js";

export const closeConflictingPendingOrder = async (
  buyerKey: string,
  targetProduct: PaymentProduct,
): Promise<CommunityOrder | null> => {
  const current = await findCurrentOrder(buyerKey);
  if (!current || current.status === "PAID" || current.payment_product === targetProduct) {
    return current;
  }

  if (current.payment_provider === "ALIPAY") {
    return closeBuyerAlipayOrder(current.id, buyerKey);
  }
  return closeBuyerWechatOrder(current.id, buyerKey);
};
