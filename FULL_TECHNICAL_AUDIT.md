# Полный технический аудит проекта Stars Shop (Этап 2 — Актуализированная ревизия 100%)

**Дата ревизии:** 2026-11-18  
**Репозиторий:** `Vanyamujlan/Shop-Tg-bot` (актуальное состояние рабочей ветки)  
**Режим проверки:** Независимый технический аудит фактического исходного кода (Read-Only, без подключения к Production Firebase и без реальных платежей)  
**Результаты локальных проверок:**
- Локальные модульные и транзакционные тесты (`npm test` / `src/tests/stage1.test.ts`): **`29/29 PASS`**
- Пакет аудита на официальном Firebase Emulator (`npm run audit:emulator`): **`38/38 PASS`**
- Статический анализ (`npm run lint` = `eslint . && tsc --noEmit`): **`0 ошибок`**

---

## 1. Аудит 14 обязательных областей проекта

### 1.1. Архитектура проекта, зависимости и точки входа
- **Точки входа:**
  - Серверная: `server.ts` (строки `9–155`) — инициализирует Express (`0.0.0.0:3000`), `firestoreRepo.init()`, `botManager.start()`, фоновый воркер `FulfillmentService.startRecoveryWorker(..., 30_000)` и graceful shutdown (`SIGINT`/`SIGTERM`).
  - Клиентская заглушка превью: `index.html` + `src/index.ts`.
- **Замечания:**
  - На сервере при импорте `src/db/firestore.ts` загружается `src/db/firestoreErrorHandler.ts`, инициализирующий браузерный клиентский SDK `firebase/firestore` (`AUD-001`).
  - В `package.json` остались неиспользуемые 3D/WebXR/AI-зависимости от базового шаблона (`AUD-011`).

### 1.2. Backend, API, авторизация и валидация запросов
- **Маршруты Express (`server.ts:71–120`):**
  - `POST /webhook/telegram` (`server.ts:72–74`) — передаёт запрос в `botManager.handleWebhookRequest(req, res)` (`src/bot/bot.ts:285–337`).
  - Проверяется наличие `WEBHOOK_SECRET` (`503` при отсутствии), заголовок `X-Telegram-Bot-Api-Secret-Token` через `crypto.timingSafeEqual` (`401` при несовпадении, `src/bot/bot.ts:23–39, 297–304`), структура `update_id` (`400` при некорректном теле, `src/bot/bot.ts:41–50, 307–313`).
  - `GET /health` (`server.ts:77–94`) и `GET /` (`server.ts:97–120`) публично возвращают внутренние идентификаторы проекта и БД (`AUD-009`).

### 1.3. Telegram Bot: команды, callback, webhook, защита от повторных запросов
- Инициализация в `src/bot/bot.ts` (фреймворк `telegraf@^4.16.3`).
- Защита от повторных нажатий inline-кнопок реализована через `isDuplicateCallbackClick(userId, key, ttlMs)` (`src/bot/handlers/userHandler.ts:31–48`).
- Все динамические строки экранируются через `escapeHtml()` (`src/bot/formatters.ts:10–17`).
- Списки заказов, товаров и пользователей обрезаются (`.slice(0, 8)` / `.slice(0, 10)`) без кнопок пагинации (`AUD-006`).

### 1.4. Каталог товаров и система хранения цифровых ключей
- Каталог поддерживает 3 категории (`stars`, `premium`, `gifts` — `src/types.ts:27`), CRUD товаров в админ-панели и фильтрацию активных позиций (`ProductService`).
- **Критический пробел (`AUD-002`):** В БД и коде отсутствует хранилище (пул) уникальных одноразовых ключей (`product_keys`) и учёт остатков (`stock`). Единственный реализованный адаптер выдачи — `ManualAdminFulfillmentAdapter` (`src/services/FulfillmentService.ts:45–64`), требующий ручного ввода кода администратором.
- При пустой коллекции `products` метод `seedInitialData()` (`src/db/firestore.ts:710–724`) автоматически создаёт 6 тестовых товаров с пометкой `(Тест)` (`src/constants.ts:19–92`).

