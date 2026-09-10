-- Поиск поездки по адресу. Вычисляемая колонка держит разбор адреса рядом с
-- данными, поэтому запрос и индекс всегда согласованы.
ALTER TABLE trips
    ADD COLUMN IF NOT EXISTS address_search TSVECTOR
    GENERATED ALWAYS AS (
        to_tsvector('russian', pickup_address || ' ' || destination_address)
    ) STORED;
