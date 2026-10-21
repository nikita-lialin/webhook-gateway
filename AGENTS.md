# AGENTS.md — правила работы над проектом

Этот файл обязателен для всех, кто пишет код в репозитории, включая AI-ассистентов.

## Процесс

1. Работаем строго по шагам из `docs/ROADMAP.md`. Следующий шаг начинается только после того,
   как все пункты DoD текущего шага выполнены и подтверждены.
2. Один шаг = один коммит (или PR) с сообщением вида `step N: <краткое описание>`.
3. Перед коммитом: `npm run typecheck`, `npm run lint`, `npm test` зелёные (с шага, где они появились).
4. Каждый шаг проходит `CODE_REVIEW_CHECKLIST.md`.
5. Новые переменные окружения, команды и сервисы сразу отражаются в `.env.example` и `DEPLOYMENT.md`.

## Стек (согласован)

- Node.js 20 LTS, TypeScript (strict)
- Fastify (логгер pino, JSON)
- PostgreSQL 16, Redis 7, BullMQ
- Docker Compose

Смена стека или добавление новой инфраструктуры — только после согласования.

## npm-пакеты

Новый пакет добавляется **только после согласования**. Согласованный список:

| Пакет | Зачем | Шаг |
| --- | --- | --- |
| fastify | HTTP-сервер, встроенный pino-логгер | 1 |
| typescript, @types/node, tsx | сборка и dev-режим с автоперезапуском | 1 |
| eslint, typescript-eslint, prettier | запрет `any` и `console.log` линтером, форматирование | 1 |
| zod | валидация env и payload | 2 |
| vitest | unit- и integration-тесты | 2 |
| pg, @types/pg | драйвер PostgreSQL | 3 |
| node-pg-migrate | миграции | 3 |
| bullmq (тянет ioredis) | очереди и воркеры | 9 |
| @fastify/rate-limit | rate limiting ingress | 17 |

Без пакетов: HTTP-клиент — встроенный `fetch` + `AbortSignal.timeout`; HMAC и случайные значения —
`node:crypto`; UUID — `crypto.randomUUID()`.

## Правила кода

- TypeScript `strict`; `any` запрещён (в том числе неявный). Для внешних данных — `unknown` + валидация схемой.
- `console.log` и прочие `console.*` запрещены. Логи — только через логгер Fastify / pino, в JSON.
- `process.env` читается **только** в `src/config`. Остальной код получает типизированный конфиг.
- SQL — только параметризованный (`$1, $2…`), никакой конкатенации строк с пользовательскими данными.
- Секреты (`WEBHOOK_SECRET`, `signing_secret`, `ADMIN_API_KEY`) никогда не попадают в логи и ответы API
  (кроме однократной выдачи `signing_secret` при создании эндпоинта).
- Сравнение секретов и подписей — только `crypto.timingSafeEqual` с проверкой длины.
- Схема БД меняется **только новыми миграциями**. Применённые миграции не редактируются.
- PostgreSQL — источник истины. В Redis/BullMQ лежит только `eventId`.
- `app` и `worker` не импортируют модули друг друга; общее — только `src/config`, `src/db`, `src/queue`.
- Ошибки не глотаются молча: либо обрабатываются, либо логируются с контекстом и пробрасываются.

## Структура проекта

```
src/
  config/          # чтение и валидация env (единственное место с process.env)
  db/              # пул pg, транзакции, types.ts (типы строк таблиц)
  queue/           # подключение к Redis, очереди BullMQ, enqueue
  modules/<фича>/  # endpoints, ingress, events, replay …: routes, service, repository, тесты
  app.ts           # buildApp(): сборка Fastify-инстанса без listen (для тестов через inject)
  index.ts         # точка входа API: buildApp() + listen + graceful shutdown
  worker.ts        # точка входа воркера
migrations/        # миграции node-pg-migrate
test/              # общие тестовые хелперы, E2E
docs/              # ROADMAP.md и прочая документация
```

## Окружение разработки

- Разработка на Windows, запуск — в Docker. Команды в документации должны работать внутри контейнеров.
- Окончания строк — LF (зафиксировано в `.gitattributes`). Не меняйте это: shell-скрипты и
  healthcheck в контейнерах ломаются на CRLF.
