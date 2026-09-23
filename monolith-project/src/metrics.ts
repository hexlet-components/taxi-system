// Счётчики сервиса. Формат простой JSON, поэтому клиентская библиотека
// метрик не нужна ни на одном языке.
type Summary = { count: number; sum: number; values: number[] };

const summary = (): Summary => ({ count: 0, sum: 0, values: [] });

const state = {
  requestsByStatus: new Map<number, number>(),
  requestDuration: summary(),
  poolWait: summary(),
  sql: summary(),
  notifications: summary(),
  cacheHits: 0,
  cacheMisses: 0,
  overloadRejected: 0,
  notificationFailures: 0,
};

// Хвост распределения важнее среднего, но хранить все значения нельзя:
// оставляем последние, этого хватает для отчёта по прогону.
const maxValues = 2000;

const observe = (target: Summary, value: number) => {
  target.count += 1;
  target.sum += value;
  target.values.push(value);
  if (target.values.length > maxValues) target.values.shift();
};

const quantile = (values: number[], q: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return Math.round(sorted[index] ?? 0);
};

const render = (target: Summary) => ({
  count: target.count,
  avg_ms: target.count === 0 ? 0 : Math.round(target.sum / target.count),
  p50_ms: quantile(target.values, 0.5),
  p95_ms: quantile(target.values, 0.95),
  p99_ms: quantile(target.values, 0.99),
});

export const metrics = {
  request(status: number, durationMs: number) {
    state.requestsByStatus.set(status, (state.requestsByStatus.get(status) ?? 0) + 1);
    observe(state.requestDuration, durationMs);
  },
  poolWait(ms: number) {
    observe(state.poolWait, ms);
  },
  sql(ms: number) {
    observe(state.sql, ms);
  },
  notification(ms: number, failed: boolean) {
    observe(state.notifications, ms);
    if (failed) state.notificationFailures += 1;
  },
  cacheHit() {
    state.cacheHits += 1;
  },
  cacheMiss() {
    state.cacheMisses += 1;
  },
  overloadRejected() {
    state.overloadRejected += 1;
  },
  snapshot() {
    return {
      instance: '',
      http_requests_total: Object.fromEntries(state.requestsByStatus),
      http_request_duration: render(state.requestDuration),
      pool_wait: render(state.poolWait),
      sql: render(state.sql),
      notifications: render(state.notifications),
      notification_failures_total: state.notificationFailures,
      cache_hits_total: state.cacheHits,
      cache_misses_total: state.cacheMisses,
      overload_rejected_total: state.overloadRejected,
    };
  },
};
