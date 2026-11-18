.PHONY: up down reset inspect retry test
up:
	docker compose build app
	docker compose up -d --wait

down:
	docker compose down --remove-orphans
reset:
	docker compose down -v --remove-orphans
inspect:
	docker compose exec db psql -U postgres -d taxi -c 'SELECT id,trip_id,published_at FROM event_outbox ORDER BY id' -c 'SELECT id,attempts,last_error,delivered_at FROM notification_jobs ORDER BY id'
retry:
	docker compose exec db psql -U postgres -d taxi -v ON_ERROR_STOP=1 -c "UPDATE notification_jobs SET attempts=0,next_attempt=now() WHERE id=$(ID) AND delivered_at IS NULL"
test:
	pnpm test
