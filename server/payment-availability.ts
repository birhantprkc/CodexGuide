import {
  getCommunitySiteUrl,
  isAlipayPaymentEnabled,
  isCommunityPaymentEnabled,
  isWechatNativePaymentEnabled,
} from "./config.js";
import { AppError } from "./errors.js";

export const requireCommunityPaymentEnabled = (): void => {
  if (!isCommunityPaymentEnabled()) {
    throw new AppError(503, "payment_not_open", "交流群正式收款尚未开放，请稍后再来。");
  }
};

export const requireAlipayPaymentEnabled = (): void => {
  requireCommunityPaymentEnabled();
  if (!isAlipayPaymentEnabled()) {
    throw new AppError(503, "alipay_not_open", "支付宝收款通道暂未开放，请稍后再来。");
  }
};

export const requireCommunitySiteOrigin = (request: Request): void => {
  if (new URL(request.url).origin !== getCommunitySiteUrl()) {
    throw new AppError(409, "wrong_payment_origin", "请从正式交流群页面重新发起支付。");
  }
};

export const requireWechatNativePaymentEnabled = (): void => {
  requireCommunityPaymentEnabled();
  if (!isWechatNativePaymentEnabled()) {
    throw new AppError(503, "wechat_native_not_open", "微信支付通道暂未开放，请稍后再来。" );
  }
};
