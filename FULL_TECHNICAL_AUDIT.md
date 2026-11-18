# Полный технический аудит проекта Stars Shop (Telegram-магазин цифровых товаров и ключей)

**Дата проведения аудита:** 2026-11-18  
**Репозиторий:** `Vanyamujlan/Shop-Tg-bot`  
**Режим проверки:** Полный статический и архитектурный аудит кодовой базы (Read-Only, без изменения исходного кода, без подключения к Production Firebase и без реальных платежей)  
**Статус пакета Firestore Emulator Audit Package:** `COMPLETED` (`38/38 PASS`, архив `firestore-audit-package.zip` верифицирован)

---

## 1. Полная инвентаризация проекта

### 1.1. Структура папок и файлов репозитория

```text
/
├── .env.example                           # Шаблон переменных окружения (без реальных секретов)
├── AUDIT_REPORT.md                        # Отчёт о проверке Firestore Emulator Audit Package
├── DRAFT_firestore.rules                  # Черновая версия правил безопасности (устаревший дубликат)
├── FULL_TECHNICAL_AUDIT.md                # Настоящий отчёт полного технического аудита проекта
├── README.md                              # Документация по запуску и проверке проекта и аудит-пакета
├── firebase-applet-config.json            # Конфигурация клиентского Firebase апплета
├── firebase-blueprint.json                # Схема сущностей и коллекций Firestore
├── firebase.json                          # Конфигурация Firebase CLI (эмулятор Firestore 127.0.0.1:8080 и деплой правил)
├── firestore-audit-package.zip            # Верифицированный архив Firestore Emulator Audit Package (22 записи: 14 файлов, 8 папок)
├── firestore.indexes.json                 # Составные индексы Firestore (orders, payments, transactions)
├── firestore.rules                        # Основной файл правил безопасности Cloud Firestore (371 строка)
├── index.html                             # Заглушка клиентской страницы для Vite / AI Studio preview
├── metadata.json                          # Метаданные апплета AI Studio
├── package.json                           # Манифест зависимостей и npm-скриптов
├── security_spec.md                       # Спецификация модели безопасности Firestore
├── server.ts                              # Точка входа HTTP-сервера Express, инициализация БД, бота и фонового воркера
├── tsconfig.json                          # Конфигурация компилятора TypeScript
├── vite.config.js                         # Конфигурация Vite
├── src/
│   ├── bg.svg                             # Остаточный графический ассет шаблона
│   ├── constants.ts                       # Категории товаров и стартовый набор тестовых товаров (INITIAL_TEST_PRODUCTS)
│   ├── index.css                          # Остаточный файл стилей шаблона
│   ├── index.ts                           # Клиентская точка входа для превью-статус страницы
│   ├── types.ts                           # Глобальные интерфейсы TypeScript (User, Product, Order, Payment, TransactionRecord, StoreSettings)
│   ├── config/
│   │   └── env.ts                         # Парсинг, валидация переменных окружения и защита от утечки секретов
│   ├── db/
│   │   ├── firestore.ts                   # Репозиторий Firestore (Firebase Admin SDK + In-Memory Fallback + транзакции)
│   │   └── firestoreErrorHandler.ts       # Инициализация клиентского Firebase SDK и диагностика соединения
│   ├── bot/
│   │   ├── bot.ts                         # Инициализация Grammy Bot, подключение middleware, команд, webhook/polling
│   │   ├── formatters.ts                  # Форматирование текстовых сообщений Telegram (HTML, экранирование)
│   │   ├── keyboards.ts                   # Генерация Inline-клавиатур для покупателей и администраторов
│   │   └── handlers/
│   │       ├── userHandler.ts             # Обработчики пользовательских команд (/start, /catalog, /orders, /profile, /support, /help) и витрины
│   │       ├── paymentHandler.ts          # Обработчики покупки (buy:<id>), pre_checkout_query и successful_payment (Telegram Stars XTR)
│   │       └── adminHandler.ts            # Полная админ-панель (/admin, заказы, возвраты, товары, мастер создания, пользователи, статистика)
│   └── services/
│       ├── UserService.ts                 # Сервис управления пользователями, ролями и блокировками
│       ├── ProductService.ts              # Сервис управления каталогом товаров и валидации карточек
│       ├── OrderService.ts                # Сервис жизненного цикла заказов и статусных переходов
│       ├── PaymentService.ts              # Сервис транзакционной обработки платежей Telegram Stars и возвратов (refundStarPayment)
│       └── FulfillmentService.ts          # Сервис исполнения заказов, идемпотентной доставки, ретраев и фонового восстановления
└── firestore-audit-package/               # Автономный пакет аудита на официальном Firebase Emulator (38 тестов)
    ├── README.md
    ├── AUDIT_REPORT.md
    ├── firebase.json
    ├── firestore.rules
    ├── firestore.indexes.json
    ├── scripts/
    │   ├── productionGuard.ts
    │   ├── seedAuditData.ts
    │   └── runAuditEmulatorCli.ts
    ├── tests/
    │   ├── securityRules.emulator.test.ts
    │   ├── functionalCrudAndTransactions.test.ts
    │   └── javaCheck.test.ts
    └── reports/
        ├── audit-test-results.json
        └── emulator-synthetic-dump.json
```

### 1.2. Анализ `package.json` и зависимостей
- **Используемые серверные зависимости:**
  - `express` (`^5.2.1`) — HTTP-сервер, маршрутизация `/webhook`, `/health`, `/`.
  - `grammy` (`^1.42.0`) — фреймворк для работы с Telegram Bot API (включая Telegram Stars `XTR`, `answerPreCheckoutQuery`, `refundStarPayment`).
  - `firebase-admin` (`^13.7.0`) — серверный SDK для привилегированного доступа к Cloud Firestore и транзакций.
  - `dotenv` (`^17.4.0`) — загрузка переменных окружения.
- **Тестовые и сборочные зависимости:**
  - `tsx` (`^4.21.0`), `typescript` (`^5.9.3`), `@firebase/rules-unit-testing` (`^5.0.0`), `@types/express`, `@types/node`.
- **Неиспользуемые/остаточные зависимости от шаблона (`AUD-011`):**
  - В `package.json` присутствуют пакеты 3D/XR/AI-шаблона (`xrblocks`, `three`, `@dimforge/rapier3d-simd-compat`, `@mediapipe/*`, `@pmndrs/uikit`, `@sparkjsdev/spark`, `troika-three-text`, `openai`, `@google/genai`, `lit`, `firebase`), которые не требуются серверному Telegram-боту.

### 1.3. Серверная архитектура (`server.ts`)
- Сервер работает на порту `3000` (настраивается через `PORT`, привязан к `0.0.0.0`).
- Последовательность запуска в `bootstrap()` (`server.ts:122-154`):
  1. Проверка конфигурации `validateConfig()` (`src/config/env.ts`).
  2. Инициализация репозитория БД `await firestoreRepo.init()` (`src/db/firestore.ts`) и первичный сидинг тестовых данных `await firestoreRepo.seedInitialData()`.
  3. Инициализация Telegram-бота `await initBot()` (`src/bot/bot.ts`):
     - В режиме `BOT_MODE=webhook` проверяет HTTPS `WEBHOOK_URL` и `WEBHOOK_SECRET`, регистрирует webhook в Telegram с `secret_token`.
     - В режиме `BOT_MODE=polling` удаляет старый webhook (`drop_pending_updates: false`) и запускает long polling с `allowed_updates: ['message', 'callback_query', 'pre_checkout_query']`.
  4. Запуск фонового воркера восстановления незавершённых выдач `FulfillmentService.startRecoveryWorker(bot)` с интервалом `60_000` мс (`1 минута`).

