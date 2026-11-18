# Firestore Audit Package — Stars Shop (`@Starsladen_bot`)

Локальный изолированный пакет аудита структуры базы данных Cloud Firestore, правил безопасности (`firestore.rules`), составных индексов (`firestore.indexes.json`), целостности данных и конкурентных транзакций для проекта **Stars Shop** (`https://github.com/Vanyamujlan/Shop-Tg-bot`).

---

## 1. Гарантии безопасности и изоляции

1. **Полная изоляция от Production Firestore:**
   - Все скрипты и тесты работают **исключительно** с локальным **Firebase Firestore Emulator** (`127.0.0.1:8080`, проект `demo-stars-shop-audit`).
   - В `src/db/firestore.ts` реализован жёсткий защитный барьер `assertEmulatorOnlyEnvironment()` (`ProductionGuardError`), который немедленно аварийно завершает процесс, если:
     - `FIRESTORE_EMULATOR_HOST` не задан или указывает на внешний хост (разрешены только `127.0.0.1:<port>` и `localhost:<port>`);
     - `projectId` не начинается с `demo-` или совпадает с `tg-1-675b4`;
     - В окружении присутствуют переменные `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` или `GOOGLE_APPLICATION_CREDENTIALS`.
2. **Полное обезличивание данных:**
   - В пакете отсутствуют реальные Telegram ID, имена пользователей, токены, ключи и персональные email-адреса.
   - В функции `isAdmin()` внутри `firestore.rules` полностью удалён личный email; проверка прав администратора осуществляется только через коллекцию `/admins/$(request.auth.uid)` и Custom Claims (`request.auth.token.admin == true`).
   - Все тестовые данные являются 100% синтетическими (`900000101..900000902`, `chg_synth_*`, `ord_synth_*`, `pay_synth_*`, `tx_synth_*`).

---

## 2. Состав пакета `/firestore-audit-package`

```text
firestore-audit-package/
├── firebase.json                         # Конфигурация локального Firebase Firestore Emulator (127.0.0.1:8080)
├── firestore.rules                       # Синхронизированные с src/types.ts и обезличенные правила безопасности
├── firestore.indexes.json                # 10 составных индексов (Composite Indexes) для серверных запросов
├── scripts/
│   └── seedSyntheticData.ts              # Генератор 54 синтетических документов (12 сценариев) + JSON-дамп
├── tests/
│   └── runEmulatorAuditSuite.ts          # Полный набор из 37 тестов на реальном Emulator + @firebase/rules-unit-testing
├── export/
│   ├── firestore-collections-dump.json   # Полный JSON-дамп всех 7 коллекций (54 документа) с метаданными
│   ├── audit-test-results.json           # Машиночитаемый отчёт о прохождении всех 37 тестов
│   └── native-emulator-export/           # Нативный снимок Firebase Emulator (firebase emulators:export)
├── AUDIT_REPORT.md                       # Подробный технический отчёт о результатах всех проверок
└── README.md                             # Настоящая инструкция по запуску и проверке
```

---

## 3. Требования к окружению

- **Node.js**: `>= 20.x`
- **Java Runtime (JRE/JDK)**: `>= 21` (требуется для `firebase-tools >= 15.x` при запуске локального `cloud-firestore-emulator.jar`)
- **Firebase CLI**: `firebase-tools` (`npm i -g firebase-tools` или через `npx firebase`)

Проверка версии Java:
```bash
java -version
# Должна быть версия openjdk 21.x или выше
```

---

## 4. Быстрый запуск аудита одной командой

Запуск эмулятора, выполнение всех 37 автоматических проверок (Environment Guard, Data Integrity, Security Rules, Indexes & Cursor Pagination, Concurrency & Chaos), повторное заполнение эталонного набора из 54 синтетических документов и сохранение нативного экспорта:

```bash
env -u FIREBASE_PRIVATE_KEY \
    -u FIREBASE_CLIENT_EMAIL \
    -u GOOGLE_APPLICATION_CREDENTIALS \
    -u FIREBASE_PROJECT_ID \
    -u TELEGRAM_BOT_TOKEN \
  firebase emulators:exec \
    --only firestore \
    --project demo-stars-shop-audit \
    --export-on-exit=./firestore-audit-package/export/native-emulator-export \
    "npx tsx firestore-audit-package/tests/runEmulatorAuditSuite.ts && npx tsx firestore-audit-package/scripts/seedSyntheticData.ts"
```

