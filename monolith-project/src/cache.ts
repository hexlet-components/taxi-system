// Кэш в процессе приложения. Он не требует ещё одного сервиса, но у каждого
// экземпляра он свой, поэтому за балансировщиком доля попаданий ниже, чем на
// одном экземпляре. Общий кэш это следующий шаг, и его цена разобрана в
// решении docs/decisions/030-tariff-cache.md.
import { metrics } from './metrics.ts';

type Entry = { value: unknown; expiresAt: number };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export const cached = async <T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> => {
  if (ttlMs <= 0) {
    metrics.cacheMiss();
    return { value: await load(), hit: false };
  }

  const now = Date.now();
  const entry = entries.get(key);
  if (entry !== undefined && entry.expiresAt > now) {
    metrics.cacheHit();
    return { value: entry.value as T, hit: true };
  }

  metrics.cacheMiss();
  // Одновременные промахи по одному ключу идут в базу одним запросом, иначе
  // истёкший популярный ключ даёт всплеск нагрузки.
  const running = inflight.get(key);
  if (running !== undefined) {
    return { value: (await running) as T, hit: false };
  }

  const loading = load().finally(() => inflight.delete(key));
  inflight.set(key, loading);
  const value = await loading;
  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  return { value, hit: false };
};

export const cacheSize = () => entries.size;
