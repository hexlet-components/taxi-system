#!/bin/sh
# Подписка ждёт готовности основной базы: initdb реплики и основной идут
# одновременно, и без ожидания CREATE SUBSCRIPTION падает на подключении.
set -e

until pg_isready -h db -U postgres -d taxi >/dev/null 2>&1; do
  sleep 1
done

psql -v ON_ERROR_STOP=1 -U postgres -d taxi <<'SQL'
CREATE SUBSCRIPTION taxi
  CONNECTION 'host=db user=postgres dbname=taxi'
  PUBLICATION taxi;
SQL
