CREATE TABLE IF NOT EXISTS period_salaries (
    period TEXT PRIMARY KEY,
    amount TEXT NOT NULL DEFAULT '0'
);

--bun:split
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(name);
