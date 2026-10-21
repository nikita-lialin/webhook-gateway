# Webhook Gateway — Roadmap MVP

Полная версия плана со всеми DoD:
[Webhook Gateway — Roadmap MVP](https://claude.ai/artifact/3Jy4tTxvpwbVjP7aCTEspQ).

Этот файл — трекер прогресса в репозитории. Полный DoD шага переносится сюда, когда шаг начинается,
и отмечается по мере выполнения. Шаг закрыт, когда отмечены все его пункты.

## Прогресс

### Фаза A. Фундамент

- [x] Шаг 0. Документы проекта и соглашения (без кода)
- [x] Шаг 1. Каркас приложения и Docker
- [ ] Шаг 2. Конфигурация и тестовая инфраструктура
- [ ] Шаг 3. Подключение PostgreSQL и механизм миграций
- [ ] Шаг 4. Схема данных (первая миграция)
- [ ] Шаг 5. Реестр подписчиков (Endpoints)

### Фаза B. Приём вебхуков (Ingress)

- [ ] Шаг 6. Маршрут приёма и валидация payload
- [ ] Шаг 7. Проверка HMAC-подписи
- [ ] Шаг 8. Сохранение события и идемпотентность
- [ ] Шаг 9. Redis, BullMQ и постановка в очередь

### Фаза C. Доставка и повторы

- [ ] Шаг 10. Процесс воркера и сервис worker в Compose
- [ ] Шаг 11. Dispatcher: HTTP-отправка и журнал попыток
- [ ] Шаг 12. Retry и экспоненциальный backoff
- [ ] Шаг 13. Dead Letter Queue
- [ ] Шаг 14. Восстановление «застрявших» событий (Recovery Sweeper)

### Фаза D. Логи, Replay, усиление и сдача

- [ ] Шаг 15. Logs API (только чтение)
- [ ] Шаг 16. Ручной Replay
- [ ] Шаг 17. Усиление: rate limiting и graceful shutdown API
- [ ] Шаг 18. E2E-сценарий, аудит «Адвокат дьявола» и документация

---

## Текущий шаг

### Шаг 1. Каркас приложения и Docker

DoD:

- [x] Скрипты `build`, `start` (смотрит на `dist/index.js`), `dev`, `typecheck`, `lint`; `npm run build` и `npm run lint` чистые.
- [x] `.env.example` содержит все 8 переменных из `DEPLOYMENT.md`; `.env` в `.gitignore`.
- [x] В compose у postgres и redis есть healthcheck (`pg_isready`, `redis-cli ping`), app ждёт `service_healthy`; данные postgres в именованном volume.
- [x] В Dockerfile есть `CMD`, образ запускается не от root.
- [x] В коде нет `console.log` (правило ESLint), логи только через pino, JSON.
- [x] `docker compose up --build` поднимает 3 сервиса, `GET /health` отдаёт 200.
