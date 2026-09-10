import pg from 'pg';
import { config } from './config.ts';
import { metrics } from './metrics.ts';

const { Pool } = pg;

const makePool = (connectionString: string) =>
  new Pool({
    connectionString,
    max: config.poolSize,
  });

export const primary = makePool(config.databaseUrl);
// Копия базы поднята в стенде, но сервис пока читает всё из основной.
export const replica = primary;

// Соединение и запрос замеряются раздельно, потому что ожидание в пуле и
// время самой команды упираются в разные пределы.
const withClient = async <T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const waitStarted = performance.now();
  const client = await pool.connect();
  metrics.poolWait(performance.now() - waitStarted);
  const sqlStarted = performance.now();
  try {
    return await run(client);
  } finally {
    metrics.sql(performance.now() - sqlStarted);
    client.release();
  }
};

export const query = async <T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  pool: pg.Pool = primary,
): Promise<pg.QueryResult<T>> => withClient(pool, (client) => client.query<T>(sql, params));

export const transaction = async <T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> =>
  withClient(primary, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
