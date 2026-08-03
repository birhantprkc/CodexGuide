import {
  getCommunitySiteUrl,
  isAlipayPaymentEnabled,
  isCommunityPaymentEnabled,
  isWechatNativePaymentEnabled,
} from "../../server/config.js";
import { errorResponse } from "../../server/errors.js";
import { assertMethod, noStoreHeaders } from "../../server/http.js";
import { COMMUNITY_PRICE_CENTS } from "../../server/payment-constants.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      assertMethod(request, ["GET"]);

      const globalEnabled = isCommunityPaymentEnabled();
      const alipayEnabled = globalEnabled && isAlipayPaymentEnabled();
      const wechatNativeEnabled = globalEnabled && isWechatNativePaymentEnabled();
      return Response.json(
        {
          communityOrigin: getCommunitySiteUrl(),
          paymentEnabled: alipayEnabled || wechatNativeEnabled,
          paymentMethods: {
            alipay: { enabled: alipayEnabled },
            wechatNative: { enabled: wechatNativeEnabled },
          },
          paymentProvider: "ALIPAY",
          priceCents: COMMUNITY_PRICE_CENTS,
        },
        { headers: noStoreHeaders() },
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
};
