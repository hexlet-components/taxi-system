import { config } from './config.ts';
import { metrics } from './metrics.ts';
import { notify } from './notifications.ts';
import { primary, query, replica, transaction } from './db.ts';

export type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const badRequest = (message: string): Reply => ({ status: 400, body: { error: message } });

const asNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const health = async (): Promise<Reply> => {
  try {
    await query('SELECT 1');
    return { status: 200, body: { status: 'ok', instance: config.instance } };
  } catch {
    return { status: 503, body: { status: 'database unavailable', instance: config.instance } };
  }
};

export const snapshot = async (): Promise<Reply> => ({
  status: 200,
  body: { ...metrics.snapshot(), instance: config.instance },
});

const tariff = async (code: string) => {
  const result = await query<{
    code: string;
    name: string;
    base_price: string;
    price_per_km: string;
  }>('SELECT code, name, base_price, price_per_km FROM tariffs WHERE code = $1', [code]);
  return result.rows[0] ?? null;
};

export const getTariff = async (code: string): Promise<Reply> => {
  const value = await tariff(code);
  if (value === null) return { status: 404, body: { error: 'tariff not found' } };
  return { status: 200, body: value };
};

type TripRow = {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  status: string;
  price: string;
  pickup_address: string;
  destination_address: string;
  created_at: Date;
};

const tripView = (row: TripRow) => ({
  id: Number(row.id),
  passengerId: Number(row.passenger_id),
  driverId: row.driver_id === null ? null : Number(row.driver_id),
  status: row.status,
  price: Number(row.price),
  pickupAddress: row.pickup_address,
  destinationAddress: row.destination_address,
  createdAt: row.created_at,
});

const tripById = async (id: number, pool = primary) => {
  const result = await query<TripRow>(
    `SELECT id, passenger_id, driver_id, status, price,
            pickup_address, destination_address, created_at
     FROM trips WHERE id = $1`,
    [id],
    pool,
  );
  return result.rows[0] ?? null;
};

export const getTrip = async (id: number): Promise<Reply> => {
  const row = await tripById(id);
  if (row === null) return { status: 404, body: { error: 'trip not found' } };
  return { status: 200, body: tripView(row), headers: { 'x-source': 'primary' } };
};

export const createTrip = async (
  body: Record<string, unknown>,
  idempotencyKey: string | undefined,
): Promise<Reply> => {
  if (idempotencyKey === undefined || idempotencyKey === '') {
    return badRequest('Idempotency-Key header is required');
  }
  const passengerId = asNumber(body.passengerId);
  const pickupAddress = typeof body.pickupAddress === 'string' ? body.pickupAddress : '';
  const destinationAddress =
    typeof body.destinationAddress === 'string' ? body.destinationAddress : '';
  if (passengerId === null || pickupAddress === '' || destinationAddress === '') {
    return badRequest('passengerId, pickupAddress and destinationAddress are required');
  }
  const tariffCode = typeof body.tariff === 'string' ? body.tariff : 'economy';

  const known = await query<{ trip_id: string }>(
    'SELECT trip_id FROM idempotency_keys WHERE key = $1',
    [idempotencyKey],
  );
  const knownId = known.rows[0];
  if (knownId !== undefined) {
    const row = await tripById(Number(knownId.trip_id));
    if (row !== null) {
      return { status: 200, body: tripView(row), headers: { 'idempotent-replay': 'true' } };
    }
  }

  const tariffRow = await tariff(tariffCode);
  if (tariffRow === null) return badRequest('unknown tariff');
  const price = Number(tariffRow.base_price);

  let created: TripRow;
  try {
    created = await transaction(async (client) => {
      const inserted = await client.query<TripRow>(
        `INSERT INTO trips (passenger_id, status, price, pickup_address, destination_address)
         VALUES ($1, 'searching', $2, $3, $4)
         RETURNING id, passenger_id, driver_id, status, price,
                   pickup_address, destination_address, created_at`,
        [passengerId, price, pickupAddress, destinationAddress],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('trip insert returned no row');
      await client.query('INSERT INTO trip_events (trip_id, event) VALUES ($1, $2)', [
        row.id,
        'created',
      ]);
      // Ключ пишется в той же транзакции, что и поездка: иначе повтор после
      // сбоя между двумя записями создал бы вторую поездку.
      await client.query('INSERT INTO idempotency_keys (key, trip_id) VALUES ($1, $2)', [
        idempotencyKey,
        row.id,
      ]);
      return row;
    });
  } catch (error) {
    // Гонку двух одновременных повторов ловит уникальность ключа, и второй
    // запрос отдаёт поездку первого.
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      const raced = await query<{ trip_id: string }>(
        'SELECT trip_id FROM idempotency_keys WHERE key = $1',
        [idempotencyKey],
      );
      const racedId = raced.rows[0];
      if (racedId !== undefined) {
        const row = await tripById(Number(racedId.trip_id));
        if (row !== null) {
          return { status: 200, body: tripView(row), headers: { 'idempotent-replay': 'true' } };
        }
      }
    }
    throw error;
  }

  const notified = await notify(
    { event: 'trip_created', tripId: Number(created.id) },
    idempotencyKey,
  );
  return {
    status: 201,
    body: { ...tripView(created), notified },
    headers: { 'x-notified': String(notified) },
  };
};

