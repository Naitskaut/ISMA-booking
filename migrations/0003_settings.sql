-- npx wrangler d1 execute zhk-booking --remote --file=migrations/0003_settings.sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