### 1.4. Архитектура базы данных (Firebase / Firestore)
В проекте используются **7 коллекций Firestore**:
1. `users/{userId}` — профили покупателей и администраторов (`id`, `username`, `firstName`, `lastName`, `languageCode`, `role`, `isBlocked`, `totalOrders`, `totalSpentStars`, `createdAt`, `updatedAt`).
2. `products/{productId}` — каталог цифровых товаров (`id`, `title`, `shortDescription`, `description`, `category`, `price`, `currency: 'XTR'`, `isActive`, `isFeatured`, `deliveryType`, `deliveryContent`, `fulfillmentType`, `stock`, `sortOrder`, `metadata`, `createdAt`, `updatedAt`).
3. `orders/{orderId}` — заказы пользователей (`id`, `userId`, `username`, `firstName`, `productId`, `productTitle`, `category`, `quantity`, `pricePerUnit`, `totalPrice`, `currency: 'XTR'`, `paymentStatus`, `fulfillmentStatus`, `fulfillmentType`, `deliveryType`, `deliveredContent`, `fulfillmentNote`, `deliveryAttempts`, `fulfillmentLockId`, `fulfillmentLockedAt`, `adminNotifiedAt`, `telegramPaymentChargeId`, `providerPaymentChargeId`, `createdAt`, `updatedAt`, `paidAt`, `completedAt`, `refundedAt`).
4. `payments/{paymentId}` — записи платежей Telegram Stars (`id`, `orderId`, `userId`, `productId`, `amount`, `currency: 'XTR'`, `status: 'succeeded' | 'refunded'`, `invoicePayload`, `telegramPaymentChargeId`, `providerPaymentChargeId`, `rawSummary`, `createdAt`, `refundedAt`, `refundedByAdminId`, `refundReason`).
5. `payment_charges/{chargeId}` — дедупликационный реестр идентификаторов `telegramPaymentChargeId` для 100% защиты от двойного зачисления одного и того же платежа внутри транзакции.
6. `transactions/{txId}` — неизменяемый журнал аудита всех событий (`order_created`, `payment_succeeded`, `payment_refunded`, `order_status_updated`, `fulfillment_completed`, `fulfillment_failed`).
7. `settings/{settingId}` — глобальные настройки магазина (`settings/global`: `maintenanceMode`, `supportUsername`, `welcomeNote`, `storeName`, `updatedAt`).

---

## 2. Проверка функциональности

| Подсистема / Функция | Статус реализации | Детали проверки, логические ошибки и крайние случаи |
| :--- | :--- | :--- |
| **Запуск бота и навигация (`/start`, `/help`, `/support`)** | **Полностью реализовано** | Команды и inline-кнопки работают корректно, HTML-экранирование через `escapeHtml` защищает от поломки разметки (`src/bot/formatters.ts:10-17`). |
| **Регистрация и синхронизация пользователя** | **Реализовано (с замечанием)** | Глобальный middleware (`src/bot/handlers/userHandler.ts:118-158`) создаёт/обновляет профиль при каждом апдейте. **Проблема (`AUD-007`):** `UserService.upsertFromTelegram` выполняет нетранзакционный `getDoc` + `setDoc` на каждый клик, что создаёт гонку со счётчиками `totalOrders`/`totalSpentStars` и лишнюю нагрузку на Firestore. |
| **Блокировка пользователей (`isBlocked`)** | **Полностью реализовано** | Заблокированный пользователь отсекается в глобальном middleware (`userHandler.ts:127-143`), при `OrderService.createOrder` (`OrderService.ts:62-64`) и на этапе `validatePreCheckout` (`PaymentService.ts:106-108`). |
| **Каталог товаров, категории, популярные товары (`🌟 Популярные`)** | **Полностью реализовано** | Фильтрация по `isActive`, `category`, `isFeatured` и сортировка по `sortOrder` работают стабильно. В наличии 4 категории (`stars`, `premium`, `steam`, `other`). |
| **Карточка товара и проверка остатков (`stock`)** | **Полностью реализовано** | Поддерживаются бесконечный остаток (`stock: null`) и количественный остаток (`stock >= 0`). При `stock === 0` кнопка покупки заменяется на `❌ Нет в наличии` (`keyboards.ts:61`). |
| **Корзина и выбор количества товара** | **Частично реализовано (`AUD-010`)** | Бэкенд (`OrderService.createOrder`, `PaymentService`, `FulfillmentService`) поддерживает `quantity` от `1` до `10`, но UI бота (`paymentHandler.ts:31`) жестко передаёт `quantity: 1`. Нет выбора количества в карточке и нет мультитоварной корзины. |
| **Создание заказа и инвойса Telegram Stars (`XTR`)** | **Полностью реализовано** | Проверяется формат `invoicePayload` (`ord:<orderId>:<userId>:<productId>:<totalPrice>`), создаётся заказ в статусе `pending`, отправляется инвойс `replyWithInvoice` с валютой `XTR` и `provider_token: ""` (`paymentHandler.ts:44-69`). |
| **Проверка перед оплатой (`pre_checkout_query`)** | **Полностью реализовано** | `PaymentService.validatePreCheckout` (`PaymentService.ts:65-146`) проверяет валюту `XTR`, подлинность `invoicePayload`, владельца заказа, статус `pending`, совпадение суммы, активность товара, остаток на складе и отсутствие блокировки покупателя. |
| **Транзакционная обработка оплаты (`successful_payment`)** | **Полностью реализовано** | `PaymentService.processSuccessfulPayment` (`PaymentService.ts:152-331`) выполняется внутри `firestoreRepo.runTransaction`: проверяет `payment_charges/{chargeId}`, атомарно списывает `stock`, переводит заказ в `paid`, обновляет статистику покупателя и создаёт `payments` и `transactions`. |
| **Выдача цифровых товаров и ключей (`FulfillmentService`)** | **Частично / Заглушка для ключей (`AUD-002`)** | Реализованы 3 адаптера: `DigitalContentFulfillmentAdapter` (выдаёт статический `deliveryContent` из товара), `ManualAdminFulfillmentAdapter` (переводит в `processing` и уведомляет админа для ручной отправки кода) и `ProviderFulfillmentAdapter` (сейчас делегирует в `ManualAdminFulfillmentAdapter`). **Отсутствует** пул уникальных одноразовых ключей (`product_keys`), из которого при покупке автоматически выдавался бы и помечался использованным уникальный ключ активации. |
| **Баланс / статистика пользователя и транзакции** | **Реализовано (с ошибкой при возврате `AUD-003`)** | Магазин работает по модели прямой оплаты инвойсов Telegram Stars (`XTR`), а в профиле пользователя учитываются агрегаты `totalOrders` и `totalSpentStars`. **Ошибка (`AUD-003`):** при возврате средств (`markPaymentRefunded`) счётчики `totalOrders` и `totalSpentStars` у пользователя **не уменьшаются**. |
| **Возврат платежей (`refundStarPayment`)** | **Реализовано (с уязвимостью UX/логики `AUD-004`)** | Вызывает `ctx.api.refundStarPayment(order.userId, order.telegramPaymentChargeId)` и транзакционно возвращает `stock` (`PaymentService.ts:333-411`). **Проблема (`AUD-004`):** нет подтверждения действия (один клик сразу возвращает Stars) и разрешён возврат даже для уже выполненных (`completed`) заказов. |
| **Административная панель (`/admin`)** | **Реализовано (с ошибками переходов `AUD-004`, `AUD-005`, `AUD-006`)** | Поддерживает просмотр статистики, заказов, ручную выдачу с кодом (`adm:ord_note`), создание/редактирование/удаление товаров, блокировку пользователей. **Проблемы:** можно перевести неоплаченный заказ в `processing` (`AUD-005`), отменить уже оплаченный заказ по старой кнопке (`AUD-004`), списки ограничены первыми 10 элементами без пагинации (`AUD-006`). |
| **Режим технического обслуживания (`maintenanceMode`)** | **Не реализовано (`AUD-008`)** | Документ `settings/global` с полем `maintenanceMode: false` создаётся при сидинге (`firestore.ts:687-694`), но нигде в коде бота не проверяется и не переключается из админки. |

