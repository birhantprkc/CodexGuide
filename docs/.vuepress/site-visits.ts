export type SiteVisitStats = { today: number; total: number };

const ENDPOINT = "/api/site/visits";
const SESSION_KEY = "codexguide-visit-recorded";

let pending: Promise<SiteVisitStats | null> | null = null;

const alreadyRecorded = (): boolean => {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
};

const rememberRecorded = (): void => {
  try {
    window.sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    // 隐私模式下 sessionStorage 不可用，仅退化为每次请求都上报，服务端仍按天去重。
  }
};

const requestStats = async (): Promise<SiteVisitStats | null> => {
  // 同一浏览器会话只上报一次，其余情况仅读取计数。
  const recorded = alreadyRecorded();
  const response = await fetch(ENDPOINT, {
    method: recorded ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!response.ok) return null;

  const data = (await response.json()) as Partial<SiteVisitStats>;

  if (!Number.isFinite(data.today) || !Number.isFinite(data.total)) return null;

  if (!recorded) rememberRecorded();

  return { today: Number(data.today), total: Number(data.total) };
};

export const loadSiteVisitStats = (): Promise<SiteVisitStats | null> => {
  if (typeof window === "undefined") return Promise.resolve(null);

  // 统计服务未配置或暂时不可用时静默降级，不影响页面其他内容。
  pending ??= requestStats().catch(() => null);

  return pending;
};
