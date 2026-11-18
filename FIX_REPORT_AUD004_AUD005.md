# Отчёт о выполненной работе по исправлению проблем AUD-004 и AUD-005

**Дата выполнения:** 2026-11-18  
**Затронутые задачи аудита:**
- **`AUD-004` (`HIGH`)** — Двухэтапное подтверждение возврата Telegram Stars (`refundStarPayment`) с предупреждением для уже выполненных заказов, защита от повторного возврата и конкурентных запросов, а также серверный запрет отмены уже оплаченных заказов (`adm:ord_cancel` / `ucancel`).
- **`AUD-005` (`HIGH`)** — Серверный и UI-запрет перевода неоплаченных (`pending`), отменённых (`cancelled`) или возвращённых (`refunded`) заказов в статус обработки (`processing`) или выдачи (`completed`), а также запрет отката выполненного заказа (`completed`) обратно в `processing`.

---

## 1. Список всех изменённых файлов

1. `src/services/OrderService.ts` — серверная транзакционная валидация переходов статусов оплаты и выдачи в `OrderService.updateOrderStatus()`.
2. `src/services/PaymentService.ts` — метод `PaymentService.executeOrderRefund()` с защитой от конкурентных запросов (`activeRefundLocks`), проверкой статуса оплаты и идемпотентным `PaymentService.markPaymentRefunded()`.
3. `src/bot/keyboards.ts` — фильтрация кнопок управления заказом в `buildAdminOrderActionKeyboard()` и новая клавиатура второго шага подтверждения возврата `buildAdminOrderRefundConfirmKeyboard()`.
4. `src/bot/handlers/adminHandler.ts` — двухэтапный возврат (`adm:ord_refund` -> `adm:ord_refund_confirm`) и серверные проверки статусов перед `adm:ord_proc`, `adm:ord_note` и `adm:ord_cancel`.
5. `src/bot/handlers/userHandler.ts` — транзакционная защита обработчика пользовательской отмены заказа `ucancel:<orderId>`.
6. `src/tests/stage1.test.ts` — добавлены 4 автоматических теста (`A-01`, `A-02`, `A-03`, `A-04`), проверяющих все аспекты `AUD-004` и `AUD-005`.

---

## 2. Конкретные изменения и номера строк по каждому файлу

| Файл | Номера строк | Описание изменений |
| :--- | :--- | :--- |
| `src/services/OrderService.ts` | Строки `209–299` | В `OrderService.updateOrderStatus()` добавлен запрет прямого перевода в `refunded` в обход `PaymentService.markPaymentRefunded`, транзакционная проверка `existing.paymentStatus === 'pending'` перед отменой (`cancelled`), проверка подтверждённой оплаты перед переводом в `processing` / `completed` и запрет отката `completed -> processing`. |
| `src/services/PaymentService.ts` | Строки `330–494` | Добавлен `activeRefundLocks` (`Set<string>`), метод `isRefundInProgress(orderId)`, метод `executeOrderRefund(...)` с in-flight блокировкой и проверкой статуса оплаты/платежа перед вызовом `refundStarPayment`, а также ужесточена транзакция `markPaymentRefunded()`. |
| `src/bot/keyboards.ts` | Строки `193–285` | В `buildAdminOrderActionKeyboard()` кнопки `adm:ord_proc`, `adm:ord_done`, `adm:ord_note` отображаются только для оплаченных и ещё не завершённых заказов; кнопка `adm:ord_refund` — только для оплаченных заказов с `telegramPaymentChargeId`; кнопка `adm:ord_cancel` — только при `paymentStatus === 'pending' && fulfillmentStatus === 'pending'`. Добавлена функция `buildAdminOrderRefundConfirmKeyboard()` (строки `270–285`). |
| `src/bot/handlers/adminHandler.ts` | Строки `16–27`, `235–637` | Импортирована `buildAdminOrderRefundConfirmKeyboard`; добавлены серверные проверки статуса оплаты в `adm:ord_proc` (строки `236–310`), `adm:ord_note` (строки `344–411`) и `adm:ord_cancel` (строки `585–637`); `adm:ord_refund` переведён на показ экрана подтверждения (строки `440–513`), а реальный вызов `refundStarPayment` вынесен в `adm:ord_refund_confirm` (строки `516–582`). |
| `src/bot/handlers/userHandler.ts` | Строки `362–404` | В `ucancel:<orderId>` добавлена проверка `order.fulfillmentStatus !== 'pending'`, обновление карточки при отказе и блок `try / catch` вокруг `OrderService.updateOrderStatus()`. |
| `src/tests/stage1.test.ts` | Строки `24–29`, `1079–1365` | Импортированы клавиатуры админки и добавлены 4 интеграционных автотеста `A-01`, `A-02`, `A-03`, `A-04`. |

