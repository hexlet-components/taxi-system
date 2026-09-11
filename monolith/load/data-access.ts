// Отдельный профиль проверяет три чтения со своей целью p95. Редкие городские
// операции здесь усилены, чтобы за короткий интервал получить выборку.
import http from 'k6/http';
import { check } from 'k6';

const profile = JSON.parse(open('./profile.json'));
const targetUrl = __ENV.TARGET_URL ?? 'http://nginx:8080';

const scenario = (name: string, rate: number) => ({
  executor: 'constant-arrival-rate',
  exec: name,
  rate,
  timeUnit: '1s',
  duration: profile.stand.duration,
  preAllocatedVUs: 10,
  maxVUs: 100,
  gracefulStop: '5s',
});

export const options = {
  scenarios: {
    history: scenario('history', profile.stand.historyRate),
    nearby: scenario('nearby', profile.stand.nearbyRate),
    support: scenario('support', profile.stand.supportRate),
  },
  thresholds: {
    'http_req_duration{scenario:history}': [`p(95)<${profile.targets.dataAccessP95Ms}`],
    'http_req_duration{scenario:nearby}': [`p(95)<${profile.targets.dataAccessP95Ms}`],
    'http_req_duration{scenario:support}': [`p(95)<${profile.targets.dataAccessP95Ms}`],
    http_req_failed: [`rate<=${profile.targets.errorRate}`],
    dropped_iterations: ['count==0'],
  },
};

export const history = () => {
  const response = http.get(`${targetUrl}/passengers/${1 + (__VU % 1000)}/trips`);
  check(response, { 'history is 200': (result) => result.status === 200 });
};

export const nearby = () => {
  const response = http.get(
    `${targetUrl}/drivers/nearby?lat=55.756&lon=37.619&radius=5000&fresh=3600`,
  );
  check(response, { 'nearby is 200': (result) => result.status === 200 });
};

export const support = () => {
  const response = http.get(`${targetUrl}/trips/search?q=%D0%9B%D0%B5%D1%81%D0%BD%D0%B0%D1%8F`);
  check(response, { 'support search is 200': (result) => result.status === 200 });
};
