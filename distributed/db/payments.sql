CREATE TABLE reservations (
    id text PRIMARY KEY,
    amount integer NOT NULL CHECK (amount > 0),
    state text NOT NULL CHECK (state IN ('reserved', 'released'))
);
