INSERT INTO passengers (name, phone)
SELECT 'Passenger ' || n, '+79' || LPAD(n::TEXT, 9, '0')
FROM generate_series(1, 10000) AS s(n);

INSERT INTO drivers (name)
SELECT 'Driver ' || n
FROM generate_series(1, 1000) AS s(n);

INSERT INTO trips (
    passenger_id, driver_id, status, price,
    pickup_address, destination_address, created_at
)
SELECT
    1 + (n - 1) % 10000,
    1 + (n - 1) % 1000,
    'completed',
    300 + n % 1000,
    'Лесная улица, 10',
    'Садовая улица, 5',
    TIMESTAMPTZ '2026-01-01 00:00:00+00' + n * INTERVAL '1 second'
FROM generate_series(1, 2000000) AS s(n);

CREATE UNIQUE INDEX trips_one_active_per_passenger
ON trips (passenger_id)
WHERE status IN ('searching', 'accepted', 'in_progress');

CREATE UNIQUE INDEX trips_one_active_per_driver
ON trips (driver_id)
WHERE status IN ('accepted', 'in_progress');

ANALYZE trips;
