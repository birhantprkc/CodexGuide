import { findCurrentOrder, hasActiveGroupQr } from "../../server/db.js";
import { readPaidCommunityBuyerKeys } from "../../server/auth.js";
import { errorResponse } from "../../server/errors.js";
import { assertMethod, noStoreHeaders } from "../../server/http.js";
import { readPaidCommunitySession } from "../../server/session.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      assertMethod(request, ["GET"]);
      const buyerKeys = readPaidCommunityBuyerKeys(request);

      if (buyerKeys.length === 0) {
        return Response.json(
          {
            authenticated: false,
            eligible: false,
            sessionReady: false,
            sessionUrl: "/api/auth/community/session",
          },
          { headers: noStoreHeaders() },
        );
      }

      const [orders, groupQr] = await Promise.all([
        Promise.all(buyerKeys.map((buyerKey) => findCurrentOrder(buyerKey))),
        hasActiveGroupQr(),
      ]);
      const selected =
        orders.find((order) => order?.status === "PAID") ||
        orders.find((order) => order?.status === "PENDING") ||
        null;

      return Response.json(
        {
          authenticated: true,
          eligible: selected?.status === "PAID",
          groupQrReady: groupQr,
          orderId: selected?.id ?? null,
          orderStatus: selected?.status ?? null,
          paymentProduct: selected?.payment_product ?? null,
          paymentProvider: selected?.payment_provider ?? null,
          sessionReady: Boolean(readPaidCommunitySession(request)),
          sessionUrl: "/api/auth/community/session",
        },
        { headers: noStoreHeaders() },
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
};
