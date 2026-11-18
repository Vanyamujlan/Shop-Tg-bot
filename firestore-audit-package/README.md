# Firestore Emulator Audit Package — Stars Shop (`@Starsladen_bot`)

Локальный воспроизводимый пакет для независимого технического аудита структуры базы данных Cloud Firestore, правил безопасности (`firestore.rules`), составных индексов (`firestore.indexes.json`), целостности данных и конкурентных транзакций проекта **Stars Shop** (`https://github.com/Vanyamujlan/Shop-Tg-bot`).

---

## 1. Гарантии безопасности и изоляции от Production

1. **Строгая изоляция в локальном Firebase Firestore Emulator:**
   - Все операции чтения, записи и тестирования выполняются **только** в локальном **Firebase Firestore Emulator** по адресу `127.0.0.1:8080` с изолированным проектом `demo-stars-shop-audit`.
   - В `src/db/firestore.ts` реализован защитный барьер `assertEmulatorOnlyEnvironment()` (`ProductionGuardError`), который выполняется **до любых обращений к Firestore** и немедленно завершает процесс с ошибкой, если:
     - не задана переменная `FIRESTORE_EMULATOR_HOST` или её хост отличается от `127.0.0.1` / `localhost`;
     - `projectId` не начинается с префикса `demo-` или совпадает с `tg-1-675b4`;
     - в окружении присутствуют переменные `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` или `GOOGLE_APPLICATION_CREDENTIALS`.
   - Автоматическое переключение на Production Firestore при недоступности эмулятора невозможно.
2. **Полное отсутствие реальных данных и секретов:**
   - В пакете нет реальных Telegram ID, личных данных покупателей, токенов и сервисных ключей.
   - Из `firestore.rules`, `DRAFT_firestore.rules`, `security_spec.md` и `firestore.rules.test.ts` полностью удалён реальный email; функция `isAdmin()` проверяет права исключительно через коллекцию `/admins/$(request.auth.uid)` и Custom Claims (`request.auth.token.admin == true`).
   - Все 54 документа во всех 7 коллекциях являются 100% синтетическими.

---

## 2. Структура пакета `/firestore-audit-package`

```text
firestore-audit-package/
├── firebase.json                         # Конфигурация локального Firestore Emulator (127.0.0.1:8080)
├── firestore.rules                       # Синхронизированные с src/types.ts правила безопасности
├── firestore.indexes.json                # 10 составных индексов (Composite Indexes)
├── scripts/
│   ├── runAuditEmulatorCli.ts            # Скрипт запуска полного аудита (npm run audit:emulator)
│   └── seedSyntheticData.ts              # Генератор 54 синтетических документов (12 сценариев) + JSON-дамп
├── tests/
│   └── runEmulatorAuditSuite.ts          # 37 автоматических проверок на реальном Emulator + @firebase/rules-unit-testing
├── export/
│   ├── firestore-collections-dump.json   # Полный JSON-дамп всех 7 коллекций (54 документа)
│   ├── audit-test-results.json           # Машиночитаемый отчёт о прохождении всех 37 проверок
│   └── native-emulator-export/           # Нативный снимок Firebase Emulator (firebase emulators:export)
├── AUDIT_REPORT.md                       # Подробный технический отчёт о результатах всех проверок
└── README.md                             # Документация по схеме, 54 документам, 12 сценариям и запуску
```

---

## 3. Воспроизводимый запуск аудита

### Требования к среде
- **Node.js**: `>= 20.x`
- **Java Runtime (JRE/JDK)**: `>= 21` (требуется для `firebase-tools >= 15.x` и `cloud-firestore-emulator.jar`)
- **Firebase CLI**: `firebase-tools` (`firebase --version`)

### Основной способ: запуск одной командой (`npm run audit:emulator`)

Из корня проекта выполните:

```bash
npm run audit:emulator
```