---

## 5. Пошаговый ручной запуск (в двух терминалах)

### Шаг 1. Запуск Firestore Emulator (Терминал 1)

Для чистого запуска:
```bash
firebase emulators:start --only firestore --project demo-stars-shop-audit
```

Либо с загрузкой готового нативного снимка из пакета:
```bash
firebase emulators:start \
  --only firestore \
  --project demo-stars-shop-audit \
  --import=./firestore-audit-package/export/native-emulator-export
```

### Шаг 2. Заполнение 12 синтетических сценариев (Терминал 2)

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
GCLOUD_PROJECT=demo-stars-shop-audit \
  npx tsx firestore-audit-package/scripts/seedSyntheticData.ts
```

Скрипт очистит локальный эмулятор, запишет **54 синтетических документа** в 7 коллекций (`users`, `products`, `orders`, `payments`, `transactions`, `admins`, `settings`) и обновит файл `firestore-audit-package/export/firestore-collections-dump.json`.

### Шаг 3. Запуск полного набора из 37 тестов (Терминал 2)

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
GCLOUD_PROJECT=demo-stars-shop-audit \
  npx tsx firestore-audit-package/tests/runEmulatorAuditSuite.ts
```

---

## 6. Описание 12 синтетических сценариев в дампе

| № | Сценарий | Ключевые ID документов | Назначение в аудите |
|---|---|---|---|
| 1 | Активные и скрытые товары | `prod_stars_100` .. `prod_archived_old` | Проверка фильтрации `active == true`, валидации цен и остатков (`stock`) |
| 2 | Новый пользователь | `900000101` | Базовый профиль без покупок (`balance: 0`) |
| 3 | Успешный платёж и выдача (`delivered`) | `ord_synth_001_delivered`, `pay_synth_001_succeeded` | Полный цикл XTR-оплаты, идемпотентность `chg_synth_xtr_0001`, журнал транзакций |
| 4 | Оплаченный заказ в процессе выдачи (`processing_fulfillment`) | `ord_synth_002_processing`, `pay_synth_002_succeeded` | Проверка захвата лок-поля `fulfillmentStartedAt` воркером выдачи |
| 5 | Заказ на повторной попытке (`fulfillment_NextRetryAt`) | `ord_synth_003_retry_pending`, `tx_synth_003_retry_sched` | Проверка очереди ретраев (`fulfillmentAttempts: 2`, `fulfillmentNextRetryAt`) |
| 6 | Заказ в `manual_review` / `needsManualReconciliation` | `ord_synth_004_manual_recon`, `ord_synth_008_manual_review` | Проверка ручной сверки при таймауте внешнего провайдера после списания средств |
| 7 | Истёкший / отменённый заказ (`cancelled`) | `ord_synth_005_cancelled`, `pay_synth_005_failed` | Отмена неоплаченного инвойса без создания ложной записи об успешном платеже |
| 8 | Возврат средств (`refunded`) | `ord_synth_006_refunded`, `pay_synth_006_refunded` | Сверка статуса `refunded` между заказом, платежом и записью `refund` в `transactions` |
| 9 | Покупка за внутренний баланс (`BALANCE`) | `ord_synth_007_balance_delivered`, `pay_synth_007_balance` | Проверка внутренней оплаты (`paymentMethod: 'BALANCE'`) и списания с баланса пользователя |
| 10 | Администраторы и настройки (`admins`, `settings`) | `900000901`, `900000902`, `settings/general` | Проверка RBAC (`role: 'superadmin' | 'moderator'`) и конфигурации магазина |
| 11 | Заблокированный пользователь (`isBlocked: true`) | `900000104` | Проверка сохранения истории заказов заблокированного пользователя |
| 12 | Пакет заказов с одинаковым `createdAt` | `ord_synth_009_tie_a`, `ord_synth_010_tie_b`, `ord_synth_011_tie_c` | Проверка стабильной курсорной пагинации (`startAfter(DocumentSnapshot)`) при `createdAt = 2026-11-17T10:00:00.000Z` |
