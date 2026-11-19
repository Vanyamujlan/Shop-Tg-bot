# Полный технический аудит проекта Stars Shop (Актуализированная ревизия после Stage 3.2 Update & Stage 3.3)

**Дата ревизии:** 2026-11-19  
**Репозиторий:** `Vanyamujlan/Shop-Tg-bot` (актуальное состояние рабочей ветки `main`)  
**Режим проверки:** Независимый технический аудит фактического исходного кода (без подключения к Production Firebase, без реальных токенов и без реальных платежей)  
**Результаты локальных проверок:**
- Локальные модульные и транзакционные тесты (`npm test` / `src/tests/stage1.test.ts`): **`52/52 PASS`** (`P-01`..`P-05`, `F-01`..`F-03`, `S-01`..`S-03`, `R-01`..`R-08`, `G-01`..`G-06`, `A-01`..`A-08`, `B-01`..`B-11`, `K-01`..`K-08`)
- Пакет аудита на официальном Firebase Emulator (`npm run audit:emulator`): **`38/38 PASS`**
- Статический анализ (`npm run lint` = `eslint . && tsc --noEmit`) и проверка сборки (`npm run build`): **`0 ошибок`**

---

## 1. Аудит 14 обязательных областей проекта

### 1.1. Архитектура проекта, зависимости и точки входа
- **Точки входа:**
  - Серверная: `server.ts` — инициализирует Express (`0.0.0.0:3000`), `firestoreRepo.init()`, `botManager.start()`, фоновый воркер `FulfillmentService.startRecoveryWorker(..., 30_000)` и graceful shutdown (`SIGINT`/`SIGTERM`).
  - Клиентская заглушка превью: `index.html` + `src/index.ts`.
- **Замечания:**
  - На сервере при импорте `src/db/firestore.ts` загружается `src/db/firestoreErrorHandler.ts`, инициализирующий браузерный клиентский SDK `firebase/firestore` (`AUD-001`).
  - В `package.json` остались неиспользуемые 3D/WebXR/AI-зависимости от базового шаблона (`AUD-011`).

### 1.2. Backend, API, авторизация и валидация запросов
- **Маршруты Express (`server.ts`):**
  - `POST /webhook/telegram` — передаёт запрос в `botManager.handleWebhookRequest(req, res)`. Проверяется наличие `WEBHOOK_SECRET` (`503` при отсутствии), заголовок `X-Telegram-Bot-Api-Secret-Token` через `crypto.timingSafeEqual` (`401` при несовпадении) и структура `update_id` (`400` при некорректном теле).
  - `POST /webhook/cryptobot` и `POST /webhook/xrocket` — проверяют криптографические подписи вебхуков (`crypto-pay-api-signature`, `rocket-pay-signature`) по сырому телу запроса (`req.rawBody`) и запускают серверную сверку счёта через официальный REST API провайдера (`verifyAndProcessTopUp`). Маршрут `/webhook/lolzteam` и интеграция Lolzteam полностью удалены.
  - `GET /health` и `GET /` публично возвращают внутренние идентификаторы проекта и БД (`AUD-009`).

### 1.3. Telegram Bot: команды, callback, webhook, защита от повторных запросов
- Инициализация в `src/bot/bot.ts` (фреймворк `telegraf@^4.16.3`).
- Защита от повторных нажатий inline-кнопок реализована через `isDuplicateCallbackClick(userId, key, ttlMs)`.
- Все динамические строки экранируются через `escapeHtml()`.
- Списки заказов, товаров и пользователей обрезаются (`.slice(0, 8)` / `.slice(0, 10)`) без кнопок пагинации (`AUD-006`).

