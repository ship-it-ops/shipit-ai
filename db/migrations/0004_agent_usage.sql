-- 0004_agent_usage.sql: what each agent spends per day.
--
-- Applied by the migration step, never by the app at boot. Forward-only.
--
-- The daily token cap has to count tokens on the day they are spent. Summing
-- runs by their creation day misses a chat that stays active past midnight,
-- and a chat's other limits reset with every question, so nothing else bounds
-- it. One row per agent and UTC day, added to in the same transaction as the
-- run's own counters.

CREATE TABLE agent_usage_daily (
  agent_id       uuid NOT NULL REFERENCES agents (id),
  -- The UTC date the tokens were spent on.
  day            date NOT NULL,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);
