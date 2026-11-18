COMPOSE ?= docker compose

.PHONY: up down reset check test transfer resume inspect

up:
	$(COMPOSE) up -d --build --wait

down:
	$(COMPOSE) down --remove-orphans

# Explicit destructive reset of this Compose project's training data.
reset:
	$(COMPOSE) down -v --remove-orphans

check:
	$(COMPOSE) run --rm --no-deps tools pnpm check

test:
	pnpm test

transfer:
	$(COMPOSE) run --rm --no-deps tools node src/transfer.ts start $(CITY) $(TARGET)

resume:
	$(COMPOSE) run --rm --no-deps tools node src/transfer.ts resume $(ID)

inspect:
	$(COMPOSE) exec coordinator psql -U postgres -d taxi -c 'TABLE placements' -c 'SELECT id,city,source,target,stage FROM transfers'
