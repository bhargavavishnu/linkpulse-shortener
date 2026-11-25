CREATE TABLE IF NOT EXISTS short_links (
  id BIGSERIAL PRIMARY KEY,
  short_code VARCHAR(24) UNIQUE NOT NULL,
  original_url TEXT NOT NULL,
  custom_alias BOOLEAN NOT NULL DEFAULT FALSE,
  click_count BIGINT NOT NULL DEFAULT 0,
  is_hot BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS click_events (
  id BIGSERIAL PRIMARY KEY,
  short_link_id BIGINT NOT NULL REFERENCES short_links(id) ON DELETE CASCADE,
  referrer VARCHAR(255) NOT NULL DEFAULT 'direct',
  device_type VARCHAR(32) NOT NULL DEFAULT 'desktop',
  user_agent TEXT NOT NULL DEFAULT '',
  ip_hash VARCHAR(64) NOT NULL DEFAULT '',
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_short_links_clicks ON short_links(click_count DESC);
CREATE INDEX IF NOT EXISTS idx_click_events_link_time ON click_events(short_link_id, clicked_at DESC);

CREATE OR REPLACE VIEW daily_click_stats AS
SELECT
  short_link_id,
  DATE_TRUNC('day', clicked_at)::date AS day,
  COUNT(*)::int AS clicks,
  COUNT(*) FILTER (WHERE device_type = 'mobile')::int AS mobile_clicks,
  COUNT(*) FILTER (WHERE device_type = 'desktop')::int AS desktop_clicks,
  COUNT(*) FILTER (WHERE device_type = 'tablet')::int AS tablet_clicks
FROM click_events
GROUP BY short_link_id, DATE_TRUNC('day', clicked_at)::date;

CREATE OR REPLACE VIEW weekly_click_stats AS
SELECT
  short_link_id,
  DATE_TRUNC('week', clicked_at)::date AS week_start,
  COUNT(*)::int AS clicks,
  COUNT(DISTINCT referrer)::int AS unique_referrers
FROM click_events
GROUP BY short_link_id, DATE_TRUNC('week', clicked_at)::date;