### 1.5. Заказы и жизненный цикл статусов
- Заказ создаётся в `OrderService.createOrder()` (`src/services/OrderService.ts:19–77`) строго по цене из БД (`totalPrice = product.price * quantity`).
- **Исправлено (`AUD-005` — `FIXED`, `AUD-004` частично):** В `OrderService.updateOrderStatus()` (`src/services/OrderService.ts:209–299`) внедрены серверные транзакционные проверки:
  - Запрещён перевод в `paid` или `refunded` через `updateOrderStatus`.
  - Запрещена отмена (`cancelled`) заказа, если `paymentStatus !== 'pending'` или `fulfillmentStatus !== 'pending'`.
  - Запрещён перевод в `processing` или `completed` без подтверждённой оплаты (`paid | processing | completed`).
  - Запрещён откат из `completed` обратно в `processing`.

### 1.6. Оплата Stars, проверка оплаты и защита от повторного начисления
- `PaymentService.validatePreCheckout()` (`src/services/PaymentService.ts:35–112`) проверяет готовность хранилища, валюту `XTR`, блокировку пользователя, владельца заказа, статус `pending`, активность товара и точное совпадение суммы.
- `PaymentService.processSuccessfulPayment()` (`src/services/PaymentService.ts:122–328`) выполняется в одной транзакции Firestore (все `tx.get` строго до `tx.set`):
  - Дедупликация по `payments/pay_<telegramPaymentChargeId>`.
  - При повторном или параллельном webhook с тем же `charge_id` возвращает `alreadyProcessed: true` без повторного инкремента статистики.
- **Риск (`AUD-013`):** На строках `202–207` `processSuccessfulPayment` проверяет наличие документа товара `products/{order.productId}` и выбрасывает исключение, если администратор физически удалил товар через `adm:pdel` после выставления счёта.

### 1.7. Возвраты, конкурентные запросы и согласованность Firestore
- Реализовано двухэтапное подтверждение возврата в админ-панели (`adm:ord_refund` -> `adm:ord_refund_confirm`, `src/bot/handlers/adminHandler.ts:440–582`).
- **Обнаружены 3 оставшиеся проблемы в механизме возвратов:**
  1. **`AUD-003` (`HIGH`, `OPEN`):** `PaymentService.markPaymentRefunded()` (`src/services/PaymentService.ts:424–494`) не уменьшает `totalOrders` и `totalSpentStars` в документе `users/{userId}`.
  2. **`AUD-015` (`HIGH`, `OPEN`):** Блокировка конкурентных возвратов `activeRefundLocks` (`src/services/PaymentService.ts:330`) хранится в памяти одного процесса Node.js (`new Set<string>()`) и **не защищает от гонки между несколькими экземплярами сервера** (multi-instance Cloud Run).
  3. **`AUD-016` (`HIGH`, `OPEN`):** В `PaymentService.executeOrderRefund()` (`src/services/PaymentService.ts:399–413`) внешний вызов Telegram API `refundStarPayment` выполняется **до** записи в Firestore (`markPaymentRefunded`). Если `refundStarPayment` завершился успешно в Telegram, а запись в Firestore упала по сетевому таймауту, Stars уже возвращены покупателю, но в БД заказ остаётся в статусе `paid`/`completed` без маркера `needsManualReconciliation`.

### 1.8. Автоматическая выдача цифровых товаров после подтверждённой оплаты
- `FulfillmentService.initiateFulfillment()` (`src/services/FulfillmentService.ts:237–520`) атомарно захватывает заказ в транзакции перед вызовом адаптера, поддерживает сверку `checkExternalStatus` после сбоя, карантин неидемпотентных провайдеров (`needsManualReconciliation: true`) и лимит `MAX_FULFILLMENT_ATTEMPTS = 3`.
- Отсутствует адаптер автоматической выдачи одноразовых ключей из БД (`AUD-002`).

### 1.9. Админ-панель, права доступа и финансовые операции
- Все обработчики защищены проверкой `ensureAdmin(ctx)` (`src/bot/handlers/adminHandler.ts:81–97`), сверяющей `ADMIN_IDS` и коллекцию `admins`.
- Все действия администраторов логируются в `transactions` (`type: 'admin_action'`).
- Статистика `adm:stats` (`src/bot/handlers/adminHandler.ts:161–168`) загружает максимум `200` документов на коллекцию (`AUD-006`).
- Отсутствует управление `maintenanceMode` (`AUD-008`).

