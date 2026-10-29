CREATE TABLE trips (
    id bigint PRIMARY KEY,
    status text NOT NULL,
    amount_cents bigint NOT NULL
);
INSERT INTO trips VALUES (701, 'requested', 90000);
