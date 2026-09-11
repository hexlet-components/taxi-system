import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { metrics } from './metrics.ts';
import { PoolTimeoutError, primary, replica } from './db.ts';
import * as handlers from './handlers.ts';
import type { Reply } from './handlers.ts';

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw === '') return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
};

type Route = {
  method: string;
  pattern: RegExp;
  run: (context: {
    match: RegExpMatchArray;
    params: URLSearchParams;
    request: IncomingMessage;
  }) => Promise<Reply>;
};

const routes: Route[] = [
  { method: 'GET', pattern: /^\/health$/, run: () => handlers.health() },
  { method: 'GET', pattern: /^\/metrics$/, run: () => handlers.snapshot() },
  { method: 'POST', pattern: /^\/admin\/drain$/, run: () => handlers.drain() },
  { method: 'POST', pattern: /^\/admin\/undrain$/, run: () => handlers.undrain() },
  {
    method: 'POST',
    pattern: /^\/trips$/,
    run: async ({ request }) =>
      handlers.createTrip(await readJson(request), request.headers['idempotency-key'] as string),
  },
  { method: 'GET', pattern: /^\/trips\/search$/, run: ({ params }) => handlers.searchTrips(params) },
  {
    method: 'GET',
    pattern: /^\/trips\/(\d+)$/,
    run: ({ match }) => handlers.getTrip(Number(match[1])),
  },
  {
    method: 'POST',
    pattern: /^\/trips\/(\d+)\/accept$/,
    run: async ({ match, request }) =>
      handlers.acceptTrip(Number(match[1]), await readJson(request)),
  },
  {
    method: 'POST',
    pattern: /^\/trips\/(\d+)\/cancel$/,
    run: async ({ match, request }) =>
      handlers.cancelTrip(Number(match[1]), await readJson(request)),
  },
  {
    method: 'POST',
    pattern: /^\/drivers\/(\d+)\/location$/,
    run: async ({ match, request }) =>
      handlers.updateLocation(Number(match[1]), await readJson(request)),
  },
  {
    method: 'GET',
    pattern: /^\/drivers\/nearby$/,
    run: ({ params }) => handlers.nearbyDrivers(params),
  },
  {
    method: 'GET',
    pattern: /^\/passengers\/(\d+)\/trips$/,
    run: ({ match }) => handlers.passengerTrips(Number(match[1])),
  },
  {
    method: 'GET',
    pattern: /^\/tariffs\/([a-z]+)$/,
    run: ({ match }) => handlers.getTariff(String(match[1])),
  },
];

// Запросы в обработке. Предел проверяется до обращения к базе, потому что
// принятая и не обслуженная работа продлевает перегрузку вместо того, чтобы
// её разгрузить.
let inflight = 0;

const send = (response: ServerResponse, reply: Reply, startedAt: number) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-instance': config.instance,
    ...(reply.headers ?? {}),
  };
  response.writeHead(reply.status, headers);
  response.end(JSON.stringify(reply.body));
  metrics.request(reply.status, performance.now() - startedAt);
};

const server = createServer(async (request, response) => {
  const startedAt = performance.now();
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  // Метрики, проверка готовности и вывод экземпляра из работы остаются
  // доступными под перегрузкой и во время слива: балансировщику нужен ответ
  // проверки, а стенд иначе нечем наблюдать.
  const alwaysServed =
    url.pathname === '/metrics' ||
    url.pathname === '/health' ||
    url.pathname.startsWith('/admin/');

  if (!alwaysServed) {
    if (handlers.isDraining()) {
      send(response, { status: 503, body: { error: 'instance is draining' } }, startedAt);
      return;
    }
    if (config.maxInflight > 0 && inflight >= config.maxInflight) {
      // Общая перегрузка обозначается 503. Nginx может попробовать второй
      // экземпляр, но max_fails=0 не оставляет группу upstream без адресов и
      // сохраняет итоговый 503, если оба экземпляра исчерпали ёмкость.
      metrics.overloadRejected();
      send(
        response,
        {
          status: 503,
          body: { error: 'service capacity exhausted' },
          headers: { 'retry-after': String(config.retryAfterSeconds) },
        },
        startedAt,
      );
      return;
    }
  }

  const route = routes.find(
    (candidate) => candidate.method === request.method && candidate.pattern.test(url.pathname),
  );
  if (route === undefined) {
    send(response, { status: 404, body: { error: 'route not found' } }, startedAt);
    return;
  }

  inflight += 1;
  try {
    const match = url.pathname.match(route.pattern);
    if (match === null) throw new Error('route matched but capture failed');
    const reply = await route.run({ match, params: url.searchParams, request });
    send(response, reply, startedAt);
  } catch (error) {
    if (error instanceof PoolTimeoutError) {
      // Ожидание соединения кончилось: сервис перегружен, и клиенту это
      // сообщается отдельным статусом.
      send(
        response,
        {
          status: 503,
          body: { error: 'database pool timeout' },
          headers: { 'retry-after': String(config.retryAfterSeconds) },
        },
        startedAt,
      );
      return;
    }
    console.error(error);
    send(response, { status: 500, body: { error: 'internal error' } }, startedAt);
  } finally {
    inflight -= 1;
  }
});

server.listen(config.port, () => {
  console.log(`taxi ${config.instance} listening on ${config.port}`);
});

// Обновление без остановки: экземпляр перестаёт принимать соединения, доводит
// начатые запросы и только потом закрывает пулы.
const shutdown = () => {
  server.close(async () => {
    await primary.end();
    if (replica !== primary) await replica.end();
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