---

## 3. Проверка безопасности

### 3.1. Защита API endpoints и Webhook
- **`POST /webhook` (`server.ts:44-74`):**
  - Защищён проверкой заголовка `X-Telegram-Bot-Api-Secret-Token`.
  - Сравнение секрета выполняется функцией `verifyWebhookSecret()` (`src/config/env.ts:155-169`) с использованием **криптографически стойкого сравнения за постоянное время** `crypto.timingSafeEqual(expectedBuf, providedBuf)`, что полностью исключает timing-атаки.
  - При неверном токене возвращается `401 Unauthorized` без раскрытия деталей.
- **`GET /health` и `GET /` (`server.ts:77-120`) — Найдена проблема `AUD-009`:**
  - Публичные эндпоинты возвращают без авторизации внутренние метаданные инфраструктуры (`database.projectId`, `database.databaseId`, `botId`, `botUsername`, `statusMessage`).

### 3.2. Авторизация и проверка прав администратора (RBAC)
- Список ID администраторов задаётся через переменную окружения `ADMIN_IDS` (`src/config/env.ts:28-36`) и дополнительно проверяется по полю `role === 'admin'` в коллекции `users` (`UserService.isAdmin`, `src/services/UserService.ts:62-75`).
- Все административные команды (`/admin`) и callback-действия (`^adm:`) проходят через жёсткий охранный фильтр `requireAdmin(ctx)` (`src/bot/handlers/adminHandler.ts:39-48`). Попытка несанкционированного вызова логируется (`console.warn`) и блокируется.

### 3.3. Firestore Security Rules (`firestore.rules`)
- Проверены на официальном эмуляторе Firebase (`38/38 PASS` в `firestore-audit-package`):
  - Глобальный `match /{document=**} { allow read, write: if false; }` закрывает любые неописанные коллекции.
  - Коллекции `/payments`, `/payment_charges` и `/transactions` имеют `allow create, update, delete: if false;` — изменение финансовых записей возможно **только** через серверный Firebase Admin SDK.
  - Покупатель не может повысить себе роль до `admin`, разблокировать себя (`isBlocked`), изменить `totalOrders` / `totalSpentStars` или пометить заказ оплаченным (`paymentStatus: 'paid'`).

### 3.4. Защита от повторной оплаты, гонок (Race Conditions) и двойной выдачи
- **Защита от дублирования оплаты (`Double-Spend / Replay Attack`):**
  - В `PaymentService.processSuccessfulPayment()` (`src/services/PaymentService.ts:163-180`) внутри транзакции Firestore проверяется как документ `payment_charges/{telegramPaymentChargeId}`, так и текущий статус заказа (`order.paymentStatus === 'paid'`). Повторный webhook от Telegram с тем же `telegram_payment_charge_id` обрабатывается идемпотентно и возвращает `alreadyProcessed: true` без повторного списания товара и без повторного начисления статистики.
- **Защита от двойной выдачи цифрового товара (`Lease Lock`):**
  - В `FulfillmentService.fulfillOrder()` (`src/services/FulfillmentService.ts:207-332`) реализована транзакционная блокировка (lease lock) через поля `fulfillmentLockId` и `fulfillmentLockedAt` с таймаутом `45_000` мс (`FULFILLMENT_LOCK_LEASE_MS`). Если два процесса одновременно попытаются выдать один заказ, второй процесс получит `alreadyRunning: true` и прекратит выполнение.

### 3.5. Работа с секретами и персональными данными
- Модуль `src/config/env.ts` содержит массив `SENSITIVE_ENV_KEYS` (`BOT_TOKEN`, `FIREBASE_PRIVATE_KEY`, `WEBHOOK_SECRET`, `GEMINI_API_KEY` и др.) и функцию `redactSecrets()` (`src/config/env.ts:91-118`), маскирующую токены Telegram и приватные ключи PEM.
- В репозитории и в `.env.example` отсутствуют реальные ключи и токены.

---

## 4. Проверка надёжности

### 4.1. Транзакционность Firestore
- Все критические финансовые операции (`processSuccessfulPayment`, `markPaymentRefunded`, захват лока выдачи в `fulfillOrder`, финализация `completeOrder`) обёрнуты в `firestoreRepo.runTransaction()`.
- Внутри `runTransaction` соблюдается правило Firestore: **все чтения (`tx.get`) выполняются строго до первой записи (`tx.set` / `tx.update`)** (например, в `PaymentService.ts:164-210`).

### 4.2. Ретраи, идемпотентность и восстановление после сбоев
- При сбое доставки сообщения в Telegram (`FulfillmentService.ts:522-561`) сервис выполняет до `3` попыток (`MAX_AUTO_DELIVERY_ATTEMPTS = 3`) с экспоненциальной задержкой (`1500ms`, `3000ms`).
- Если все автоматические попытки исчерпаны или бот был перезапущен в момент оплаты:
  1. Фоновый воркер `FulfillmentService.startRecoveryWorker(bot)` (`FulfillmentService.ts:124-182`) каждую минуту сканирует заказы со статусом `paymentStatus === 'paid'` и `fulfillmentStatus` в `['pending', 'processing']`.
  2. Если заказ завис дольше `90` секунд (`STUCK_ORDER_THRESHOLD_MS`), воркер автоматически перезапускает выдачу или отправляет эскалационное уведомление администраторам (`ensureAdminNotified`, защищённое от спама полем `adminNotifiedAt`).
- Если критическая ошибка БД произошла уже после списания Stars на стороне Telegram (`paymentHandler.ts:180-212`), бот отправляет покупателю и всем администраторам экстренное сообщение с `Order ID` и `Charge ID` для ручной верификации.

### 4.3. Обнаруженные риски надёжности
1. **Фоновый клиентский Firebase SDK (`AUD-001`):** `src/db/firestoreErrorHandler.ts` инициализирует браузерный SDK `@firebase/firestore` внутри серверного процесса Node.js, что порождает периодические ошибки разрыва неактивного gRPC-потока `GrpcConnection RPC 'Listen' stream ... Code: 1 CANCELLED`.
2. **Незащищённые статусные переходы в админке (`AUD-004`, `AUD-005`):** Администратор может случайно перевести неоплаченный заказ в `processing` или отменить уже оплаченный заказ нажатием на устаревшую inline-клавиатуру.
3. **Жёсткое удаление товара (`AUD-013`):** Удаление товара (`adm:pdel`) физически удаляет документ из `products`, из-за чего оплата ранее выставленного инвойса по этому товару упадёт на проверке `if (!product)` в `PaymentService.processSuccessfulPayment`.

---

## 5. Проверка качества кода

- **Типизация TypeScript:** Строгий режим (`"strict": true` в `tsconfig.json`), проверка `npx tsc --noEmit` и `npm run lint` проходят с кодом `0` без единой ошибки.
- **Дублирование и неиспользуемый код (`AUD-012`):**
  - Метод `UserService.incrementUserPurchaseStats()` (`src/services/UserService.ts:94-109`) нигде не вызывается, так как инкремент выполняется напрямую внутри транзакции `PaymentService.processSuccessfulPayment()`.
  - Метод `OrderService.markOrderPaid()` (`src/services/OrderService.ts:135-207`) дублирует часть логики `PaymentService.processSuccessfulPayment()` и используется только в тестах.
  - В корне проекта лежат черновые файлы `DRAFT_firestore.rules` и `security_spec.md`, дублирующие актуальный `firestore.rules`.
