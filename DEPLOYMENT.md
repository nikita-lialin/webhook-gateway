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
| `REDIS_URL` | URL | — | да | строка подключения Redis | 1 |
| `WEBHOOK_SECRET` | строка, ≥ 32 символов | — | да | секрет проверки HMAC-подписи входящих вебхуков | 1 |
| `WORKER_CONCURRENCY` | целое > 0 | `5` | нет | число параллельных доставок в одном воркере | 1 |
| `MAX_RETRY_ATTEMPTS` | целое > 0 | `8` | нет | максимум попыток доставки до перевода в `dead` | 1 |

Добавятся по ходу roadmap (описание появится в этой таблице на соответствующем шаге):
`ADMIN_API_KEY` _(шаг 5)_, лимит тела запроса _(шаг 6)_, таймаут доставки _(шаг 11)_,
база и потолок backoff _(шаг 12)_, интервал sweeper _(шаг 14)_, лимиты rate limit и `TRUST_PROXY` _(шаг 17)_.

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
| `npm run worker` | запуск воркера | 10 |

Внутри контейнера:

```bash
docker compose exec app npm run migrate:up
docker compose exec app npm run migrate:status
```

## Тесты

Integration-тесты работают с отдельной базой `gateway_test` (создаётся init-скриптом postgres)
и тем же Redis с отдельным префиксом очередей _(шаг 3)_.

```bash
docker compose exec app npm test
```

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

`services.database` появляется на шаге 3, `services.redis` — на шаге 9. До этого `/health`
возвращает `{ "status": "ok" }`.

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
