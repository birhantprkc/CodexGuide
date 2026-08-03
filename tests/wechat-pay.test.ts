import {
  createCipheriv,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WechatConfig } from "../server/config.js";
import type { CommunityOrder } from "../server/db.js";
import {
  createMerchantAuthorization,
  createWechatNativeOrder,
  decryptWechatNotification,
  validatePaidTransaction,
  validateWechatNotificationEnvelope,
  validateWechatRefund,
  verifyWechatSignature,
  type WechatNotification,
  type WechatTransaction,
} from "../server/wechat-pay.js";

const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wechatPayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPrivatePem = merchantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const merchantPublicPem = merchantKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const wechatPayPrivatePem = wechatPayKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const wechatPayPublicPem = wechatPayKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

const config: WechatConfig = {
  appId: "wx-test-app",
  apiV3Key: "12345678901234567890123456789012",
  merchantId: "1900000001",
  merchantPrivateKey: merchantPrivatePem,
  merchantSerialNumber: "MERCHANT-SERIAL",
  publicKey: wechatPayPublicPem,
  publicKeyId: "PUB_KEY_ID_01111111111111111111111111111111",
};

const signedHeaders = (
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
  serial = config.publicKeyId,
): Headers => {
  const nonce = "callback-nonce";
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${body}\n`);
  signer.end();

  return new Headers({
    "Wechatpay-Nonce": nonce,
    "Wechatpay-Serial": serial,
    "Wechatpay-Signature": signer.sign(wechatPayPrivatePem, "base64"),
    "Wechatpay-Timestamp": String(timestamp),
  });
};

const signedResponse = (body: string, status = 200): Response =>
  new Response(body, { headers: signedHeaders(body), status });

const order: CommunityOrder = {
  alipay_buyer_key: null,
  alipay_trade_no: null,
  amount_cents: 990,
  buyer_key: "a".repeat(64),
  created_at: new Date(),
  currency: "CNY",
  id: "CGMTEST00000000000000001",
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
};

describe("WeChat Pay API v3 signatures", () => {
  it("signs Native merchant requests using the exact API v3 message", () => {
    const authorization = createMerchantAuthorization(
      "POST",
      "/v3/pay/transactions/native",
      "{\"amount\":990}",
      config,
      1_800_000_000,
      "merchant-nonce",
    );
    const signature = authorization.match(/signature="([^"]+)"/u)?.[1];
    const verifier = createVerify("RSA-SHA256");
    verifier.update(
      "POST\n/v3/pay/transactions/native\n1800000000\nmerchant-nonce\n{\"amount\":990}\n",
    );
    verifier.end();

    expect(authorization).toContain('serial_no="MERCHANT-SERIAL"');
    expect(signature).toBeTruthy();
    expect(verifier.verify(merchantPublicPem, signature!, "base64")).toBe(true);
  });

  it("requires the configured WeChat Pay public-key ID and a fresh signature", () => {
    const body = "{\"id\":\"notification\"}";
    const now = Math.floor(Date.now() / 1000);
    expect(() => verifyWechatSignature(body, signedHeaders(body, now), config, now)).not.toThrow();

    expect(() =>
      verifyWechatSignature(body, signedHeaders(body, now, "PLATFORM-SERIAL"), config, now),
    ).toThrow("签名无效");
    const probe = signedHeaders(body, now);
    probe.set("Wechatpay-Signature", "WECHATPAY/SIGNTEST/fake");
    expect(() => verifyWechatSignature(body, probe, config, now)).toThrow("探测");
    expect(() => verifyWechatSignature(body, signedHeaders(body, now), config, now + 301)).toThrow(
      "签名无效",
    );
  });
});

describe("WeChat Pay Native requests", () => {
  beforeEach(() => {
    process.env.COMMUNITY_SITE_URL = "https://codexguide.ai";
  });

  it("creates a ten-minute Native order with a server-fixed 990-cent amount", async () => {
    const codeUrl = "weixin://wxpay/bizpayurl?pr=test-code";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.amount).toEqual({ currency: "CNY", total: 990 });
      expect(payload.appid).toBe(config.appId);
      expect(payload.mchid).toBe(config.merchantId);
      expect(payload.out_trade_no).toBe(order.id);
      expect(payload.notify_url).toBe("https://codexguide.ai/api/wechat-pay/notify");
      expect(payload.time_expire).toBe("2027-01-15T08:10:00+00:00");
      expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
      return signedResponse(JSON.stringify({ code_url: codeUrl }));
    });

    await expect(
      createWechatNativeOrder(
        order.id,
        new Date("2027-01-15T08:10:00.000Z"),
        fetchMock as typeof fetch,
        config,
      ),
    ).resolves.toBe(codeUrl);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.mch.weixin.qq.com/v3/pay/transactions/native",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a response without a valid code_url", async () => {
    const fetchMock = vi.fn(async () => signedResponse(JSON.stringify({ code_url: "https://bad" })));
    await expect(
      createWechatNativeOrder(order.id, new Date(), fetchMock as typeof fetch, config),
    ).rejects.toThrow("有效付款码");
  });
});

describe("WeChat Pay notifications and refund invariants", () => {
  const transaction: WechatTransaction = {
    amount: { currency: "CNY", payer_total: 990, total: 990 },
    appid: config.appId,
    mchid: config.merchantId,
    out_trade_no: order.id,
    trade_state: "SUCCESS",
    trade_type: "NATIVE",
    transaction_id: "4200000000001",
  };

  it("decrypts AES-256-GCM resources and validates all Native order invariants", () => {
    const nonce = randomBytes(12).toString("base64url").slice(0, 12);
    const associatedData = "transaction";
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.apiV3Key), Buffer.from(nonce));
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(transaction), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
    const notification: WechatNotification = {
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        associated_data: associatedData,
        ciphertext,
        nonce,
        original_type: "transaction",
      },
    };

    validateWechatNotificationEnvelope(notification, "TRANSACTION.SUCCESS", "transaction");
    const decrypted = decryptWechatNotification(notification, config);
    expect(decrypted).toEqual(transaction);
    expect(validatePaidTransaction(decrypted, order, config)).toBe("4200000000001");
  });

  it.each([
    [{ ...transaction, appid: "wrong" }, "appid"],
    [{ ...transaction, mchid: "wrong" }, "mchid"],
    [{ ...transaction, trade_type: "JSAPI" }, "product"],
    [{ ...transaction, amount: { currency: "CNY", total: 1 } }, "amount"],
    [{ ...transaction, amount: { currency: "USD", total: 990 } }, "currency"],
  ])("rejects a mismatched paid transaction", (candidate, _reason) => {
    expect(() => validatePaidTransaction(candidate, order, config)).toThrow("不匹配");
  });

  it("refuses a different transaction ID from the one already recorded", () => {
    expect(() =>
      validatePaidTransaction(
        transaction,
        { ...order, status: "PAID", wechat_transaction_id: "4200000000999" },
        config,
      ),
    ).toThrow("不匹配");
  });

  it("never credits a legacy JSAPI or non-WeChat local order", () => {
    expect(() =>
      validatePaidTransaction(
        transaction,
        { ...order, payment_product: "WECHAT_JSAPI" },
        config,
      ),
    ).toThrow("不匹配");
    expect(() =>
      validatePaidTransaction(
        transaction,
        { ...order, payment_product: "ALIPAY_WEB", payment_provider: "ALIPAY" },
        config,
      ),
    ).toThrow("不匹配");
  });

  it("validates PROCESSING and SUCCESS refunds without treating them as equivalent", () => {
    const refundBase = {
      amount: { currency: "CNY", refund: 990, total: 990 },
      mchid: config.merchantId,
      out_refund_no: `WR${order.id}`,
      out_trade_no: order.id,
      refund_id: "5030000000001",
    };
    expect(
      validateWechatRefund({ ...refundBase, status: "PROCESSING" }, order, `WR${order.id}`, config),
    ).toEqual({ refundId: "5030000000001", status: "PROCESSING" });
    expect(
      validateWechatRefund({ ...refundBase, status: "SUCCESS" }, order, `WR${order.id}`, config),
    ).toEqual({ refundId: "5030000000001", status: "SUCCESS" });
  });
});
