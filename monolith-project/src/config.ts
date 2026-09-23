export const config = {
  port: Number(process.env.PORT ?? 8080),
  instance: process.env.INSTANCE ?? 'app',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/taxi',
  replicaUrl: process.env.REPLICA_URL ?? process.env.DATABASE_URL ?? '',
  notificationsUrl: process.env.NOTIFICATIONS_URL ?? '',
  // Размер пула держим меньше max_connections базы, поделённого на число
  // экземпляров: два экземпляра по 10 соединений оставляют базе запас.
  poolSize: Number(process.env.POOL_SIZE ?? 10),
  // Ожидание соединения из пула. Без предела запрос ждёт бесконечно и очередь
  // растёт быстрее, чем сервис её разбирает.
  poolTimeoutMs: Number(process.env.POOL_TIMEOUT_MS ?? 0),
  statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS ?? 0),
  notificationsBudgetMs: Number(process.env.NOTIFICATIONS_BUDGET_MS ?? 10000),
  notificationsAttemptTimeoutMs: Number(process.env.NOTIFICATIONS_ATTEMPT_TIMEOUT_MS ?? 10000),
  notificationsRetries: Number(process.env.NOTIFICATIONS_RETRIES ?? 0),
  // Предел одновременно обрабатываемых запросов. Сверх него сервис отвечает
  // отказом сразу, потому что принятая и не обслуженная работа продлевает
  // перегрузку.
  maxInflight: Number(process.env.MAX_INFLIGHT ?? 0),
  retryAfterSeconds: Number(process.env.RETRY_AFTER_SECONDS ?? 1),
  tariffCacheTtlMs: Number(process.env.TARIFF_CACHE_TTL_MS ?? 0),
  readHistoryFromReplica: process.env.READ_HISTORY_FROM_REPLICA === 'true',
  drainEnabled: process.env.DRAIN_ENABLED === 'true',
};
