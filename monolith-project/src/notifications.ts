// Обращение к сервису уведомлений. Поездка к этому моменту уже сохранена,
// поэтому отказ уведомления не отменяет заказ и не задерживает ответ дольше
// таймаута.
import { config } from './config.ts';
import { metrics } from './metrics.ts';

export const notify = async (payload: unknown, idempotencyKey: string): Promise<boolean> => {
  if (config.notificationsUrl === '') return false;

  const deadline = performance.now() + config.notificationsBudgetMs;
  for (let attempt = 0; attempt <= config.notificationsRetries; attempt += 1) {
    if (attempt > 0) {
      const backoffMs = 25 + Math.random() * 25;
      if (performance.now() + backoffMs >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return false;
    const started = performance.now();
    try {
      const response = await fetch(config.notificationsUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Повтор с тем же ключом позволяет получателю отбросить дубль.
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(config.notificationsAttemptTimeoutMs, remainingMs)),
        ),
      });
      metrics.notification(performance.now() - started, !response.ok);
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      metrics.notification(performance.now() - started, true);
    }
  }
  return false;
};
