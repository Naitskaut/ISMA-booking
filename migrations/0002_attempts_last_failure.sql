-- Для баз, созданных до появления окна ошибок:
-- npx wrangler d1 execute zhk-booking --remote --file=migrations/0002_attempts_last_failure.sql
ALTER TABLE attempts ADD COLUMN last_failure INTEGER NOT NULL DEFAULT 0;
