// Стаб сервиса уведомлений. Задержку и долю отказов задаёт проверка через
// /_control, поэтому шаг про таймауты воспроизводится без правки окружения.
import { createServer } from 'node:http';

type Control = { delayMs: number; failRate: number };

const control: Control = { delayMs: 0, failRate: 0 };
let received = 0;

const readBody = async (stream: AsyncIterable<Buffer>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub');
  const json = (status: number, payload: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  if (url.pathname === '/_control') {
    if (request.method === 'POST') {
      const body = await readBody(request);
      const patch = body === '' ? {} : (JSON.parse(body) as Partial<Control>);
      if (typeof patch.delayMs === 'number') control.delayMs = patch.delayMs;
      if (typeof patch.failRate === 'number') control.failRate = patch.failRate;
      received = 0;
      json(200, { ...control, received });
      return;
    }
    json(200, { ...control, received });
    return;
  }

  if (url.pathname === '/notify' && request.method === 'POST') {
    await readBody(request);
    received += 1;
    await sleep(control.delayMs);
    if (Math.random() < control.failRate) {
      json(503, { error: 'notification service unavailable' });
      return;
    }
    json(202, { accepted: true });
    return;
  }

  if (url.pathname === '/health') {
    json(200, { status: 'ok' });
    return;
  }

  json(404, { error: 'not found' });
});

server.listen(Number(process.env.PORT ?? 8080), () => {
  console.log('notifications stub listening');
});
