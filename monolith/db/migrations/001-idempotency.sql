-- Ключ операции. Повтор запроса после потери ответа возвращает прежнюю
-- поездку, потому что ключ уникален и хранится вместе с её идентификатором.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(128) PRIMARY KEY,
    trip_id BIGINT NOT NULL REFERENCES trips (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