### 1.10. Firestore Rules, индексы и транзакции
- `firestore.rules` (371 строка) запрещает клиентскую запись в `/payments`, `/payment_charges`, `/transactions`, `/admins`, `/settings` и защищает поля `role`, `isBlocked`, `totalOrders`, `totalSpentStars` и `paymentStatus: 'paid'`.
- `firestore.indexes.json` содержит 10 составных индексов для `orders`, `payments`, `products`, `transactions`.
- Незначительное расхождение в клиентском правиле отмены заказа по полю `fulfillmentNote` (`AUD-014`).

### 1.11. Защита секретов, конфиденциальных данных и внутренних endpoint
- Секреты (`TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `FIREBASE_PRIVATE_KEY`) маскируются в логах через `maskSecretsInText()` (`src/bot/bot.ts:10–21`, `server.ts:16–40`).
- Публичные маршруты `GET /health` и `GET /` раскрывают инфраструктурные идентификаторы (`AUD-009`).

### 1.12. Обработка ошибок, логирование и мониторинг
- При недоступности Firebase Admin SDK в Production активируется защитный режим `degradedMode = true` (`StorageUnavailableError`), блокирующий создание новых заказов и `pre_checkout_query` (`src/db/firestore.ts:520–537`).
- Фоновый клиентский SDK в `src/db/firestoreErrorHandler.ts` генерирует ошибку разрыва неактивного gRPC-потока `Listen` каждые ~60 секунд (`AUD-001`).

### 1.13. Тесты, покрытие критических сценариев и конкурентные операции
- В наличии два набора тестов:
  1. `npm test` (`src/tests/stage1.test.ts` — **29 тестов**): покрывает транзакции оплаты, конкурентную оплату в 6 потоков (`P-03`), конкурентных воркеров выдачи (`F-02`), crash-recovery (`F-03`), защиту webhook (`S-01`, `S-02`), запрет невалидных переходов статусов (`A-01`, `A-02`), двухэтапный возврат и in-memory блокировку возврата (`A-03`, `A-04`).
  2. `npm run audit:emulator` (`firestore-audit-package` — **38 тестов**): проверяет `firestore.rules`, CRUD и транзакции на реальном Firebase Emulator (`127.0.0.1:8080`) и валидацию Java 21+.
- **Чего не хватает в тестах:**
  - Тесты `src/tests/stage1.test.ts` работают на in-memory движке (`enableIsolatedTestMode(true)`), поэтому не ловят сетевой gRPC-стрим клиентского SDK (`AUD-001`).
  - Нет теста на сбой записи Firestore *после* успешного `callTelegramRefund` (`AUD-016`) и на пересчёт статистики пользователя при возврате (`AUD-003`).

### 1.14. Сборка, зависимости, конфигурация и готовность к развёртыванию
- **Важный факт о сборке (`AUD-011`):** В `package.json:9` команда `"build": "tsc --noEmit"` при `"noEmit": true` в `tsconfig.json:10` выполняет **только проверку типов TypeScript** и не создаёт скомпилированный production-артефакт в `dist/`. Запуск в production (`"start": "tsx server.ts"`) выполняется через `tsx` с огромным `node_modules`, содержащим неиспользуемые 3D/XR-библиотеки.

---

## 2. Реестр всех дефектов (с проверкой статуса AUD-001 — AUD-016)

---

### `AUD-001` — Инициализация клиентского Firebase SDK на сервере вызывает обрывы gRPC-потока `Listen`
- **Критичность:** `High`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/db/firestoreErrorHandler.ts` (`1–10`, `37–52`), `src/db/firestore.ts` (`589`)
- **Как воспроизводится:** При запуске сервера `server.ts` импортирует `src/db/firestore.ts`, который импортирует `src/db/firestoreErrorHandler.ts` (где на уровне модуля вызываются `initializeApp(firebaseConfig)` и `getFirestore(clientApp, ...)`), а в `firestoreRepo.init()` на строке `589` вызывается `await testConnection()` (`getDocFromServer(doc(db, 'test', 'connection'))`). Через ~60 секунд простоя клиентский SDK пишет в лог: `@firebase/firestore: Firestore (13.4.0): GrpcConnection RPC 'Listen' stream ... Code: 1 Message: 1 CANCELLED: Disconnecting idle stream.`
- **Последствия:** Засорение логов сервера ложными ошибками gRPC, лишнее сетевое подключение к Firestore в обход `firebase-admin`.
- **Минимальное исправление:** Удалить импорт и вызов `testConnection()` из `src/db/firestore.ts` (доступность БД уже проверяется через `this.adminDb.collection('_health_probe')` на строках `618–624`).

---

### `AUD-002` — Отсутствие хранилища (пула) одноразовых цифровых ключей и автозасев тестовых товаров `(Тест)`
- **Критичность:** `Critical`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/services/FulfillmentService.ts` (`45–64`, `71–72`), `src/constants.ts` (`19–92`), `src/db/firestore.ts` (`710–724`)
- **Как воспроизводится:**
  1. При оплате любого заказа вызывается `ManualAdminFulfillmentAdapter.requestFulfillment()` (`FulfillmentService.ts:53–63`), который всегда возвращает `handledAutomatically: false, status: 'processing'`. В проекте нет коллекции одноразовых ключей и логики автоматического извлечения ключа при покупке.
  2. При запуске на пустой БД `seedInitialData()` (`src/db/firestore.ts:710–724`) загружает 6 позиций из `INITIAL_TEST_PRODUCTS` с названиями вида `50 Telegram Stars (Тест)`.
- **Последствия:** Покупатель не получает цифровой ключ автоматически после оплаты — каждый заказ требует ручной выдачи администратором; при чистом деплое на витрину попадают тестовые товары.
- **Минимальное исправление:** Реализовать коллекцию/пул ключей `product_keys` с транзакционным резервированием ключа под `orderId` и отключить автозасев `INITIAL_TEST_PRODUCTS` в `production` (или вынести под флаг `SEED_INITIAL_PRODUCTS=true`).

---

### `AUD-003` — При возврате средств (`markPaymentRefunded`) не уменьшаются `totalOrders` и `totalSpentStars` пользователя
- **Критичность:** `High`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/services/PaymentService.ts` (`424–494`, в сравнении со строками `281–302`)
- **Как воспроизводится:** Оплатить заказ (`totalOrders` становится `1`, `totalSpentStars` увеличивается на сумму заказа), затем выполнить возврат через `PaymentService.executeOrderRefund()` / `markPaymentRefunded()`. Документ `users/{userId}` в транзакции возврата не читается и не обновляется.
- **Последствия:** Статистика покупок пользователя в `/profile` и в админке остаётся завышенной после возврата Stars.
- **Минимальное исправление:** В начале транзакции `PaymentService.markPaymentRefunded()` прочитать `users/{order.userId}` и уменьшить `totalOrders = Math.max(0, existingUser.totalOrders - 1)` и `totalSpentStars = Math.max(0, existingUser.totalSpentStars - order.totalPrice)`.

---

### `AUD-004` — Двухэтапное подтверждение возврата и серверный запрет отмены оплаченных заказов
- **Критичность:** `High`
- **Статус:** ⚠️ **ЧАСТИЧНО ИСПРАВЛЕНО (`PARTIALLY FIXED`)** — *основная логика исправлена и покрыта тестами `A-02`, `A-03`, `A-04`, но выявлены 2 связанных дефекта распределённой блокировки и отказоустойчивости возврата (`AUD-015` и `AUD-016`)*.
- **Файл и строки:** `src/bot/handlers/adminHandler.ts` (`440–637`), `src/bot/keyboards.ts` (`236–285`), `src/services/OrderService.ts` (`237–255`), `src/services/PaymentService.ts` (`330–494`)
- **Что исправлено:**
  1. Нажатие `adm:ord_refund:<orderId>` больше не возвращает Stars в 1 клик, а открывает экран подтверждения (`adm:ord_refund_confirm:<orderId>`) с предупреждением, если заказ уже `completed`.
  2. Отмена уже оплаченного заказа через `adm:ord_cancel` или `ucancel` заблокирована на уровне обработчиков и внутри транзакции `OrderService.updateOrderStatus()`.
- **Что осталось доработать:** см. `AUD-015` (межпроцессная блокировка возврата в Firestore) и `AUD-016` (обработка сбоя записи в Firestore после успешного возврата в Telegram API).

---

### `AUD-005` — Запрет перевода неоплаченного заказа в `processing`/`completed` и фильтрация кнопок выдачи
- **Критичность:** `High`
- **Статус:** ✅ **ИСПРАВЛЕНО (`FIXED`)**
- **Файл и строки:** `src/bot/keyboards.ts` (`196–231`), `src/bot/handlers/adminHandler.ts` (`236–310`, `344–411`), `src/services/OrderService.ts` (`258–278`)
- **Проверка исправления:** Клавиатура `buildAdminOrderActionKeyboard()` скрывает кнопки выдачи для неоплаченных заказов; обработчики `adm:ord_proc` и `adm:ord_note` и транзакция `OrderService.updateOrderStatus()` отклоняют невалидные переходы. Подтверждено автотестами `A-01` и `A-02`.

---

### `AUD-006` — Отсутствие пагинации списков в боте и лимит 200 документов в статистике `adm:stats`
- **Критичность:** `Medium`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/bot/keyboards.ts` (`71`, `179`, `288`), `src/bot/handlers/adminHandler.ts` (`161–168`, `206`, `777`)
- **Как воспроизводится:** При наличии >8 заказов у покупателя или >10 заказов/пользователей в админке `.slice(0, 8)` / `.slice(0, 10)` отсекает остальные записи без кнопок перехода на следующую страницу. В `adm:stats` (`adminHandler.ts:163–166`) запрашивается не более `200` документов, из-за чего выручка и число заказов перестают расти после 200 записей.
- **Последствия:** Невозможность открыть старые заказы через меню и искажение финансовой статистики магазина при росте базы свыше 200 заказов.
- **Минимальное исправление:** Добавить callback-кнопки пагинации (`page`/`cursor`) в клавиатуры списков и использовать агрегирующие счётчики для `adm:stats`.

---

### `AUD-007` — Нетранзакционный `getDoc` + `setDoc` в `UserService.upsertFromTelegram` и `setUserBlocked`
- **Критичность:** `Medium`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/services/UserService.ts` (`10–50`, `77–92`), `src/bot/handlers/userHandler.ts` (`122`)
- **Как воспроизводится:** Глобальный middleware (`userHandler.ts:122`) на каждое входящее обновление вызывает `UserService.upsertFromTelegram()`, который читает весь документ `users/{userId}` вне транзакции и перезаписывает его целиком через `setDoc` (`UserService.ts:18–30`). При параллельном выполнении с `PaymentService.processSuccessfulPayment()` старое значение `totalOrders` и `totalSpentStars` из `existing` может перезатереть только что увеличенные счётчики.
- **Последствия:** Потеря инкремента `totalOrders`/`totalSpentStars` при конкурентных апдейтах и лишняя запись в Firestore на каждый клик пользователя.
- **Минимальное исправление:** Использовать частичное обновление `updateDoc` только для профильных полей (`username`, `firstName`, `lastName`, `languageCode`, `updatedAt`) при их реальном изменении, либо выполнять запись внутри транзакции без перезаписи `totalOrders`, `totalSpentStars` и `isBlocked`.

---

### `AUD-008` — Настройка `maintenanceMode` в `settings/global` не проверяется и не управляется из админки
- **Критичность:** `Medium`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/db/firestore.ts` (`687–694`), `src/types.ts` (`144–150`)
- **Как воспроизводится:** Документ `settings/global` создаётся с полем `maintenanceMode: false`, но ни один метод в `OrderService`, `PaymentService` или `userHandler` не читает это поле.
- **Последствия:** Администратор не может временно приостановить приём заказов через бота на время технических работ.
- **Минимальное исправление:** Проверять `maintenanceMode` в `OrderService.createOrder()` и `PaymentService.validatePreCheckout()`, а также добавить кнопку переключения в `/admin`.

---

### `AUD-009` — Публичные эндпоинты `GET /health` и `GET /` раскрывают внутренние метаданные инфраструктуры
- **Критичность:** `Medium`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `server.ts` (`77–120`)
- **Как воспроизводится:** Любой неавторизованный GET-запрос к `/health` или `/` возвращает JSON/текст с `projectId`, `databaseId`, `botId`, `botUsername` и диагностической строкой `statusMessage`.
- **Последствия:** Раскрытие внутренней конфигурации GCP/Firebase и диагностических ошибок внешним сканерам.
- **Минимальное исправление:** Оставить в публичном `/health` только `{ ok: !dbStatus.degradedMode, status: dbStatus.degradedMode ? 'degraded' : 'ok', timestamp }`, скрыв идентификаторы проекта и БД.

---

### `AUD-010` — Отсутствие выбора количества товара (`quantity > 1`) в пользовательском интерфейсе бота
- **Критичность:** `Medium`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/bot/handlers/paymentHandler.ts` (`28–32`), `src/services/OrderService.ts` (`41`)
- **Как воспроизводится:** При нажатии `buy:<productId>` в `paymentHandler.ts:31` всегда передаётся `quantity: 1`, хотя `OrderService.createOrder()` поддерживает `quantity` от `1` до `10`.
- **Последствия:** Покупатель вынужден оплачивать каждую единицу товара отдельным заказом.
- **Минимальное исправление:** Добавить выбор количества или оставить явное ограничение `1 шт. на заказ`, если магазин продаёт только штучные пакеты.

---

### `AUD-011` — Отсутствие реальной компиляции в `npm run build` (`tsc --noEmit`) и тяжёлые 3D/XR-зависимости шаблона
- **Критичность:** `Medium`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `package.json` (`2`, `9`, `16–51`), `tsconfig.json` (`10`)
- **Как воспроизводится:** Команда `npm run build` запускает `tsc --noEmit`, который проверяет типы, но не создаёт production-сборку. В `package.json` присутствуют `xrblocks`, `three`, `@dimforge/rapier3d-simd-compat`, `@mediapipe/*`, `openai`, `@google/genai`, не используемые ботом.
- **Последствия:** Раздутый Docker-образ/окружение и запуск production-сервера через dev-раннер `tsx server.ts`.
- **Минимальное исправление:** Очистить `package.json` от неиспользуемых зависимостей шаблона при подготовке финального контейнера.

---

### `AUD-012` — Неиспользуемый метод `UserService.incrementUserPurchaseStats` и черновые файлы в корне
- **Критичность:** `Low`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/services/UserService.ts` (`94–109`), `DRAFT_firestore.rules`, `security_spec.md`
- **Как воспроизводится:** `UserService.incrementUserPurchaseStats()` нигде не вызывается (статистика обновляется внутри `PaymentService.processSuccessfulPayment` и `OrderService.markOrderPaid`). Файл `DRAFT_firestore.rules` полностью дублирует `firestore.rules`.
- **Последствия:** Риск двойного начисления статистики при ошибочном вызове `incrementUserPurchaseStats` и путаница при редактировании правил Firestore.
- **Минимальное исправление:** Удалить неиспользуемый метод `UserService.incrementUserPurchaseStats()` и черновик `DRAFT_firestore.rules`.

---

### `AUD-013` — Физическое удаление товара (`adm:pdel`) без подтверждения ломает оплату ранее выставленных счетов
- **Критичность:** `Medium`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/bot/handlers/adminHandler.ts` (`650–666`), `src/services/ProductService.ts` (`138–140`), `src/services/PaymentService.ts` (`201–207`)
- **Как воспроизводится:**
  1. Покупатель нажимает «Купить» — бот создаёт заказ `pending` и отправляет счёт Telegram Stars в чат.
  2. Администратор нажимает `🗑 Удалить товар` (`adm:pdel:<productId>`), что сразу вызывает `ProductService.deleteProduct()` и физически удаляет документ `products/{productId}`.
  3. Покупатель оплачивает ранее открытый инвойс; Telegram списывает Stars и присылает `successful_payment`, но `PaymentService.processSuccessfulPayment()` на строках `202–207` не находит удалённый документ товара и выбрасывает исключение `Товар ... для заказа ... не найден в каталоге`.
- **Последствия:** Списание Stars у покупателя без автоматического зачисления оплаты в БД (срабатывает аварийный блок ручного разбора в `paymentHandler.ts:180–212`).
- **Минимальное исправление:** В `processSuccessfulPayment` при оплате уже созданного заказа использовать сохранённые в самом заказе поля (`order.productId`, `order.productName`, `order.totalPrice`), если товар был удалён после выставления инвойса, а в админке заменить удаление товара с существующими заказами на деактивацию (`isActive: false`) + добавить подтверждение удаления.

---

### `AUD-014` — Расхождение `firestore.rules` и `userHandler.ts` по полю `fulfillmentNote` при отмене заказа
- **Критичность:** `Low`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `firestore.rules` (`300–308`), `src/bot/handlers/userHandler.ts` (`380–385`)
- **Как воспроизводится:** В `firestore.rules:307` клиентское правило отмены заказа разрешает изменять только `['paymentStatus', 'fulfillmentStatus', 'updatedAt']`, тогда как `userHandler.ts:384` передаёт также `fulfillmentNote: 'Отменён покупателем до оплаты.'`.
- **Последствия:** На работу Telegram-бота не влияет (бот работает через Admin SDK), но при использовании клиентского SDK запрос отмены с `fulfillmentNote` был бы отклонён правилами.
- **Минимальное исправление:** Добавить `'fulfillmentNote'` в список разрешённых полей при отмене заказа в `firestore.rules:307`.

---

### `AUD-015` — Блокировка возврата `activeRefundLocks` работает только в памяти одного процесса и не защищает при нескольких экземплярах сервера
- **Критичность:** `High`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/services/PaymentService.ts` (`330–358`)
- **Как воспроизводится:** `PaymentService.activeRefundLocks` представляет собой локальный `new Set<string>()` в оперативной памяти процесса Node.js. Если приложение развёрнуто в Cloud Run с количеством экземпляров `> 1` и два администратора (или два параллельных запроса) одновременно нажимают `adm:ord_refund_confirm:<orderId>`, запросы балансируются на разные инстансы контейнера. Оба инстанса видят пустой локальный `activeRefundLocks`, оба читают заказ в статусе `paid` и оба вызывают Telegram API `refundStarPayment`.
- **Последствия:** Гонка между инстансами сервера при горизонтальном масштабировании.
- **Минимальное исправление:** Захватывать распределённый lease-лок возврата непосредственно в документе заказа в Firestore внутри транзакции (например, `refundLockId`, `refundLockedAt` с таймаутом 45 секунд) **до** вызова `callTelegramRefund`.

---

### `AUD-016` — Риск рассинхронизации при успешном возврате в Telegram API (`refundStarPayment`) и последующей ошибке записи в Firestore
- **Критичность:** `High`
- **Статус:** ❌ **НЕ ИСПРАВЛЕНО (`OPEN`)**
- **Файл и строки:** `src/services/PaymentService.ts` (`399–413`), `src/bot/handlers/adminHandler.ts` (`528–581`)
- **Как воспроизводится:** В `PaymentService.executeOrderRefund()` сначала выполняется внешний сетевой запрос `await params.callTelegramRefund(...)` (`refundStarPayment` в Telegram API, строки `399–402`), и только после него запускается транзакция `await this.markPaymentRefunded(...)` (строки `404–407`). Если вызов `refundStarPayment` в Telegram прошёл успешно, но в момент коммита `markPaymentRefunded` произошёл временный сбой Firestore (`DEADLINE_EXCEEDED` / `UNAVAILABLE`), метод выбросит ошибку без сохранения состояния возврата.
- **Последствия:** Telegram реально вернул Stars покупателю, но в базе Firestore заказ остаётся в статусе `paid` / `completed` (а `PaymentRecord` — в статусе `paid`), без флага `needsManualReconciliation` и без записи о том, что средства уже списаны с баланса бота.
- **Минимальное исправление:**
  1. Перед вызовом `callTelegramRefund` транзакционно записывать в заказ маркер `refundStartedAt` (одновременно решая `AUD-015`).
  2. Обернуть вызов `markPaymentRefunded` после успешного `callTelegramRefund` во встроенный retry (3 попытки с backoff), а если БД остаётся недоступной — переводить заказ в карантин сверки (`needsManualReconciliation: true`, `fulfillmentLastError: 'CRITICAL: Telegram refundStarPayment succeeded, but Firestore commit failed'`) и отправлять экстренное уведомление администратору.

---

## 3. Оценка тестирования и сборки

1. **Что реально проверяют существующие тесты:**
   - `npm test` (`src/tests/stage1.test.ts` — `29/29 PASS`): проверяет бизнес-логику `OrderService`, `PaymentService`, `FulfillmentService`, конкурентную оплату (`P-03`), конкурентных воркеров выдачи (`F-02`), crash-recovery (`F-03`), валидацию `X-Telegram-Bot-Api-Secret-Token` (`S-01`, `S-02`), запрет невалидных переходов статусов (`A-01`, `A-02`) и защиту возврата в рамках одного процесса (`A-03`, `A-04`).
   - `npm run audit:emulator` (`firestore-audit-package` — `38/38 PASS`): проверяет `firestore.rules`, индексы и транзакции на реальном Firebase Emulator (`127.0.0.1:8080`).
2. **Чего тесты пока НЕ проверяют:**
   - Сценарий частичного сбоя: `refundStarPayment` в Telegram прошёл успешно, а `markPaymentRefunded` в Firestore завершился ошибкой (`AUD-016`).
   - Межпроцессную конкуренцию возвратов через Firestore-лок без опоры на in-memory `Set` (`AUD-015`).
   - Уменьшение `totalOrders` и `totalSpentStars` пользователя при возврате (`AUD-003`).
   - Оплату ранее выставленного инвойса после удаления товара администратором (`AUD-013`).
3. **Честная оценка сборки:**
   - Команда `npm run build` выполняет **только `tsc --noEmit`** (статическую проверку типов TypeScript). Полноценная компиляция/бандлинг серверного кода в отдельный production-артефакт (`dist/`) в проекте не настроена (`AUD-011`).

---

## 4. Итоговая сводка аудита (100%)

- **Проверено областей из 14:** **`14 из 14 (100%)`**
- **Всего зафиксировано проблем в реестре (`AUD-001` — `AUD-016`):** **`16`**
  - **Critical:** **`1`** (`AUD-002`)
  - **High:** **`6`** (`AUD-001`, `AUD-003`, `AUD-004` *[частично исправлена]*, `AUD-005` *[исправлена]*, `AUD-015`, `AUD-016`)
  - **Medium:** **`7`** (`AUD-006`, `AUD-007`, `AUD-008`, `AUD-009`, `AUD-010`, `AUD-011`, `AUD-013`)
  - **Low:** **`2`** (`AUD-012`, `AUD-014`)
- **Статус исправления проблем:**
  - **Полностью исправлено (`FIXED`):** **`1`** (`AUD-005`)
  - **Частично исправлено (`PARTIALLY FIXED`):** **`1`** (`AUD-004` — внедрены двухшаговое подтверждение возврата и запрет отмены оплаченных заказов; межпроцессный лок и защита от сбоя БД после `refundStarPayment` выделены в `AUD-015` и `AUD-016`)
  - **Осталось исправить (`OPEN`):** **`14`** (`AUD-001`, `AUD-002`, `AUD-003`, `AUD-006`, `AUD-007`, `AUD-008`, `AUD-009`, `AUD-010`, `AUD-011`, `AUD-012`, `AUD-013`, `AUD-014`, `AUD-015`, `AUD-016`)
- **Какие компоненты не удалось проверить локально:**
  - Реальный сетевой обмен с Production Telegram Bot API (`sendInvoice`, `refundStarPayment`) и внешним API поставщика ключей/Stars (в соответствии с правилами безопасности аудита внешние боевые платёжные контуры не подключались). Все остальные 14 компонентов проверены по исходному коду и на локальном эмуляторе.
- **Что блокирует запуск первых реальных продаж (Must-Fix Blockers):**
  1. **`AUD-002` (`Critical`):** Отсутствие пула одноразовых ключей для автоматической выдачи и автозасев тестовых товаров `(Тест)` при пустой БД.
  2. **`AUD-015` + `AUD-016` + `AUD-003` (`High`):** Перенос блокировки возврата из памяти процесса в транзакцию Firestore, защита от рассинхронизации при сбое записи в БД после успешного `refundStarPayment` в Telegram и корректировка `totalOrders`/`totalSpentStars` при возврате.
  3. **`AUD-001` (`High`):** Отключение клиентского Firebase SDK (`firestoreErrorHandler.ts`) в серверном процессе, вызывающего обрывы gRPC-потока `Listen`.
  4. **`AUD-007` + `AUD-013` + `AUD-009` (`Medium`):** Устранение гонки `setDoc` в `UserService.upsertFromTelegram`, защита `processSuccessfulPayment` при удалённом товаре и скрытие внутренних идентификаторов из публичного `/health`.
- **Рекомендуемый следующий этап исправлений:**
  - **Этап 3.1 (Финансовая атомарность возвратов и БД):** Исправить `AUD-015`, `AUD-016`, `AUD-003`, `AUD-001`, `AUD-007`, `AUD-013`, `AUD-009` + добавить тесты на сбой БД после `refundStarPayment` и пересчёт статистики при возврате.
  - **Этап 3.2 (Каталог и автовыдача ключей):** Исправить `AUD-002` (пул одноразовых ключей и отключение автозасева тестовых позиций в Production) и `AUD-008` (`maintenanceMode`).
  - **Этап 3.3 (UX, пагинация и сборка):** Исправить `AUD-006`, `AUD-010`, `AUD-011`, `AUD-012`, `AUD-014`.
