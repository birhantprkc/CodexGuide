ALTER TABLE community_orders
  ADD COLUMN IF NOT EXISTS payment_product VARCHAR(24)
  CHECK (payment_product IN ('ALIPAY_WEB', 'WECHAT_JSAPI', 'WECHAT_NATIVE'));

UPDATE community_orders
SET payment_product = CASE
  WHEN payment_provider = 'ALIPAY' THEN 'ALIPAY_WEB'
  ELSE 'WECHAT_JSAPI'
END
WHERE payment_product IS NULL;

UPDATE community_orders
SET status = 'CLOSED', updated_at = NOW()
WHERE payment_product = 'WECHAT_JSAPI' AND status = 'PENDING';

ALTER TABLE community_orders
  ALTER COLUMN payment_product SET NOT NULL;

ALTER TABLE community_orders
  ADD COLUMN IF NOT EXISTS wechat_code_url TEXT;

ALTER TABLE community_orders
  ADD COLUMN IF NOT EXISTS wechat_code_expires_at TIMESTAMPTZ;

ALTER TABLE community_orders
  ADD COLUMN IF NOT EXISTS wechat_refund_id VARCHAR(64);

ALTER TABLE community_orders
  ADD COLUMN IF NOT EXISTS refund_status VARCHAR(16)
  CHECK (refund_status IN ('PROCESSING', 'SUCCESS', 'CLOSED', 'ABNORMAL'));

UPDATE community_orders
SET refund_status = 'SUCCESS'
WHERE status = 'REFUNDED' AND refund_status IS NULL;

UPDATE community_orders
SET refund_status = 'PROCESSING'
WHERE status = 'PAID' AND refund_request_no IS NOT NULL AND refund_status IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS community_orders_wechat_refund_id_unique_idx
  ON community_orders (wechat_refund_id)
  WHERE wechat_refund_id IS NOT NULL;
