PROFILE ?= mixed
SCALE ?= 1
NAME ?= $(PROFILE)

setup:
	npm ci
	npm run migrate

migrate:
	npm run migrate

start:
	node src/index.ts

lint:
	npx tsc --noEmit

test:
	npx tsc --noEmit

# Стенд целиком. Замер идёт на поднятом стенде, поэтому цель поднимает его и
# оставляет работать.
# Порядок важен. Приложение запускается из смонтированного каталога, поэтому
# до установки зависимостей оно падает, а сама установка требует поднятой
# базы, потому что вместе с зависимостями применяются миграции.
up:
	docker compose up -d db replica notifications
	docker compose run --rm app make setup
	docker compose up -d

down:
	docker compose down -v --remove-orphans

psql:
	docker compose exec db psql -U postgres -d taxi

seed-large:
	docker compose exec -T db psql -U postgres -d taxi -v ON_ERROR_STOP=1 < db/seed-large.sql

# Нагрузочный прогон. Шапку отчёта с условиями опыта цель пишет сама: руками
# их переписывают неполно, а без них числа замера ничего не значат.
load:
	@mkdir -p reports
	@{ \
	  echo "# Замер $(NAME)"; \
	  echo ""; \
	  echo "## Условия опыта"; \
	  echo ""; \
	  echo "- дата: $$(date -u '+%Y-%m-%d %H:%M:%SZ')"; \
	  echo "- коммит: $$(git rev-parse --short HEAD 2>/dev/null || echo 'вне git')"; \
	  echo "- ядер у docker: $$(docker info --format '{{.NCPU}}')"; \
	  echo "- память docker: $$(docker info --format '{{.MemTotal}}') байт"; \
	  echo "- лимиты app: $$(docker inspect --format '{{.HostConfig.NanoCpus}} nanocpus, {{.HostConfig.Memory}} байт' $$(docker compose ps -q app | head -1))"; \
	  echo "- сценарий: load/$(PROFILE).ts, множитель частот $(SCALE)"; \
	  echo "- профиль: load/profile.json"; \
	  echo ""; \
	  echo "## Итоги прогона"; \
	  echo ""; \
	  echo "Числа в reports/$(NAME).json." ; \
	  echo ""; \
	  echo "## Вывод"; \
	  echo ""; \
	  echo "TODO: что упёрлось в предел и по какому признаку это видно."; \
	} > reports/$(NAME).md
	docker compose --profile load run --rm -e RATE_SCALE=$(SCALE) k6 run /load/$(PROFILE).ts --summary-export=/reports/$(NAME).json

# Каталог load/ существует, поэтому без .PHONY make считает цель выполненной.
.PHONY: setup migrate start lint test up down psql seed-large load
