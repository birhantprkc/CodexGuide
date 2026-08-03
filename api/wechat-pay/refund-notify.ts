import {
  findOrderById,
  markOrderRefunded,
  saveWechatRefund,
} from "../../server/db.js";
import { AppError, errorResponse } from "../../server/errors.js";
import { assertMethod } from "../../server/http.js";
import { getWechatConfig } from "../../server/config.js";
import {
  decryptWechatResource,
  validateWechatNotificationEnvelope,
  validateWechatRefund,
  verifyWechatSignature,
  type WechatNotification,
  type WechatRefund,
} from "../../server/wechat-pay.js";

const refundEvents = new Set(["REFUND.SUCCESS", "REFUND.CLOSED", "REFUND.ABNORMAL"]);

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
        throw new AppError(400, "invalid_notification_json", "微信退款通知格式无效。" );
      }
      if (!notification.event_type || !refundEvents.has(notification.event_type)) {
        throw new AppError(400, "invalid_notification", "微信退款通知类型无效。" );
      }
      validateWechatNotificationEnvelope(notification, notification.event_type, "refund");

      const refund = decryptWechatResource<WechatRefund>(notification, config);
      const order = await findOrderById(refund.out_trade_no || "");
      if (!order) throw new AppError(404, "order_not_found", "未找到对应订单。" );
      if (!order.refund_request_no) {
        throw new AppError(409, "refund_not_found", "本地退款申请不存在。" );
      }

      const validated = validateWechatRefund(refund, order, order.refund_request_no, config);
      await saveWechatRefund(
        order.id,
        order.refund_request_no,
        validated.status,
        validated.refundId,
      );
      if (validated.status === "SUCCESS") {
        await markOrderRefunded(order.id, order.refund_request_no);
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      return errorResponse(error);
    }
  },
};
