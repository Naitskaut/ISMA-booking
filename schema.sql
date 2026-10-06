-- Квартиры и хэши их кодов (сами коды не хранятся)
CREATE TABLE IF NOT EXISTS apartments (
  label      TEXT PRIMARY KEY,          -- номер квартиры, например "45" или "2-45"
  code_hash  TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Брони: один день — одна бронь, одна квартира — одна бронь в месяц
CREATE TABLE IF NOT EXISTS bookings (
  date       TEXT PRIMARY KEY,          -- YYYY-MM-DD
  month      TEXT NOT NULL,             -- YYYY-MM
  apartment  TEXT NOT NULL REFERENCES apartments(label) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (apartment, month)
);

CREATE INDEX IF NOT EXISTS bookings_month ON bookings(month);

-- Защита от подбора кодов и пароля
CREATE TABLE IF NOT EXISTS attempts (
  key          TEXT PRIMARY KEY,        -- "apt:45" или "admin:<ip>"
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, -- unix-время в секундах
  last_failure INTEGER NOT NULL DEFAULT 0  -- время последней ошибки
);

-- Настройки из админки: контакт, правила, срок отмены (значения в JSON)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
