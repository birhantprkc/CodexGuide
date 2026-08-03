import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { getWechatConfig } from "../server/config.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("WeChat Native configuration", () => {
  beforeEach(() => {
    process.env.WECHAT_APP_ID = "wx-test-app";
    delete process.env.WECHAT_APP_SECRET;
    process.env.WECHAT_PAY_API_V3_KEY = "12345678901234567890123456789012";
    process.env.WECHAT_PAY_MCH_ID = "1900000001";
    process.env.WECHAT_PAY_CERT_SERIAL_NO = "MERCHANT-SERIAL";
    process.env.WECHAT_PAY_PRIVATE_KEY = privateKey;
    process.env.WECHAT_PAY_PUBLIC_KEY_ID = "PUB_KEY_ID_3000000001";
    process.env.WECHAT_PAY_PUBLIC_KEY = publicKey;
  });

  it("loads Native credentials without requiring an app secret", () => {
    expect(getWechatConfig()).toMatchObject({
      appId: "wx-test-app",
      publicKeyId: "PUB_KEY_ID_3000000001",
    });
  });

  it("rejects a platform-certificate serial in public-key mode", () => {
    process.env.WECHAT_PAY_PUBLIC_KEY_ID = "PLATFORM-SERIAL";
    expect(() => getWechatConfig()).toThrow("WECHAT_PAY_PUBLIC_KEY_ID");
  });

  it("requires an APIv3 key of exactly 32 bytes", () => {
    process.env.WECHAT_PAY_API_V3_KEY = "short";
    expect(() => getWechatConfig()).toThrow("WECHAT_PAY_API_V3_KEY");
  });
});