export const acceptTrip = async (
  tripId: number,
  body: Record<string, unknown>,
): Promise<Reply> => {
  const driverId = asNumber(body.driverId);
  if (driverId === null) return badRequest('driverId is required');

  return transaction(async (client) => {
    // Порядок блокировок один во всех обработчиках: сначала водитель, затем
    // поездка. Разный порядок дал бы взаимную блокировку двух запросов.
    const driver = await client.query<{ id: string; is_available: boolean }>(
      'SELECT id, is_available FROM drivers WHERE id = $1 FOR UPDATE',
      [driverId],
    );
    const driverRow = driver.rows[0];
    if (driverRow === undefined) return { status: 404, body: { error: 'driver not found' } };

    const trip = await client.query<TripRow>(
      `SELECT id, passenger_id, driver_id, status, price,
              pickup_address, destination_address, created_at
       FROM trips WHERE id = $1 FOR UPDATE`,
      [tripId],
    );
    const tripRow = trip.rows[0];
    if (tripRow === undefined) return { status: 404, body: { error: 'trip not found' } };
    if (tripRow.status !== 'searching') {
      return { status: 409, body: { error: `trip is ${tripRow.status}` } };
    }
    if (!driverRow.is_available) {
      return { status: 409, body: { error: 'driver is busy' } };
    }

    await client.query('UPDATE drivers SET is_available = FALSE WHERE id = $1', [driverId]);
    const updated = await client.query<TripRow>(
      `UPDATE trips SET driver_id = $1, status = 'accepted'
       WHERE id = $2
       RETURNING id, passenger_id, driver_id, status, price,
                 pickup_address, destination_address, created_at`,
      [driverId, tripId],
    );
    await client.query('INSERT INTO trip_events (trip_id, event) VALUES ($1, $2)', [
      tripId,
      'accepted',
    ]);
    const row = updated.rows[0];
    if (row === undefined) throw new Error('trip update returned no row');
    return { status: 200, body: tripView(row) };
  });
};

export const cancelTrip = async (
  tripId: number,
  body: Record<string, unknown>,
): Promise<Reply> => {
  const reason = typeof body.reason === 'string' ? body.reason : 'unspecified';
  return transaction(async (client) => {
    const trip = await client.query<TripRow>(
      'SELECT id, status, driver_id FROM trips WHERE id = $1 FOR UPDATE',
      [tripId],
    );
    const tripRow = trip.rows[0];
    if (tripRow === undefined) return { status: 404, body: { error: 'trip not found' } };
    if (tripRow.status === 'completed' || tripRow.status === 'cancelled') {
      return { status: 409, body: { error: `trip is ${tripRow.status}` } };
    }
    if (tripRow.driver_id !== null) {
      await client.query('UPDATE drivers SET is_available = TRUE WHERE id = $1', [
        tripRow.driver_id,
      ]);
    }
    await client.query(
      `UPDATE trips SET status = 'cancelled', cancel_reason = $1, driver_id = NULL WHERE id = $2`,
      [reason, tripId],
    );
    await client.query('INSERT INTO trip_events (trip_id, event) VALUES ($1, $2)', [
      tripId,
      'cancelled',
    ]);
    return { status: 200, body: { id: tripId, status: 'cancelled', cancelReason: reason } };
  });
};

