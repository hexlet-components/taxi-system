-- Состояния поездки перечислены в базе, поэтому неизвестный статус не попадёт
-- в таблицу даже при ошибке приложения.
ALTER TABLE trips
    DROP CONSTRAINT IF EXISTS trips_status_check;

ALTER TABLE trips
    ADD CONSTRAINT trips_status_check
    CHECK (status IN ('searching', 'accepted', 'in_progress', 'completed', 'cancelled'));

-- Принятая поездка без водителя противоречива, и это проверяется внутри записи.
ALTER TABLE trips
    DROP CONSTRAINT IF EXISTS trips_driver_required_check;

ALTER TABLE trips
    ADD CONSTRAINT trips_driver_required_check
    CHECK (status = 'searching' OR status = 'cancelled' OR driver_id IS NOT NULL);
