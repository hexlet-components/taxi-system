CREATE TABLE receipts (
    operation_key TEXT PRIMARY KEY,
    trip_id BIGINT NOT NULL,
    payload JSONB NOT NULL,
    requests INTEGER NOT NULL DEFAULT 1,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
