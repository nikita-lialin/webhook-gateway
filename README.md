# Webhook Gateway

Шлюз приёма и надёжной доставки вебхуков. Запуск и конфигурация — в [DEPLOYMENT.md](DEPLOYMENT.md),
правила разработки — в [AGENTS.md](AGENTS.md), план — в [docs/ROADMAP.md](docs/ROADMAP.md).

## Подпись входящих вебхуков

`POST /webhooks/:endpointId` принимает только подписанные запросы (иначе 401):

- `X-Webhook-Timestamp` — unix-время в секундах; допустимое отклонение от времени сервера ±5 минут;
- `X-Webhook-Signature: sha256=<hex>` — HMAC-SHA256 от строки `<timestamp>.<сырое тело>` с ключом `WEBHOOK_SECRET`.

### Идемпотентность

Ключ — заголовок `Idempotency-Key` (до 255 символов), без него — SHA-256 от сырого тела.
Первый запрос → `202 { "eventId": "…" }`; повтор → `200 { "eventId": "…", "duplicate": true }`.
Ошибка БД → `503`: клиент может безопасно повторить запрос.

### Ручная отправка

Скрипт читает `WEBHOOK_SECRET` из окружения контейнера, подписывает тело и отправляет запрос:

```bash
docker compose exec app npm run sign -- <endpointId> '{"event":"test"}'
```

Третий аргумент — базовый URL (по умолчанию `http://localhost:3000`). Вывод: `<status> <тело ответа>`.
