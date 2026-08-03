import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findOrderById: vi.fn(),
  markWechatOrderPaid: vi.fn(),
}));

vi.mock("../server/db.js", () => dbMocks);

import handler from "../api/wechat-pay/notify.js";

const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPrivatePem = merchantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const platformPrivatePem = platformKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const platformPublicPem = platformKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const apiV3Key = "12345678901234567890123456789012";
const orderId = "CGMTEST00000000000000001";

const notificationBody = (amount = 990): string => {
  const transaction = {
    appid: "wx-test-app",
    mchid: "1900000001",
    out_trade_no: orderId,
    trade_state: "SUCCESS",
    trade_type: "NATIVE",
    transaction_id: "4200000000001",
    amount: { currency: "CNY", payer_total: amount, total: amount },
  };
  const nonce = randomBytes(12).toString("base64url").slice(0, 12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from("transaction"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(transaction), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");

  return JSON.stringify({
    event_type: "TRANSACTION.SUCCESS",
    id: "notification-id",
    resource_type: "encrypt-resource",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      associated_data: "transaction",
      ciphertext,
      nonce,
      original_type: "transaction",
    },
  });
};

const signedRequest = (body: string, valid = true): Request => {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = "callback-nonce";
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${body}\n`);
  signer.end();
  const signature = signer.sign(platformPrivatePem, "base64");

  return new Request("https://codexguide.ai/api/wechat-pay/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Serial": "PUB_KEY_ID_01111111111111111111111111111111",
      "Wechatpay-Signature": valid ? signature : `x${signature.slice(1)}`,
      "Wechatpay-Timestamp": String(timestamp),
    },
    body,
  });
};

describe("WeChat Pay notification endpoint", () => {
  beforeEach(() => {
    process.env.PUBLIC_SITE_URL = "https://codexguide.ai";
    process.env.WECHAT_APP_ID = "wx-test-app";
    process.env.WECHAT_PAY_API_V3_KEY = apiV3Key;
    process.env.WECHAT_PAY_MCH_ID = "1900000001";
    process.env.WECHAT_PAY_CERT_SERIAL_NO = "MERCHANT-SERIAL";
    process.env.WECHAT_PAY_PRIVATE_KEY = merchantPrivatePem;
    process.env.WECHAT_PAY_PUBLIC_KEY_ID = "PUB_KEY_ID_01111111111111111111111111111111";
    process.env.WECHAT_PAY_PUBLIC_KEY = platformPublicPem;
    dbMocks.findOrderById.mockReset();
    dbMocks.markWechatOrderPaid.mockReset();
    dbMocks.markWechatOrderPaid.mockResolvedValue(true);
    dbMocks.findOrderById.mockResolvedValue({
      alipay_buyer_key: null,
      alipay_trade_no: null,
      amount_cents: 990,
      buyer_key: "b".repeat(64),
      created_at: new Date(),
      currency: "CNY",
      id: orderId,
      paid_at: null,
      payment_product: "WECHAT_NATIVE",
      payment_provider: "WECHAT",
      prepay_expires_at: null,
      prepay_id: null,
      refund_request_no: null,
      refund_status: null,
      refunded_at: null,
      status: "PENDING",
      updated_at: new Date(),
      wechat_code_expires_at: null,
      wechat_code_url: null,
      wechat_refund_id: null,
      wechat_transaction_id: null,
    });
  });

  it("marks a fully verified notification paid", async () => {
    const response = await handler.fetch(signedRequest(notificationBody()));
    expect(response.status).toBe(204);
    expect(dbMocks.markWechatOrderPaid).toHaveBeenCalledWith(orderId, "4200000000001");
  });

  it("keeps verified payment notifications active when new Native orders are disabled", async () => {
    process.env.WECHAT_NATIVE_PAYMENT_ENABLED = "false";

    const response = await handler.fetch(signedRequest(notificationBody()));

    expect(response.status).toBe(204);
    expect(dbMocks.findOrderById).toHaveBeenCalledWith(orderId);
    expect(dbMocks.markWechatOrderPaid).toHaveBeenCalledWith(orderId, "4200000000001");
  });

  it("rejects invalid signatures before touching the order", async () => {
    const response = await handler.fetch(signedRequest(notificationBody(), false));
    expect(response.status).toBe(401);
    expect(dbMocks.findOrderById).not.toHaveBeenCalled();
    expect(dbMocks.markWechatOrderPaid).not.toHaveBeenCalled();
  });

  it("rejects a signed non-object notification as a client error", async () => {
    const response = await handler.fetch(signedRequest("null"));
    expect(response.status).toBe(400);
    expect(dbMocks.findOrderById).not.toHaveBeenCalled();
  });

  it("rejects a signed notification with the wrong amount", async () => {
    const response = await handler.fetch(signedRequest(notificationBody(1)));
    expect(response.status).toBe(400);
    expect(dbMocks.markWechatOrderPaid).not.toHaveBeenCalled();
  });

  it("rejects a conflicting transaction without overwriting the paid row", async () => {
    dbMocks.markWechatOrderPaid.mockResolvedValue(false);
    const response = await handler.fetch(signedRequest(notificationBody()));
    expect(response.status).toBe(409);
  });

  it("acknowledges a duplicate payment notification after the same transaction was refunded", async () => {
    dbMocks.findOrderById.mockResolvedValue({
      ...(await dbMocks.findOrderById()),
      status: "REFUNDED",
      wechat_transaction_id: "4200000000001",
    });
    const response = await handler.fetch(signedRequest(notificationBody()));
    expect(response.status).toBe(204);
    expect(dbMocks.markWechatOrderPaid).not.toHaveBeenCalled();
  });
});