- **Тестовое покрытие:**
  - Отлично покрыты правила безопасности Firestore, базовые транзакции и проверка окружения Java (`38` автотестов в `firestore-audit-package`).
  - Однако отсутствуют модульные тесты для самих сервисов приложения (`PaymentService`, `FulfillmentService`, `OrderService`) и обработчиков `adminHandler` / `paymentHandler`.

---

## 6. Оценка готовности к реальным продажам по подсистемам

1. **Каталог товаров:** **90% (Готов с минимальными правками)** — структура категорий, цен, сортировки и остатков полностью рабочая; перед продажами нужно отключить авто-сидинг тестовых товаров `(Тест)` (`INITIAL_TEST_PRODUCTS`) в Production.
2. **Оформление и жизненный цикл заказов:** **80% (Требует доработки)** — создание и отмена покупателем работают отлично, но нужно закрыть невалидные переходы статусов в админке (`AUD-004`, `AUD-005`) и добавить выбор количества (`AUD-010`).
3. **Платёжная система (Telegram Stars XTR):** **92% (Высокая готовность)** — `pre_checkout_query`, `successful_payment`, проверка `invoicePayload` и защита от дублей через `payment_charges` реализованы на высоком уровне. Требуется исправить пересчёт статистики пользователя при возврате (`AUD-003`) и добавить двухшаговое подтверждение возврата (`AUD-004`).
4. **Выдача цифровых ключей (`Fulfillment`):** **55% (Главный блокер для автоматической продажи ключей — `AUD-002`)** — механизм доставки, локов, ретраев и ручной выдачи админом готов на 100%, но **нет хранилища/пула уникальных одноразовых ключей** (сейчас `deliveryContent` статичен для всех покупателей одного товара либо требует ручного ввода кода администратором).
5. **Баланс / статистика пользователя и транзакции:** **78% (Требует исправления)** — учёт покупок и аудит-лог работают, но при возврате (`refund`) статистика `totalSpentStars` и `totalOrders` не уменьшается (`AUD-003`), а `upsertFromTelegram` может перезатереть счётчики при гонке (`AUD-007`).
6. **Административная панель:** **75% (Требует доработки)** — богатый функционал прямо внутри Telegram, но отсутствуют пагинация списков (`AUD-006`), подтверждение возврата/удаления (`AUD-004`, `AUD-013`) и переключатель `maintenanceMode` (`AUD-008`).
7. **Telegram Bot:** **90% (Готов)** — поддерживает webhook и polling, корректное экранирование HTML, обработку ошибок Grammy и graceful shutdown.
8. **Серверная инфраструктура:** **82% (Требует очистки)** — необходимо убрать инициализацию клиентского Firebase SDK на сервере (`AUD-001`), скрыть внутренние поля из публичного `/health` (`AUD-009`) и очистить `package.json` от неиспользуемых 3D-пакетов (`AUD-011`).
9. **Конкурентная обработка заказов:** **85% (Хорошо)** — списание `stock`, запись `payment_charges` и захват `fulfillmentLockId` атомарны в транзакциях Firestore; единственное узкое место — нетранзакционный `UserService.upsertFromTelegram` в middleware (`AUD-007`).

---

## 7. Детальный реестр всех найденных проблем (`AUD-001` — `AUD-014`)

---

### `AUD-001` — Фоновое подключение клиентского Firebase SDK в серверном процессе вызывает обрывы gRPC-стримов
- **Серьёзность:** `HIGH`
- **Файл и строки кода:**
  - `src/db/firestoreErrorHandler.ts` (строки `1–52`, особенно `7–9` и `37–52`)
  - `src/db/firestore.ts` (строка `589`)
- **Суть проблемы:** При импорте `src/db/firestore.ts` загружается модуль `src/db/firestoreErrorHandler.ts`, который на уровне модуля вызывает `initializeApp(firebaseConfig)` и `getFirestore(clientApp, ...)` из клиентского браузерного пакета `firebase/firestore`, а в `firestoreRepo.init()` (`src/db/firestore.ts:589`) вызывает `await testConnection()` (`getDocFromServer(doc(db, 'test', 'connection'))`). Поскольку сервер работает через `firebase-admin`, неаутентифицированный клиентский SDK открывает фоновый gRPC-поток `Listen` к Firestore, который каждые ~60 секунд обрывается по таймауту с ошибкой:
  `@firebase/firestore: Firestore (13.4.0): GrpcConnection RPC 'Listen' stream ... error. Code: 1 Message: 1 CANCELLED: Disconnecting idle stream. Timed out waiting for new targets.`
- **Влияние на магазин:** Засоряет серверные логи ошибками gRPC, создаёт лишнее сетевое подключение к проекту из `firebase-applet-config.json` при старте сервера и расходует сокеты.
- **Способ исправления:** Удалить вызов клиентского `testConnection()` из серверного `firestoreRepo.init()` в `src/db/firestore.ts` и проверять доступность БД исключительно через `this.adminDb` (`firebase-admin/firestore`), либо инициализировать клиентский SDK лениво только при явной необходимости.
- **Необходимые тесты:** Интеграционный тест инициализации `firestoreRepo.init()`, проверяющий отсутствие активных gRPC-соединений клиентского `@firebase/firestore` и отсутствие обращений к `firebase-applet-config.json` при работе сервера.

---

### `AUD-002` — Отсутствие автоматического хранилища (пула) уникальных одноразовых ключей и тестовые товары в каталоге по умолчанию
- **Серьёзность:** `CRITICAL`
- **Файл и строки кода:**
  - `src/services/FulfillmentService.ts` (строки `45–97`)
  - `src/constants.ts` (строки `19–92`)
  - `src/db/firestore.ts` (строки `710–724`)
  - `src/types.ts` (строки `29–66`)
- **Суть проблемы:**
  1. Для товаров с типом `manual_admin` и `provider_adapter` (`src/services/FulfillmentService.ts:45-72`) автоматическая выдача не происходит: заказ переводится в `processing` и ждёт, пока администратор вручную введёт код через `adm:ord_note:<orderId>`.
  2. Для товаров с типом `auto_digital` (`DigitalContentFulfillmentAdapter`, `FulfillmentService.ts:78-97`) всем покупателям отправляется одно и то же статическое поле `product.deliveryContent`. В БД отсутствует коллекция/массив одноразовых ключей (например, `product_keys`), из которого внутри транзакции извлекался бы уникальный неиспользованный ключ для конкретного заказа.
  3. При первом запуске на пустой БД `firestoreRepo.seedInitialData()` (`src/db/firestore.ts:710-724`) автоматически засевает 6 тестовых товаров с пометкой `(Тест)` из `INITIAL_TEST_PRODUCTS` (`src/constants.ts:19-92`).
- **Влияние на магазин:** Невозможно вести автоматическую 24/7 продажу уникальных цифровых ключей (Steam-кодов, подарочных карт, уникальных промокодов) без участия администратора на каждый заказ или риска выдать один и тот же код двум покупателям. Кроме того, тестовые позиции `(Тест)` попадают на витрину при чистом старте.
- **Способ исправления:**
  1. Реализовать пул одноразовых ключей (например, коллекцию `product_keys` или список ключей товара с транзакционным резервированием `status: 'available' -> 'assigned'` и привязкой к `orderId` + автосинхронизацией `product.stock`).
  2. Добавить загрузку пачки ключей для товара в админ-панель (`adm:pkeys:<productId>`).
  3. Отключить автоматический засев `INITIAL_TEST_PRODUCTS` при `NODE_ENV === 'production'` (или вынести под флаг `SEED_TEST_PRODUCTS=true`).