---

## 3. Сравнение старой и новой логики исправленных участков кода

### 3.1. `src/services/OrderService.ts` (`updateOrderStatus`, строки `209–299`)

**Старая логика:**
```ts
  public static async updateOrderStatus(params: {
    orderId: string;
    paymentStatus?: OrderStatus;
    fulfillmentStatus?: OrderStatus;
    fulfillmentNote?: string;
  }): Promise<Order | null> {
    if (params.paymentStatus === 'paid' || params.fulfillmentStatus === 'paid') {
      throw new Error(
        'Перевод заказа в статус paid разрешён только через PaymentService.processSuccessfulPayment.',
      );
    }

    return firestoreRepo.runTransaction(async (tx) => {
      const existing = await tx.get<Order>('orders', params.orderId);
      if (!existing) return null;

      const now = new Date().toISOString();
      const nextFulfillment = params.fulfillmentStatus ?? existing.fulfillmentStatus;
      const nextPayment = params.paymentStatus ?? existing.paymentStatus;

      const updated: Order = {
        ...existing,
        paymentStatus: nextPayment,
        fulfillmentStatus: nextFulfillment,
        // ...
```

**Новая логика:**
```ts
  public static async updateOrderStatus(params: {
    orderId: string;
    paymentStatus?: OrderStatus;
    fulfillmentStatus?: OrderStatus;
    fulfillmentNote?: string;
  }): Promise<Order | null> {
    if (params.paymentStatus === 'paid' || params.fulfillmentStatus === 'paid') {
      throw new Error(
        'Перевод заказа в статус paid разрешён только через PaymentService.processSuccessfulPayment.',
      );
    }

    if (
      params.paymentStatus === 'refunded' ||
      params.fulfillmentStatus === 'refunded'
    ) {
      throw new Error(
        'Перевод заказа в статус refunded разрешён только через PaymentService.markPaymentRefunded.',
      );
    }

    return firestoreRepo.runTransaction(async (tx) => {
      const existing = await tx.get<Order>('orders', params.orderId);
      if (!existing) return null;

      const now = new Date().toISOString();
      const nextFulfillment = params.fulfillmentStatus ?? existing.fulfillmentStatus;
      const nextPayment = params.paymentStatus ?? existing.paymentStatus;

      // AUD-004: Запрет отмены уже оплаченного, выданного или возвращённого заказа
      if (nextPayment === 'cancelled' || nextFulfillment === 'cancelled') {
        if (
          existing.paymentStatus !== 'pending' &&
          existing.paymentStatus !== 'cancelled'
        ) {
          throw new Error(
            `Невозможно отменить заказ #${existing.orderId}: заказ уже имеет статус оплаты "${existing.paymentStatus}".`,
          );
        }
        if (
          existing.fulfillmentStatus !== 'pending' &&
          existing.fulfillmentStatus !== 'cancelled'
        ) {
          throw new Error(
            `Невозможно отменить заказ #${existing.orderId}: статус выдачи уже "${existing.fulfillmentStatus}".`,
          );
        }
      }

      // AUD-005: Запрет перевода неоплаченного, отменённого или возвращённого заказа в обработку или выдачу
      if (nextFulfillment === 'processing' || nextFulfillment === 'completed') {
        const hasConfirmedPayment =
          existing.paymentStatus === 'paid' ||
          existing.paymentStatus === 'processing' ||
          existing.paymentStatus === 'completed';

        if (!hasConfirmedPayment) {
          throw new Error(
            `Невозможно перевести заказ #${existing.orderId} в статус "${nextFulfillment}": заказ не оплачен (статус оплаты: "${existing.paymentStatus}").`,
          );
        }

        if (
          existing.fulfillmentStatus === 'completed' &&
          nextFulfillment === 'processing'
        ) {
          throw new Error(
            `Невозможно вернуть уже выполненный заказ #${existing.orderId} обратно в обработку ("processing").`,
          );
        }
      }
