# Сервис такси

Стартовый сервис для проекта по системному дизайну. Балансировщик nginx, два экземпляра приложения, PostgreSQL и генератор нагрузки запускаются через Docker Compose.

## Запуск

```sh
make up
make seed-large
make load PROFILE=mixed NAME=baseline
make down
```

Сервис доступен по адресу `http://localhost:8080`. Порт меняется переменной `WEB_PORT`.

Проектная работа лежит в _design.md_, _design/adr/_ и _reports/_. Индекс истории добавляется отдельной миграцией после базового замера.
