INSERT INTO passengers (name, phone)
SELECT 'Passenger ' || n, '+79' || LPAD(n::TEXT, 9, '0')
FROM generate_series(1, 20) AS s(n);
INSERT INTO drivers (name)
SELECT 'Driver ' || n FROM generate_series(1, 20) AS s(n);