### 1.4. Каталог товаров и система хранения цифровых ключей
- Каталог поддерживает 3 категории (`stars`, `premium`, `gifts`), CRUD товаров в админ-панели и фильтрацию активных позиций (`ProductService`).
- **Исправлено в Stage 3.3 (`AUD-002` — `FIXED` в части хранилища и автоматической выдачи цифровых ключей):**
  - Реализована коллекция `digital_keys` и сервис `DigitalKeyService` (`src/services/DigitalKeyService.ts`).
  - Поддерживается ручное добавление ключей (по одному и списком), автогенерация по внутреннему алгоритму товара (`gift_voucher_v1`, `stars_promo_v1`) только для товаров с заданным `keyGeneratorAlgorithm`, проверка уникальности по SHA-256 (`DuplicateDigitalKeyError`), статусы `available | reserved | delivered | disabled`, учёт остатков и отключение ключей.
  - Доступ к генератору и складу ключей разрешён исключительно владельцу бота (`OWNER_TELEGRAM_ID`, серверная проверка `isOwnerTelegramId` и `ensureOwner`).

### 1.5. Заказы и жизненный цикл статусов
- Заказ создаётся в `OrderService.createOrder()` строго по цене из БД (`totalPrice = product.price * quantity`).
- **Исправлено (`AUD-005` — `FIXED`, `AUD-004` — `FIXED`):** В `OrderService.updateOrderStatus()` действуют серверные транзакционные проверки переходов статусов.

### 1.6. Оплата Stars, проверка оплаты и защита от повторного начисления
- `PaymentService.validatePreCheckout()` проверяет готовность хранилища, валюту `XTR`, блокировку пользователя, владельца заказа, статус `pending`, активность товара и точное совпадение суммы.
- `PaymentService.processSuccessfulPayment()` выполняется в одной транзакции Firestore (все `tx.get` строго до `tx.set`) с дедупликацией по `payments/pay_<telegramPaymentChargeId>`.
- **Риск (`AUD-013`):** `processSuccessfulPayment` проверяет наличие документа товара `products/{order.productId}` и выбрасывает исключение, если администратор физически удалил товар через `adm:pdel` после выставления счёта.

### 1.7. Возвраты, конкурентные запросы и согласованность Firestore
- Реализовано двухэтапное подтверждение возврата в админ-панели (`adm:ord_refund` -> `adm:ord_refund_confirm` для Stars и `adm:ord_bal_refund` -> `adm:ord_bal_refund_confirm` для внутреннего баланса).
- **Исправлено в Stage 3.1 (`AUD-003`, `AUD-004`, `AUD-015`, `AUD-016` — `FIXED`):**
  1. **`AUD-003` (`FIXED`):** `PaymentService.markPaymentRefunded()` атомарно уменьшает `totalOrders` и `totalSpentStars` пользователя с флагом `refundStatsAdjusted: true`.
  2. **`AUD-015` (`FIXED`):** Распределённая блокировка возврата через транзакцию Firestore (`order.refundState = 'refund_in_progress'`, `refundLockToken`, `refundStartedAt`).
  3. **`AUD-016` (`FIXED`):** 3-фазный протокол возврата и метод восстановления `PaymentService.recoverPendingRefunds()`.

### 1.8. Автоматическая выдача цифровых товаров после подтверждённой оплаты
- **Исправлено в Stage 3.3 (`AUD-002` — `FIXED`):**
  - После подтверждённой оплаты (`Telegram Stars` или `внутренний баланс`) `FulfillmentService.initiateFulfillment()` вызывает `DigitalKeyService.fulfillOrderWithDigitalKey()`.
  - Внутри транзакции Firestore атомарно выбирается свободный ключ (`status === 'available'`), переводится в `delivered` с привязкой к `orderId`, `userId`, `userTelegramId` и `deliveredAt`.
  - Два параллельных заказа гарантированно получают разные ключи (`K-05`), повторный webhook не выдаёт второй ключ (`K-06`).
  - При отсутствии доступных ключей заказ **не** помечается как выполненный (`fulfillmentStatus: 'processing'`, `awaitingKeyStock: true`), а владельцу (`OWNER_TELEGRAM_ID`) отправляется уведомление о нехватке ключей (`K-07`).
  - При сбое отправки сообщения Telegram выданный ключ сохраняется в заказе в БД и не теряется (`K-08`).

