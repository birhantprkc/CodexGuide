<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import {
  loadCommunityRuntimeConfig,
  redirectToCommunityOrigin,
} from "../community-runtime.js";

const authenticated = ref(false);
const checking = ref(true);
const password = ref("");
const selectedFile = ref<File | null>(null);
const previewUrl = ref<string | null>(null);
const message = ref("正在检查管理员登录状态…");
const busy = ref(false);
const orderId = ref("");
const refundReason = ref("用户申请退款");
const order = ref<{
  amountCents: number;
  createdAt: string;
  orderId: string;
  paidAt: string | null;
  paymentProduct: string;
  paymentProvider: string;
  refundStatus: string | null;
  refundedAt: string | null;
  status: string;
} | null>(null);

const clearPreview = (): void => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = null;
};

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as { error?: { message?: string } };
    return data.error?.message || "请求失败。";
  } catch {
    return "请求失败。";
  }
};

const loadCurrentQr = async (): Promise<void> => {
  clearPreview();
  const response = await fetch("/api/admin/group-qr", { cache: "no-store" });
  if (response.status === 404) {
    message.value = "尚未上传群二维码，请选择图片。";
    return;
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  previewUrl.value = URL.createObjectURL(await response.blob());
  message.value = "当前生效的群二维码如下。";
};

const checkSession = async (): Promise<void> => {
  const response = await fetch("/api/admin/session", { cache: "no-store" });
  if (!response.ok) throw new Error(await errorMessage(response));
  const data = (await response.json()) as { authenticated: boolean };
  authenticated.value = data.authenticated;
  checking.value = false;
  if (authenticated.value) await loadCurrentQr();
  else message.value = "请输入管理员密码。";
};

const login = async (): Promise<void> => {
  busy.value = true;
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    password.value = "";
    authenticated.value = true;
    await loadCurrentQr();
  } catch (error) {
    message.value = error instanceof Error ? error.message : "登录失败。";
  } finally {
    busy.value = false;
  }
};

const chooseFile = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  selectedFile.value = input.files?.[0] || null;
  if (selectedFile.value) {
    clearPreview();
    previewUrl.value = URL.createObjectURL(selectedFile.value);
    message.value = "请确认预览，上传后将立即替换当前群码。";
  }
};

const upload = async (): Promise<void> => {
  if (!selectedFile.value) return;
  busy.value = true;
  try {
    const form = new FormData();
    form.append("groupQr", selectedFile.value);
    const response = await fetch("/api/admin/group-qr", { method: "POST", body: form });
    if (!response.ok) throw new Error(await errorMessage(response));
    selectedFile.value = null;
    await loadCurrentQr();
    message.value = "群二维码已替换并立即生效。";
  } catch (error) {
    message.value = error instanceof Error ? error.message : "上传失败。";
  } finally {
    busy.value = false;
  }
};

