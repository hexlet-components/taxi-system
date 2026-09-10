CREATE EXTENSION IF NOT EXISTS postgis;

-- Позиция водителя. Тип geography считает расстояния в метрах, координаты в
-- WGS 84.
CREATE TABLE IF NOT EXISTS driver_locations (
    driver_id BIGINT PRIMARY KEY REFERENCES drivers (id),
    position GEOGRAPHY(POINT, 4326) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
