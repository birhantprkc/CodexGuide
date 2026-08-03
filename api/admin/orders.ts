import { requireAdminSession } from "../../server/auth.js";
import { findOrderById } from "../../server/db.js";
import { AppError, errorResponse } from "../../server/errors.js";
import { assertMethod, noStoreHeaders } from "../../server/http.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      assertMethod(request, ["GET"]);
      requireAdminSession(request);
      const orderId = new URL(request.url).searchParams.get("id") || "";
      if (!/^CG[A-Z0-9]{20,30}$/u.test(orderId)) {
        throw new AppError(400, "invalid_order_id", "订单号无效。" );
      }

      const order = await findOrderById(orderId);
      if (!order) throw new AppError(404, "order_not_found", "未找到对应订单。" );
      return Response.json(
        {
          amountCents: order.amount_cents,
          createdAt: order.created_at,
          orderId: order.id,
          paidAt: order.paid_at,
          paymentProduct: order.payment_product,
          paymentProvider: order.payment_provider,
          refundStatus: order.refund_status,
          refundedAt: order.refunded_at,
          status: order.status,
        },
        { headers: noStoreHeaders() },
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
};
