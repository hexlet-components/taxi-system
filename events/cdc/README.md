# CDC с Debezium

Окружение дополняет урок «CDC и Debezium» (`cdc`). Опыт показывает первоначальный снимок PostgreSQL, поток изменений и продолжение после остановки Kafka Connect. Нужны Docker с Compose и curl. Команды выполняются в терминале из этого каталога. Порт 18083 должен быть свободен. Стенд не требует одновременного запуска других примеров курса.

Стенд содержит PostgreSQL, Kafka и Debezium. В _compose.yml_ образы закреплены по digest. Пароль postgres и права суперпользователя предназначены для изолированного локального опыта. REST API привязан к loopback. Образы автоматически загружаются при первом запуске.

## Снимок

Compose создаёт отдельный проект events-cdc. После готовности контейнеров SQL создаёт таблицу trips с одной поездкой до запуска наблюдения.

```bash
docker compose -p events-cdc up -d --wait
docker compose -p events-cdc exec -T postgres \
  psql -U postgres -d taxi -v ON_ERROR_STOP=1 < setup.sql
curl --silent --show-error --fail \
  -H 'Content-Type: application/json' \
  --data @connector.json \
  http://localhost:18083/connectors
curl --silent --show-error --fail \
  http://localhost:18083/connectors/taxi-trips/status
```

Первый ответ Connect содержит name taxi-trips. В статусе коннектор и задача должны перейти в RUNNING. Если задача ещё запускается, тот же запрос статуса показывает её дальнейшее состояние. FAILED требует чтения trace в ответе статуса.

Читатель получает одну запись снимка. Он заканчивает работу после первого сообщения, а само сообщение сохраняется в Kafka.

```bash
docker compose -p events-cdc exec -T kafka \
  /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 --topic taxi.public.trips \
  --from-beginning --max-messages 1 --timeout-ms 15000
```

В записи op равен r, after.id равен 701, after.status равен requested. После записи выводится Processed a total of 1 messages. Если команда закончилась по timeout до сообщения, статус Connect показывает, завершился ли снимок; повтор команды снова начинает чтение с начала.

## Изменения

Файл changes.sql создаёт поездку 702, завершает 701 и удаляет 702. Повторное чтение с начала позволяет увидеть снимок и новые операции одним набором.

```bash
docker compose -p events-cdc exec -T postgres \
  psql -U postgres -d taxi -v ON_ERROR_STOP=1 < changes.sql
docker compose -p events-cdc exec -T kafka \
  /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 --topic taxi.public.trips \
  --from-beginning --max-messages 5 --timeout-ms 15000
```

Последовательность содержит op r для 701, c для 702, u для 701 и d для 702. Пятая запись имеет значение null и служит tombstone. В обновлении after.status равен completed. Сумма amount_cents хранится в копейках, валюта этого опыта RUB. Прежние значения полей не считаются доступными без проверки replica identity.

## Остановка и продолжение

Команды останавливают только Connect. Kafka и PostgreSQL продолжают работать, а слот сохраняется. Во время остановки сумма поездки меняется на 85000.

```bash
docker compose -p events-cdc stop connect
docker compose -p events-cdc exec -T postgres \
  psql -U postgres -d taxi -v ON_ERROR_STOP=1 \
  -c "UPDATE trips SET amount_cents = 85000 WHERE id = 701;"
docker compose -p events-cdc exec -T postgres \
  psql -U postgres -d taxi -v ON_ERROR_STOP=1 \
  -c "SELECT slot_name, active, restart_lsn, confirmed_flush_lsn, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes FROM pg_replication_slots WHERE slot_name = 'taxi_trips';"
docker compose -p events-cdc start connect
curl --silent --show-error --fail \
  http://localhost:18083/connectors/taxi-trips/status
```

В остановленном состоянии `active` равен `false`. Поле `retained_bytes` показывает удерживаемый слотом объём; его конкретное значение зависит от работы базы. После запуска Connect HTTP API может ещё готовиться, поэтому повтор запроса статуса служит проверкой состояния `RUNNING` коннектора и задачи.

Читатель снова проходит топик с начала. В проверенном проходе он получает шесть записей, включая обновление, выполненное при остановленном Connect.

```bash
docker compose -p events-cdc exec -T kafka \
  /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 --topic taxi.public.trips \
  --from-beginning --timeout-ms 15000
```

В последнем обновлении op равен u, after.id равен 701 и after.amount_cents равен 85000. При отказах возможны повторы, поэтому число записей само по себе не доказывает однократную доставку. Конец вывода по timeout означает отсутствие новых сообщений за интервал ожидания и может сопровождаться ненулевым кодом завершения читателя.

## Повтор опыта и очистка

Команда удаляет только контейнеры, сеть и тома проекта events-cdc. Она удаляет учебные данные, слот и служебные топики Connect. После неё опыт начинается заново с запуска и setup.sql.

```bash
docker compose -p events-cdc down -v
```

Опыт проверяет продолжение при сохранённых Kafka, PostgreSQL и слоте. Он не моделирует потерю WAL, аварийное переключение базы или работу нескольких брокеров. Для длительной остановки нужны контроль диска, ограничение удержания WAL и отдельный договор восстановления.
