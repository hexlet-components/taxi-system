-- Два миллиона поездок для шага про индексы. Заливается вручную, потому что
-- на таком объёме initdb стенда идёт минуты.
-- CASCADE нужен потому, что миграции добавляют таблицы, ссылающиеся на
-- поездки, и без него заливка падает на внешнем ключе.
TRUNCATE trip_events, trips, drivers, passengers RESTART IDENTITY CASCADE;

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
    300 + n % 10000,
    'Лесная улица, 10',
    'Садовая улица, 5',
    TIMESTAMPTZ '2026-01-01 00:00:00+00' + n * INTERVAL '1 second'
FROM generate_series(1, 2000000) AS s(n);

UPDATE trips AS t
SET pickup_address = sample.address
FROM (VALUES
    (1101, 'улица Садовая, 7, подъезд 3'),
    (1102, 'улица Садовая, 7, подъезд 3'),
    (1103, 'улица Садовая, 9'),
    (1104, 'улица Полевая, 7, подъезд 3')
) AS sample(id, address)
WHERE t.id = sample.id;

ANALYZE trips;