```

---

### 3.2. `src/bot/keyboards.ts` (`buildAdminOrderActionKeyboard`, строки `193–285`)

**Старая логика:**
```ts
  if (order.fulfillmentStatus !== 'completed' && order.paymentStatus !== 'refunded') {
    rows.push([
      Markup.button.callback(
        '🔄 Взять в обработку',
        `adm:ord_proc:${order.orderId}`,
      ),
      Markup.button.callback(
        '✅ Подтвердить выдачу',
        `adm:ord_done:${order.orderId}`,
      ),
    ]);
    rows.push([
      Markup.button.callback(
        '📝 Выдать с кодом / сообщением',
        `adm:ord_note:${order.orderId}`,
      ),
    ]);
  }
```

**Новая логика:**
```ts
  // AUD-005: Кнопки обработки и выдачи доступны ТОЛЬКО для оплаченных заказов
  const isPaidForFulfillment =
    order.paymentStatus === 'paid' || order.paymentStatus === 'processing';

  if (
    isPaidForFulfillment &&
    order.fulfillmentStatus !== 'completed' &&
    order.fulfillmentStatus !== 'refunded' &&
    order.fulfillmentStatus !== 'cancelled'
  ) {
    const actionRow = [];
    if (order.fulfillmentStatus !== 'processing') {
      actionRow.push(
        Markup.button.callback(
          '🔄 Взять в обработку',
          `adm:ord_proc:${order.orderId}`,
        ),
      );
    }
    actionRow.push(
      Markup.button.callback(
        '✅ Подтвердить выдачу',
        `adm:ord_done:${order.orderId}`,
      ),
    );
    rows.push(actionRow);
    rows.push([
      Markup.button.callback(
        '📝 Выдать с кодом / сообщением',
        `adm:ord_note:${order.orderId}`,
      ),
    ]);
  }
```

---

## 4. Реализация двухэтапного подтверждения возврата (`AUD-004`)

### Шаг 1 (`adm:ord_refund:<orderId>` — `src/bot/handlers/adminHandler.ts:440–513`):
При нажатии на кнопку `↩️ Возврат Stars (refundStarPayment)` возврат **не выполняется сразу**. Вместо этого:
1. Проверяется наличие `telegramPaymentChargeId`, отсутствие статуса `refunded`, допустимость статуса оплаты (`paid | processing | completed`) и отсутствие уже идущего возврата (`PaymentService.isRefundInProgress(orderId)`).
2. Если заказ уже был выдан покупателю (`order.fulfillmentStatus === 'completed'`), выводится предупреждение:
   `🚨 ВНИМАНИЕ: Заказ уже ВЫПОЛНЕН (товар был выдан покупателю)! Если вы подтвердите возврат, покупатель получит Stars обратно, сохранив выданный товар.`
3. Отображается клавиатура `buildAdminOrderRefundConfirmKeyboard(order)` (`src/bot/keyboards.ts:270–285`):
   - `✅ Да, вернуть <N> ⭐ покупателю` -> `adm:ord_refund_confirm:<orderId>`
   - `❌ Отмена (вернуться к заказу)` -> `adm:ord:<orderId>`

### Шаг 2 (`adm:ord_refund_confirm:<orderId>` — `src/bot/handlers/adminHandler.ts:516–582`):
Только при явном нажатии кнопки подтверждения вызывается `PaymentService.executeOrderRefund(...)`, который выполняет `refundStarPayment`, атомарно обновляет БД через `PaymentService.markPaymentRefunded()`, записывает аудит администратора и отправляет уведомление покупателю.

---

## 5. Серверные проверки статусов оплаты перед отменой и обработкой заказа (`AUD-004` и `AUD-005`)

1. **Перед отменой заказа (`adm:ord_cancel` в `src/bot/handlers/adminHandler.ts:585–637`, `ucancel` в `src/bot/handlers/userHandler.ts:362–404` и внутри транзакции `OrderService.updateOrderStatus` в `src/services/OrderService.ts:231–248`):**
   - Проверяется `existing.paymentStatus === 'pending' && existing.fulfillmentStatus === 'pending'`.
   - Если заказ уже оплачен (`paid`), находится в обработке (`processing`), выполнен (`completed`) или возвращён (`refunded`), отмена отклоняется как на уровне обработчика (с обновлением устаревшей клавиатуры), так и внутри транзакции Firestore.
2. **Перед переводом в обработку или выдачей (`adm:ord_proc` в `src/bot/handlers/adminHandler.ts:236–310`, `adm:ord_note` в `src/bot/handlers/adminHandler.ts:344–411` и внутри транзакции `OrderService.updateOrderStatus` в `src/services/OrderService.ts:251–271`):**
   - Проверяется, что заказ имеет подтверждённую оплату (`paymentStatus === 'paid' || paymentStatus === 'processing'`).
   - Неоплаченные (`pending`), отменённые (`cancelled`) и возвращённые (`refunded`) заказы блокируются.
   - Уже выполненный заказ (`fulfillmentStatus === 'completed'`) не может быть откачен обратно в `processing`.

---

## 6. Защита от повторного возврата и одновременных запросов (`src/services/PaymentService.ts:330–494`)

1. **In-flight блокировка параллельных запросов (`activeRefundLocks`):**
   - Статический `Set<string>` `PaymentService.activeRefundLocks` блокирует параллельные вызовы `executeOrderRefund` для одного `orderId` до завершения текущего запроса к Telegram API (`refundStarPayment`) и коммита в Firestore.
   - Любой конкурентный запрос во время выполнения первого немедленно получает ошибку: `Возврат по заказу #<orderId> уже выполняется параллельным запросом.`
   - Блокировка гарантированно снимается в блоке `finally`.