- **Необходимые тесты:**
  - Тест конкурентной покупки последнего ключа двумя пользователями (гарантия выдачи разных ключей и отсутствия дублей).
  - Тест возврата/отмены заказа и корректной обработки статуса выданного ключа.

---

### `AUD-003` — При возврате Stars (`markPaymentRefunded`) не уменьшаются счётчики `totalOrders` и `totalSpentStars` у пользователя
- **Серьёзность:** `HIGH`
- **Файл и строки кода:**
  - `src/services/PaymentService.ts` (строки `333–411`, в сравнении со строками `281–302`)
- **Суть проблемы:** При успешной оплате `PaymentService.processSuccessfulPayment()` (`PaymentService.ts:281-287`) увеличивает в документе `users/{userId}` поля `totalOrders` (`+1`) и `totalSpentStars` (`+order.totalPrice`). Однако при оформлении возврата в `PaymentService.markPaymentRefunded()` (`PaymentService.ts:333-411`) транзакция обновляет `payments/{paymentId}`, `orders/{orderId}`, возвращает `products/{productId}.stock` и создаёт запись в `transactions`, но **не обновляет `users/{order.userId}`**.
- **Влияние на магазин:** Нарушается консистентность финансовых данных между коллекциями `users` и `payments`. В профиле пользователя (`/profile`) и в админ-панели (`adm:usr:<id>`) сумма потраченных Stars и число заказов остаются завышенными после возврата средств.
- **Способ исправления:** Внутри транзакции `PaymentService.markPaymentRefunded()` прочитать документ `users/{order.userId}` (в блоке чтений до записей) и уменьшить `totalOrders = Math.max(0, user.totalOrders - 1)` и `totalSpentStars = Math.max(0, user.totalSpentStars - order.totalPrice)`.
- **Необходимые тесты:** Транзакционный тест: оплата заказа на `100 XTR` -> проверка `totalSpentStars === 100, totalOrders === 1` -> вызов `markPaymentRefunded` -> проверка `totalSpentStars === 0, totalOrders === 0` и возврата `stock + quantity`.

---

### `AUD-004` — Отсутствие двухшагового подтверждения возврата Stars (`adm:ord_refund`), разрешение возврата по уже выполненным заказам без предупреждения и перезапись оплаченных заказов через `adm:ord_cancel`
- **Серьёзность:** `HIGH`
- **Файл и строки кода:**
  - `src/bot/handlers/adminHandler.ts` (строки `365–440` и `443–470`)
  - `src/bot/keyboards.ts` (строки `220–240`)
  - `src/services/OrderService.ts` (строки `209–247`)
- **Суть проблемы:**
  1. Кнопка `↩️ Возврат Stars (refundStarPayment)` (`adm:ord_refund:<orderId>`) отображается на всех оплаченных заказах (включая уже доставленные `fulfillmentStatus === 'completed'`) и при **одном случайном нажатии** немедленно вызывает `ctx.api.refundStarPayment()`, возвращая реальные Telegram Stars покупателю без диалога подтверждения (`Да, подтвердить возврат` / `Отмена`).
  2. Обработчик `adm:ord_cancel:<orderId>` (`src/bot/handlers/adminHandler.ts:443-470`) не проверяет текущий статус оплаты заказа перед вызовом `OrderService.updateOrderStatus({ orderId, paymentStatus: 'cancelled', fulfillmentStatus: 'cancelled' })`. Если у администратора в чате осталось старое сообщение о заказе (когда он ещё был `pending`), нажатие `❌ Отменить заказ` перепишет уже оплаченный (`paid`) и выданный (`completed`) заказ в статус `cancelled`!
- **Влияние на магазин:** Прямой риск финансовых потерь из-за случайного нажатия кнопки возврата в Telegram, а также риск повреждения статуса оплаченного заказа при клике по старой inline-клавиатуре.
- **Способ исправления:**
  1. Добавить промежуточный экран подтверждения возврата (`adm:ord_refund_confirm:<orderId>`) с предупреждением, если товар уже был выдан (`fulfillmentStatus === 'completed'`).
  2. В `adm:ord_cancel` и внутри `OrderService.updateOrderStatus()` запретить переход в `paymentStatus: 'cancelled'`, если текущий `paymentStatus` равен `'paid'` или `'refunded'` (выполняя проверку внутри транзакции).
- **Необходимые тесты:**
  - Тест попытки отмены заказа в статусе `paid` через `adm:ord_cancel` / `updateOrderStatus` (должен отклоняться с ошибкой).
  - Тест потока подтверждения возврата.

---

### `AUD-005` — Некорректные переходы статусов в админке: `adm:ord_proc` позволяет перевести неоплаченный (`pending`) заказ в `fulfillmentStatus: 'processing'`
- **Серьёзность:** `HIGH`
- **Файл и строки кода:**
  - `src/bot/keyboards.ts` (строки `196–213`)
  - `src/bot/handlers/adminHandler.ts` (строки `235–264`, `298–330`)
  - `src/services/OrderService.ts` (строки `209–247`)
- **Суть проблемы:**
  1. В `buildAdminOrderActionKeyboard()` (`src/bot/keyboards.ts:196`) кнопки исполнения заказа (`🔄 Взять в обработку`, `✅ Подтвердить выдачу`, `📝 Выдать с кодом / сообщением`) показываются при условии `order.fulfillmentStatus !== 'completed' && order.paymentStatus !== 'refunded'`, то есть **даже для неоплаченных (`pending`) и отменённых (`cancelled`) заказов**.
  2. Обработчик `adm:ord_proc` (`src/bot/handlers/adminHandler.ts:242-246`) вызывает `OrderService.updateOrderStatus({ orderId, fulfillmentStatus: 'processing' })` без проверки `order.paymentStatus === 'paid'`. В результате неоплаченный заказ переходит в невалидное состояние (`paymentStatus: 'pending'`, `fulfillmentStatus: 'processing'`).
  3. Аналогично `adm:ord_note` (`adminHandler.ts:298-330`) позволяет админу открыть диалог ввода ключа для ещё не оплаченного заказа (ошибка обнаружится только после того, как админ отправит текст).
- **Влияние на магазин:** Нарушение конечного автомата состояний заказа (`pending` + `processing`), путаница в интерфейсе администратора.
- **Способ исправления:**
  1. В `buildAdminOrderActionKeyboard()` (`src/bot/keyboards.ts:196`) показывать кнопки выдачи и обработки **только** при `order.paymentStatus === 'paid' && order.fulfillmentStatus !== 'completed'`.
  2. В `adm:ord_proc`, `adm:ord_note` и в `OrderService.updateOrderStatus()` проверять, что перевод в `fulfillmentStatus: 'processing' | 'completed'` разрешён исключительно при `order.paymentStatus === 'paid'`.
- **Необходимые тесты:** Юнит-тест конечного автомата `OrderService.updateOrderStatus()` и `buildAdminOrderActionKeyboard()` для всех комбинаций `paymentStatus` и `fulfillmentStatus`.

---

### `AUD-006` — Отсутствие пагинации в списках заказов и пользователей и жёсткий лимит 200 записей при расчёте статистики магазина
- **Серьёзность:** `MEDIUM`
- **Файл и строки кода:**
  - `src/bot/keyboards.ts` (строки `71`, `128`, `172–188`, `258`)
  - `src/bot/formatters.ts` (строка `137`)
  - `src/bot/handlers/adminHandler.ts` (строки `161–168`, `198–213`, `477`, `681`)