Команда выполняет `firestore-audit-package/scripts/runAuditEmulatorCli.ts`, который последовательно:
1. Проверяет наличие `firebase.json` (хост строго `127.0.0.1:8080`), установленных пакетов (`@firebase/rules-unit-testing`, `firebase-admin`, `firebase`, `tsx`), `firebase --version` и `java -version` (`>= 21`).
2. Удаляет любые секреты из окружения процесса и запускает `assertEmulatorOnlyEnvironment('demo-stars-shop-audit')` **до** старта эмулятора.
3. Запускает `firebase emulators:exec --only firestore --project demo-stars-shop-audit` строго на `127.0.0.1:8080`.
4. Очищает эмулятор и загружает 54 синтетических документа (12 сценариев) во все 7 коллекций.
5. Выполняет все 37 проверок (`Environment`, `Integrity`, `SecurityRules` через `@firebase/rules-unit-testing`, `IndexesQueries`, `Concurrency`).
6. Восстанавливает эталонный набор из 54 документов после мутирующих тестов, сохраняет `export/firestore-collections-dump.json`, `export/audit-test-results.json` и нативный снимок `export/native-emulator-export/`.
7. Завершается с ненулевым кодом возврата (`exit 1`), если хотя бы один тест завершился со статусом `FAIL` или если эмулятор не смог запуститься.

### Пошаговый ручной запуск (в двух терминалах)

**Терминал 1 — запуск Firestore Emulator:**
```bash
firebase emulators:start --only firestore --project demo-stars-shop-audit
```
*(или с импортом готового снимка: `firebase emulators:start --only firestore --project demo-stars-shop-audit --import=./firestore-audit-package/export/native-emulator-export`)*

**Терминал 2 — загрузка синтетических данных и запуск тестов:**
```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
GCLOUD_PROJECT=demo-stars-shop-audit \
FIREBASE_PROJECT_ID=demo-stars-shop-audit \
  npx tsx firestore-audit-package/scripts/seedSyntheticData.ts

FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
GCLOUD_PROJECT=demo-stars-shop-audit \
FIREBASE_PROJECT_ID=demo-stars-shop-audit \
  npx tsx firestore-audit-package/tests/runEmulatorAuditSuite.ts
```

---

## 4. Актуальная схема данных (`src/types.ts` и `firestore.rules`)

Все суммы выражены в целых единицах **Telegram Stars**, валюта во всех финансовых документах строго фиксирована как `'XTR'`, а временные метки хранятся в формате строк ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).

### 4.1. Перечисления (Enums / Union Types)
- **`ProductCategory`**: `'stars' | 'premium' | 'gifts'`
- **`FulfillmentType`**: `'manual' | 'provider_adapter'`
- **`OrderStatus`** (используется для `paymentStatus` и `fulfillmentStatus` в `Order`):
  `'pending' | 'paid' | 'processing' | 'completed' | 'cancelled' | 'refunded' | 'failed'`
- **`PaymentRecord['status']`**: `'paid' | 'refunded'`
- **`TransactionType`**:
  `'invoice_created' | 'pre_checkout_ok' | 'payment_received' | 'fulfillment_completed' | 'fulfillment_failed' | 'fulfillment_retry' | 'order_cancelled' | 'payment_refunded' | 'admin_action' | 'error'`
- **`AdminRecord['role']`**: `'admin' | 'superadmin'`

### 4.2. Поля и связи 7 коллекций

