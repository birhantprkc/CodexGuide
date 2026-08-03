import { requirePaidCommunitySession } from "../../server/auth.js";
import { closeConflictingPendingOrder } from "../../server/community-order-coordinator.js";
import { AppError, errorResponse } from "../../server/errors.js";
import { assertMethod, assertSameOrigin, noStoreHeaders } from "../../server/http.js";
import {
  requireCommunitySiteOrigin,
  requireWechatNativePaymentEnabled,
} from "../../server/payment-availability.js";
import {
  closeBuyerWechatOrder,
  getWechatBuyerOrderStatus,
  prepareWechatNativeOrder,
} from "../../server/wechat-native-order-service.js";

const orderIdFrom = (request: Request): string => {
  const orderId = new URL(request.url).searchParams.get("id") || "";
  if (!/^CG[A-Z0-9]{20,30}$/u.test(orderId)) {
    throw new AppError(400, "invalid_order_id", "订单号无效。" );
  }
  return orderId;
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      assertMethod(request, ["DELETE", "GET", "POST"]);
      const session = requirePaidCommunitySession(request);

      if (request.method === "POST") {
        assertSameOrigin(request);
        requireCommunitySiteOrigin(request);
        requireWechatNativePaymentEnabled();
        const current = await closeConflictingPendingOrder(session.buyerKey, "WECHAT_NATIVE");
        if (current?.status === "PAID") {
          return Response.json(
            { eligible: true, orderId: current.id },
            { headers: noStoreHeaders() },
          );
        }
        return Response.json(
          await prepareWechatNativeOrder(session.buyerKey),
          { headers: noStoreHeaders() },
        );
      }

      const orderId = orderIdFrom(request);
      if (request.method === "DELETE") {
        assertSameOrigin(request);
        const order = await closeBuyerWechatOrder(orderId, session.buyerKey);
        return Response.json(
          { orderId: order.id, status: order.status },
          { headers: noStoreHeaders() },
        );
      }

      const url = new URL(request.url);
      const order = await getWechatBuyerOrderStatus(
        orderId,
        session.buyerKey,
        url.searchParams.get("reconcile") === "1",
      );
      return Response.json(
        { eligible: order.status === "PAID", orderId: order.id, status: order.status },
        { headers: noStoreHeaders() },
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
};