- **Суть проблемы:**
  1. Список заказов покупателя (`buildUserOrdersKeyboard`, `keyboards.ts:71`) обрезается до `orders.slice(0, 8)` без кнопок пагинации (`⬅️` / `➡️`).
  2. Списки заказов (`buildAdminOrdersKeyboard`, `keyboards.ts:179`) и пользователей (`buildAdminUsersKeyboard`, `keyboards.ts:258`) в админке обрезаются до `slice(0, 10)` без пагинации, а список товаров (`keyboards.ts:128`) — до `slice(0, 12)`.
  3. В фильтрах заказов админки (`keyboards.ts:172-177`) отсутствуют кнопки фильтрации для статусов `failed`, `pending` и `refunded`.
  4. Расчёт общей выручки и числа заказов в `adm:stats` (`adminHandler.ts:161-168`) загружает максимум `200` документов (`getAllUsers(200)`, `getAllOrders(undefined, 200)`, `getAllPayments(200)`). После 200 заказов статистика выручки перестанет расти.
- **Влияние на магазин:** При росте числа заказов свыше 10 администратор не сможет открыть более старые заказы через кнопки списка, а статистика выручки в `/admin` будет отображать неполные данные после 200 продаж.
- **Способ исправления:** Добавить постраничную навигацию в callback-данные (`orders:page:<n>`, `adm:orders:<filter>:<page>`, `adm:users:<page>`, `adm:products:<page>`), добавить вкладку проблемных/возвращённых заказов и увеличить/агрегировать выборку для статистики.
- **Необходимые тесты:** Тест генерации клавиатур пагинации при наличии >10 заказов и >12 товаров.

---

### `AUD-007` — Нетранзакционный `UserService.upsertFromTelegram` на каждый апдейт создаёт гонку со счётчиками покупок и лишние записи в Firestore
- **Серьёзность:** `MEDIUM`
- **Файл и строки кода:**
  - `src/services/UserService.ts` (строки `10–50`, `77–92`)
  - `src/bot/handlers/userHandler.ts` (строка `122`)
- **Суть проблемы:**
  1. На каждый входящий клик или сообщение срабатывает глобальный middleware (`userHandler.ts:122`), вызывающий `UserService.upsertFromTelegram()`.
  2. Метод выполняет `const existing = await firestoreRepo.getDoc<User>('users', userId)` и затем перезаписывает **весь документ целиком** через `await firestoreRepo.setDoc('users', userId, updated)` (`UserService.ts:18-48`).
  3. Если апдейт `successful_payment` обрабатывается параллельно с другим апдейтом пользователя, `upsertFromTelegram` может прочитать старые значения `totalOrders` и `totalSpentStars` до коммита транзакции оплаты и перезатереть их старыми значениями через `setDoc`.
  4. Запись в Firestore на каждый клик по меню создаёт лишнюю задержку отклика бота и увеличивает расход лимита операций записи Firestore.
- **Влияние на магазин:** Возможна потеря инкремента `totalOrders` / `totalSpentStars` при параллельных апдейтах и замедление отклика кнопок меню.
- **Способ исправления:** Обновлять профиль пользователя через `updateDoc` (меняя только профильные поля `username`, `firstName`, `lastName`, `languageCode`, `updatedAt`, не затрагивая `totalOrders`, `totalSpentStars`, `isBlocked`), и выполнять запись только тогда, когда данные профиля действительно изменились или с последнего обновления прошло более N минут. В `setUserBlocked` также использовать `updateDoc` вместо `getDoc + setDoc`.
- **Необходимые тесты:** Тест параллельного вызова `upsertFromTelegram` и `processSuccessfulPayment`, подтверждающий сохранение обновлённых `totalOrders` и `totalSpentStars`.

---

### `AUD-008` — Настройка `maintenanceMode` в коллекции `settings/global` не подключена к логике бота и админ-панели
- **Серьёзность:** `MEDIUM`
- **Файл и строки кода:**
  - `src/db/firestore.ts` (строки `687–694`)
  - `src/types.ts` (строки `144–150`)
  - `src/bot/handlers/userHandler.ts` (строки `118–158`)
- **Суть проблемы:** При инициализации БД создаётся документ `settings/global` с полем `maintenanceMode: false`. Однако ни пользовательский middleware, ни `OrderService.createOrder`, ни `PaymentService.validatePreCheckout` не проверяют `maintenanceMode`, а в админ-панели нет кнопки для включения/выключения режима техработ.
- **Влияние на магазин:** Администратор не может временно приостановить приём новых заказов из интерфейса бота во время обновления каталога или технических работ.
- **Способ исправления:** Добавить проверку `maintenanceMode` при создании новых заказов (`OrderService.createOrder` и `validatePreCheckout`) с пропуском администраторов, а в `/admin` добавить кнопку переключения режима техработ.
- **Необходимые тесты:** Тест блокировки создания нового заказа обычным пользователем при `maintenanceMode: true` при сохранении доступа у администратора.

---

### `AUD-009` — Публичные эндпоинты `GET /health` и `GET /` раскрывают внутренние метаданные инфраструктуры
- **Серьёзность:** `MEDIUM`
- **Файл и строки кода:**
  - `server.ts` (строки `77–120`)
- **Суть проблемы:** Публичные HTTP-маршруты `/health` и `/` возвращают любому неаутентифицированному клиенту `database.projectId`, `database.databaseId`, `database.statusMessage` (включая текст ошибки Firebase при сбое), `botId`, `botUsername` и внутренние названия адаптеров выдачи.
- **Влияние на магазин:** Раскрытие технической информации о проекте Google Cloud / Firebase и конфигурации бота внешним сканерам.
- **Способ исправления:** Оставить в публичном ответе `/health` только безопасные поля (`status: 'ok'`, `mode`, `database: { connected: boolean, readyForWrites: boolean }`), не публикуя `projectId`, `databaseId` и сырые тексты ошибок.
- **Необходимые тесты:** HTTP-тест ответа `GET /health`, проверяющий отсутствие `projectId` и секретных/внутренних идентификаторов в JSON.

---

### `AUD-010` — Отсутствие выбора количества единиц товара при покупке (при полной поддержке `quantity` на бэкенде)
- **Серьёзность:** `MEDIUM`
- **Файл и строки кода:**
  - `src/bot/handlers/paymentHandler.ts` (строки `28–32`)
  - `src/bot/keyboards.ts` (строки `51–67`)
- **Суть проблемы:** `OrderService.createOrder()` поддерживает покупку от `1` до `10` единиц товара в одном заказе (`quantity: 1..10`), корректно считает `totalPrice` и списывает нужное количество из `stock`. Однако кнопка покупки в карточке товара (`buy:<productId>`) в `paymentHandler.ts:31` жёстко создаёт заказ с `quantity: 1`.
- **Влияние на магазин:** Покупатель, желающий приобрести несколько одинаковых позиций, вынужден оформлять и оплачивать каждый заказ по отдельности.
- **Способ исправления:** Поддержать формат callback `buy:<productId>:<quantity>` (с дефолтом `1`) или кнопки выбора количества в карточке товара при достаточном остатке.
- **Необходимые тесты:** Тест создания заказа через `buy:<productId>:3` и проверки `totalPrice === price * 3` и списания `stock - 3`.

---

### `AUD-011` — Избыточные неиспользуемые 3D/XR/AI зависимости в `package.json` и остаточные файлы шаблона
- **Серьёзность:** `MEDIUM`
- **Файл и строки кода:**
  - `package.json` (строки `2`, `16–51`)
  - `src/bg.svg`, `src/index.css`
- **Суть проблемы:** В `package.json` проекта указано имя `"xrblocks-example"` и подключены тяжёлые пакеты (`xrblocks`, `three`, `@dimforge/rapier3d-simd-compat`, `@mediapipe/tasks-audio`, `@mediapipe/tasks-vision`, `@pmndrs/uikit`, `@sparkjsdev/spark`, `troika-three-text`, `openai`, `@google/genai`, `lit`), которые нигде не используются в коде магазина `Stars Shop`.
- **Влияние на магазин:** Раздувает размер `node_modules`, замедляет установку зависимостей и сборку контейнера при деплое.
- **Способ исправления:** Привести `package.json` в соответствие с фактическими зависимостями проекта (при необходимости очистки на этапе рефакторинга).
- **Необходимые тесты:** Проверка успешного прохождения `npm run build`, `npm run lint` и `npm run audit:emulator`.

