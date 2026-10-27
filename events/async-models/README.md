# Java-примеры моделей асинхронного взаимодействия

Окружение дополняет уроки «Модели асинхронного взаимодействия» (`async-interaction-models`) и «Журнал событий в Kafka» (`kafka-log`). Для первого урока оно проверяет распределение задания и независимые подписки RabbitMQ. Для второго показывает чтение истории двумя группами Kafka. Зависимости Java-клиентов закреплены в _pom.xml_.

Команды выполняются из каталога _events/async-models/_ репозитория [taxi-system](https://github.com/hexlet-components/taxi-system). На компьютере установлен Docker с Docker Compose. При первом запуске Maven скачивает зависимости.

## Опыты RabbitMQ

Самостоятельная работа урока о выборе модели использует три программы. Команды запускают только RabbitMQ и показывают распределение задания и доставку отдельным подпискам.

```bash
docker compose -p lesson-async-models up -d --wait rabbitmq
docker compose -p lesson-async-models run --rm --no-deps java mvn -q compile exec:java -Dexec.mainClass=OfferProducer
docker compose -p lesson-async-models run --rm --no-deps java mvn -q compile exec:java -Dexec.mainClass=OfferWorkers
docker compose -p lesson-async-models run --rm --no-deps java mvn -q compile exec:java -Dexec.mainClass=SubscriptionsDemo
```

## Чтение журнала Kafka

Урок о журнале использует две программы. Первая создаёт топик и записывает события, вторая читает их двумя независимыми группами.

```bash
docker compose -p lesson-async-models up -d --wait kafka
docker compose -p lesson-async-models run --rm --no-deps java mvn -q compile exec:java -Dexec.mainClass=TripProducer
docker compose -p lesson-async-models run --rm --no-deps java mvn -q compile exec:java -Dexec.mainClass=TripConsumer
```

Параметр `-Dexec.mainClass` выбирает программу для запуска. Флаг `--no-deps` оставляет состав уже запущенных брокеров без изменений. Для каждого опыта нужен исходный набор данных, поэтому перед повторным запуском окружение очищают командой из раздела «Очистка».

## Общий запуск и результаты

Все модели можно проверить одним запуском.

```bash
docker compose -p lesson-async-models up -d --wait rabbitmq kafka
docker compose -p lesson-async-models run --rm java
```

Класс _src/main/java/AsyncModelsDemo.java_ запускает программы обоих уроков в нужном порядке. В каталоге _src/main/java/_ лежат те же исходники, что показаны в Java-блоках урока о журнале Kafka и самостоятельной работы по моделям взаимодействия.

| Программа | Действие |
| --- | --- |
| `OfferProducer` | Создаёт общую очередь и записывает одно задание |
| `OfferWorkers` | Запускает двух последовательных читателей общей очереди |
| `SubscriptionsDemo` | Публикует событие в две связанные очереди и читает каждую |
| `TripProducer` | Создаёт топик и записывает `e1` и `e2` |
| `TripConsumer` | Читает обе записи двумя независимыми группами |

Успешный запуск содержит следующие строки.

```text
A: offer-42
B: empty
lesson-receipts: {"event_type":"TripCompleted","trip_id":42}
lesson-report: {"event_type":"TripCompleted","trip_id":42}
lesson-java-report: e1
lesson-java-report: e2
lesson-java-rebuild: e1
lesson-java-rebuild: e2
```

В первых двух строках видно, что задание получил один исполнитель. Два читателя разных очередей получили одинаковое событие. Две независимые группы Kafka прочитали одни и те же записи. Программа не отправляет предложения или чеки и не рассчитывает выручку для отчёта.

Каждая группа Kafka заканчивает чтение после двух записей или через 30 секунд. Если нужные данные не получены, программа завершается с ошибкой.

В программе адреса брокеров берутся из переменных окружения Compose. Вместо `localhost:5672` и `localhost:9092` из объяснения урока используются имена сервисов `rabbitmq` и `kafka`, потому что Java работает в отдельном контейнере.

## Очистка

Для повторного запуска очищаем очереди и удаляем созданный топик вместе с окружением. Команда ниже удаляет контейнеры и тома только проекта этого примера, включая кеш Maven. После неё запуск начинается заново.

```bash
docker compose -p lesson-async-models down -v
```

Окружение проверяет модели доставки при работающих брокерах. Перезапуски, повторы и сохранность при потере узла требуют отдельных опытов.
