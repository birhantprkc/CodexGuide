CREATE TABLE IF NOT EXISTS site_visit_daily (
  visit_date DATE PRIMARY KEY,
  visits BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_visit_visitors (
  visitor_hash CHAR(64) NOT NULL,
  visit_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (visitor_hash, visit_date)
);

CREATE INDEX IF NOT EXISTS site_visit_visitors_date_idx
  ON site_visit_visitors (visit_date);