export const updateLocation = async (
  driverId: number,
  body: Record<string, unknown>,
): Promise<Reply> => {
  const lat = asNumber(body.lat);
  const lon = asNumber(body.lon);
  if (lat === null || lon === null) return badRequest('lat and lon are required');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return badRequest('lat or lon is out of range');
  }
  // ST_MakePoint принимает долготу первым аргументом: перестановка даёт
  // допустимую точку в другом месте, поэтому порядок проверяется здесь.
  const result = await query(
    `INSERT INTO driver_locations (driver_id, position, updated_at)
     VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::GEOGRAPHY, NOW())
     ON CONFLICT (driver_id) DO UPDATE
       SET position = EXCLUDED.position, updated_at = EXCLUDED.updated_at`,
    [driverId, lon, lat],
  );
  if (result.rowCount === 0) return { status: 404, body: { error: 'driver not found' } };
  return { status: 200, body: { driverId, lat, lon } };
};

export const nearbyDrivers = async (params: URLSearchParams): Promise<Reply> => {
  const lat = asNumber(params.get('lat'));
  const lon = asNumber(params.get('lon'));
  const radius = asNumber(params.get('radius') ?? '1000');
  const freshSeconds = asNumber(params.get('fresh') ?? '60');
  if (lat === null || lon === null || radius === null || freshSeconds === null) {
    return badRequest('lat, lon are required, radius and fresh must be numbers');
  }

  const result = await query<{ driver_id: string; distance_m: string }>(
    `WITH search AS (
       SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::GEOGRAPHY AS origin,
              statement_timestamp() AS as_of
     )
     SELECT l.driver_id, ST_Distance(l.position, s.origin) AS distance_m
     FROM driver_locations AS l
     JOIN drivers AS d ON d.id = l.driver_id
     CROSS JOIN search AS s
     WHERE d.is_available
       AND l.updated_at BETWEEN s.as_of - make_interval(secs => $4) AND s.as_of
       AND ST_DWithin(l.position, s.origin, $3)
     ORDER BY distance_m
     LIMIT 10`,
    [lon, lat, radius, freshSeconds],
  );
  return {
    status: 200,
    body: result.rows.map((row) => ({
      driverId: Number(row.driver_id),
      distanceM: Math.round(Number(row.distance_m)),
    })),
  };
};

export const searchTrips = async (params: URLSearchParams): Promise<Reply> => {
  const q = params.get('q') ?? '';
  if (q.trim() === '') return badRequest('q is required');
  const result = await query<TripRow & { rank: number }>(
    `SELECT id, passenger_id, driver_id, status, price,
            pickup_address, destination_address, created_at,
            ts_rank(address_search, websearch_to_tsquery('russian', $1)) AS rank
     FROM trips
     WHERE address_search @@ websearch_to_tsquery('russian', $1)
     ORDER BY rank DESC, created_at DESC
     LIMIT 20`,
    [q],
  );
  return { status: 200, body: result.rows.map(tripView) };
};

export const passengerTrips = async (passengerId: number): Promise<Reply> => {
  const result = await query<TripRow>(
    `SELECT id, passenger_id, driver_id, status, price,
            pickup_address, destination_address, created_at
     FROM trips
     WHERE passenger_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [passengerId],
    replica,
  );
  return {
    status: 200,
    body: result.rows.map(tripView),
    headers: { 'x-source': replica === primary ? 'primary' : 'replica' },
  };
};