| Коллекция | Ключ документа | Обязательные поля | Опциональные поля | Связи (Foreign Keys) |
|---|---|---|---|---|
| `settings` | `key` (`'global'`) | `key` (`'global'`), `storeName` (`string`), `supportUsername` (`string`), `maintenanceMode` (`boolean`), `updatedAt` (`string`) | — | Единственный документ конфигурации |
| `admins` | `adminId` (`tg_<telegramId>`) | `adminId` (`string`), `telegramId` (`number`), `role` (`'admin' \| 'superadmin'`), `addedAt` (`string`) | — | Используется в `isAdmin()` в `firestore.rules` |
| `products` | `id` | `id`, `name`, `category` (`ProductCategory`), `description`, `price` (`number > 0`), `currency` (`'XTR'`), `imageUrl`, `isActive` (`boolean`), `fulfillmentType` (`FulfillmentType`), `createdAt`, `updatedAt` | — | На `products.id` ссылается `orders.productId` |
| `users` | `userId` (`tg_<telegramId>`) | `userId`, `telegramId` (`number`), `firstName` (`string`), `isBlocked` (`boolean`), `totalOrders` (`number >= 0`), `totalSpentStars` (`number >= 0`), `createdAt`, `updatedAt` | `username`, `lastName`, `languageCode` | На `users.userId` ссылаются `orders.userId`, `payments.userId`, `transactions.userId` |
| `orders` | `orderId` | `orderId`, `userId`, `userTelegramId` (`number`), `productId`, `productName`, `category` (`ProductCategory`), `quantity` (`number > 0`), `totalPrice` (`number == price * quantity`), `currency` (`'XTR'`), `paymentStatus` (`OrderStatus`), `fulfillmentStatus` (`OrderStatus`), `createdAt`, `updatedAt` | `username`, `telegramPaymentChargeId`, `providerPaymentChargeId`, `fulfillmentNote`, `fulfillmentStartedAt`, `fulfillmentAttempts`, `fulfillmentLastError`, `fulfillmentNextRetryAt`, `fulfillmentIdempotencyKey`, `externalExecutionReference`, `needsManualReconciliation`, `adminNotifiedAt`, `buyerNotifiedAt`, `paidAt`, `completedAt` | `userId -> users.userId`, `productId -> products.id`, `telegramPaymentChargeId -> payments.telegramPaymentChargeId` |
| `payments` | `paymentId` (`pay_<chargeId>`) | `paymentId`, `telegramPaymentChargeId`, `orderId`, `userId`, `userTelegramId` (`number`), `totalAmount` (`number == order.totalPrice`), `currency` (`'XTR'`), `invoicePayload` (`== orderId`), `status` (`'paid' \| 'refunded'`), `createdAt` | `providerPaymentChargeId`, `refundedAt` | `orderId -> orders.orderId`, `userId -> users.userId` |
| `transactions` | `transactionId` | `transactionId`, `orderId`, `userId`, `type` (`TransactionType`), `amount` (`number >= 0`), `currency` (`'XTR'`), `details` (`string`), `createdAt` | — | `orderId -> orders.orderId`, `userId -> users.userId` (или `admins.adminId` для `admin_action`) |

---

## 5. Описание 12 синтетических сценариев (`seedSyntheticData.ts`)