const lookupOrder = async (): Promise<void> => {
  const target = orderId.value.trim().toUpperCase();
  if (!target) return;
  busy.value = true;
  try {
    const response = await fetch(`/api/admin/orders?id=${encodeURIComponent(target)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    order.value = await response.json();
    orderId.value = order.value?.orderId || target;
    message.value = "订单已找到，请核对支付渠道与状态后再操作。";
  } catch (error) {
    order.value = null;
    message.value = error instanceof Error ? error.message : "订单查询失败。";
  } finally {
    busy.value = false;
  }
};

const refundOrder = async (): Promise<void> => {
  if (!order.value || order.value.status !== "PAID") return;
  busy.value = true;
  try {
    const response = await fetch("/api/admin/refunds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.value.orderId, reason: refundReason.value }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const result = (await response.json()) as { status: string };
    await lookupOrder();
    message.value = result.status === "REFUNDED"
      ? "退款已成功，入群资格已撤销。"
      : `退款当前状态：${result.status}。成功后才会撤销资格。`;
  } catch (error) {
    message.value = error instanceof Error ? error.message : "退款发起失败。";
  } finally {
    busy.value = false;
  }
};

const queryRefund = async (): Promise<void> => {
  if (!order.value) return;
  busy.value = true;
  try {
    const response = await fetch(
      `/api/admin/refunds?id=${encodeURIComponent(order.value.orderId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
    const result = (await response.json()) as { status: string };
    await lookupOrder();
    message.value = result.status === "REFUNDED"
      ? "退款已成功，入群资格已撤销。"
      : `退款当前状态：${result.status}。`;
  } catch (error) {
    message.value = error instanceof Error ? error.message : "退款状态查询失败。";
  } finally {
    busy.value = false;
  }
};

const logout = async (): Promise<void> => {
  await fetch("/api/admin/logout", { method: "POST" });
  authenticated.value = false;
  selectedFile.value = null;
  clearPreview();
  message.value = "已退出管理页。";
};

onMounted(async () => {
  try {
    const runtime = await loadCommunityRuntimeConfig();
    if (redirectToCommunityOrigin(runtime.communityOrigin)) return;
    await checkSession();
  } catch (error) {
    checking.value = false;
    message.value = error instanceof Error ? error.message : "管理服务暂时不可用。";
  }
});

onBeforeUnmount(clearPreview);
</script>

<template>
  <main class="community-admin-shell">
    <h1>付费交流群管理</h1>
    <p class="community-admin-message" role="status">{{ message }}</p>

    <form v-if="!checking && !authenticated" class="community-admin-card" @submit.prevent="login">
      <label for="community-admin-password">管理员密码</label>
      <input
        id="community-admin-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        maxlength="256"
        required
      >
      <button type="submit" :disabled="busy || password.length < 1">{{ busy ? "登录中…" : "登录" }}</button>
    </form>

    <section v-if="authenticated" class="community-admin-card">
      <h2>群二维码</h2>
      <img v-if="previewUrl" :src="previewUrl" alt="当前或待上传的微信群二维码预览">
      <label class="community-admin-file">
        <span>选择新的群二维码</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" @change="chooseFile">
      </label>
      <button type="button" :disabled="busy || !selectedFile" @click="upload">
        {{ busy ? "上传中…" : "确认替换" }}
      </button>
    </section>

    <section v-if="authenticated" class="community-admin-card">
      <h2>订单与退款</h2>
      <form class="community-admin-order-search" @submit.prevent="lookupOrder">
        <label for="community-order-id">商户订单号</label>
        <input
          id="community-order-id"
          v-model="orderId"
          type="text"
          autocomplete="off"
          maxlength="32"
          placeholder="CG…"
          required
        >
        <button type="submit" :disabled="busy || !orderId.trim()">精确查询</button>
      </form>

      <dl v-if="order" class="community-admin-order-detail">
        <div><dt>订单号</dt><dd>{{ order.orderId }}</dd></div>
        <div><dt>渠道</dt><dd>{{ order.paymentProvider }} / {{ order.paymentProduct }}</dd></div>
        <div><dt>金额</dt><dd>¥{{ (order.amountCents / 100).toFixed(2) }}</dd></div>
        <div><dt>订单状态</dt><dd>{{ order.status }}</dd></div>
        <div><dt>退款状态</dt><dd>{{ order.refundStatus || "未申请" }}</dd></div>
        <div><dt>支付时间</dt><dd>{{ order.paidAt || "—" }}</dd></div>
        <div><dt>退款时间</dt><dd>{{ order.refundedAt || "—" }}</dd></div>
      </dl>

      <template v-if="order">
        <label for="community-refund-reason">退款原因</label>
        <input
          id="community-refund-reason"
          v-model="refundReason"
          type="text"
          maxlength="80"
        >
        <button type="button" :disabled="busy || order.status !== 'PAID'" @click="refundOrder">
          发起全额原路退款
        </button>
        <button
          class="community-admin-secondary"
          type="button"
          :disabled="busy || !order.refundStatus"
          @click="queryRefund"
        >查询退款状态</button>
      </template>
    </section>

    <button
      v-if="authenticated"
      class="community-admin-logout"
      type="button"
      @click="logout"
    >退出登录</button>
  </main>
</template>

<style scoped>
:global(.theme-container:has(.community-admin-shell) .vp-page-title) {
  display: none;
}

.community-admin-shell {
  width: min(100%, 34rem);
  margin: 0 auto;
  padding: 2rem 0 5rem;
}

.community-admin-shell h1 { text-align: center; }

.community-admin-message {
  min-height: 1.6rem;
  color: var(--vp-c-text-mute);
  text-align: center;
}

.community-admin-card {
  display: grid;
  gap: 1rem;
  margin-top: 1.5rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  padding: 1.25rem;
  background: var(--vp-c-bg);
}

.community-admin-card input[type="password"],
.community-admin-card input[type="text"] {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  padding: 0.75rem;
  color: var(--vp-c-text);
  background: var(--vp-c-bg);
  font: inherit;
}

.community-admin-card img {
  display: block;
  width: min(100%, 22rem);
  margin: 0 auto;
  border: 1px solid var(--vp-c-border);
  border-radius: 10px;
  background: #fff;
}

.community-admin-card button {
  border: 0;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  color: #fff;
  background: var(--vp-c-accent);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.community-admin-card button:disabled { cursor: not-allowed; opacity: 0.5; }
.community-admin-card .community-admin-secondary { background: #64748b; }

.community-admin-logout {
  display: block;
  width: 100%;
  margin-top: 1.5rem;
  border: 0;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  color: #fff;
  background: #64748b;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.community-admin-card h2 { margin: 0; border: 0; padding: 0; font-size: 1.1rem; }
.community-admin-order-search { display: grid; gap: 0.75rem; }
.community-admin-order-detail { display: grid; gap: 0.6rem; margin: 0; }
.community-admin-order-detail div { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: 0.75rem; }
.community-admin-order-detail dt { color: var(--vp-c-text-mute); }
.community-admin-order-detail dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }

.community-admin-file {
  display: grid;
  gap: 0.5rem;
  color: var(--vp-c-text-mute);
}
</style>
