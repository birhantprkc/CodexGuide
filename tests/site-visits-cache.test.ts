import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.hoisted(() => vi.fn());

vi.mock("../server/db.js", () => ({ db: () => sql }));

type VisitModule = typeof import("../server/site-visits.js");

// 缓存是模块级状态，每个用例重新加载模块以获得干净的起点。
const freshModule = async (): Promise<VisitModule> => {
  vi.resetModules();
  return import("../server/site-visits.js");
};

const statsRow = (today: number, total: number) => [
  { today_visits: String(today), total_visits: String(total) },
];

describe("visit counter caching", () => {
  beforeEach(() => {
    sql.mockReset();
    vi.useFakeTimers();
    // 关闭随机清理，避免额外查询干扰调用计数。
    vi.spyOn(Math, "random").mockReturnValue(0.99);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("serves repeated reads from memory instead of the database", async () => {
    const { readSiteVisitStats } = await freshModule();
    sql.mockResolvedValue(statsRow(7, 900));

    expect(await readSiteVisitStats()).toEqual({ today: 7, total: 900 });
    expect(await readSiteVisitStats()).toEqual({ today: 7, total: 900 });
    expect(await readSiteVisitStats()).toEqual({ today: 7, total: 900 });

    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the cache window elapses", async () => {
    const { readSiteVisitStats, SITE_VISIT_CACHE_SECONDS } = await freshModule();
    sql.mockResolvedValue(statsRow(7, 900));

    await readSiteVisitStats();
    vi.advanceTimersByTime(SITE_VISIT_CACHE_SECONDS * 1000 - 1);
    await readSiteVisitStats();
    expect(sql).toHaveBeenCalledTimes(1);

    sql.mockResolvedValue(statsRow(9, 902));
    vi.advanceTimersByTime(2);

    expect(await readSiteVisitStats()).toEqual({ today: 9, total: 902 });
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("records a new visitor with a single query and updates the cache", async () => {
    const { readSiteVisitStats, recordSiteVisit } = await freshModule();

    sql.mockResolvedValueOnce(statsRow(7, 900));
    await readSiteVisitStats();

    // 写入语句通过 RETURNING 带回今日计数，无需再查一次汇总。
    sql.mockResolvedValueOnce([{ visits: "8" }]);
    expect(await recordSiteVisit("a".repeat(64))).toEqual({ today: 8, total: 901 });
    expect(sql).toHaveBeenCalledTimes(2);

    // 后续读取直接命中刚更新的缓存。
    expect(await readSiteVisitStats()).toEqual({ today: 8, total: 901 });
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("leaves the counters untouched when the same visitor returns", async () => {
    const { recordSiteVisit } = await freshModule();

    sql.mockResolvedValueOnce([{ visits: "8" }]);
    sql.mockResolvedValueOnce(statsRow(8, 901));
    await recordSiteVisit("a".repeat(64));

    // 当天重复访问：认领失败，写入语句返回空行，计数保持不变。
    sql.mockResolvedValueOnce([]);
    expect(await recordSiteVisit("a".repeat(64))).toEqual({ today: 8, total: 901 });
  });

  it("falls back to a full read when nothing is cached yet", async () => {
    const { recordSiteVisit } = await freshModule();

    sql.mockResolvedValueOnce([{ visits: "1" }]);
    sql.mockResolvedValueOnce(statsRow(1, 52_341));

    expect(await recordSiteVisit("b".repeat(64))).toEqual({ today: 1, total: 52_341 });
    expect(sql).toHaveBeenCalledTimes(2);
  });
});
