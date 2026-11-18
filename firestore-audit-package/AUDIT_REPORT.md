# ОТЧЁТ О ТЕХНИЧЕСКОМ АУДИТЕ FIRESTORE (FIREBASE EMULATOR)
## Проект: Stars Shop (`@Starsladen_bot` / `https://github.com/Vanyamujlan/Shop-Tg-bot`)

- **Дата и время выполнения аудита:** `2026-11-18T07:27:49Z`
- **Целевая среда тестирования:** Локальный **Firebase Firestore Emulator v1.22.0** (`127.0.0.1:8080`, `firebase-tools@15.34.1`, `OpenJDK 21.0.13`)
- **Изолированный проект эмулятора:** `demo-stars-shop-audit`
- **Подключение к Production Firestore (`tg-1-675b4`):** `ЗАБЛОКИРОВАНО (0 обращений)`
- **Использование реальных секретов, токенов и персональных данных:** `0 (100% синтетический набор данных)`
- **Итоговый результат тестового прогона:** **`37 / 37 PASS (0 FAIL)`**

---

## 1. Сводная статистика выполненных проверок

| Раздел аудита (Suite) | Код проверок | Выполнено тестов | Успешно (`PASS`) | Ошибок (`FAIL`) | Статус |
|---|---|---:|---:|---:|---|
| 1. Защита окружения и изоляция от Production (`Environment`) | `ENV-01` .. `ENV-04` | 4 | 4 | 0 | **PASS** |
| 2. Целостность данных и инварианты схемы (`Integrity`) | `INT-01` .. `INT-11` | 11 | 11 | 0 | **PASS** |
| 3. Правила безопасности Firestore (`SecurityRules`) | `SEC-01` .. `SEC-10` | 10 | 10 | 0 | **PASS** |
| 4. Индексы, запросы и курсорная пагинация (`IndexesQueries`) | `IDX-01` .. `IDX-06` | 6 | 6 | 0 | **PASS** |
| 5. Конкурентность, идемпотентность и отказоустойчивость (`Concurrency`) | `CON-01` .. `CON-06` | 6 | 6 | 0 | **PASS** |
| **ИТОГО** | **`37 проверок`** | **37** | **37** | **0** | **PASS** |

> Дополнительно внутри проверки `SEC-10` выполнены **12 негативных векторов атак («Dirty Dozen»)** через `@firebase/rules-unit-testing` против реального движка правил эмулятора — все `12/12` заблокированы с кодом `PERMISSION_DENIED`.

---

## 2. Детальный реестр всех 37 выполненных проверок

### Блок 1. Защита окружения и изоляция от Production (`Environment`)

| ID | Название проверки | Что проверялось | Результат | Детали выполнения |
|---|---|---|---|---|
| `ENV-01` | Блокировка при отсутствии `FIRESTORE_EMULATOR_HOST` | Проверка того, что `assertEmulatorOnlyEnvironment()` выбрасывает `ProductionGuardError`, если переменная `FIRESTORE_EMULATOR_HOST` не задана | **PASS** | Выброшен `ProductionGuardError` до инициализации SDK |
| `ENV-02` | Блокировка Production `projectId` и внешних хостов | Проверка запрета подключения к реальному проекту `tg-1-675b4`, проекту без префикса `demo-` или хосту вне `127.0.0.1` / `localhost` | **PASS** | Реальный `projectId` и внешние хосты жёстко отклонены |
| `ENV-03` | Блокировка при наличии реальных сервисных ключей в окружении | Проверка запрета запуска при наличии `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` или `GOOGLE_APPLICATION_CREDENTIALS` | **PASS** | Присутствие реальных ключей в окружении вызывает немедленный `ProductionGuardError` |
| `ENV-04` | Реальное подключение к Firebase Firestore Emulator и загрузка 12 сценариев | Инициализация `firebase-admin` поверх `127.0.0.1:8080` (`demo-stars-shop-audit`) и запись 54 синтетических документов в 7 коллекций | **PASS** | Записано 54 документа: `users` (4), `products` (6), `orders` (12), `payments` (10), `transactions` (19), `admins` (2), `settings` (1) |

### Блок 2. Проверка целостности данных (`Integrity`)

