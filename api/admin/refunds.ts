import {
  queryAlipayCommunityRefund,
  refundAlipayCommunityOrder,
} from "../../server/alipay-order-service.js";
import { requireAdminSession } from "../../server/auth.js";
import { findOrderById } from "../../server/db.js";
import { AppError, errorResponse } from "../../server/errors.js";
import { assertMethod, assertSameOrigin, noStoreHeaders, parseJson } from "../../server/http.js";
import {
  queryWechatCommunityRefund,
  refundWechatCommunityOrder,
} from "../../server/wechat-native-order-service.js";

const orderIdFrom = (value: unknown): string => {
  const orderId = typeof value === "string" ? value : "";
  if (!/^CG[A-Z0-9]{20,30}$/u.test(orderId)) {
    throw new AppError(400, "invalid_order_id", "订单号无效。" );
  }
  return orderId;
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      assertMethod(request, ["GET", "POST"]);
      requireAdminSession(request);

      if (request.method === "POST") {
        assertSameOrigin(request);
        const body = await parseJson<{ orderId?: unknown; reason?: unknown }>(request);
        const orderId = orderIdFrom(body.orderId);
        const reason = typeof body.reason === "string" ? body.reason.trim() : "用户申请退款";
        if (!reason || Buffer.byteLength(reason, "utf8") > 80) {
          throw new AppError(400, "invalid_refund_reason", "退款原因不能为空且不能超过 80 字节。" );
        }
        const order = await findOrderById(orderId);
        if (!order) throw new AppError(404, "order_not_found", "未找到对应订单。" );
        const result = order.payment_provider === "WECHAT"
          ? await refundWechatCommunityOrder(order, reason)
          : await refundAlipayCommunityOrder(order, reason);
        return Response.json(result, { headers: noStoreHeaders() });
      }

      const orderId = orderIdFrom(new URL(request.url).searchParams.get("id"));
      const order = await findOrderById(orderId);
      if (!order) throw new AppError(404, "order_not_found", "未找到对应订单。" );
      const result = order.payment_provider === "WECHAT"
        ? await queryWechatCommunityRefund(order)
        : await queryAlipayCommunityRefund(order);
      return Response.json(result, { headers: noStoreHeaders() });
    } catch (error) {
      return errorResponse(error);
    }
  },
};
