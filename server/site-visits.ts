import { createHmac } from "node:crypto";

import { db } from "./db.js";

export type SiteVisitStats = { today: number; total: number };

// 站点面向中文读者，"今日"以东八区自然日为准。
const SITE_TIMEZONE = "Asia/Shanghai";
const VISITOR_RETENTION_DAYS = 3;
const PRUNE_PROBABILITY = 0.01;

const BOT_PATTERN =
  /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python-requests|axios|node-fetch|lighthouse/iu;

const visitorSalt = (): string =>
  process.env.SITE_VISIT_HASH_SECRET?.trim() ||
  process.env.COMMUNITY_BUYER_HMAC_SECRET?.trim() ||
  "codexguide-site-visits";

// 只保存不可逆摘要：同一访客同一天记一次，隔天摘要即失效，不留存原始 IP。
export const visitorHash = (ip: string, userAgent: string): string =>
  createHmac("sha256", visitorSalt()).update(`${ip}\n${userAgent}`).digest("hex");

export const isAutomatedVisitor = (userAgent: string): boolean =>
  userAgent.trim().length === 0 || BOT_PATTERN.test(userAgent);

const count = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// 计数只用于展示，容忍一分钟延迟换取数据库压力下降一到两个数量级。
export const SITE_VISIT_CACHE_SECONDS = 60;

const CACHE_TTL_MS = SITE_VISIT_CACHE_SECONDS * 1000;

// 函数实例级缓存。多实例各自持有一份，最差情况是每个实例每分钟查一次。
let cache: { expiresAt: number; stats: SiteVisitStats } | null = null;

const cachedStats = (): SiteVisitStats | null =>
  cache && cache.expiresAt > Date.now() ? cache.stats : null;

const storeStats = (stats: SiteVisitStats): SiteVisitStats => {
  cache = { expiresAt: Date.now() + CACHE_TTL_MS, stats };
  return stats;
};

const fetchStats = async (): Promise<SiteVisitStats> => {
  const sql = db();
  const rows = (await sql`
    WITH today AS (
      SELECT (NOW() AT TIME ZONE ${SITE_TIMEZONE})::date AS visit_date
    )
    SELECT
      COALESCE(
        (SELECT visits FROM site_visit_daily WHERE visit_date = (SELECT visit_date FROM today)),
        0
      ) AS today_visits,
      COALESCE((SELECT SUM(visits) FROM site_visit_daily), 0) AS total_visits
  `) as Array<{ today_visits: unknown; total_visits: unknown }>;

  return {
    today: count(rows[0]?.today_visits),
    total: count(rows[0]?.total_visits),
  };
};

export const readSiteVisitStats = async (): Promise<SiteVisitStats> =>
  cachedStats() ?? storeStats(await fetchStats());

const pruneVisitors = async (): Promise<void> => {
  const sql = db();
  await sql`
    DELETE FROM site_visit_visitors
    WHERE visit_date < (NOW() AT TIME ZONE ${SITE_TIMEZONE})::date
      - ${VISITOR_RETENTION_DAYS}::int
  `;
};

export const recordSiteVisit = async (hash: string): Promise<SiteVisitStats> => {
  const sql = db();

  // 认领与累加放在同一条语句里，保证同一访客并发刷新只会计一次。
  // RETURNING 直接带回今日计数，省掉写入后的那次汇总查询。
  const rows = (await sql`
    WITH today AS (
      SELECT (NOW() AT TIME ZONE ${SITE_TIMEZONE})::date AS visit_date
    ),
    claimed AS (
      INSERT INTO site_visit_visitors (visitor_hash, visit_date)
      SELECT ${hash}, visit_date FROM today
      ON CONFLICT (visitor_hash, visit_date) DO NOTHING
      RETURNING visit_date
    )
    INSERT INTO site_visit_daily (visit_date, visits)
    SELECT visit_date, 1 FROM claimed
    ON CONFLICT (visit_date) DO UPDATE
      SET visits = site_visit_daily.visits + 1, updated_at = NOW()
    RETURNING visits
  `) as Array<{ visits: unknown }>;

  if (Math.random() < PRUNE_PROBABILITY) await pruneVisitors();

  // 老访客当天重复访问：计数没有变化，缓存即可。
  if (rows.length === 0) return readSiteVisitStats();

  const snapshot = cachedStats();

  // 新访客：今日数由数据库带回，累计数在缓存基础上加一，整个写路径只需一次查询。
  // 多实例并发时累计数可能短暂偏小，缓存过期后自动回到真实值。
  return snapshot
    ? storeStats({ today: count(rows[0].visits), total: snapshot.total + 1 })
    : storeStats(await fetchStats());
};
