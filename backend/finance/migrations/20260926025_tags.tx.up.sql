-- Etiquetas: marcas transversales a la categoría (viaje, trabajo, deducible).
-- name_key es el nombre en minúsculas: evita "Viaje" y "viaje" duplicadas.
CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER   NOT NULL,
    name       TEXT      NOT NULL,
    name_key   TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_key ON tags(user_id, name_key);

--bun:split
-- Qué etiquetas lleva cada gasto (sin user_id propio: se escribe sólo tras
-- comprobar que el gasto y la etiqueta son del perfil).
CREATE TABLE IF NOT EXISTS expense_tags (
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (expense_id, tag_id)
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_expense_tags_tag ON expense_tags(tag_id);