| № | Сценарий | Фактические ID документов в базе | Проверяемые инварианты и логика |
|---|---|---|---|
| **1** | Новый пользователь без заказов | `users/tg_900001001` (`telegramId: 900001001`, `username: 'syn_new_buyer'`) | Начальное состояние профиля: `totalOrders: 0`, `totalSpentStars: 0`, `isBlocked: false` |
| **2** | Каталог из 6 товаров (активные и архивный, `manual` и `provider_adapter`) | `products/stars_pack_100`, `products/stars_pack_500`, `products/premium_3m`, `products/premium_12m`, `products/gift_crystal_star`, `products/gift_archived_limited` | Категории `stars`, `premium`, `gifts`; фильтрация `isActive == true` (5 активных) и скрытие архивного `gift_archived_limited` (`isActive: false`) |
| **3** | Неоплаченный заказ в статусе `pending` | `orders/ord_syn_pending_01`, `transactions/tx_syn_001_invoice` | Создан инвойс на `100 XTR` (`paymentStatus: 'pending'`, `fulfillmentStatus: 'pending'`), запись в `payments` отсутствует; запрет выдачи до оплаты |
| **4** | Оплаченный заказ в статусе `paid` (ожидает захвата воркером выдачи) | `orders/ord_syn_paid_02`, `payments/pay_chg_syn_paid_02`, `transactions/tx_syn_002_precheckout`, `transactions/tx_syn_003_paid` | Подтверждён `chg_syn_paid_02` (`100 XTR`), `paymentStatus: 'paid'`, `fulfillmentStatus: 'paid'`, `fulfillmentAttempts: 0` |
| **5** | Заказ в активной выдаче `processing` | `orders/ord_syn_processing_03`, `payments/pay_chg_syn_processing_03`, `transactions/tx_syn_004_proc_paid` | Захвачен воркером (`fulfillmentStatus: 'processing'`, `fulfillmentStartedAt: '2026-11-17T09:30:05.000Z'`, `fulfillmentAttempts: 1`, `externalExecutionReference: 'manual_ord_syn_processing_03'`) |
| **6** | Успешно выданный заказ `completed` | `orders/ord_syn_completed_04`, `payments/pay_chg_syn_completed_04`, `transactions/tx_syn_005_comp_paid`, `transactions/tx_syn_006_comp_done`, `transactions/tx_syn_016_admin_act` | Полный цикл выдачи (`paymentStatus: 'completed'`, `fulfillmentStatus: 'completed'`, заполнены `completedAt`, `adminNotifiedAt`, `buyerNotifiedAt`, `fulfillmentNote`) |
| **7** | Неудачная выдача `failed` после исчерпания 3 попыток | `orders/ord_syn_failed_05`, `payments/pay_chg_syn_failed_05`, `transactions/tx_syn_007_fail_paid`, `transactions/tx_syn_008_fail_err` | Ошибка провайдера после `fulfillmentAttempts: 3` (`paymentStatus: 'paid'`, `fulfillmentStatus: 'failed'`, `needsManualReconciliation: true`, `fulfillmentLastError`) |
| **8** | Заказ на ручной сверке (`needsManualReconciliation: true`) после сбоя во время внешнего вызова | `orders/ord_syn_reconcile_06`, `payments/pay_chg_syn_reconcile_06`, `transactions/tx_syn_009_rec_paid` | Защита от двойной выдачи при перезапуске во время вызова неидемпотентного провайдера (`paymentStatus: 'paid'`, `fulfillmentStatus: 'failed'`, `fulfillmentAttempts: 1`, `needsManualReconciliation: true`) |
| **9** | Заказ, получивший дублирующееся уведомление об оплате (идемпотентная дедупликация) | `orders/ord_syn_dup_payment_07`, `payments/pay_chg_syn_dup_07`, `transactions/tx_syn_010_dup_paid`, `transactions/tx_syn_011_dup_done` | Повторный `successful_payment` с `chg_syn_dup_07` не создал второй `PaymentRecord` и не задвоил выдачу (`paymentStatus: 'completed'`, `fulfillmentStatus: 'completed'`) |
| **10** | Заказ в очереди на повторную попытку выдачи (`fulfillmentNextRetryAt`) | `orders/ord_syn_retry_08`, `payments/pay_chg_syn_retry_08`, `transactions/tx_syn_012_retry_paid`, `transactions/tx_syn_013_retry_sched` | Временная сетевая ошибка на попытке #1 (`paymentStatus: 'paid'`, `fulfillmentStatus: 'failed'`, `fulfillmentAttempts: 1`, `fulfillmentNextRetryAt: '2026-11-17T09:55:14.000Z'`, `needsManualReconciliation: false`) |
| **11** | Официальный возврат средств `refunded` (`refundStarPayment`) | `orders/ord_syn_refunded_09`, `payments/pay_chg_syn_refunded_09`, `transactions/tx_syn_014_ref_paid`, `transactions/tx_syn_015_ref_done` | Согласованный статус `refunded` в заказе и платеже (`refundedAt: '2026-11-17T09:59:00.000Z'`) и транзакция `payment_refunded` |
| **12** | Серия заказов одного покупателя + 3 заказа с **одинаковым `createdAt`** + заблокированный пользователь и роли админов | `orders/ord_syn_same_ts_10`, `orders/ord_syn_same_ts_11`, `orders/ord_syn_same_ts_12`, `payments/pay_chg_syn_same_ts_10`, `payments/pay_chg_syn_same_ts_11`, `transactions/tx_syn_017_same_ts_10`..`tx_syn_019_cancelled_12`, `users/tg_900001002`, `users/tg_900001004`, `admins/tg_900000001`, `admins/tg_900000002`, `settings/global` | Три заказа (`ord_syn_same_ts_10`, `ord_syn_same_ts_11`, `ord_syn_same_ts_12`) имеют идентичный `createdAt = '2026-11-17T10:00:00.000Z'` для проверки курсорной пагинации `startAfter(DocumentSnapshot)` без пропусков и дублей |

