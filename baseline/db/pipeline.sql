CREATE TABLE event_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id BIGINT NOT NULL REFERENCES trips (id),
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ
);
CREATE TABLE notification_jobs (
    id BIGINT PRIMARY KEY REFERENCES trips (id),
    operation_key TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    delivered_at TIMESTAMPTZ
);
CREATE FUNCTION record_trip_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO event_outbox (trip_id, payload)
    VALUES (NEW.id, jsonb_build_object(
        'trip_id', NEW.id::TEXT, 'status', NEW.status, 'price', NEW.price
    ));
    IF TG_OP = 'INSERT' THEN
        INSERT INTO notification_jobs (id, operation_key, payload)
        VALUES (NEW.id, 'trip-created/' || NEW.id, jsonb_build_object(
            'event', 'trip_created', 'tripId', NEW.id
        ));
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trip_change AFTER INSERT OR UPDATE ON trips
FOR EACH ROW EXECUTE FUNCTION record_trip_change();
