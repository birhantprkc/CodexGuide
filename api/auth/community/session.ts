import { getBuyerHmacSecret } from "../../../server/config.js";
import { findCurrentOrder } from "../../../server/db.js";
import { errorResponse } from "../../../server/errors.js";
import { assertMethod, noStoreHeaders } from "../../../server/http.js";
import { hmacHex, randomToken } from "../../../server/security.js";
import {
  paidCommunitySessionCookie,
  readAlipaySession,
  readCommunitySession,
  readPaidCommunitySession,
} from "../../../server/session.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      assertMethod(request, ["GET"]);
      const current = readPaidCommunitySession(request);
      if (current) {
        return Response.json({ authenticated: true }, { headers: noStoreHeaders() });
      }

      const legacyKeys = [
        readAlipaySession(request)?.buyerKey,
        readCommunitySession(request)?.buyerKey,
      ].filter((value): value is string => Boolean(value));
      const uniqueLegacyKeys = [...new Set(legacyKeys)];
      let buyerKey = uniqueLegacyKeys[0];
      if (uniqueLegacyKeys.length > 1) {
        const candidates = await Promise.all(
          uniqueLegacyKeys.map(async (key) => ({ key, order: await findCurrentOrder(key) })),
        );
        buyerKey =
          candidates.find(({ order }) => order?.status === "PAID")?.key ||
          candidates.find(({ order }) => order?.status === "PENDING")?.key ||
          buyerKey;
      }
      buyerKey ||= hmacHex(`paid-community:${randomToken(32)}`, getBuyerHmacSecret());
      const headers = noStoreHeaders({ "Set-Cookie": paidCommunitySessionCookie(buyerKey) });
      return Response.json({ authenticated: true }, { headers });
    } catch (error) {
      return errorResponse(error);
    }
  },
};
