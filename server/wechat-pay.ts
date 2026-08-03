import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
} from "node:crypto";

import type { WechatConfig } from "./config.js";
import { getCommunitySiteUrl, getWechatConfig } from "./config.js";
import type { CommunityOrder } from "./db.js";
import { AppError } from "./errors.js";
import { COMMUNITY_PRICE_CENTS } from "./payment-constants.js";

export { COMMUNITY_PRICE_CENTS } from "./payment-constants.js";

const ORDER_DESCRIPTION = "CodexGuide 交流群入群资格";
type Fetch = typeof globalThis.fetch;

export type WechatTransaction = {
  amount?: { currency?: string; payer_total?: number; total?: number };
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  trade_state?: string;
  trade_type?: string;
  transaction_id?: string;
};

export type WechatRefund = {
  amount?: { currency?: string; payer_refund?: number; refund?: number; total?: number };
  mchid?: string;
  out_refund_no?: string;
  out_trade_no?: string;
  refund_id?: string;
  refund_status?: "ABNORMAL" | "CLOSED" | "PROCESSING" | "SUCCESS";
  status?: "ABNORMAL" | "CLOSED" | "PROCESSING" | "SUCCESS";
  transaction_id?: string;
};

export type WechatNotification = {
  event_type?: string;
  resource_type?: string;
  resource?: {
    algorithm?: string;
    associated_data?: string;
    ciphertext?: string;
    nonce?: string;
    original_type?: string;
  };
};

const nonce = (): string => randomBytes(16).toString("hex");

const rsaSign = (message: string, privateKey: string): string => {
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  return signer.sign(privateKey, "base64");
};

export const createMerchantAuthorization = (
  method: string,
  pathWithQuery: string,
  body: string,
  config: WechatConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
  nonceValue = nonce(),
): string => {
  const message = `${method}\n${pathWithQuery}\n${nowSeconds}\n${nonceValue}\n${body}\n`;
  const signature = rsaSign(message, config.merchantPrivateKey);

  return (
    "WECHATPAY2-SHA256-RSA2048 " +
    `mchid="${config.merchantId}",` +
    `nonce_str="${nonceValue}",` +
    `timestamp="${nowSeconds}",` +
    `serial_no="${config.merchantSerialNumber}",` +
    `signature="${signature}"`
  );
};

export const verifyWechatSignature = (
  body: string,
  headers: Headers,
  config: WechatConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): void => {
  const serial = headers.get("wechatpay-serial") || "";
  const signature = headers.get("wechatpay-signature") || "";
  const timestamp = headers.get("wechatpay-timestamp") || "";
  const nonceValue = headers.get("wechatpay-nonce") || "";
  const parsedTimestamp = Number(timestamp);

  if (signature.startsWith("WECHATPAY/SIGNTEST/")) {
    throw new AppError(401, "signature_probe", "微信支付签名探测请求已拒绝。" );
  }

  if (
    serial !== config.publicKeyId ||
    !signature ||
    !nonceValue ||
    !Number.isFinite(parsedTimestamp) ||
    !Number.isInteger(parsedTimestamp) ||
    Math.abs(nowSeconds - parsedTimestamp) > 300
  ) {
    throw new AppError(401, "invalid_wechat_signature", "微信支付签名无效。" );
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${timestamp}\n${nonceValue}\n${body}\n`);
  verifier.end();

  if (!verifier.verify(config.publicKey, signature, "base64")) {
    throw new AppError(401, "invalid_wechat_signature", "微信支付签名无效。" );
  }
};

const wechatRequest = async <T>(
  method: "GET" | "POST",
  pathWithQuery: string,
  payload: unknown,
  fetchImpl: Fetch,
  config: WechatConfig,
): Promise<T> => {
  const body = method === "POST" ? JSON.stringify(payload) : "";
  const response = await fetchImpl(`https://api.mch.weixin.qq.com${pathWithQuery}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: createMerchantAuthorization(method, pathWithQuery, body, config),
      "Content-Type": "application/json",
      "User-Agent": "CodexGuide-Paid-Community/2.0",
    },
    body: method === "POST" ? body : undefined,
  });
  const rawBody = await response.text();
  verifyWechatSignature(rawBody, response.headers, config);

  let data: (T & { code?: string; message?: string }) | undefined;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody) as T & { code?: string; message?: string };
    } catch {
      throw new AppError(502, "invalid_wechat_response", "微信支付返回了无效响应。" );
    }
  }

  if (!response.ok) {
    console.error("WeChat Pay API error", response.status, data?.code || "unknown");
    throw new AppError(502, "wechat_pay_error", "微信支付暂时不可用，请稍后重试。" );
  }

  return data as T;
};

const rfc3339 = (value: Date): string => value.toISOString().replace(/\.\d{3}Z$/u, "+00:00");

export const createWechatNativeOrder = async (
  orderId: string,
  expiresAt: Date,
  fetchImpl: Fetch = fetch,
  config: WechatConfig = getWechatConfig(),
): Promise<string> => {
  const data = await wechatRequest<{ code_url?: string }>(
    "POST",
    "/v3/pay/transactions/native",
    {
      amount: { currency: "CNY", total: COMMUNITY_PRICE_CENTS },
      appid: config.appId,
      description: ORDER_DESCRIPTION,
      mchid: config.merchantId,
      notify_url: `${getCommunitySiteUrl()}/api/wechat-pay/notify`,
      out_trade_no: orderId,
      time_expire: rfc3339(expiresAt),
    },
    fetchImpl,
    config,
  );

  if (!data.code_url || !/^weixin:\/\/wxpay\/bizpayurl\?/u.test(data.code_url)) {
    throw new AppError(502, "missing_wechat_code_url", "微信支付未返回有效付款码。" );
  }
  return data.code_url;
};

