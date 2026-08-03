import { findOrderById, markWechatOrderPaid } from "../../server/db.js";
import { AppError, errorResponse } from "../../server/errors.js";
import { assertMethod } from "../../server/http.js";
import {
  decryptWechatNotification,
  validatePaidTransaction,
  validateWechatNotificationEnvelope,
  verifyWechatSignature,
  type WechatNotification,
} from "../../server/wechat-pay.js";
import { getWechatConfig } from "../../server/config.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      assertMethod(request, ["POST"]);
      const rawBody = await request.text();
      const config = getWechatConfig();
      verifyWechatSignature(rawBody, request.headers, config);

      let notification: WechatNotification;
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        notification = parsed as WechatNotification;
      } catch {
        throw new AppError(400, "invalid_notification_json", "微信支付通知格式无效。" );
      }

      validateWechatNotificationEnvelope(notification, "TRANSACTION.SUCCESS", "transaction");
      const transaction = decryptWechatNotification(notification, config);
      const orderId = transaction.out_trade_no || "";
      const order = await findOrderById(orderId);
      if (!order) throw new AppError(404, "order_not_found", "未找到对应订单。" );

      const transactionId = validatePaidTransaction(transaction, order, config);
      if (
        ["REFUNDED", "REVOKED"].includes(order.status) &&
        order.wechat_transaction_id === transactionId
      ) {
        return new Response(null, { status: 204 });
      }
      if (!(await markWechatOrderPaid(order.id, transactionId))) {
        throw new AppError(409, "payment_state_conflict", "订单支付状态发生冲突。" );
      }

      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof AppError) {
        console.error("WeChat payment notification rejected", error.code);
      }
      return errorResponse(error);
    }
  },
};
