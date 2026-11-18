CREATE TABLE processed_events (
    event_id BIGINT PRIMARY KEY,
    payload JSONB NOT NULL,
    deliveries INTEGER NOT NULL DEFAULT 1,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE trip_summary (
    trip_id BIGINT PRIMARY KEY,
    status TEXT NOT NULL,
    price NUMERIC(12, 2) NOT NULL,
    source_version BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
