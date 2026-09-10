// Самый короткий сценарий k6. Два виртуальных клиента по очереди дёргают
// один адрес десять секунд, и этого хватает, чтобы увидеть, как выглядит
// сводка прогона.
import http from 'k6/http';
import { sleep } from 'k6';

export const options = { vus: 2, duration: '10s' };

const targetUrl = __ENV.TARGET_URL ?? 'http://nginx:8080';

export default function () {
  http.get(`${targetUrl}/trips/1`, { timeout: '2s', redirects: 0 });
  sleep(1);
}
