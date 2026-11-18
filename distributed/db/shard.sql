CREATE TABLE shard_control (
    city integer PRIMARY KEY,
    version integer NOT NULL,
    active boolean NOT NULL,
    generation integer NOT NULL DEFAULT 0,
    transfer_id uuid,
    snapshot_hash text
);
CREATE TABLE drivers (
    city integer NOT NULL REFERENCES shard_control (city),
    id integer NOT NULL,
    version integer NOT NULL DEFAULT 1,
    PRIMARY KEY (city, id)
);
CREATE TABLE bookings (
    city integer NOT NULL,
    id uuid NOT NULL,
    driver integer NOT NULL,
    amount integer NOT NULL CHECK (amount > 0),
    state text NOT NULL CHECK (state IN ('reserving', 'confirmed', 'compensating', 'cancelled', 'completed', 'blocked')),
    cancel_requested boolean NOT NULL DEFAULT false,
    PRIMARY KEY (city, id),
    FOREIGN KEY (city, driver) REFERENCES drivers (city, id)
);
CREATE UNIQUE INDEX one_active_trip ON bookings (city, driver)
WHERE state IN ('reserving', 'confirmed', 'compensating', 'blocked');
CREATE TABLE outbox (
    city integer NOT NULL,
    booking uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('reserve', 'release')),
    done boolean NOT NULL DEFAULT false,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    next_attempt timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (city, booking, action),
    FOREIGN KEY (city, booking) REFERENCES bookings (city, id)
);
