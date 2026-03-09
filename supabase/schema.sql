-- SkeinBook Beta Users
-- Run in Supabase SQL Editor (or via supabase db push)

CREATE TABLE beta_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  beta_key TEXT UNIQUE NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT now(),
  download_count INTEGER DEFAULT 0,
  last_download TIMESTAMPTZ,
  platform TEXT,              -- 'windows' | 'mac-x64' | 'mac-arm64' | 'linux'
  notes TEXT                  -- internal notes about this tester
);

-- Fast key lookups from the Worker
CREATE INDEX idx_beta_users_key ON beta_users(beta_key);

-- Row Level Security: table is private, no public policies.
-- The Cloudflare Worker connects via the service_role key.
ALTER TABLE beta_users ENABLE ROW LEVEL SECURITY;

-- Helper: generate a random beta key like "SB-a1b2c3d4"
-- Usage:  INSERT INTO beta_users (email, beta_key) VALUES ('tester@example.com', 'SB-' || substr(md5(random()::text), 1, 8));