| ID | Название проверки | Что проверялось | Результат | Детали выполнения |
|---|---|---|---|---|
| `INT-01` | Ссылочная целостность платежей (`payments -> orders`) | Каждый документ в `payments` ссылается на существующий `Order` и совпадает по `telegramPaymentChargeId` | **PASS** | Проверено 10/10 документов `payments` |
| `INT-02` | Математическое совпадение сумм | Для каждого платежа и заказа выполняется `PaymentRecord.totalAmount == Order.totalPrice == Product.price * Order.quantity` | **PASS** | Проверено 10/10 платежей и 12/12 заказов |
| `INT-03` | Строгое соблюдение валюты `XTR` | Во всех финансовых документах (`products`, `orders`, `payments`, `transactions`) поле `currency === 'XTR'` | **PASS** | Проверено 47/47 финансовых документов |
| `INT-04` | Ссылочная целостность заказов (`orders -> products, users`) | Каждый заказ ссылается на существующий `Product` (`productId`) и существующего `StoreUser` (`userId` и `userTelegramId`) | **PASS** | Проверено 12/12 заказов |
| `INT-05` | Запрет завершения или перевода в `paid` без подтверждённой оплаты | Вызов `OrderService.completeOrder()` и `OrderService.markOrderPaid()` для неоплаченного заказа `ord_syn_pending_01` без записи в `payments` | **PASS** | Обе операции отклонены бизнес-логикой и транзакционной проверкой |
| `INT-06` | Запрет повторной обработки одного `telegram_payment_charge_id` | Повторный вызов `PaymentService.processSuccessfulPayment()` с уже существующим `chg_syn_completed_04` | **PASS** | Возвращён `alreadyProcessed: true`; дубликат платежа не создан, счётчики пользователя не изменены |
| `INT-07` | Запрет двойной выдачи одного заказа | Повторный вызов `OrderService.completeOrder()` и `FulfillmentService.initiateFulfillment()` для завершённого заказа `ord_syn_completed_04` | **PASS** | Возвращён `alreadyCompleted: true`; повторная выдача заблокирована |
| `INT-08` | Допустимость комбинаций статусов заказов | Проверка всех заказов на соответствие конечным автоматам `paymentStatus` (`pending`, `paid`, `completed`, `failed`, `refunded`) и `fulfillmentStatus` (`pending`, `paid`, `processing`, `completed`, `failed`, `refunded`) | **PASS** | Все 12/12 заказов находятся в валидных комбинациях статусов |
| `INT-09` | Наличие всех обязательных полей во всех 7 коллекциях | Проверка каждого из 54 документов на наличие всех обязательных полей согласно `src/types.ts` и `firebase-blueprint.json` | **PASS** | Проверено 54/54 документов — пропусков обязательных полей нет |
| `INT-10` | Строгое соответствие типов данных и дат ISO-8601 | Проверка примитивных типов (`string`, `number`, `boolean`), неотрицательных целых чисел и валидности строк ISO-8601 | **PASS** | Все поля во всех 54 документах строго типизированы |
| `INT-11` | Межколлекционная согласованность агрегатов | Сверка `user.totalOrders` и `user.totalSpentStars` с фактическими оплаченными заказами, платежами и журналом `transactions` | **PASS** | Для всех 4 пользователей агрегаты математически сходятся (`tg_900001002`: 8 заказов / 2650 XTR; `tg_900001003`: 2 заказа / 3450 XTR) |

### Блок 3. Проверка правил безопасности (`SecurityRules` через `@firebase/rules-unit-testing`)

