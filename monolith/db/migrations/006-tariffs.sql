-- Тарифы меняются редко и читаются на каждом заказе, поэтому это тот случай,
-- когда кэш снимает нагрузку с базы.
CREATE TABLE IF NOT EXISTS tariffs (
    code VARCHAR(32) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    base_price NUMERIC(12, 2) NOT NULL,
    price_per_km NUMERIC(12, 2) NOT NULL
);

INSERT INTO tariffs (code, name, base_price, price_per_km)
VALUES
    ('economy', 'Эконом', 149.00, 12.50),
    ('comfort', 'Комфорт', 249.00, 18.00),
    ('business', 'Бизнес', 499.00, 32.00)
ON CONFLICT (code) DO NOTHING;
