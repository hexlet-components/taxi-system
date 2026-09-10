// Первый сценарий: одно чтение поездки с постоянной частотой. Он нужен, чтобы
// убедиться, что генератор и стенд работают, до разбора смешанного профиля.
import http from 'k6/http';
import { check } from 'k6';

const profile = JSON.parse(open('./profile.json'));
const targetUrl = __ENV.TARGET_URL ?? 'http://nginx:8080';

export const options = {
  scenarios: {
    read: {
      // Открытая модель: частота задаётся независимо от ответов сервиса,
      // поэтому замедление видно по числу незавершённых операций.
      executor: 'constant-arrival-rate',
      rate: profile.stand.readRate,
      timeUnit: '1s',
      duration: profile.stand.duration,
      preAllocatedVUs: 20,
      maxVUs: 200,
      gracefulStop: '5s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: [`rate<=${profile.targets.errorRate}`],
    http_req_duration: [`p(95)<${profile.targets.p95Ms}`],
    dropped_iterations: ['count==0'],
  },
};

export default function () {
  const response = http.get(`${targetUrl}/trips/1`, { timeout: '5s' });
  check(response, { 'status is 200': (result) => result.status === 200 });
}