2. **Защита от повторного возврата (Idempotency):**
   - Перед вызовом Telegram API проверяются `order.paymentStatus === 'refunded'`, `order.fulfillmentStatus === 'refunded'` и статус документа `payments/pay_<chargeId>` (`existingPayment?.status === 'refunded'`).
   - Внутри транзакции `PaymentService.markPaymentRefunded()` повторный вызов для уже возвращённого заказа возвращает текущий объект заказа без повторной записи в коллекцию `transactions`.

---

## 7. Добавленные тесты и результаты их выполнения (`src/tests/stage1.test.ts:1079–1365`)

В набор `src/tests/stage1.test.ts` добавлены 4 новых автотеста:
- **`A-01` (`Fulfillment`)** — `AUD-005: Запрет перевода неоплаченного заказа в processing/completed и фильтрация кнопок админ-клавиатуры`: проверяет отсутствие кнопок выдачи/возврата у `pending`-заказа и блокировку переходов `pending -> processing` и `pending -> completed` в `OrderService.updateOrderStatus`.
- **`A-02` (`Security`)** — `AUD-004: Серверный запрет отмены уже оплаченного или выданного заказа и запрет отката completed -> processing`: проверяет отклонение `OrderService.updateOrderStatus({ paymentStatus: 'cancelled' })` после оплаты и запрет возврата `completed -> processing`.
- **`A-03` (`Payments`)** — `AUD-004: Двухэтапное подтверждение возврата (клавиатура шага 2 и запрет возврата неоплаченных/отменённых заказов)`: проверяет генерацию `buildAdminOrderRefundConfirmKeyboard` (`adm:ord_refund_confirm:<id>`) и блокировку возврата неоплаченных/отменённых заказов.
- **`A-04` (`Payments`)** — `AUD-004: Защита от повторного возврата и конкурентных запросов refundStarPayment`: запускает 4 одновременных вызова `PaymentService.executeOrderRefund` и проверяет, что `callTelegramRefund` вызывается ровно **1 раз**, 3 параллельных запроса отклоняются in-flight блокировкой, а последующий вызов возвращает `alreadyRefunded: true` без повторного обращения к Telegram API.

---

## 8. Результаты выполнения тестов, ESLint и TypeScript

- **`npm test`**: `29/29 PASS` (включая `A-01`, `A-02`, `A-03`, `A-04`), exit code `0`.
- **`npm run lint` (`eslint . && tsc --noEmit`)**: `0 ошибок`, exit code `0`.
- **`npx tsc --noEmit`**: `0 ошибок`, exit code `0`.
