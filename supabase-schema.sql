-- Exécuter dans le SQL Editor de Supabase

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  title TEXT,
  lead_outcome TEXT,
  probability FLOAT,
  threshold FLOAT,
  press_status TEXT DEFAULT 'checking',
  press_headline TEXT,
  press_source TEXT,
  press_summary TEXT,
  detected_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  name TEXT,
  score INT,
  hot_count INT,
  event_count INT,
  avg_probability FLOAT,
  top_event_title TEXT,
  top_event_probability FLOAT,
  event_ids TEXT[],
  computed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE threat_history (
  id BIGSERIAL PRIMARY KEY,
  score INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE poll_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION trim_threat_history()
RETURNS void AS $$
  DELETE FROM threat_history
  WHERE id NOT IN (
    SELECT id FROM threat_history ORDER BY created_at DESC LIMIT 1000
  );
$$ LANGUAGE sql;