export const queryWechatOrder = async (
  orderId: string,
  fetchImpl: Fetch = fetch,
  config: WechatConfig = getWechatConfig(),
): Promise<WechatTransaction> => {
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(config.merchantId)}`;
  return wechatRequest<WechatTransaction>("GET", path, null, fetchImpl, config);
};

export const closeWechatOrder = async (
  orderId: string,
  fetchImpl: Fetch = fetch,
  config: WechatConfig = getWechatConfig(),
): Promise<void> => {
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}/close`;
  await wechatRequest<void>("POST", path, { mchid: config.merchantId }, fetchImpl, config);
};

export const refundWechatOrder = async (
  order: CommunityOrder,
  refundRequestNo: string,
  reason: string,
  fetchImpl: Fetch = fetch,
  config: WechatConfig = getWechatConfig(),
): Promise<WechatRefund> =>
  wechatRequest<WechatRefund>(
    "POST",
    "/v3/refund/domestic/refunds",
    {
      amount: { currency: order.currency, refund: order.amount_cents, total: order.amount_cents },
      notify_url: `${getCommunitySiteUrl()}/api/wechat-pay/refund-notify`,
      out_refund_no: refundRequestNo,
      out_trade_no: order.id,
      reason,
    },
    fetchImpl,
    config,
  );

export const queryWechatRefund = async (
  refundRequestNo: string,
  fetchImpl: Fetch = fetch,
  config: WechatConfig = getWechatConfig(),
): Promise<WechatRefund> =>
  wechatRequest<WechatRefund>(
    "GET",
    `/v3/refund/domestic/refunds/${encodeURIComponent(refundRequestNo)}`,
    null,
    fetchImpl,
    config,
  );

export const validateWechatNotificationEnvelope = (
  notification: WechatNotification,
  eventType: string,
  originalType: "refund" | "transaction",
): void => {
  if (
    notification.event_type !== eventType ||
    notification.resource_type !== "encrypt-resource" ||
    notification.resource?.original_type !== originalType
  ) {
    throw new AppError(400, "invalid_notification", "微信支付通知内容无效。" );
  }
};

export const decryptWechatResource = <T>(
  notification: WechatNotification,
  config: WechatConfig = getWechatConfig(),
): T => {
  const resource = notification.resource;
  if (
    resource?.algorithm !== "AEAD_AES_256_GCM" ||
    !resource.ciphertext ||
    !resource.nonce
  ) {
    throw new AppError(400, "invalid_notification", "微信支付通知内容无效。" );
  }

  try {
    const encrypted = Buffer.from(resource.ciphertext, "base64");
    const authTag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.apiV3Key, "utf8"),
      Buffer.from(resource.nonce, "utf8"),
    );
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associated_data || "", "utf8"));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as T;
  } catch {
    throw new AppError(400, "notification_decryption_failed", "微信支付通知解密失败。" );
  }
};

export const decryptWechatNotification = (
  notification: WechatNotification,
  config: WechatConfig = getWechatConfig(),
): WechatTransaction => decryptWechatResource<WechatTransaction>(notification, config);

export const validatePaidTransaction = (
  transaction: WechatTransaction,
  order: CommunityOrder,
  config: WechatConfig = getWechatConfig(),
): string => {
  if (
    order.payment_provider !== "WECHAT" ||
    order.payment_product !== "WECHAT_NATIVE" ||
    transaction.trade_state !== "SUCCESS" ||
    transaction.trade_type !== "NATIVE" ||
    transaction.out_trade_no !== order.id ||
    transaction.appid !== config.appId ||
    transaction.mchid !== config.merchantId ||
    transaction.amount?.currency !== order.currency ||
    transaction.amount?.total !== order.amount_cents ||
    !transaction.transaction_id ||
    (order.wechat_transaction_id !== null &&
      order.wechat_transaction_id !== transaction.transaction_id)
  ) {
    throw new AppError(400, "payment_mismatch", "微信支付结果与本地订单不匹配。" );
  }
  return transaction.transaction_id;
};

export const validateWechatRefund = (
  refund: WechatRefund,
  order: CommunityOrder,
  refundRequestNo: string,
  config: WechatConfig = getWechatConfig(),
): { refundId: string | null; status: NonNullable<WechatRefund["status"]> } => {
  const status = refund.status || refund.refund_status;
  if (
    order.payment_provider !== "WECHAT" ||
    order.payment_product !== "WECHAT_NATIVE" ||
    refund.out_trade_no !== order.id ||
    refund.out_refund_no !== refundRequestNo ||
    (refund.mchid !== undefined && refund.mchid !== config.merchantId) ||
    refund.amount?.total !== order.amount_cents ||
    refund.amount?.refund !== order.amount_cents ||
    (refund.amount?.currency !== undefined && refund.amount.currency !== order.currency) ||
    !status ||
    !["ABNORMAL", "CLOSED", "PROCESSING", "SUCCESS"].includes(status)
  ) {
    throw new AppError(400, "refund_mismatch", "微信退款结果与本地订单不匹配。" );
  }

  return { refundId: refund.refund_id || null, status };
};
