// Профиль сервиса: заказы, чтения и обновления координат идут одновременно с
// разными частотами, как в требованиях. Каждый сценарий содержит одну
// операцию, поэтому частота сценария совпадает с частотой запросов.
import http from 'k6/http';
import { check } from 'k6';

const profile = JSON.parse(open('./profile.json'));
const targetUrl = __ENV.TARGET_URL ?? 'http://nginx:8080';
// Множитель частот. Базовый прогон идёт с единицей, а перегрузку получают
// тем же профилем с большим множителем: так сравнивают два прогона одного
// сценария, а не два разных сценария.
const scale = Number(__ENV.RATE_SCALE ?? '1');

const scenario = (name: string, rate: number, startTime: string) => ({
  executor: 'constant-arrival-rate',
  exec: name,
  rate: Math.round(rate * scale),
  timeUnit: '1s',
  duration: profile.stand.duration,
  startTime,
  preAllocatedVUs: 20,
  maxVUs: 300,
  gracefulStop: '5s',
});

export const options = {
  scenarios: {
    // Прогрев отделён от измеряемого интервала: первые запросы идут по
    // холодному кэшу и пустому пулу соединений.
    warmup: {
      executor: 'constant-arrival-rate',
      exec: 'read',
      rate: 5,
      timeUnit: '1s',
      duration: profile.stand.warmup,
      preAllocatedVUs: 5,
      maxVUs: 50,
    },
    orders: scenario('order', profile.stand.orderRate, profile.stand.warmup),
    reads: scenario('read', profile.stand.readRate, profile.stand.warmup),
    locations: scenario('location', profile.stand.locationRate, profile.stand.warmup),
    // История пассажира стоит отдельным сценарием, потому что именно на ней
    // видно разницу между чтением по индексу и чтением всей таблицы.
    history: scenario('history', profile.stand.historyRate, profile.stand.warmup),
  },
  thresholds: {
    'http_req_duration{scenario:reads}': [`p(95)<${profile.targets.p95Ms}`],
    // Порог у истории мягкий: на этом сценарии видно разницу до и после
    // индекса, и прогон «до» не должен падать раньше, чем даст числа.
    'http_req_duration{scenario:history}': ['p(95)<30000'],
    'http_req_failed{scenario:reads}': [`rate<=${profile.targets.errorRate}`],
    dropped_iterations: ['count==0'],
  },
};

export const read = () => {
  const response = http.get(`${targetUrl}/trips/1`, { timeout: '5s' });
  check(response, { 'read is 200': (result) => result.status === 200 });
};

export const order = () => {
  const key = `load-${__VU}-${__ITER}-${Date.now()}`;
  const response = http.post(
    `${targetUrl}/trips`,
    JSON.stringify({
      passengerId: 1 + (__VU % 1000),
      pickupAddress: 'улица Лесная, 10',
      destinationAddress: 'улица Садовая, 5',
    }),
    { headers: { 'content-type': 'application/json', 'idempotency-key': key }, timeout: '5s' },
  );
  check(response, { 'order accepted or rejected': (r) => r.status === 201 || r.status === 503 });
};

export const history = () => {
  const passengerId = 1 + (__VU % 1000);
  const response = http.get(`${targetUrl}/passengers/${passengerId}/trips`, { timeout: '10s' });
  check(response, { 'history is 200': (r) => r.status === 200 });
};

export const location = () => {
  const driverId = 1 + (__VU % 1000);
  const response = http.post(
    `${targetUrl}/drivers/${driverId}/location`,
    JSON.stringify({ lat: 55.756 + Math.random() / 100, lon: 37.619 + Math.random() / 100 }),
    { headers: { 'content-type': 'application/json' }, timeout: '5s' },
  );
  check(response, { 'location accepted or rejected': (r) => r.status === 200 || r.status === 503 });
};
