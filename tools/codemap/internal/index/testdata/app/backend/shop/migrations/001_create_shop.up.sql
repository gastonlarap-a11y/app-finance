CREATE TABLE IF NOT EXISTS items (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE carts_old (
    id INTEGER PRIMARY KEY
);

-- DROP TABLE items; (a comment: must not drop anything)
CREATE TABLE legacy (
    id INTEGER PRIMARY KEY
);
