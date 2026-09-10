// Обращение к сервису уведомлений.
import { config } from './config.ts';
import { metrics } from './metrics.ts';

export const notify = async (payload: unknown, idempotencyKey: string): Promise<boolean> => {
  if (config.notificationsUrl === '') return false;

  const started = performance.now();
  try {
    const response = await fetch(config.notificationsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    metrics.notification(performance.now() - started, !response.ok);
    return response.ok;
  } catch {
    metrics.notification(performance.now() - started, true);
    return false;
  }
};
