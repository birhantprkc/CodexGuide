# 付费交流群部署说明

正式域名为 `https://codexguide.ai`。说明页位于 `/community/join`，直接付款页位于
`/community/pay`，管理页位于 `/community/admin`。`/community/pay` 默认选择支付宝；
`/community/pay?provider=wechat` 在桌面浏览器直接展示微信 Native 付款码。

支付宝网站支付与微信 Native 支付共用买家会话、订单资格、受保护群二维码和管理员后台。
金额由服务端固定为 990 分，浏览器不能传入或修改金额。微信 Native 不支持相册或长按识别，
手机端应改用支付宝，或在电脑打开付款页后使用手机微信“扫一扫”。

## 1. 数据库

1. 在 Vercel 项目中连接 Neon Postgres，把池化连接串保存为 `DATABASE_URL`。
2. 在受信任终端临时导出同一连接串，执行 `pnpm db:migrate`。
3. 迁移脚本按文件名执行 `migrations/` 下的幂等 SQL；`003-wechat-native.sql` 会补充支付产品、Native 付款码和退款状态字段，并关闭遗留的 JSAPI 待支付订单。
4. `community_orders_one_active_per_buyer_idx` 保证每个买家最多只有一个 `PENDING/PAID` 活动订单。

## 2. 环境变量与开关

新安装首次部署应关闭全局开关；如果支付宝已经在线，保留现有全局和支付宝开关值，只关闭微信 Native：

```text
PUBLIC_SITE_URL=https://codexguide.ai
COMMUNITY_SITE_URL=https://codexguide.ai
COMMUNITY_PAYMENT_ENABLED=<新安装为 false；已有支付宝时保持当前值>
ALIPAY_PAYMENT_ENABLED=<保持现有支付宝值>
WECHAT_NATIVE_PAYMENT_ENABLED=false
DATABASE_URL=<Neon 池化连接串>

ALIPAY_ENV=production
ALIPAY_APP_ID=<生产应用 AppId>
ALIPAY_PRIVATE_KEY=<生产应用 PKCS#1 私钥原文>
ALIPAY_PUBLIC_KEY=<生产支付宝 RSA2 公钥原文>
ALIPAY_SELLER_ID=<签约主体 PID>
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
ALIPAY_NOTIFY_ENABLED=true

WECHAT_APP_ID=<已绑定商户号的 AppId>
WECHAT_PAY_MCH_ID=<普通商户号>
WECHAT_PAY_CERT_SERIAL_NO=<商户 API 证书序列号>
WECHAT_PAY_PRIVATE_KEY=<商户 API 证书私钥 PEM>
WECHAT_PAY_API_V3_KEY=<严格 32 字节的 APIv3 密钥>
WECHAT_PAY_PUBLIC_KEY_ID=<PUB_KEY_ID_数字串>
WECHAT_PAY_PUBLIC_KEY=<微信支付公钥 PEM>

COMMUNITY_SESSION_SECRET=<至少 32 字节的随机值>
COMMUNITY_BUYER_HMAC_SECRET=<至少 32 字节的独立随机值>
ADMIN_SESSION_SECRET=<至少 32 字节的独立随机值>
ADMIN_PASSWORD_HASH=<pnpm admin:hash-password 的输出>
```

三个随机值必须彼此独立。所有连接串、私钥、APIv3 密钥和密码只能由用户在 Vercel 受信任界面填写；不得提交到仓库、复制到对话或输出到日志。微信 Native 不需要 `WECHAT_APP_SECRET`。旧的 `WECHAT_PAYMENT_ENABLED` 已废弃，不能重新开启 JSAPI 路由。

开关规则：

- `COMMUNITY_PAYMENT_ENABLED` 控制所有新订单。
- `ALIPAY_PAYMENT_ENABLED` 只控制支付宝新订单；未配置时兼容全局值。
- `WECHAT_NATIVE_PAYMENT_ENABLED` 只控制微信 Native 新订单，默认 `false`。
- 已有资格访问、支付/退款通知、查单、关单和退款不受新订单开关影响。

## 3. 微信 Native 配置