| ID | Название проверки | Что проверялось | Результат | Детали выполнения |
|---|---|---|---|---|
| `SEC-01` | Запрет чтения чужих заказов (`get` и `list`) | Пользователь `tg_900001001` пытается прочитать заказ пользователя `tg_900001002`; пользователь `tg_900001002` читает собственный заказ | **PASS** | Чужой заказ заблокирован (`PERMISSION_DENIED`), собственный прочитан успешно |
| `SEC-02` | Запрет изменения суммы заказа и занижения цены при создании | Попытка изменить `totalPrice` существующего заказа или создать заказ, где `totalPrice != product.price * quantity` | **PASS** | Обе атаки заблокированы правилом сверки цены с `/products/$(request.resource.data.productId)` |
| `SEC-03` | Запрет самостоятельного подтверждения оплаты | Попытка покупателя создать заказ сразу со статусом `paymentStatus: 'paid'` или обновить `pending -> paid` | **PASS** | Заблокировано (`PERMISSION_DENIED`) |
| `SEC-04` | Запрет подмены статуса выдачи на `processing` или `completed` | Попытка покупателя перевести свой заказ в `processing`/`completed`; проверка легитимной отмены собственного неоплаченного (`pending`) заказа | **PASS** | Подмена статуса выдачи заблокирована; отмена собственного `pending`-заказа разрешена |
| `SEC-05` | Защита каталога товаров (`products`) | Попытка покупателя создать/изменить/удалить товар или прочитать скрытый товар (`isActive: false`) | **PASS** | Запись и чтение скрытых товаров для обычного пользователя заблокированы (`PERMISSION_DENIED`) |
| `SEC-06` | Запрет повышения привилегий (`admins`) и саморазблокировки (`users.isBlocked`) | Попытка обычного пользователя добавить себя в `/admins`, прочитать список админов, сбросить `isBlocked: false` или накрутить `totalSpentStars` | **PASS** | Все попытки повышения привилегий и обхода блокировки отклонены (`PERMISSION_DENIED`) |
| `SEC-07` | Защита коллекции `payments` и append-only аудит | Попытка чтения чужого платежа, создания фальшивого платежа клиентом или удаления платежа (даже администратором) | **PASS** | Чужие платежи и клиентская запись запрещены; `allow delete: if false` гарантирует неизменяемость финансового архива |
| `SEC-08` | Полная матрица доступа ко всем 7 коллекциям без захардкоженных email | Проверка доступа неавторизованного гостя, покупателя и администратора (через документ `/admins/{uid}` и через Custom Claim `admin: true`) | **PASS** | RBAC работает исключительно через `/admins/$(request.auth.uid)` и Custom Claims; личные email полностью отсутствуют |
| `SEC-09` | Валидация новых полей `Order` и новых типов `StoreTransaction` | Проверка записи через правила безопасности полей `fulfillmentStartedAt`, `fulfillmentAttempts`, `fulfillmentLastError`, `fulfillmentNextRetryAt`, `fulfillmentIdempotencyKey`, `externalExecutionReference`, `needsManualReconciliation`, `adminNotifiedAt`, `buyerNotifiedAt` и транзакций `fulfillment_failed`, `fulfillment_retry`, `admin_action` | **PASS** | Все новые поля и типы транзакций из `src/types.ts` проходят валидацию `firestore.rules` |
| `SEC-10` | Прогон 12 атакующих векторов («Dirty Dozen») | Реальный прогон всех 12 эксплойт-пейлоадов из `firestore.rules.test.ts` через движок правил эмулятора | **PASS** | `12 / 12` атакующих запросов заблокированы с `PERMISSION_DENIED` |

### Блок 4. Проверка индексов, серверных запросов и пагинации (`IndexesQueries`)

| ID | Название проверки | Что проверялось | Результат | Детали выполнения |
|---|---|---|---|---|
| `IDX-01` | Сверка всех 10 составных индексов в `firestore.indexes.json` | Проверка наличия и точного совпадения полей/направлений всех 10 Composite Indexes с запросами в коде | **PASS** | Все 10 индексов (`orders`: 5, `products`: 3, `payments`: 1, `transactions`: 1) полностью покрывают запросы |
| `IDX-02` | Выполнение всех 5 индексированных запросов к `orders` через Emulator | Реальный прогон запросов по `userId`, `userTelegramId`, `paymentStatus`, `fulfillmentStatus (DESC)` и `fulfillmentStatus (ASC)` | **PASS** | Все 5 запросов вернули точные выборки в правильном порядке |
| `IDX-03` | Выполнение 5 индексированных запросов к `products`, `payments`, `transactions` | Реальный прогон фильтрации активных/всех товаров по категориям и цене, платежей по статусу и транзакций по типу | **PASS** | Все 5 запросов выполнены без ошибок |
| `IDX-04` | Курсорная пагинация (`startAfter`) при одинаковых `createdAt` | Постраничный обход (`limit: 2`) всех 10 заказов пользователя `tg_900001002`, включая 3 заказа с идентичным `createdAt = '2026-11-17T10:00:00.000Z'` (`ord_syn_same_ts_10`, `ord_syn_same_ts_11`, `ord_syn_same_ts_12`) | **PASS** | За 5 страниц возвращены ровно `10/10` уникальных заказов, включая все 3 заказа с одинаковым timestamp — без единого пропуска или дубля |
| `IDX-05` | Корректность сортировки (`ASC`/`DESC`) и фильтрации в сервисах | Проверка монотонного убывания `createdAt` в `OrderService.getAllOrders()` и возрастания `price` в `ProductService.getAllProducts()` | **PASS** | Сортировка и фильтрация работают детерминированно |
| `IDX-06` | Анализ потенциально опасных запросов для Production Firestore | Статический и динамический аудит всех вызовов `queryDocs` / `queryDocsPaginated` на предмет `FAILED_PRECONDITION` в Production | **PASS** | Опасных запросов (неравенства на разных полях, сортировка без индекса, скалярный `startAfter` без tie-breaker) не обнаружено |