---

## 6. Полный реестр всех 54 синтетических документов в 7 коллекциях

| Коллекция | Кол-во | Полный список ID документов в дампе (`export/firestore-collections-dump.json`) |
|---|---:|---|
| **`settings`** | **1** | `global` |
| **`admins`** | **2** | `tg_900000001` (`role: 'superadmin'`), `tg_900000002` (`role: 'admin'`) |
| **`products`** | **6** | `stars_pack_100` (`100 XTR`, active), `stars_pack_500` (`450 XTR`, active), `premium_3m` (`1000 XTR`, active), `premium_12m` (`3000 XTR`, active), `gift_crystal_star` (`250 XTR`, active), `gift_archived_limited` (`750 XTR`, inactive) |
| **`users`** | **4** | `tg_900001001` (0 заказов / 0 XTR), `tg_900001002` (8 оплаченных заказов / 2650 XTR), `tg_900001003` (2 оплаченных заказа / 3450 XTR), `tg_900001004` (`isBlocked: true`, 0 заказов / 0 XTR) |
| **`orders`** | **12** | `ord_syn_pending_01`, `ord_syn_paid_02`, `ord_syn_processing_03`, `ord_syn_completed_04`, `ord_syn_failed_05`, `ord_syn_reconcile_06`, `ord_syn_dup_payment_07`, `ord_syn_retry_08`, `ord_syn_refunded_09`, `ord_syn_same_ts_10`, `ord_syn_same_ts_11`, `ord_syn_same_ts_12` |
| **`payments`** | **10** | `pay_chg_syn_paid_02`, `pay_chg_syn_processing_03`, `pay_chg_syn_completed_04`, `pay_chg_syn_failed_05`, `pay_chg_syn_reconcile_06`, `pay_chg_syn_dup_07`, `pay_chg_syn_retry_08`, `pay_chg_syn_refunded_09`, `pay_chg_syn_same_ts_10`, `pay_chg_syn_same_ts_11` |
| **`transactions`** | **19** | `tx_syn_001_invoice`, `tx_syn_002_precheckout`, `tx_syn_003_paid`, `tx_syn_004_proc_paid`, `tx_syn_005_comp_paid`, `tx_syn_006_comp_done`, `tx_syn_007_fail_paid`, `tx_syn_008_fail_err`, `tx_syn_009_rec_paid`, `tx_syn_010_dup_paid`, `tx_syn_011_dup_done`, `tx_syn_012_retry_paid`, `tx_syn_013_retry_sched`, `tx_syn_014_ref_paid`, `tx_syn_015_ref_done`, `tx_syn_016_admin_act`, `tx_syn_017_same_ts_10`, `tx_syn_018_same_ts_11`, `tx_syn_019_cancelled_12` |
| **ИТОГО** | **54** | **Все 7 коллекций полностью заполнены и согласованы** |