1. 确认 `WECHAT_APP_ID` 已与 `WECHAT_PAY_MCH_ID` 绑定。
2. 商户 API 请求用 `WECHAT_PAY_CERT_SERIAL_NO` 和商户 API 私钥签名。
3. API 应答、支付通知和退款通知只接受与 `WECHAT_PAY_PUBLIC_KEY_ID` 完全一致的 `PUB_KEY_ID_...`，并使用 `WECHAT_PAY_PUBLIC_KEY` 验签。
4. 支付通知地址为 `https://codexguide.ai/api/wechat-pay/notify`。
5. 退款通知地址为 `https://codexguide.ai/api/wechat-pay/refund-notify`。
6. 两个通知地址都必须公网 HTTPS 直达，不得重定向或被部署保护拦截。

Native 下单调用 `POST /v3/pay/transactions/native`，订单有效期为 10 分钟。网页每 2 秒读取本地状态，每 10 秒主动查一次微信；回调丢失时以主动查单补偿。退款固定复用 `WR{orderId}`，微信返回 `PROCESSING` 只记录处理中；只有通知或查询最终为 `SUCCESS` 才把订单写为 `REFUNDED` 并撤销群码资格。

官方参考：[Native 开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4012791891)、[Native 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)、[微信支付公钥验签](https://pay.wechatpay.cn/doc/v3/merchant/4013053249)、[退款结果通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791886)。

## 4. 支付宝与本地验证

1. 运行 `pnpm alipay:configure-sandbox`，从受保护的 `.alipay-sandbox.json` 生成 `.env.local`。
2. `.alipay-sandbox.json` 和 `.env.local` 已被 Git 忽略，严禁提交或输出其内容。
3. 配置本地 `DATABASE_URL` 后执行 `pnpm db:migrate`，再运行 `pnpm alipay:sandbox`。
4. 本地入口为 `http://localhost:3000/community/join`；微信参数结构、签名、应答验签和通知解密由自动化测试覆盖。

微信 Native 没有用于本方案的本地沙箱闭环，真实支付和公网异步通知必须在生产候选环境用一笔真实 ¥9.9 订单验收。

## 5. 管理员与退款

生成管理员密码哈希：

```bash
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
pnpm admin:hash-password
unset ADMIN_PASSWORD
```

只把命令输出保存到 Vercel 的 `ADMIN_PASSWORD_HASH`。部署后登录 `/community/admin`：

- 上传从未公开过的微信群二维码；支持 PNG、JPEG、WebP，最大 2 MB。
- 使用完整商户订单号精确查询订单。
- 由通用退款入口按 `payment_provider` 分发到支付宝或微信，只支持全额原路退款。
- 微信退款处于 `PROCESSING` 时资格继续有效，最终 `SUCCESS` 后立即失效。

如果在支付平台人工退款，必须在确认平台最终退款成功后再同步数据库资格，不能在退款受理时提前撤销。

## 6. 上线顺序

1. 本地完成 `pnpm test`、`pnpm typecheck`、`pnpm build`。
2. 部署生产候选，保持现有支付宝开关不变，并设置 `WECHAT_NATIVE_PAYMENT_ENABLED=false`。
3. 在受信任界面只验证所需变量是否存在，不读取或回显变量值。
4. 执行数据库迁移，确认管理页可登录且私有群码已上传。
5. 获得一次明确的生产写操作授权后，再开启全局开关和微信开关完成一笔真实 ¥9.9 支付。
6. 核对微信平台成功记录、异步通知、数据库 `PAID`、付款会话可读群码、未付款会话返回 403。
7. 从管理页发起全额退款，确认退款最终 `SUCCESS`、数据库 `REFUNDED`，且原付款会话不能再读取群码。
8. 全链路通过后保持 Native 开启；失败时只关闭 `WECHAT_NATIVE_PAYMENT_ENABLED`，支付宝和已有资格继续工作。

生产验收不得使用开发者自己的资金或支付账户。涉及真实支付、退款、数据库迁移、群码替换或生产开关时，必须在执行前列出精确命令或点击动作、目标环境、预期变更和回滚方式，并取得同一份清单的一次性授权。