---

### `AUD-012` — Мёртвый код в сервисах (`incrementUserPurchaseStats`, `markOrderPaid`) и дублирующие черновые файлы в корне
- **Серьёзность:** `LOW`
- **Файл и строки кода:**
  - `src/services/UserService.ts` (строки `94–109`)
  - `src/services/OrderService.ts` (строки `135–207`)
  - `DRAFT_firestore.rules`, `security_spec.md`
- **Суть проблемы:**
  1. `UserService.incrementUserPurchaseStats()` не вызывается нигде в проекте, так как начисление статистики перенесено внутрь транзакции `PaymentService.processSuccessfulPayment()`.
  2. `OrderService.markOrderPaid()` дублирует логику перевода заказа в статус `paid` без создания записи в `payments` и без проверки `payment_charges`.
  3. В корне репозитория лежат черновые файлы `DRAFT_firestore.rules` и `security_spec.md`.
- **Влияние на магазин:** Риск случайного вызова `OrderService.markOrderPaid()` или `incrementUserPurchaseStats()` при будущей разработке, что приведёт к двойному учёту статистики или обходу реестра `payment_charges`.
- **Способ исправления:** Пометить `markOrderPaid` как внутренний/тестовый или объединить с `PaymentService`, удалить неиспользуемый `incrementUserPurchaseStats` и убрать черновые дубликаты правил.
- **Необходимые тесты:** Проверка `npx tsc --noEmit` и `npm run audit:emulator`.

---

### `AUD-013` — Физическое удаление товара (`adm:pdel`) без подтверждения может сломать оплату уже выставленного инвойса
- **Серьёзность:** `LOW`
- **Файл и строки кода:**
  - `src/bot/handlers/adminHandler.ts` (строки `554–570`)
  - `src/services/ProductService.ts` (строки `138–140`)
  - `src/services/PaymentService.ts` (строки `201–207`)
- **Суть проблемы:** При нажатии `🗑 Удалить товар` (`adm:pdel:<id>`) документ товара немедленно удаляется из коллекции `products` (без диалога подтверждения и без проверки активных `pending` заказов по этому товару). Если покупатель получил инвойс за минуту до удаления товара и оплатил его после удаления, транзакция `PaymentService.processSuccessfulPayment()` выбросит ошибку `Product <id> for order <orderId> not found` (`PaymentService.ts:206`), хотя Telegram уже списал Stars.
- **Влияние на магазин:** Заказ перейдёт в ветку ручного разбора ошибки оплаты (`paymentHandler.ts:180-212`), если товар был физически удалён во время открытого инвойса.
- **Способ исправления:**
  1. В `PaymentService.processSuccessfulPayment()` при отсутствии документа `product` (если он был удалён после `pre_checkout_query`) не прерывать фиксацию уже оплаченного заказа, а использовать сохранённые в самом `Order` поля (`order.productTitle`, `order.deliveryType`, `order.fulfillmentType`).
  2. В `adm:pdel` запретить физическое удаление товара, если по нему есть заказы, предложив вместо этого архивацию (`isActive: false`), либо добавить подтверждение удаления.
- **Необходимые тесты:** Тест `processSuccessfulPayment` для заказа, товар которого был удалён после `pre_checkout_query`, проверяющий успешную запись платежа и перевод заказа в `paid`.

---

### `AUD-014` — Несоответствие списка разрешённых полей при отмене заказа покупателем в `firestore.rules`
- **Серьёзность:** `LOW`
- **Файл и строки кода:**
  - `firestore.rules` (строки `300–308`)
  - `src/bot/handlers/userHandler.ts` (строки `371–376`)
- **Суть проблемы:** В `userHandler.ts:371-376` при отмене неоплаченного заказа покупателем через бота обновляются поля `paymentStatus`, `fulfillmentStatus`, `fulfillmentNote` и `updatedAt`. В `firestore.rules` (строка `307`) правило для клиентской отмены заказа разрешает изменять только `['paymentStatus', 'fulfillmentStatus', 'updatedAt']` (без `fulfillmentNote`).
- **Влияние на магазин:** На работу Telegram-бота не влияет (так как бот работает через Admin SDK), но при использовании клиентского доступа отмена заказа с комментарием `fulfillmentNote` будет отклонена правилами.
- **Способ исправления:** Разрешить опциональное поле `fulfillmentNote` (строка до 500 символов) при клиентской отмене заказа в `firestore.rules`.
- **Необходимые тесты:** Тест в `securityRules.emulator.test.ts` на отмену заказа покупателем с полем `fulfillmentNote`.

---

## 8. Итоговая сводка аудита

### 8.1. Сводная таблица по разделам проекта

| Раздел | Статус | Найденные проблемы |
| :--- | :--- | :--- |
| **Архитектура** | **PARTIAL (Хорошая модульная база с точечными недочётами)** | `AUD-001` (клиентский Firebase SDK на сервере), `AUD-008` (`maintenanceMode` не подключён), `AUD-011` (лишние зависимости шаблона) |
| **Telegram Bot** | **PASS (С мелкими UX-замечаниями)** | `AUD-006` (нет пагинации списков), `AUD-010` (нет выбора количества товара в UI) |
| **Firebase / Firestore** | **PASS (Высокая надёжность схемы и правил)** | `AUD-001` (фоновый gRPC-стрим клиентского SDK), `AUD-007` (лишние `setDoc` при каждом клике), `AUD-014` (мелкое расхождение `fulfillmentNote` в правилах) |
| **Авторизация** | **PASS** | Критических проблем не обнаружено; RBAC (`ADMIN_IDS` + `role === 'admin'`) и `isBlocked` проверяются во всех точках входа |
| **Каталог** | **PARTIAL** | `AUD-002` (автозасев 6 тестовых товаров `(Тест)` при пустой БД), `AUD-013` (жёсткое удаление товара без проверки заказов) |
| **Заказы** | **PARTIAL** | `AUD-004` (`adm:ord_cancel` может отменить оплаченный заказ), `AUD-005` (`adm:ord_proc` переводит неоплаченный заказ в `processing`), `AUD-010` (только `quantity: 1` из UI) |
| **Платежи** | **PARTIAL (Ядро транзакций надёжно, есть баг возврата)** | `AUD-003` (возврат не уменьшает `totalOrders`/`totalSpentStars`), `AUD-004` (возврат в 1 клик без подтверждения и по уже выданным заказам), `AUD-013` (ошибка оплаты при удалённом товаре) |
| **Выдача ключей** | **FAIL / PARTIAL (Главный функциональный пробел)** | `AUD-002` (нет автоматического пула уникальных одноразовых ключей; `auto_digital` выдаёт статический текст, а `manual_admin`/`provider_adapter` требуют ручной выдачи админом) |
| **Баланс** | **PARTIAL** | `AUD-003` (не уменьшается статистика `totalSpentStars`/`totalOrders` при возврате), `AUD-007` (гонка в `upsertFromTelegram` может перезаписать счётчики) |
| **Админка** | **PARTIAL** | `AUD-004` (нет подтверждения `refund` и защита `cancel`), `AUD-005` (кнопки выдачи на неоплаченных заказах), `AUD-006` (нет пагинации, лимит 200 в статистике), `AUD-008` (нет кнопки `maintenanceMode`) |
| **API** | **PASS (С замечанием по `/health`)** | `AUD-009` (`GET /health` и `GET /` раскрывают `projectId`, `databaseId` и `botId`); `POST /webhook` защищён отлично (`timingSafeEqual`) |
| **Безопасность** | **PASS (Высокий уровень защиты)** | `AUD-009` (метаданные в `/health`), `AUD-014` (`fulfillmentNote` в `firestore.rules`); секреты, webhook и финансовые коллекции защищены надёжно |
| **Надёжность** | **PARTIAL** | `AUD-001` (обрывы gRPC-стрима клиентского SDK), `AUD-007` (гонка `setDoc` в `upsertFromTelegram`), `AUD-013` (жёсткое удаление товара при открытом инвойсе) |
| **Тесты** | **PARTIAL** | `38/38 PASS` в пакете эмулятора Firestore и Java-проверки; требуются новые юнит/интеграционные тесты на `PaymentService` (возвраты), пул ключей и конечный автомат админки |

