export const config = {
  port: Number(process.env.PORT ?? 8080),
  instance: process.env.INSTANCE ?? 'app',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/taxi',
  replicaUrl: process.env.REPLICA_URL ?? process.env.DATABASE_URL ?? '',
  notificationsUrl: process.env.NOTIFICATIONS_URL ?? '',
  poolSize: Number(process.env.POOL_SIZE ?? 10),
};
