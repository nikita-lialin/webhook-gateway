# DEPLOYMENT.md — запуск и эксплуатация

> Документ описывает целевое состояние MVP. Возможности, которых ещё нет в коде, помечены
> шагом roadmap, на котором они появятся: _(шаг N)_.

## Требования

- Docker Desktop (Windows/macOS) или Docker Engine + Compose v2 (Linux).
- Node.js 20 LTS — только если нужно запускать что-то вне контейнеров.

## Быстрый старт

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
# заполнить WEBHOOK_SECRET и ADMIN_API_KEY
docker compose up --build
```

Проверка:

```bash
curl http://localhost:3000/health
```

## Сервисы Docker Compose

| Сервис | Образ / команда | Порт | Назначение | Шаг |
| --- | --- | --- | --- | --- |
| `app` | образ проекта, `node dist/index.js` | 3000 | API: приём вебхуков, admin-API, Logs API, replay | 1 |
| `worker` | тот же образ, `node dist/worker.js` | — | доставка, повторы, DLQ, recovery sweeper | 10 |
| `postgres` | `postgres:16-alpine` | 5432 | источник истины; данные в именованном volume | 1 |
| `redis` | `redis:7-alpine` (`appendonly yes`, `maxmemory-policy noeviction`) | 6379 | очереди BullMQ, счётчики rate limit | 1 |

Порядок старта: `postgres` и `redis` имеют healthcheck (`pg_isready`, `redis-cli ping`);
`app` и `worker` стартуют после `service_healthy`.

## Переменные окружения

| Переменная | Тип | По умолчанию | Обязательная | Описание | Шаг |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` \| `production` \| `test` | `development` | нет | режим работы | 1 |
| `PORT` | число | `3000` | нет | порт HTTP-сервера `app` | 1 |
| `LOG_LEVEL` | `fatal` … `trace` | `info` | нет | уровень логов pino | 1 |
| `DATABASE_URL` | URL | — | да | строка подключения PostgreSQL | 1 |
| `TEST_DATABASE_URL` | URL | — | нет | БД `gateway_test` для integration-тестов; без неё они пропускаются | 3 |
| `DB_POOL_MAX` | целое > 0 | `10` | нет | максимум соединений в пуле PostgreSQL | 3 |
| `DB_STATEMENT_TIMEOUT_MS` | целое > 0 | `10000` | нет | `statement_timeout` для каждого соединения | 3 |
| `REDIS_URL` | URL | — | да | строка подключения Redis | 1 |
| `WEBHOOK_SECRET` | строка, ≥ 32 символов | — | да | секрет проверки HMAC-подписи входящих вебхуков (`X-Webhook-Signature`) | 7 |
| `ADMIN_API_KEY` | строка, ≥ 32 символов | — | да | статичный ключ admin-API (`/endpoints`), передаётся в заголовке `X-Admin-Api-Key` | 5 |
| `WORKER_CONCURRENCY` | целое > 0 | `5` | нет | число параллельных доставок в одном воркере | 1 |
| `MAX_RETRY_ATTEMPTS` | целое > 0 | `8` | нет | максимум попыток доставки до перевода в `dead` | 1 |
| `RETRY_BASE_DELAY_MS` | целое > 0 | `1000` | нет | база backoff: задержка перед n-м повтором — `base × 2^(n−1)` с full jitter, мс | 12 |
| `RETRY_MAX_DELAY_MS` | целое ≥ base | `3600000` | нет | потолок задержки повтора (включая `Retry-After` для 429), мс | 12 |
| `DELIVERY_TIMEOUT_MS` | целое > 0 | `10000` | нет | жёсткий таймаут одного исходящего HTTP-запроса доставки, мс | 11 |
| `BODY_LIMIT_BYTES` | целое > 0 | `1048576` | нет | максимальный размер тела `POST /webhooks/:endpointId`; больше → 413 | 6 |

Добавятся по ходу roadmap (описание появится в этой таблице на соответствующем шаге):
интервал sweeper _(шаг 14)_, лимиты rate limit и `TRUST_PROXY` _(шаг 17)_.

Генерация секрета:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Команды npm

