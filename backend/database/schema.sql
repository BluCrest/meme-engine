-- Core token registry
CREATE TABLE IF NOT EXISTS tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT UNIQUE NOT NULL,
  symbol TEXT,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  launch_mc NUMERIC,
  current_mc NUMERIC,
  peak_mc NUMERIC,

  -- Safety scores
  safety_score INTEGER,
  honeypot BOOLEAN DEFAULT FALSE,
  liquidity_locked BOOLEAN,
  liquidity_lock_duration INTEGER,
  ownership_renounced BOOLEAN,
  top5_wallet_concentration NUMERIC,

  -- Social scores
  social_score INTEGER,
  virality_velocity NUMERIC,
  x_mentions_1h INTEGER,
  x_mentions_6h INTEGER,
  x_engagement_rate NUMERIC,

  -- Intelligence scores
  smart_money_score INTEGER,
  bundle_detected BOOLEAN DEFAULT FALSE,
  wallet_cluster_risk TEXT,

  -- Dev profile
  dev_wallet TEXT,
  dev_reputation_score INTEGER,
  dev_type TEXT,

  -- Final scores
  ape_probability INTEGER,
  moonshot_probability INTEGER,
  absolute_moonshot_probability INTEGER,

  -- Pump.fun specific
  bonding_curve_progress NUMERIC,
  graduated BOOLEAN DEFAULT FALSE,

  -- Pre-launch flag
  detected_prelaunch BOOLEAN DEFAULT FALSE,
  prelaunch_lead_time_seconds INTEGER,

  -- Status
  status TEXT DEFAULT 'new',
  alert_sent BOOLEAN DEFAULT FALSE
);

-- Dev reputation
CREATE TABLE IF NOT EXISTS dev_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT UNIQUE NOT NULL,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  total_launches INTEGER DEFAULT 0,
  rug_count INTEGER DEFAULT 0,
  avg_peak_mc NUMERIC,
  avg_time_to_rug_hours NUMERIC,
  avg_return_at_peak NUMERIC,
  bundle_history BOOLEAN DEFAULT FALSE,
  reputation_score INTEGER,
  label TEXT,

  -- Cross-chain fields
  eth_wallet TEXT,
  base_wallet TEXT,
  cross_chain_rugs INTEGER DEFAULT 0,
  cross_chain_flag BOOLEAN DEFAULT FALSE,

  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Dev launches
CREATE TABLE IF NOT EXISTS dev_launches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dev_wallet TEXT REFERENCES dev_profiles(wallet_address),
  token_address TEXT,
  chain TEXT DEFAULT 'solana',
  launched_at TIMESTAMPTZ,
  peak_mc NUMERIC,
  rugged BOOLEAN,
  time_to_rug_hours NUMERIC,
  peak_return NUMERIC
);

-- Wallet tracking
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT UNIQUE NOT NULL,
  label TEXT,
  total_trades INTEGER DEFAULT 0,
  win_rate NUMERIC,
  avg_entry_mc NUMERIC,
  avg_exit_return NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Wallet positions
CREATE TABLE IF NOT EXISTS wallet_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT,
  token_address TEXT,
  buy_amount_sol NUMERIC,
  buy_mc NUMERIC,
  sell_mc NUMERIC,
  return_multiple NUMERIC,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Your trades
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT,
  action TEXT,
  sol_amount NUMERIC,
  token_amount NUMERIC,
  price_at_trade NUMERIC,
  mc_at_trade NUMERIC,
  tx_signature TEXT,
  mode TEXT,
  triggered_by TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Open positions
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT UNIQUE,
  entry_price NUMERIC,
  entry_mc NUMERIC,
  sol_invested NUMERIC,
  remaining_ratio NUMERIC DEFAULT 1.0,
  highest_price NUMERIC,
  status TEXT DEFAULT 'open',
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- Intelligence reports
CREATE TABLE IF NOT EXISTS intelligence_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT,
  symbol TEXT,
  entry_mc NUMERIC,
  exit_mc NUMERIC,
  return_multiple NUMERIC,
  safety_score_at_entry INTEGER,
  social_score_at_entry INTEGER,
  smart_money_score_at_entry INTEGER,
  ape_probability_at_entry INTEGER,
  dev_type TEXT,
  bundle_detected BOOLEAN,
  outcome TEXT,
  notes TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Social signals log
CREATE TABLE IF NOT EXISTS social_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT,
  platform TEXT,
  signal_type TEXT,
  content TEXT,
  author TEXT,
  author_followers INTEGER,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- DeepSeek pattern library
CREATE TABLE IF NOT EXISTS deepseek_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT,
  description TEXT,
  win_rate NUMERIC,
  sample_size INTEGER,
  conditions JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pre-launch detections
CREATE TABLE IF NOT EXISTS prelaunch_detections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dev_wallet TEXT,
  token_name TEXT,
  token_symbol TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  tg_group TEXT,
  tg_message TEXT,
  dev_profile_preloaded BOOLEAN DEFAULT FALSE,
  token_address TEXT,
  went_live_at TIMESTAMPTZ,
  lead_time_seconds INTEGER
);

-- Momentum divergence signals
CREATE TABLE IF NOT EXISTS divergence_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  price_change_pct NUMERIC,
  wallet_sell_pct NUMERIC,
  divergence_score NUMERIC,
  action_taken TEXT
);