### Блок 5. Проверка конкурентных операций и аварийных сценариев (`Concurrency`)

| ID | Название проверки | Что проверялось | Результат | Детали выполнения |
|---|---|---|---|---|
| `CON-01` | Два одновременных `successful_payment` на один заказ | Параллельный запуск `Promise.all` двух транзакций `PaymentService.processSuccessfulPayment` для одного заказа в Emulator | **PASS** | Транзакция Firestore сериализовала гонку: создан ровно 1 `PaymentRecord`, `totalOrders` увеличен ровно на `+1` |
| `CON-02` | Два одновременных воркера выдачи (`initiateFulfillment`) на один заказ | Параллельный запуск двух воркеров выдачи на один оплаченный заказ в Emulator | **PASS** | Атомарный pre-claim (`fulfillmentStatus: 'processing'`) в транзакции гарантировал ровно 1 вызов внешнего адаптера (`externalAdapterCalls = 1`) |
| `CON-03` | Повторное выполнение уже выданного заказа под параллельной нагрузкой | Одновременный вызов `completeOrder` и `initiateFulfillment` для уже завершённого заказа | **PASS** | 0 повторных выдач и 0 дублирующихся уведомлений |
| `CON-04` | Перезапуск сервера во время выдачи и сверка через `checkExternalStatus` | Имитация падения процесса после захвата заказа в `processing` (истёкший lease) с последующим запуском `recoverStuckOrders` | **PASS** | Воркер восстановления вызвал `checkExternalStatus`, обнаружил факт выполнения на стороне провайдера и завершил заказ без повторного списания/выдачи |
| `CON-05` | Потеря ответа от неидемпотентного поставщика (карантин `needsManualReconciliation`) | Имитация обрыва сети во время вызова неидемпотентного поставщика, не поддерживающего проверку статуса | **PASS** | Заказ автоматически переведён в карантин ручной сверки (`needsManualReconciliation: true`), повторный небезопасный вызов заблокирован (`unsafeCalls = 0`) |
| `CON-06` | Временная недоступность Firestore и последующее восстановление | Имитация сбоя БД (`StorageUnavailableError`) при создании заказа и `pre_checkout_query`, затем восстановление работы | **PASS** | Во время сбоя операции безопасно отклоняются (без списания Stars), а после восстановления все заказы в эмуляторе полностью сохранены |

---

## 3. Обнаруженные и исправленные в ходе подготовки аудита проблемы

### Исправлено 1: Рассинхронизация `firestore.rules` и `firebase-blueprint.json` с актуальным `src/types.ts`
- **Что было обнаружено:** В исходном файле `firestore.rules` отсутствовали 9 полей жизненного цикла выдачи, ретраев и ручной сверки (`fulfillmentStartedAt`, `fulfillmentAttempts`, `fulfillmentLastError`, `fulfillmentNextRetryAt`, `fulfillmentIdempotencyKey`, `externalExecutionReference`, `needsManualReconciliation`, `adminNotifiedAt`, `buyerNotifiedAt`), добавленных в `Order`, а также 3 новых типа транзакций (`fulfillment_failed`, `fulfillment_retry`, `admin_action`) в `StoreTransaction`. Кроме того, правила проверяли только тип `timestamp`, тогда как сервер и модели используют строки ISO-8601.
- **Что исправлено:** Файлы `/firestore.rules`, `/DRAFT_firestore.rules`, `/firebase-blueprint.json` и `/firestore-audit-package/firestore.rules` полностью синхронизированы с `src/types.ts`. Добавлена функция `isValidDateVal()`, поддерживающая как `timestamp`, так и валидные строки ISO-8601, а также проверка `totalPrice == product.price * quantity` при клиентском создании заказа.

### Исправлено 2: Наличие реального email в функции `isAdmin()` в `firestore.rules`
- **Что было обнаружено:** В `firestore.rules`, `DRAFT_firestore.rules`, `security_spec.md` и `firestore.rules.test.ts` присутствовал реальный персональный email разработчика.
- **Что исправлено:** Персональный email полностью удалён из всех файлов правил, спецификаций и тестов. Проверка прав администратора в `isAdmin()` теперь опирается исключительно на существование документа `/databases/$(database)/documents/admins/$(request.auth.uid)` и Custom Claim `request.auth.token.admin == true`.