| Команда | Что делает | Шаг |
| --- | --- | --- |
| `npm run dev` | запуск API в dev-режиме с автоперезапуском | 1 |
| `npm run build` | компиляция TypeScript в `dist/` | 1 |
| `npm start` | запуск собранного API (`dist/index.js`) | 1 |
| `npm run typecheck` | `tsc --noEmit` | 1 |
| `npm run lint` | ESLint | 1 |
| `npm test` | unit- и integration-тесты (vitest) | 2 |
| `npm run migrate:up` | применить миграции | 3 |
| `npm run migrate:down` | откатить последнюю миграцию | 3 |
| `npm run migrate:status` | показать применённые и ожидающие миграции | 3 |
| `npm run sign -- <endpointId> '<json>' [baseUrl]` | отправить подписанный тестовый вебхук (секрет из `WEBHOOK_SECRET`; запускать в контейнере `app`) | 7 |
| `npm run worker` | запуск воркера | 10 |

Внутри контейнера:

```bash
docker compose exec app npm run migrate:up
docker compose exec app npm run migrate:status
```

## Миграции

Файлы — SQL в `migrations/` (`-- Up Migration` / `-- Down Migration`), раннер — node-pg-migrate.
Новая миграция: `npm run migrate:create -- <имя>`. Применённые миграции не редактируются.
`migrate:status` печатает JSON `{ applied, pending }`.

### Схема данных _(шаг 4)_

Первая миграция `1792600000000_init-schema.sql` создаёт три таблицы; типы строк — `src/db/types.ts`.

| Таблица | Назначение | Ключевое |
| --- | --- | --- |
| `endpoints` | подписчики | не удаляются, только `is_active = false` (`events.endpoint_id` — `ON DELETE RESTRICT`) |
| `events` | входящие события | уникальный `(endpoint_id, idempotency_key)`; `status` — CHECK: `pending`, `processing`, `delivered`, `failed`, `dead` |
| `delivery_attempts` | журнал попыток | уникальный `(event_id, attempt_number)`; удаляется каскадом вместе с событием |

## Тесты

Integration-тесты работают с отдельной базой `gateway_test`. Её создаёт init-скрипт
`docker/postgres/01-create-test-db.sql`, но postgres выполняет такие скрипты **только на пустом volume**.
Если volume уже существует:

```bash
docker compose exec postgres psql -U gateway -d gateway -c "CREATE DATABASE gateway_test OWNER gateway"
# или пересоздать данные: docker compose down -v && docker compose up --build
```

Образ `app` — runtime без dev-зависимостей, поэтому тесты запускаются на хосте (порт 5432 проброшен):

```powershell
$env:TEST_DATABASE_URL = "postgres://gateway:gateway@localhost:5432/gateway_test"
npm test
```

Без `TEST_DATABASE_URL` integration-тесты пропускаются (unit-тесты идут всегда).
Для тестов очереди и `services.redis` задайте ещё `TEST_REDIS_URL` (например `redis://localhost:6379`); без неё эти тесты пропускаются.
Очередь `webhook-delivery` хранит только `eventId` (jobId = eventId); если Redis недоступен, ingress всё равно отвечает 202, а событие остаётся `pending`.

## Контракт `GET /health`

Без авторизации. Используется healthcheck-ом контейнера и для ручной проверки.

Всё в порядке → **200**:

```json
{
  "status": "ok",
  "services": {
    "database": "connected",
    "redis": "connected"
  }
}
```

Любая зависимость недоступна → **503**:

```json
{
  "status": "degraded",
  "services": {
    "database": "disconnected",
    "redis": "connected"
  }
}
```

`services.database` появился на шаге 3, `services.redis` — на шаге 9.

## Логи

Все процессы пишут JSON-логи в stdout (pino).

```bash
docker compose logs -f app
docker compose logs -f worker
```

## Остановка

```bash
docker compose down        # остановить, данные postgres сохраняются в volume
docker compose down -v     # остановить и удалить данные
```

По SIGTERM `app` дожидается активных запросов, `worker` — текущих доставок; затем закрываются
пул PostgreSQL и соединение с Redis _(шаги 10, 17)_.
