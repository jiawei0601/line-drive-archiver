-- Module DB-MOD: Physical table DDL (PostgreSQL 15+)

-- Image task ledger
CREATE TABLE IF NOT EXISTS image_tasks (
  id              SERIAL PRIMARY KEY,
  message_id      VARCHAR(50)  NOT NULL UNIQUE,
  user_id         VARCHAR(50)  NOT NULL,
  group_id        VARCHAR(50),
  line_timestamp  BIGINT       NOT NULL,
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  retry_count     INT          NOT NULL DEFAULT 0,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks(status);
CREATE INDEX IF NOT EXISTS idx_image_tasks_msg_id ON image_tasks(message_id);

-- Sentinel chat history buffer (context window source)
CREATE TABLE IF NOT EXISTS chat_history (
  id              SERIAL PRIMARY KEY,
  message_id      VARCHAR(50)  NOT NULL UNIQUE,
  user_id         VARCHAR(50)  NOT NULL,
  group_id        VARCHAR(50),
  text_content    TEXT         NOT NULL,
  line_timestamp  BIGINT       NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user_time ON chat_history(user_id, line_timestamp);

-- High-concurrency PostgreSQL parameter tuning (DB-MOD §6.1.2)
-- Run after tables are created; requires SUPERUSER on Railway managed Postgres
ALTER SYSTEM SET max_connections = 200;
ALTER SYSTEM SET shared_buffers = '2GB';
ALTER SYSTEM SET effective_cache_size = '6GB';
ALTER SYSTEM SET maintenance_work_mem = '512MB';
ALTER SYSTEM SET work_mem = '32MB';
ALTER SYSTEM SET max_worker_processes = 8;
SELECT pg_reload_conf();
