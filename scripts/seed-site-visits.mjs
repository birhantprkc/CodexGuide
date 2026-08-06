import { readFile } from "node:fs/promises";

import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

// 把 Vercel Analytics 的历史访问量写成起始基数。
// 用法：
//   node scripts/seed-site-visits.mjs --total 52340
//   node scripts/seed-site-visits.mjs --total 52340 --date 2025-01-01
//   node scripts/seed-site-visits.mjs --csv ~/Downloads/analytics.csv
//   任意用法追加 --dry-run 可只预览不写库。

// 站点上线前的日期，作为历史基数所在行。固定取值，重复执行只覆盖不叠加。
const DEFAULT_BASELINE_DATE = "2025-01-01";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
};
const dryRun = args.includes("--dry-run");

const totalArg = option("total");
const csvArg = option("csv");
const baselineDate = option("date") || DEFAULT_BASELINE_DATE;

if (!totalArg && !csvArg) {
  throw new Error("必须指定 --total <数字> 或 --csv <文件路径>");
}

if (!/^\d{4}-\d{2}-\d{2}$/u.test(baselineDate)) {
  throw new Error(`--date 必须是 YYYY-MM-DD 格式，收到：${baselineDate}`);
}

const positiveInteger = (value, label) => {
  const parsed = Number(String(value).replace(/[,\s]/gu, ""));

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是非负整数，收到：${value}`);
  }

  return parsed;
};

const DATE_HEADERS = ["date", "day", "日期"];
const VALUE_HEADERS = ["visitors", "visits", "views", "pageviews", "page views", "count", "访问"];

const splitCsvLine = (line) => {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  return cells;
};

const findColumn = (headers, candidates, label) => {
  const index = headers.findIndex((header) =>
    candidates.some((candidate) => header.toLowerCase().includes(candidate)),
  );

  if (index === -1) {
    throw new Error(`CSV 里找不到${label}列，表头是：${headers.join(", ")}`);
  }

  return index;
};

const rowsFromCsv = async (path) => {
  const lines = (await readFile(path, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据");

  const headers = splitCsvLine(lines[0]);
  const dateIndex = findColumn(headers, DATE_HEADERS, "日期");
  const valueIndex = findColumn(headers, VALUE_HEADERS, "访问量");

  process.stdout.write(
    `已识别 CSV 列：日期="${headers[dateIndex]}"，访问量="${headers[valueIndex]}"\n`,
  );

  return lines.slice(1).map((line, offset) => {
    const cells = splitCsvLine(line);
    const rawDate = cells[dateIndex];
    const date = new Date(rawDate);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`第 ${offset + 2} 行的日期无法解析：${rawDate}`);
    }

    return {
      visitDate: date.toISOString().slice(0, 10),
      visits: positiveInteger(cells[valueIndex], `第 ${offset + 2} 行的访问量`),
    };
  });
};

const rows = csvArg
  ? await rowsFromCsv(csvArg)
  : [{ visitDate: baselineDate, visits: positiveInteger(totalArg, "--total") }];

const seeded = rows.reduce((sum, row) => sum + row.visits, 0);

process.stdout.write(
  `准备写入 ${rows.length} 行，合计 ${seeded.toLocaleString("zh-CN")} 次访问。\n`,
);
for (const row of rows.slice(0, 5)) {
  process.stdout.write(`  ${row.visitDate}  ${row.visits.toLocaleString("zh-CN")}\n`);
}
if (rows.length > 5) process.stdout.write(`  …其余 ${rows.length - 5} 行省略\n`);

if (dryRun) {
  process.stdout.write("--dry-run 已开启，未连接数据库，也未写入任何数据。\n");
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const hostname = new URL(databaseUrl).hostname;
const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
const localSql = isLocal ? postgres(databaseUrl, { max: 1, prepare: false }) : null;
const neonSql = isLocal ? null : neon(databaseUrl);

const query = async (statement, values) =>
  localSql ? localSql.unsafe(statement, values) : neonSql.query(statement, values);

const readTotal = async () => {
  const result = await query("SELECT COALESCE(SUM(visits), 0) AS total FROM site_visit_daily", []);
  const total = Array.isArray(result) ? result[0]?.total : result?.rows?.[0]?.total;
  return Number(total ?? 0);
};

try {
  const before = await readTotal();

  for (const row of rows) {
    // 覆盖而非累加，重复执行同一份数据不会把总数翻倍。
    await query(
      `INSERT INTO site_visit_daily (visit_date, visits)
       VALUES ($1::date, $2::bigint)
       ON CONFLICT (visit_date) DO UPDATE
         SET visits = EXCLUDED.visits, updated_at = NOW()`,
      [row.visitDate, row.visits],
    );
  }

  const after = await readTotal();
  process.stdout.write(
    `累计访问：${before.toLocaleString("zh-CN")} → ${after.toLocaleString("zh-CN")}\n`,
  );
} finally {
  if (localSql) await localSql.end();
}