### 1.9. Админ-панель, права доступа и финансовые операции
- Все обработчики админ-панели защищены проверкой `ensureAdmin(ctx)`, а раздел генератора и склада цифровых ключей (`/keys`, `own:keys:*`, сессия `owner_add_keys`) дополнительно защищён серверной проверкой `ensureOwner(ctx)` и `DigitalKeyService.assertOwnerAccess(actorTelegramId)` строго по `OWNER_TELEGRAM_ID`.
- Обычные пользователи (`K-01`) и другие администраторы из `ADMIN_IDS`, не являющиеся `OWNER_TELEGRAM_ID` (`K-02`), не имеют доступа к управлению ключами.

### 1.10. Firestore Rules, индексы и транзакции
- `firestore.rules` запрещает клиентский доступ к `/digital_keys/{keyId}` (`allow read, write: if false;`), запрещает клиентскую запись в `/payments`, `/payment_charges`, `/balance_topups`, `/transactions`, `/admins`, `/settings` и валидирует новые поля `Product`, `Order` и `StoreTransaction`.
- `firestore.indexes.json` содержит составные индексы для `orders`, `payments`, `products`, `transactions`.

### 1.11. Защита секретов, конфиденциальных данных и внутренних endpoint
- Секреты (`TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `FIREBASE_PRIVATE_KEY`, `CRYPTOBOT_API_TOKEN`, `XROCKET_API_KEY`) маскируются в логах через `maskSecretsInText()` и `redactSecretsFromText()`, а значения цифровых ключей маскируются через `maskDigitalKey()` (`STAR****EF99`).
- Публичные маршруты `GET /health` и `GET /` раскрывают инфраструктурные идентификаторы (`AUD-009`).

### 1.12. Обработка ошибок, логирование и мониторинг
- При недоступности Firebase Admin SDK в Production активируется защитный режим `degradedMode = true` (`StorageUnavailableError`), блокирующий создание новых заказов и `pre_checkout_query`.
- При ошибках xRocket Pay REST API v1 парсится структурированный формат Problem Details (`status`, `type`, `title`, `detail`, `instance`, `kind`) через `XRocketApiError` (`B-05`).

### 1.13. Тесты, покрытие критических сценариев и конкурентные операции
- В наличии два набора автотестов:
  1. `npm test` (`src/tests/stage1.test.ts` — **`52/52 PASS`**): покрывает оплату Stars (`P-01`..`P-05`), выдачу и crash-recovery (`F-01`..`F-03`), защиту webhook (`S-01`..`S-03`), правила безопасности (`R-01`..`R-08`), граничные сценарии (`G-01`..`G-06`), финансовую консистентность и возвраты (`A-01`..`A-08`), пополнение баланса через CryptoBot (3%) и xRocket Pay REST API v1 (2%) (`B-01`..`B-11`), а также генератор ключей владельца и автоматическую выдачу ключей (`K-01`..`K-08`).
  2. `npm run audit:emulator` (`firestore-audit-package` — **`38/38 PASS`**): проверяет `firestore.rules`, CRUD и транзакции на реальном Firebase Emulator (`127.0.0.1:8080`).

### 1.14. Сборка, зависимости, конфигурация и готовность к развёртыванию
- В `package.json` команда `"build": "tsc --noEmit"` при `"noEmit": true` в `tsconfig.json` выполняет статическую проверку типов TypeScript (`AUD-011`).

---

## 2. Статус реестра дефектов (`AUD-001` — `AUD-016`)

- **`AUD-001` (`High` — `OPEN`):** Инициализация клиентского Firebase SDK в `src/db/firestoreErrorHandler.ts`.
- **`AUD-002` (`Critical` — `FIXED` в Stage 3.3):** Реализованы коллекция `digital_keys`, owner-only генератор и склад ключей (`DigitalKeyService`) и автоматическая транзакционная выдача уникальных ключей после оплаты (`K-01`..`K-08`).
- **`AUD-003` (`High` — `FIXED` в Stage 3.1):** Атомарное уменьшение `totalOrders` и `totalSpentStars` при возврате (`A-07`).
- **`AUD-004` (`High` — `FIXED` в Stage 3.1):** Двухэтапное подтверждение возврата и серверный запрет отмены оплаченных заказов (`A-02`..`A-06`).
- **`AUD-005` (`High` — `FIXED`):** Запрет перевода неоплаченного заказа в `processing`/`completed` (`A-01`, `A-02`).
- **`AUD-006` (`Medium` — `OPEN`):** Отсутствие пагинации длинных списков и лимит 200 документов в `adm:stats`.
- **`AUD-007` (`Medium` — `FIXED` в Stage 3.1):** Транзакционное обновление профиля в `UserService.upsertFromTelegram` и `setUserBlocked` (`A-08`).
- **`AUD-008` (`Medium` — `OPEN`):** Поле `maintenanceMode` в `settings/global` не проверяется при создании заказа.
- **`AUD-009` (`Medium` — `OPEN`):** Публичные эндпоинты `GET /health` и `GET /` возвращают `projectId` и `databaseId`.
- **`AUD-010` (`Medium` — `OPEN`):** В UI покупателя фиксировано `quantity: 1`.
- **`AUD-011` (`Medium` — `OPEN`):** `npm run build` выполняет `tsc --noEmit`; в `package.json` присутствуют зависимости базового XR-шаблона.
- **`AUD-012` (`Low` — `OPEN`):** Неиспользуемый метод `UserService.incrementUserPurchaseStats`.
- **`AUD-013` (`Medium` — `OPEN`):** Физическое удаление товара (`adm:pdel`) без подтверждения.
- **`AUD-014` (`Low` — `OPEN`):** Расхождение клиентского правила отмены заказа по `fulfillmentNote`.
- **`AUD-015` (`High` — `FIXED` в Stage 3.1):** Распределённая блокировка возврата через транзакцию Firestore (`A-05`).
- **`AUD-016` (`High` — `FIXED` в Stage 3.1):** Восстановление после сбоя Firestore вслед за успешным возвратом Telegram (`A-06`).

---

## 3. STAGE 3.2 (Обновление) — Удаление Lolzteam, минималистичный 3-шаговый UI пополнения и исправление xRocket Pay REST API v1

1. **Полное удаление LOLZTEAM:**
   - Интеграция Lolzteam (`lolzteam`), комиссия 5%, переменные `LOLZTEAM_API_TOKEN`, `LOLZTEAM_MERCHANT_ID`, `LOLZTEAM_WEBHOOK_SECRET`, `LOLZTEAM_API_URL`, маршрут `POST /webhook/lolzteam`, кнопки выбора и тесты Lolzteam полностью удалены из проекта.
   - Архитектура `BalanceService` и `PaymentProviderGateway` сохранена расширяемой для подключения новых провайдеров в будущем.
2. **Минималистичный 3-шаговый интерфейс пополнения баланса (`src/bot/keyboards.ts`, `src/bot/formatters.ts`, `src/bot/handlers/userHandler.ts`):**
   - **Шаг 1/3 (`💰 ПОПОЛНЕНИЕ БАЛАНСА · Шаг 1/3 · 💳 Выберите способ оплаты:`):** кнопки `💎 CryptoBot [3%]`, `🚀 xRocket [2%]`, `📜 История пополнений`, `« Назад`.
   - **Шаг 2/3 (`💵 СУММА ПОПОЛНЕНИЯ · Шаг 2/3`):** отображает выбранный способ оплаты, комиссию (`3%` или `2%`), минимальную сумму, пресеты сумм, расчёт комиссии (`Сумма пополнения`, `Комиссия`, `Итоговая сумма зачисления`), ввод суммы вручную и кнопку `« Назад`.
   - **Шаг 3/3 для xRocket (`🪙 ВАЛЮТА ОПЛАТЫ · Шаг 3/3`):** сетка поддерживаемых монет и сетей xRocket (`USDT (TON/TRC-20/BEP-20/ERC-20)`, `TON (TON)`, `BTC (Bitcoin)`, `ETH (ERC-20)`, `TRX (TRC-20)`, `BNB (BEP-20)`, `USDC (ERC-20/BEP-20)`) и кнопка `« Назад`.
   - **Созданный счёт (`📄 СЧЁТ СОЗДАН · Шаг 3/3`):** показывает способ оплаты, валюту/сеть, сумму пополнения, комиссию и итоговую сумму к зачислению (`creditedAmount = paidAmount * (1 - feePercent / 100)`) и 3 кнопки: `💳 Оплатить`, `🔄 Проверить оплату`, `« Назад`.
3. **Исправление ошибки xRocket HTTP 404 (переход на официальный xRocket Pay REST API v1):**
   - Устаревший endpoint `https://pay.xrocket.tg/tg-invoices` и заголовок `Rocket-Pay-Key` заменены на актуальный официальный **xRocket Pay REST API v1**:
     - Production URL: `https://pay.api.xrocket.exchange` (Testnet: `https://pay.api.testnet.xrocket.exchange`).
     - Функция `buildXRocketApiV1Url()` формирует канонический путь `/api/v1/invoices` без дублирования `/api/v1`.
     - Авторизация: заголовок `Authorization: Bearer <XROCKET_API_KEY>`.
     - Создание счёта: `POST /api/v1/invoices` с телом `{ priceAmount, priceCurrency, payCurrencies: [priceCurrency], clientInvoiceId, description, expiresIn: 1800000 }`, обработка ответа HTTP `201 Created` и извлечение ссылки из `links.telegramBotLink`.
     - Проверка статуса: `GET /api/v1/invoices?ids=<externalInvoiceId>` со сверкой `id`, `clientInvoiceId`, `priceAmount`, `priceCurrency` и статуса `PAID`.
     - Диагностика ошибок: парсинг RFC 7807 Problem Details (`{ status, type, title, detail, instance, kind }`) в `XRocketApiError` с маскированием секретов.

---

## 4. STAGE 3.3 — Генератор ключей для владельца (`OWNER_TELEGRAM_ID`) и автоматическая выдача цифровых ключей

1. **Строгая авторизация только для владельца (`OWNER_TELEGRAM_ID`):**
   - Переменная окружения `OWNER_TELEGRAM_ID` добавлена в `.env.example` и `src/config/env.ts` (`isOwnerTelegramId()`).
   - Серверная проверка прав владельца выполняется в `DigitalKeyService.assertOwnerAccess()` и `ensureOwner(ctx)` при каждой команде (`/keys`), каждом callback (`own:keys:*`) и каждом текстовом вводе (`owner_add_keys`).
   - Обычные покупатели (`K-01`) и другие администраторы из `ADMIN_IDS`, не являющиеся `OWNER_TELEGRAM_ID` (`K-02`), получают отказ `OwnerAccessDeniedError`.
2. **Управление складом и генерацией ключей (`src/services/DigitalKeyService.ts`, коллекция `digital_keys`):**
   - Поддерживается ручное добавление одного или пачки ключей (`DigitalKeyService.addKeys`), автогенерация ключей по заданному внутреннему алгоритму (`DigitalKeyService.generateKeys` для `gift_voucher_v1` / `stars_promo_v1`), просмотр остатков по статусам (`available`, `reserved`, `delivered`, `disabled`), просмотр выданных ключей, история выдачи и отключение неиспользованных ключей (`DigitalKeyService.disableKey`).
   - Для товаров без внутреннего алгоритма автогенерация запрещена (`UnsupportedKeyGeneratorError`), разрешена только ручная загрузка реальных ключей (`K-03`).
   - Уникальность каждого ключа гарантируется детерминированным SHA-256 хешем (`dkey_<sha256_32>`) внутри транзакции Firestore (`K-04`).
3. **Автоматическая транзакционная выдача после оплаты (`FulfillmentService` + `DigitalKeyService.fulfillOrderWithDigitalKey`):**
   - После подтверждённой оплаты заказа транзакция Firestore атомарно резервирует и переводит свободный ключ из `available` в `delivered` с привязкой к `orderId` и `userTelegramId`.
   - Исключена двойная выдача одного ключа двум параллельным заказам (`K-05`) и повторная выдача при дублирующемся webhook (`K-06`).
   - При отсутствии свободных ключей заказ остаётся в `fulfillmentStatus: 'processing'` (`awaitingKeyStock: true`, **не** `completed`), а владельцу (`OWNER_TELEGRAM_ID`) отправляется уведомление (`K-07`).
   - При сбое отправки сообщения в Telegram выданный ключ остаётся привязанным к заказу в Firestore и доступен покупателю в карточке заказа (`K-08`).