### Исправлено 3: Пропуск документов при курсорной пагинации (`startAfter`) для заказов с одинаковым `createdAt`
- **Что было обнаружено:** В `FirestoreRepository.queryDocs()` (`src/db/firestore.ts`) при передаче курсора `{ value, id }` в запрос Firestore передавалось только скалярное значение `query.startAfter(cursorVal)`. Если несколько заказов имели одинаковую метку времени `createdAt` (например, `2026-11-17T10:00:00.000Z`), Firestore пропускал оставшиеся документы с этой же меткой времени при переходе на следующую страницу. Также в `applyInMemorySortAndCursorPagination` вторичная сортировка по ключу `id` не умножалась на `factor` направления сортировки.
- **Что исправлено:** В `FirestoreRepository.queryDocs()` реализовано получение `DocumentSnapshot` по `cursorId` (`this.adminDb.collection(collectionName).doc(cursorId).get()`) и передача `query.startAfter(cursorSnap)`. Это задействует встроенный tie-breaker Firestore `(__name__)` без необходимости менять составные индексы. В `applyInMemorySortAndCursorPagination` вторичное сравнение по `primaryKey` теперь учитывает `factor`. Проверено тестом `IDX-04` на 3 заказах с идентичным `createdAt = '2026-11-17T10:00:00.000Z'`.

### Исправлено 4: Добавлен жёсткий барьер `ProductionGuard` для защиты от случайного запуска тестов на Production
- **Что было добавлено:** В `src/db/firestore.ts` добавлены `ProductionGuardError`, `assertEmulatorOnlyEnvironment()` и `firestoreRepo.initWithEmulator()`, гарантирующие, что любые скрипты сидинга и аудита могут выполняться только при локальном `FIRESTORE_EMULATOR_HOST`, `projectId` с префиксом `demo-` и полном отсутствии реальных сервисных ключей в окружении.

---

## 4. Ограничения эмулятора: что НЕ может быть подтверждено только локальным Firebase Emulator

> **ВАЖНОЕ ПРЕДУПРЕЖДЕНИЕ:** Прохождение всех 37/37 тестов на локальном Firebase Firestore Emulator подтверждает корректность схемы данных, бизнес-логики, правил безопасности и транзакционной идемпотентности в коде, но **само по себе НЕ означает автоматическую готовность Production Firestore без проверки облачной инфраструктуры.**

Ниже перечислены аспекты, которые отличаются между локальным Firestore Emulator и реальным Production Cloud Firestore:

1. **Физическое наличие построенных Composite Indexes в Production Firestore:**
   - Локальный Firestore Emulator выполняет любые составные запросы (`where` + `orderBy`) без выброса `FAILED_PRECONDITION`, даже если индекс ещё не построен в облаке.
   - В рамках аудита (`IDX-01`, `IDX-06`) статически и структурно доказано, что все 10 составных индексов в `firestore.indexes.json` покрывают 100% запросов приложения. Однако перед запуском в Production необходимо убедиться, что все 10 индексов из `firestore.indexes.json` реально развёрнуты (`firebase deploy --only firestore:indexes`) и находятся в статусе `READY` в Google Cloud Console.
2. **Лимиты числа вычислений выражений в `firestore.rules` при каскадных `get()` / `exists()`:**
   - При выполнении стресс-теста `SEC-10` («Dirty Dozen») на объёмных невалидных пейлоадах эмулятор зафиксировал предупреждение `Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached` (запрос при этом безопасно отклоняется с `PERMISSION_DENIED`, то есть система работает в режиме fail-closed). В Production серверный бот работает через `firebase-admin` (обходя клиентские правила), но при возможном подключении веб-клиента правила рекомендуется поддерживать компактными.
3. **IAM-права сервисного аккаунта и сетевые квоты GCP:**
   - Эмулятор не проверяет валидность реального сервисного аккаунта (`roles/datastore.user`), лимиты пропускной способности сети Cloud Run <-> Firestore и задержки межрегиональной репликации.
4. **Реальный вебхук и платёжный шлюз Telegram Bot API (`XTR`):**
   - В эмуляторе тестируется серверная обработка `pre_checkout_query` и `successful_payment` на синтетических данных; реальное списание Telegram Stars проверяется только через инфраструктуру Telegram.
