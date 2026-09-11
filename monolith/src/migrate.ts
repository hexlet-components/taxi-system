// Миграции применяются обычным SQL по порядку имён файлов. Отдельный
// инструмент здесь ничего не добавил бы, потому что каждая миграция написана
// так, что повторный прогон её не ломает.
//
// Копия базы получает тот же набор. Логическая репликация переносит строки и
// не переносит изменения схемы, поэтому без этого шага на копии не окажется
// ни одного индекса, и чтение истории останется медленным после того, как
// индексы уже добавлены.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.ts';

const directory = path.join(import.meta.dirname, '..', 'db', 'migrations');
const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

const apply = async (connectionString: string, label: string) => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  for (const name of files) {
    const sql = await readFile(path.join(directory, name), 'utf-8');
    await client.query(sql);
    console.log(`${label}: applied ${name}`);
  }
  await client.end();
};

await apply(config.databaseUrl, 'primary');

if (config.replicaUrl !== '' && config.replicaUrl !== config.databaseUrl) {
  await apply(config.replicaUrl, 'replica');
}