---

### 8.2. Общее количество проблем по уровням серьёзности

- **`CRITICAL`:** **1** (`AUD-002`)
- **`HIGH`:** **4** (`AUD-001`, `AUD-003`, `AUD-004`, `AUD-005`)
- **`MEDIUM`:** **6** (`AUD-006`, `AUD-007`, `AUD-008`, `AUD-009`, `AUD-010`, `AUD-011`)
- **`LOW`:** **3** (`AUD-012`, `AUD-013`, `AUD-014`)
- **Всего обнаружено проблем:** **14**

---

### 8.3. Топ-10 самых важных проблем (в порядке приоритета исправления)

1. **`AUD-002` (`CRITICAL`)** — Отсутствие пула одноразовых цифровых ключей (сейчас уникальные ключи приходится выдавать вручную через админку, а `auto_digital` отправляет один и тот же статический текст) + авто-сидинг тестовых товаров `(Тест)`.
2. **`AUD-004` (`HIGH`)** — Отсутствие подтверждения при возврате Stars (`adm:ord_refund`) и возможность случайно отменить уже оплаченный заказ через `adm:ord_cancel`.
3. **`AUD-005` (`HIGH`)** — Отображение кнопок выдачи для неоплаченных заказов и возможность перевести неоплаченный (`pending`) заказ в `processing` через `adm:ord_proc`.
4. **`AUD-003` (`HIGH`)** — Возврат платежа (`markPaymentRefunded`) не уменьшает счётчики `totalOrders` и `totalSpentStars` у пользователя.
5. **`AUD-001` (`HIGH`)** — Фоновое подключение клиентского Firebase SDK в `src/db/firestoreErrorHandler.ts` на сервере, вызывающее периодические ошибки `GrpcConnection RPC 'Listen' stream ... Code: 1 CANCELLED`.
6. **`AUD-007` (`MEDIUM`)** — Нетранзакционный `UserService.upsertFromTelegram` с полной перезаписью документа `users/{id}` на каждый клик (гонка со счётчиками покупок и лишняя нагрузка на БД).
7. **`AUD-013` (`LOW` / функциональный риск оплаты)** — Физическое удаление товара (`adm:pdel`) ломает проведение `processSuccessfulPayment` по ранее выставленному инвойсу.
8. **`AUD-006` (`MEDIUM`)** — Отсутствие пагинации в списках заказов/пользователей/товаров и потолок в 200 записей при подсчёте статистики магазина в `/admin`.
9. **`AUD-008` (`MEDIUM`)** — Игнорирование флага `maintenanceMode` из `settings/global` и отсутствие управления им в админке.
10. **`AUD-009` (`MEDIUM`)** — Раскрытие внутренних метаданных (`projectId`, `databaseId`, `botId`) в публичных ответах `GET /health` и `GET /`.

---

### 8.4. Что обязательно нужно исправить перед первыми продажами, а что можно отложить

#### Обязательно исправить перед запуском реальных продаж (Must-Fix):
1. **`AUD-001`** — Отключить серверный вызов клиентского `testConnection()` в `firestoreErrorHandler.ts`, чтобы устранить фоновые ошибки gRPC-потока `Listen`.
2. **`AUD-002`** — Реализовать транзакционную выдачу уникальных одноразовых ключей из пула ключей товара (и отключить авто-сидинг тестовых товаров `(Тест)` в Production).
3. **`AUD-003`** — Корректно уменьшать `totalOrders` и `totalSpentStars` пользователя внутри транзакции `markPaymentRefunded`.
4. **`AUD-004` и `AUD-005`** — Защитить конечный автомат заказов в админке (запретить отмену оплаченных заказов и взятие в работу неоплаченных заказов, добавить двухшаговое подтверждение возврата Stars).
5. **`AUD-007`** — Перевести `UserService.upsertFromTelegram` и `setUserBlocked` на безопасное частичное обновление (`updateDoc`) без перезатирания финансовых агрегатов `totalOrders` и `totalSpentStars`.
6. **`AUD-013`** — Защитить `processSuccessfulPayment` от падения, если товар был удалён после выставления счёта, и добавить защиту при удалении товара в админке.
7. **`AUD-009`** — Убрать `projectId`, `databaseId` и внутренние диагностические строки из публичного `/health`.

#### Можно отложить на второй этап (Post-Launch / Nice-to-Have):
1. **`AUD-006`** — Полная пагинация всех списков в боте и агрегация статистики свыше 200 заказов (на старте первых продаж лимита достаточно, но лучше добавить в плановом порядке).
2. **`AUD-008`** — Управление режимом `maintenanceMode` из админки.
3. **`AUD-010`** — Выбор количества единиц товара (`quantity > 1`) в карточке товара перед покупкой.
4. **`AUD-011` и `AUD-012`** — Очистка `package.json` от неиспользуемых зависимостей шаблона и удаление черновых файлов.

---

### 8.5. Процент готовности к реальным продажам и итоговый вердикт

- **Оценка общей готовности к реальным продажам:** **78%**
  - **Обоснование:** Фундамент проекта разработан качественно: серверная часть на Express + Grammy, строгая типизация TypeScript, транзакционное ядро оплаты Telegram Stars (`XTR`) с дедупликацией через `payment_charges`, lease-блокировки выдачи с фоновым воркером восстановления, криптостойкая проверка webhook (`timingSafeEqual`) и 38/38 проходящих тестов правил безопасности Firestore. До 100% готовности не хватает автоматического пула уникальных одноразовых ключей (`AUD-002`), устранения фонового клиентского gRPC-стрима (`AUD-001`), фикса пересчёта пользовательской статистики при возврате (`AUD-003`) и защиты кнопок смены статусов/возврата в админ-панели (`AUD-004`, `AUD-005`, `AUD-007`, `AUD-013`).

- **Итоговый вердикт:**
  **Аудит успешно завершён. Архитектура проекта здоровая и полностью пригодна для перехода к этапу точечного исправления найденных проблем.**
  Рекомендуемый порядок работ на следующем этапе:
  1. **Этап 1 (Критическая стабильность и БД):** Исправление `AUD-001` (клиентский SDK gRPC), `AUD-007` (гонка `upsertFromTelegram`), `AUD-009` (`/health`).
  2. **Этап 2 (Финансовая целостность и защита статусов):** Исправление `AUD-003` (пересчёт статистики при возврате), `AUD-004` (подтверждение возврата и защита от отмены оплаченных заказов), `AUD-005` (защита от взятия в работу неоплаченных заказов), `AUD-013` (защита оплаты при удалённом товаре).
  3. **Этап 3 (Автоматическая выдача уникальных ключей и UX):** Реализация `AUD-002` (пул одноразовых цифровых ключей и отключение тестового сидинга в Production), `AUD-008` (`maintenanceMode`), `AUD-006` (пагинация и фильтры).
