# Webhook Gateway — Roadmap MVP

Полная версия плана со всеми DoD:
[Webhook Gateway — Roadmap MVP](https://claude.ai/artifact/3Jy4tTxvpwbVjP7aCTEspQ).

Этот файл — трекер прогресса в репозитории. Полный DoD шага переносится сюда, когда шаг начинается,
и отмечается по мере выполнения. Шаг закрыт, когда отмечены все его пункты.

## Прогресс

### Фаза A. Фундамент

- [x] Шаг 0. Документы проекта и соглашения (без кода)
- [x] Шаг 1. Каркас приложения и Docker
- [x] Шаг 2. Конфигурация и тестовая инфраструктура
- [x] Шаг 3. Подключение PostgreSQL и механизм миграций
- [x] Шаг 4. Схема данных (первая миграция)
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

### Шаг 4. Схема данных (первая миграция)

Три таблицы, на которых стоит всё остальное:

- `endpoints` — подписчики: `id`, `name`, `source`, `target_url`, `signing_secret`, `is_active`, таймстемпы.
- `events` — входящие события: `id` (UUID), `endpoint_id`, `idempotency_key`, `payload` (JSONB), `headers` (JSONB),
  `status` (`pending` / `processing` / `delivered` / `failed` / `dead`, CHECK-ограничение), `attempts_count`,
  `next_attempt_at`, таймстемпы.
- `delivery_attempts` — журнал попыток: `event_id`, `attempt_number`, `response_status`, `response_body` (обрезанное),
  `error`, `duration_ms`, `created_at`.

DoD:

- [x] `migrate:up` создаёт таблицы, `migrate:down` чисто откатывает (проверено циклом up → down → up).
- [x] Индексы: уникальный `(endpoint_id, idempotency_key)`, `(status, next_attempt_at)`, `delivery_attempts(event_id)`,
      уникальный `(event_id, attempt_number)`.
- [x] Внешние ключи с явным `ON DELETE` (эндпоинты не удаляются, только выключаются).
- [x] TypeScript-типы строк — в одном месте (`src/db/types.ts`).
- [x] После этого шага схема меняется только новыми миграциями.
