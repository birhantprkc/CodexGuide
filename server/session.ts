import { getAdminSessionSecret, getCommunitySessionSecret } from "./config.js";
import { cookie, readCookie } from "./http.js";
import { seal, unseal } from "./security.js";

export const COMMUNITY_SESSION_COOKIE = "codexguide_community";
export const ALIPAY_SESSION_COOKIE = "codexguide_alipay_community";
export const PAID_COMMUNITY_SESSION_COOKIE = "codexguide_paid_community";
export const ADMIN_SESSION_COOKIE = "codexguide_community_admin";

export type CommunitySession = {
  buyerKey: string;
  exp: number;
  openid: string;
  type: "community";
};

export type AlipaySession = {
  buyerKey: string;
  exp: number;
  type: "alipay-community";
};

export type PaidCommunitySession = {
  buyerKey: string;
  exp: number;
  type: "paid-community";
};

export type AdminSession = {
  exp: number;
  type: "admin";
};

export const readCommunitySession = (request: Request): CommunitySession | null =>
  unseal<CommunitySession>(
    readCookie(request, COMMUNITY_SESSION_COOKIE),
    getCommunitySessionSecret(),
    "community",
  );

export const communitySessionCookie = (openid: string, buyerKey: string): string => {
  const maxAge = 30 * 24 * 60 * 60;
  const token = seal(
    { type: "community", openid, buyerKey, exp: Date.now() + maxAge * 1000 },
    getCommunitySessionSecret(),
  );

  return cookie(COMMUNITY_SESSION_COOKIE, token, {
    maxAge,
    secure: process.env.NODE_ENV === "production",
  });
};

export const readAlipaySession = (request: Request): AlipaySession | null =>
  unseal<AlipaySession>(
    readCookie(request, ALIPAY_SESSION_COOKIE),
    getCommunitySessionSecret(),
    "alipay-community",
  );

export const alipaySessionCookie = (buyerKey: string): string => {
  const maxAge = 365 * 24 * 60 * 60;
  const token = seal(
    { type: "alipay-community", buyerKey, exp: Date.now() + maxAge * 1000 },
    getCommunitySessionSecret(),
  );

  return cookie(ALIPAY_SESSION_COOKIE, token, {
    maxAge,
    secure: process.env.NODE_ENV === "production",
  });
};

export const readPaidCommunitySession = (request: Request): PaidCommunitySession | null =>
  unseal<PaidCommunitySession>(
    readCookie(request, PAID_COMMUNITY_SESSION_COOKIE),
    getCommunitySessionSecret(),
    "paid-community",
  );

export const paidCommunitySessionCookie = (buyerKey: string): string => {
  const maxAge = 365 * 24 * 60 * 60;
  const token = seal(
    { type: "paid-community", buyerKey, exp: Date.now() + maxAge * 1000 },
    getCommunitySessionSecret(),
  );

  return cookie(PAID_COMMUNITY_SESSION_COOKIE, token, {
    maxAge,
    secure: process.env.NODE_ENV === "production",
  });
};

export const readAdminSession = (request: Request): AdminSession | null =>
  unseal<AdminSession>(
    readCookie(request, ADMIN_SESSION_COOKIE),
    getAdminSessionSecret(),
    "admin",
  );

export const adminSessionCookie = (): string => {
  const maxAge = 8 * 60 * 60;
  const token = seal(
    { type: "admin", exp: Date.now() + maxAge * 1000 },
    getAdminSessionSecret(),
  );

  return cookie(ADMIN_SESSION_COOKIE, token, {
    maxAge,
    sameSite: "Strict",
    secure: process.env.NODE_ENV === "production",
  });
};
