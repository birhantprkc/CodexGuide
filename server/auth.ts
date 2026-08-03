import { getAdminSessionSecret } from "./config.js";
import { AppError } from "./errors.js";
import { getClientIp } from "./http.js";
import { hmacHex } from "./security.js";
import {
  readAdminSession,
  readAlipaySession,
  readCommunitySession,
  readPaidCommunitySession,
  type PaidCommunitySession,
} from "./session.js";

export const requirePaidCommunitySession = (request: Request): PaidCommunitySession => {
  const current = readPaidCommunitySession(request);
  if (current) return current;

  const alipay = readAlipaySession(request);
  if (alipay) {
    return { type: "paid-community", buyerKey: alipay.buyerKey, exp: alipay.exp };
  }

  const wechat = readCommunitySession(request);
  if (wechat) {
    return { type: "paid-community", buyerKey: wechat.buyerKey, exp: wechat.exp };
  }

  throw new AppError(401, "community_session_required", "支付会话已失效，请刷新页面后重试。" );
};

export const readPaidCommunityBuyerKeys = (request: Request): string[] => {
  const keys = [
    readPaidCommunitySession(request)?.buyerKey,
    readAlipaySession(request)?.buyerKey,
    readCommunitySession(request)?.buyerKey,
  ].filter((value): value is string => Boolean(value));

  return [...new Set(keys)];
};

export const requirePaidCommunityBuyerKeys = (request: Request): string[] => {
  const keys = readPaidCommunityBuyerKeys(request);
  if (keys.length === 0) {
    throw new AppError(401, "community_session_required", "支付会话已失效，请刷新页面后重试。" );
  }
  return keys;
};

export const requireAdminSession = (request: Request): void => {
  if (!readAdminSession(request)) {
    throw new AppError(401, "admin_auth_required", "请先登录管理页。" );
  }
};

export const adminLoginBucket = (request: Request): string =>
  hmacHex(`admin-login:${getClientIp(request)}`, getAdminSessionSecret());
