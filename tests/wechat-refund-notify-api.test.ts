import { createCipheriv, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findOrderById: vi.fn(),
  markOrderRefunded: vi.fn(),
  saveWechatRefund: vi.fn(),
}));

vi.mock("../server/db.js", () => dbMocks);

import handler from "../api/wechat-pay/refund-notify.js";

const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wechatPayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPrivatePem = merchantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const wechatPayPrivatePem = wechatPayKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const wechatPayPublicPem = wechatPayKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const apiV3Key = "12345678901234567890123456789012";
const orderId = "CGMTEST00000000000000001";
const refundNo = `WR${orderId}`;

const notificationBody = (status: "ABNORMAL" | "CLOSED" | "SUCCESS", amount = 990): string => {
  const refund = {
    amount: { currency: "CNY", refund: amount, total: 990 },
    mchid: "1900000001",
    out_refund_no: refundNo,
    out_trade_no: orderId,
    refund_id: "5030000000001",
    refund_status: status,
  };
  const nonce = randomBytes(12).toString("base64url").slice(0, 12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from("refund"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(refund), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  return JSON.stringify({
    event_type: `REFUND.${status}`,
    resource_type: "encrypt-resource",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      associated_data: "refund",
      ciphertext,
      nonce,
      original_type: "refund",
    },
  });
};

const signedRequest = (body: string): Request => {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = "refund-callback-nonce";
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${body}\n`);
  signer.end();
  return new Request("https://codexguide.ai/api/wechat-pay/refund-notify", {
    method: "POST",
    headers: {
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Serial": "PUB_KEY_ID_01111111111111111111111111111111",
      "Wechatpay-Signature": signer.sign(wechatPayPrivatePem, "base64"),
      "Wechatpay-Timestamp": String(timestamp),
    },
    body,
  });
};

describe("WeChat refund notification endpoint", () => {
  beforeEach(() => {
    process.env.WECHAT_APP_ID = "wx-test-app";
    process.env.WECHAT_PAY_API_V3_KEY = apiV3Key;
    process.env.WECHAT_PAY_MCH_ID = "1900000001";
    process.env.WECHAT_PAY_CERT_SERIAL_NO = "MERCHANT-SERIAL";
    process.env.WECHAT_PAY_PRIVATE_KEY = merchantPrivatePem;
    process.env.WECHAT_PAY_PUBLIC_KEY_ID = "PUB_KEY_ID_01111111111111111111111111111111";
    process.env.WECHAT_PAY_PUBLIC_KEY = wechatPayPublicPem;
    dbMocks.findOrderById.mockReset();
    dbMocks.markOrderRefunded.mockReset();
    dbMocks.saveWechatRefund.mockReset();
    dbMocks.findOrderById.mockResolvedValue({
      amount_cents: 990,
      currency: "CNY",
      id: orderId,
      payment_product: "WECHAT_NATIVE",
      payment_provider: "WECHAT",
      refund_request_no: refundNo,
      status: "PAID",
    });
  });

  it("marks the order REFUNDED only after a SUCCESS notification", async () => {
    process.env.WECHAT_NATIVE_PAYMENT_ENABLED = "false";
    const response = await handler.fetch(signedRequest(notificationBody("SUCCESS")));
    expect(response.status).toBe(204);
    expect(dbMocks.saveWechatRefund).toHaveBeenCalledWith(
      orderId,
      refundNo,
      "SUCCESS",
      "5030000000001",
    );
    expect(dbMocks.markOrderRefunded).toHaveBeenCalledWith(orderId, refundNo);
  });

  it.each(["CLOSED", "ABNORMAL"] as const)(
    "records %s without revoking eligibility",
    async (status) => {
      const response = await handler.fetch(signedRequest(notificationBody(status)));
      expect(response.status).toBe(204);
      expect(dbMocks.saveWechatRefund).toHaveBeenCalledWith(
        orderId,
        refundNo,
        status,
        "5030000000001",
      );
      expect(dbMocks.markOrderRefunded).not.toHaveBeenCalled();
    },
  );

  it("rejects a refund amount mismatch before changing local state", async () => {
    const response = await handler.fetch(signedRequest(notificationBody("SUCCESS", 1)));
    expect(response.status).toBe(400);
    expect(dbMocks.saveWechatRefund).not.toHaveBeenCalled();
    expect(dbMocks.markOrderRefunded).not.toHaveBeenCalled();
  });
});
