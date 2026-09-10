// Миграции применяются обычным SQL по порядку имён файлов. Отдельный
// инструмент здесь ничего не добавил бы: каждая миграция написана так, что
// повторный прогон её не ломает.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.ts';

const directory = path.join(import.meta.dirname, '..', 'db', 'migrations');

const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();

const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

for (const name of files) {
  const sql = await readFile(path.join(directory, name), 'utf-8');
  await client.query(sql);
  console.log(`applied ${name}`);
}

await client.end();
