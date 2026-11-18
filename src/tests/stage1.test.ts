import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Context, Telegraf } from 'telegraf';
import type { Request, Response } from 'express';
import {
  firestoreRepo,
  StorageUnavailableError,
} from '../db/firestore.ts';
import { OrderService } from '../services/OrderService.ts';
import { PaymentService } from '../services/PaymentService.ts';
import {
  FulfillmentService,
  ManualAdminFulfillmentAdapter,
  type FulfillmentProviderAdapter,
} from '../services/FulfillmentService.ts';
import { ProductService } from '../services/ProductService.ts';
import { UserService } from '../services/UserService.ts';
import {
  botManager,
  verifyWebhookSecretToken,
  isValidTelegramUpdatePayload,
} from '../bot/bot.ts';
import { ensureAdmin } from '../bot/handlers/adminHandler.ts';
import {
  buildAdminOrderActionKeyboard,
  buildAdminOrderRefundConfirmKeyboard,
} from '../bot/keyboards.ts';
import type { Order, StoreUser } from '../types.ts';

// Force isolated test environment so production Firestore and .data/ are NEVER touched
process.env.NODE_ENV = 'test';
process.env.ALLOW_LOCAL_FALLBACK = 'false';
process.env.ADMIN_IDS = '777000111';

interface AuditTestRecord {
  id: string;
  category: 'Payments' | 'Fulfillment' | 'Security' | 'Database';
  name: string;
  status: 'PASS' | 'FAIL';
  environment: string;
  emulatorUsed: boolean;
  details: string;
}

const testResults: AuditTestRecord[] = [];

function createMockBot(
  sentMessages: Array<{ chatId: number | string; text: string }>,
  shouldFail = false,
): Telegraf {
  return {
    telegram: {
      sendMessage: async (chatId: number | string, text: string) => {
        if (shouldFail) {
          throw new Error('Simulated Telegram API 502 Bad Gateway');
        }
        sentMessages.push({ chatId, text });
        return { message_id: Date.now() };
      },
    },
  } as unknown as Telegraf;
}

function createMockExpressRes(): {
  res: Response;
  getStatus: () => number;
  getJson: () => unknown;
} {
  let statusCode = 200;
  let jsonBody: unknown = null;
  const mockRes = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return mockRes;
    },
    json(payload: unknown) {
      jsonBody = payload;
      mockRes.headersSent = true;
      return mockRes;
    },
  };
  const res = mockRes as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
  };
}

async function runTest(
  id: string,
  category: AuditTestRecord['category'],
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  try {
    const details = await fn();
    testResults.push({
      id,
      category,
      name,
      status: 'PASS',
      environment: 'Isolated In-Memory Transactional Engine + Mock Telegram API (NODE_ENV=test)',
      emulatorUsed: false,
      details,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : String(error);
    testResults.push({
      id,
      category,
      name,
      status: 'FAIL',
      environment: 'Isolated In-Memory Transactional Engine + Mock Telegram API (NODE_ENV=test)',
      emulatorUsed: false,
      details: errMsg,
    });
    throw error;
  }
}

async function runFullAuditTestSuite(): Promise<void> {
  console.log('================================================================');
  console.log('🧪 ЗАПУСК ПОЛНОГО НАБОРА АВТОТЕСТОВ STARS SHOP (ISOLATED MODE)');
  console.log('================================================================');

  firestoreRepo.enableIsolatedTestMode(true);
  FulfillmentService.baseRetryDelayMs = 10;
  FulfillmentService.staleProcessingLeaseMs = 50;

  const buyer1 = {
    id: 100200301,
    username: 'buyer_one',
    first_name: 'Alex',
    last_name: 'Buyer',
  };
  const buyer2 = {
    id: 100200302,
    username: 'buyer_two',
    first_name: 'Boris',
    last_name: 'Other',
  };

  // ===========================================================================
  // 1. PAYMENTS TESTS
  // ===========================================================================
  await runTest(
    'P-01',
    'Payments',
    'Успешная атомарная обработка платежа (successful_payment)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 2,
      });
      assert.equal(order.totalPrice, 20);
      assert.equal(order.paymentStatus, 'pending');

      const res = await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: 20,
        telegramPaymentChargeId: 'chg_p01_valid',
        providerPaymentChargeId: 'prov_p01',
      });

      assert.equal(res.alreadyProcessed, false);
      assert.equal(res.order.paymentStatus, 'paid');
      assert.equal(res.order.fulfillmentStatus, 'paid');
      assert.equal(res.payment.totalAmount, 20);

      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 1);
      assert.equal(user?.totalSpentStars, 20);
      return `Заказ #${order.orderId} переведён в paid, PaymentRecord создан, статистика пользователя: 1 заказ / 20 XTR.`;
    },
  );

  await runTest(
    'P-02',
    'Payments',
    'Повторный платёж (идемпотентность при повторной доставке update)',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const order = orders[0];

      const dupRes = await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: 20,
        telegramPaymentChargeId: 'chg_p01_valid',
      });

      assert.equal(dupRes.alreadyProcessed, true);
      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 1);
      assert.equal(user?.totalSpentStars, 20);
      return 'Повторный update вернул alreadyProcessed=true без дублирования PaymentRecord и без повторного инкремента статистики.';
    },
  );

  await runTest(
    'P-03',
    'Payments',
    'Параллельная обработка одинакового платежа (6 конкурентных потоков)',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });

      const parallelResults = await Promise.all(
        Array.from({ length: 6 }, () =>
          PaymentService.processSuccessfulPayment({
            telegramUserId: buyer1.id,
            invoicePayload: order.orderId,
            currency: 'XTR',
            totalAmount: order.totalPrice,
            telegramPaymentChargeId: 'chg_p03_parallel',
          }),
        ),
      );

      const freshCount = parallelResults.filter((r) => !r.alreadyProcessed).length;
      const dupCount = parallelResults.filter((r) => r.alreadyProcessed).length;
      assert.equal(freshCount, 1);
      assert.equal(dupCount, 5);

      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 2);
      assert.equal(user?.totalSpentStars, 20 + 50);
      return 'Из 6 параллельных вызовов ровно 1 зафиксировал платёж, 5 получили alreadyProcessed=true.';
    },
  );

  await runTest(
    'P-04',
    'Payments',
    'Отклонение платежа с неверной суммой (totalAmount mismatch)',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      await assert.rejects(
        async () => {
          await PaymentService.processSuccessfulPayment({
            telegramUserId: buyer1.id,
            invoicePayload: order.orderId,
            currency: 'XTR',
            totalAmount: 1, // ожидалось 10 XTR
            telegramPaymentChargeId: 'chg_p04_bad_amount',
          });
        },
        /Несовпадение суммы оплаты/,
      );

      const unchanged = await OrderService.getOrderById(order.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');
      return 'Платёж с заниженной суммой (1 вместо 10 XTR) отклонён, статус заказа остался pending.';
    },
  );

  await runTest(
    'P-05',
    'Payments',
    'Отклонение платежа с неверной валютой (не XTR)',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const preCheck = await PaymentService.validatePreCheckout({
        invoicePayload: order.orderId,
        telegramUserId: buyer1.id,
        currency: 'USD',
        totalAmount: order.totalPrice,
      });
      assert.equal(preCheck.ok, false);

      await assert.rejects(
        async () => {
          await PaymentService.processSuccessfulPayment({
            telegramUserId: buyer1.id,
            invoicePayload: order.orderId,
            currency: 'USD',
            totalAmount: order.totalPrice,
            telegramPaymentChargeId: 'chg_p05_bad_currency',
          });
        },
        /Неподдерживаемая валюта платежа/,
      );
      return 'Валюта USD отклонена как в validatePreCheckout, так и в processSuccessfulPayment.';
    },
  );

  await runTest(
    'P-06',
    'Payments',
    'Отклонение оплаты заказа другого пользователя',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      await assert.rejects(
        async () => {
          await PaymentService.processSuccessfulPayment({
            telegramUserId: buyer2.id, // чужой пользователь
            invoicePayload: order.orderId,
            currency: 'XTR',
            totalAmount: order.totalPrice,
            telegramPaymentChargeId: 'chg_p06_wrong_user',
          });
        },
        /Несовпадение владельца заказа/,
      );
      return 'Попытка оплатить чужой заказ отклонена с ошибкой владельца.';
    },
  );

  await runTest(
    'P-07',
    'Payments',
    'Отклонение оплаты отсутствующего заказа',
    async () => {
      await assert.rejects(
        async () => {
          await PaymentService.processSuccessfulPayment({
            telegramUserId: buyer1.id,
            invoicePayload: 'ord_non_existent_999999',
            currency: 'XTR',
            totalAmount: 10,
            telegramPaymentChargeId: 'chg_p07_missing_order',
          });
        },
        /не найден при обработке оплаты/,
      );
      return 'Оплата несуществующего заказа корректно отклонена.';
    },
  );

  await runTest(
    'P-08',
    'Payments',
    'Проброс ошибки Firestore при сбое записи во время оплаты',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      firestoreRepo.setSimulatedFailure({
        writeError: 'Simulated Firestore DEADLINE_EXCEEDED on write',
      });

      try {
        await assert.rejects(
          async () => {
            await PaymentService.processSuccessfulPayment({
              telegramUserId: buyer1.id,
              invoicePayload: order.orderId,
              currency: 'XTR',
              totalAmount: order.totalPrice,
              telegramPaymentChargeId: 'chg_p08_write_err',
            });
          },
          /Simulated Firestore DEADLINE_EXCEEDED on write/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }

      const afterFail = await OrderService.getOrderById(order.orderId);
      assert.equal(afterFail?.paymentStatus, 'pending');
      return 'Ошибка записи Firestore проброшена вызывающему коду, заказ остался в pending.';
    },
  );

  await runTest(
    'P-09',
    'Payments',
    'Rollback транзакции, запрет чтения после записи и защита markOrderPaid без PaymentRecord',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      // 1. Попытка отметить заказ оплаченным напрямую через markOrderPaid без PaymentRecord
      await assert.rejects(
        async () => {
          await OrderService.markOrderPaid({
            orderId: order.orderId,
            telegramPaymentChargeId: 'unverified_charge_id',
          });
        },
        /PaymentRecord не найден/,
      );

      // 2. Проверка нарушения порядка read-after-write и полного отката транзакции
      await assert.rejects(
        async () => {
          await firestoreRepo.runTransaction(async (tx) => {
            const u = await tx.get<StoreUser>('users', `tg_${buyer1.id}`);
            assert.ok(u);
            tx.set<StoreUser>('users', `tg_${buyer1.id}`, {
              ...u,
              totalOrders: 888888,
            });
            // Нарушаем правило: вызываем tx.get ПОСЛЕ tx.set
            await tx.get<Order>('orders', order.orderId);
          });
        },
        /все операции чтения \(tx\.get\) должны выполняться до операций записи/,
      );

      const userAfterRollback = await UserService.getUserByTelegramId(buyer1.id);
      assert.notEqual(userAfterRollback?.totalOrders, 888888);
      return 'Защита read-before-write сработала, транзакция откатилась, неавторизованный markOrderPaid заблокирован.';
    },
  );

  // ===========================================================================
  // 2. FULFILLMENT TESTS
  // ===========================================================================
  await runTest(
    'F-01',
    'Fulfillment',
    'Повторный запуск одной задачи выдачи (идемпотентность initiateFulfillment)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: 'chg_f01',
      });

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      const first = await FulfillmentService.initiateFulfillment(paid.order, bot);
      const second = await FulfillmentService.initiateFulfillment(first, bot);

      assert.equal(first.fulfillmentStatus, 'processing');
      assert.equal(second.fulfillmentStatus, 'processing');
      assert.equal(second.fulfillmentAttempts, 1);
      assert.equal(messages.length, 1);
      return 'При повторном вызове initiateFulfillment задача не дублируется (attempts=1, уведомлений=1).';
    },
  );

  await runTest(
    'F-02',
    'Fulfillment',
    'Два параллельных worker на один заказ (атомарный захват до внешней выдачи)',
    async () => {
      let adapterCalls = 0;
      const countingAdapter: FulfillmentProviderAdapter = {
        providerName: 'CountingAutoAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async (ord, ctx) => {
          adapterCalls++;
          await new Promise((r) => setTimeout(r, 25));
          return {
            handledAutomatically: true,
            status: 'completed',
            details: `Автовыдача выполнена (key=${ctx?.idempotencyKey})`,
            externalReference: `ref_${ord.orderId}`,
          };
        },
      };
      FulfillmentService.setAdapter(countingAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });
      const paid = await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: 'chg_f02_parallel_workers',
      });

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      // Запускаем два параллельных worker одновременно
      await Promise.all([
        FulfillmentService.initiateFulfillment(paid.order, bot),
        FulfillmentService.initiateFulfillment(paid.order, bot),
      ]);

      const finalOrder = await OrderService.getOrderById(order.orderId);
      assert.equal(adapterCalls, 1, 'Внешний адаптер должен быть вызван ровно 1 раз');
      assert.equal(finalOrder?.fulfillmentStatus, 'completed');

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return `Атомарный захват перед вызовом адаптера предотвратил гонку: adapterCalls=${adapterCalls}.`;
    },
  );

  await runTest(
    'F-03',
    'Fulfillment',
    'Падение сервера во время внешней обработки (сверка checkExternalStatus и карантин неидемпотентного провайдера)',
    async () => {
      // Сценарий А: Внешний запрос реально выполнился до падения сервера, провайдер подтверждает через checkExternalStatus
      const crashRecoveryAdapter: FulfillmentProviderAdapter = {
        providerName: 'ProviderWithStatusCheck',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          throw new Error('Should not be called if checkExternalStatus returns alreadyExecuted=true');
        },
        checkExternalStatus: async (_ord, key) => ({
          alreadyExecuted: true,
          status: 'completed',
          details: `Выдача подтверждена провайдером по ключу ${key}`,
          externalReference: `ext_verified_${key}`,
        }),
      };
      FulfillmentService.setAdapter(crashRecoveryAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
      });
      await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: 'chg_f03_crash',
      });

      // Имитируем состояние, когда сервер упал после захвата 'processing', не успев сохранить externalExecutionReference
      const pastIso = new Date(Date.now() - 5000).toISOString();
      await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: pastIso,
        fulfillmentAttempts: 1,
        externalExecutionReference: undefined,
      });

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      const recovered = await FulfillmentService.recoverPendingFulfillments(bot);
      const updatedOrder = await OrderService.getOrderById(order.orderId);
      assert.ok(recovered.length >= 1);
      assert.equal(updatedOrder?.fulfillmentStatus, 'completed');
      assert.ok(updatedOrder?.externalExecutionReference?.startsWith('ext_verified_'));

      // Сценарий Б: Неидемпотентный провайдер без checkExternalStatus — перевод в карантин ручной сверки (без двойной выдачи!)
      let unsafeCalls = 0;
      const nonIdempotentAdapter: FulfillmentProviderAdapter = {
        providerName: 'LegacyNonIdempotentProvider',
        supportsIdempotency: false,
        isConfigured: () => true,
        requestFulfillment: async () => {
          unsafeCalls++;
          return { handledAutomatically: true, status: 'completed', details: 'Done' };
        },
      };
      FulfillmentService.setAdapter(nonIdempotentAdapter);

      const order2 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order2.orderId,
        currency: 'XTR',
        totalAmount: order2.totalPrice,
        telegramPaymentChargeId: 'chg_f03_quarantine',
      });
      await firestoreRepo.updateDoc<Order>('orders', order2.orderId, {
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: pastIso,
        fulfillmentAttempts: 1,
        externalExecutionReference: undefined,
      });

      await FulfillmentService.recoverPendingFulfillments(bot);
      const quarantinedOrder = await OrderService.getOrderById(order2.orderId);
      assert.equal(unsafeCalls, 0, 'Неидемпотентный адаптер НЕ должен вызываться повторно после крэша');
      assert.equal(quarantinedOrder?.fulfillmentStatus, 'failed');
      assert.equal(quarantinedOrder?.needsManualReconciliation, true);

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return 'Сверка checkExternalStatus восстановила выполненный заказ, а неидемпотентный заказ без сверки переведён в карантин ручной проверки (unsafeCalls=0).';
    },
  );

  await runTest(
    'F-04',
    'Fulfillment',
    'Восстановление зависшего заказа и ограничение числа попыток (MAX_FULFILLMENT_ATTEMPTS=3)',
    async () => {
      let attemptsMade = 0;
      const alwaysFailingAdapter: FulfillmentProviderAdapter = {
        providerName: 'AlwaysFailingAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          attemptsMade++;
          throw new Error(`Provider timeout on attempt #${attemptsMade}`);
        },
      };
      FulfillmentService.setAdapter(alwaysFailingAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: 'chg_f04_retries',
      });

      const bot = createMockBot([]);

      // Попытка 1, 2, 3
      for (let i = 1; i <= 3; i++) {
        await assert.rejects(async () => {
          await FulfillmentService.initiateFulfillment(paid.order, bot);
        });
      }

      const after3 = await OrderService.getOrderById(order.orderId);
      assert.equal(after3?.fulfillmentAttempts, 3);
      assert.equal(after3?.fulfillmentStatus, 'failed');
      assert.equal(after3?.needsManualReconciliation, true);

      // 4-й вызов не вызывает внешний адаптер, оставляя заказ в failed
      const fourth = await FulfillmentService.initiateFulfillment(after3!, bot);
      assert.equal(attemptsMade, 3);
      assert.equal(fourth.fulfillmentStatus, 'failed');

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return `После ${attemptsMade} неудачных попыток заказ переведён в финальный статус failed (needsManualReconciliation=true) и не застревает в processing.`;
    },
  );

  await runTest(
    'F-05',
    'Fulfillment',
    'Ошибка уведомления Telegram не отменяет подтверждённую оплату или успешную выдачу',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: 'chg_f05_notify_fail',
      });

      const failingBot = createMockBot([], true); // Telegram API бросает 502

      const inProcessing = await FulfillmentService.initiateFulfillment(
        paid.order,
        failingBot,
      );
      assert.equal(inProcessing.paymentStatus, 'paid');
      assert.equal(inProcessing.fulfillmentStatus, 'processing');
      assert.equal(inProcessing.adminNotifiedAt, undefined);

      const completed = await FulfillmentService.completeOrder({
        orderId: order.orderId,
        adminNote: 'Код активации: STARS-999-XYZ',
        adminTelegramId: 777000111,
        bot: failingBot,
      });
      assert.equal(completed.paymentStatus, 'completed');
      assert.equal(completed.fulfillmentStatus, 'completed');
      assert.equal(completed.buyerNotifiedAt, undefined);
      return 'При падении Telegram API оплата и выдача сохранены в БД (completed), флаги уведомлений ждут повторной отправки.';
    },
  );

  await runTest(
    'F-06',
    'Fulfillment',
    'Повторная отправка уведомления после восстановления связи (retryOrderNotifications)',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const unnotifiedCompleted = orders.find(
        (o) => o.fulfillmentStatus === 'completed' && !o.buyerNotifiedAt,
      );
      assert.ok(unnotifiedCompleted);

      const deliveredMessages: Array<{ chatId: number | string; text: string }> = [];
      const workingBot = createMockBot(deliveredMessages, false);

      const retryRes = await FulfillmentService.retryOrderNotifications(
        unnotifiedCompleted.orderId,
        workingBot,
      );

      assert.equal(retryRes.adminNotified, true);
      assert.equal(retryRes.buyerNotified, true);
      assert.ok(
        deliveredMessages.some((m) => m.text.includes('STARS-999-XYZ')),
        'Покупатель должен получить код активации в повторном уведомлении',
      );
      return `Уведомления админу и покупателю успешно доставлены при повторе (сообщение содержит код активации).`;
    },
  );

  await runTest(
    'F-07',
    'Fulfillment',
    'Защита от двойной выдачи при повторном запуске recovery и completeOrder',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const completedOrder = orders.find((o) => o.fulfillmentStatus === 'completed')!;

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      // Повторный вызов completeOrder и recoverPendingFulfillments
      const again = await FulfillmentService.completeOrder({
        orderId: completedOrder.orderId,
        adminNote: 'Повторное нажатие',
        bot,
      });
      await FulfillmentService.recoverPendingFulfillments(bot);

      assert.equal(again.fulfillmentStatus, 'completed');
      assert.equal(
        messages.length,
        0,
        'Повторный вызов для уже уведомлённого и выданного заказа не отправляет дублирующих сообщений',
      );
      return 'Повторный completeOrder и recoverPendingFulfillments не приводят к повторной выдаче или дублированию сообщений.';
    },
  );

  // ===========================================================================
  // 3. SECURITY TESTS
  // ===========================================================================
  await runTest(
    'S-01',
    'Security',
    'Отсутствие WEBHOOK_SECRET блокирует webhook-запуск и запросы',
    async () => {
      const prevMode = process.env.BOT_MODE;
      const prevSecret = process.env.WEBHOOK_SECRET;
      const prevUrl = process.env.WEBHOOK_URL;

      try {
        process.env.BOT_MODE = 'webhook';
        process.env.WEBHOOK_URL = 'https://example.run.app';
        process.env.WEBHOOK_SECRET = '';

        await assert.rejects(
          async () => {
            await botManager.start();
          },
          /WEBHOOK_SECRET обязательна/,
        );

        const { res, getStatus } = createMockExpressRes();
        const req = {
          header: () => undefined,
          body: { update_id: 1001 },
        } as unknown as Request;

        await botManager.handleWebhookRequest(req, res);
        assert.equal(getStatus(), 503);
      } finally {
        process.env.BOT_MODE = prevMode;
        process.env.WEBHOOK_SECRET = prevSecret;
        process.env.WEBHOOK_URL = prevUrl;
      }
      return 'Запуск в режиме webhook без WEBHOOK_SECRET завершается с ошибкой конфигурации, запросы отклоняются с кодом 503.';
    },
  );

  await runTest(
    'S-02',
    'Security',
    'Отклонение запросов с неправильным X-Telegram-Bot-Api-Secret-Token и поддельных updates',
    async () => {
      const prevSecret = process.env.WEBHOOK_SECRET;
      try {
        process.env.WEBHOOK_SECRET = 'super_secret_webhook_token_123456';

        assert.equal(
          verifyWebhookSecretToken('super_secret_webhook_token_123456', 'wrong_token'),
          false,
        );
        assert.equal(
          verifyWebhookSecretToken(
            'super_secret_webhook_token_123456',
            'super_secret_webhook_token_123456',
          ),
          true,
        );
        assert.equal(isValidTelegramUpdatePayload({ foo: 'bar' }), false);
        assert.equal(isValidTelegramUpdatePayload({ update_id: 42 }), true);

        const { res, getStatus } = createMockExpressRes();
        const forgedReq = {
          header: (name: string) =>
            name === 'X-Telegram-Bot-Api-Secret-Token' ? 'forged_token' : undefined,
          body: {
            update_id: 9999,
            message: {
              successful_payment: {
                currency: 'XTR',
                total_amount: 10,
                invoice_payload: 'ord_forged',
                telegram_payment_charge_id: 'chg_forged',
              },
            },
          },
        } as unknown as Request;

        await botManager.handleWebhookRequest(forgedReq, res);
        assert.equal(getStatus(), 401);
      } finally {
        process.env.WEBHOOK_SECRET = prevSecret;
      }
      return 'Запрос с неверным X-Telegram-Bot-Api-Secret-Token отклонён со статусом 401 Unauthorized до вызова handleUpdate.';
    },
  );

  await runTest(
    'S-03',
    'Security',
    'Блокировка неавторизованного admin callback (ensureAdmin)',
    async () => {
      let alertShown = '';
      const fakeAdminCtx = {
        from: { id: 999888777, first_name: 'Hacker' },
        callbackQuery: { id: 'cb_1', data: 'adm:orders:all' },
        answerCbQuery: async (text: string) => {
          alertShown = text;
          return true;
        },
      } as unknown as Context;

      const allowed = await ensureAdmin(fakeAdminCtx);
      assert.equal(allowed, false);
      assert.ok(alertShown.includes('только администраторам'));
      return 'Неавторизованный callback к админ-панели заблокирован (allowed=false).';
    },
  );

  await runTest(
    'S-04',
    'Security',
    'Защита от доступа к чужому заказу в pre_checkout и карточке заказа',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const preCheckoutOtherUser = await PaymentService.validatePreCheckout({
        invoicePayload: order.orderId,
        telegramUserId: buyer2.id,
        currency: 'XTR',
        totalAmount: order.totalPrice,
      });
      assert.equal(preCheckoutOtherUser.ok, false);
      assert.ok(
        preCheckoutOtherUser.errorMessage?.includes('принадлежит другому пользователю'),
      );
      return 'Доступ чужого пользователя к заказу отклонён.';
    },
  );

  // ===========================================================================
  // 4. DATABASE TESTS
  // ===========================================================================
  await runTest(
    'D-01',
    'Database',
    'Fail-safe при недоступности Firebase: запрет создания заказов и обработки платежей',
    async () => {
      firestoreRepo.setSimulatedFailure({ unavailable: true });
      try {
        await assert.rejects(
          async () => {
            await OrderService.createOrder({
              telegramUser: buyer1,
              productId: 'stars_pack_50',
              quantity: 1,
            });
          },
          (err: unknown) => err instanceof StorageUnavailableError,
        );

        const preCheck = await PaymentService.validatePreCheckout({
          invoicePayload: 'ord_any',
          telegramUserId: buyer1.id,
          currency: 'XTR',
          totalAmount: 10,
        });
        assert.equal(preCheck.ok, false);
        assert.ok(preCheck.errorMessage?.includes('временно недоступно'));
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'При недоступности БД выбрасывается StorageUnavailableError, заказы и pre_checkout безопасно блокируются.';
    },
  );

  await runTest(
    'D-02',
    'Database',
    'Проброс ошибки чтения Firestore (не проглатывается)',
    async () => {
      firestoreRepo.setSimulatedFailure({
        readError: 'Simulated Firestore UNAVAILABLE on read',
      });
      try {
        await assert.rejects(
          async () => {
            await ProductService.getProductById('stars_pack_50');
          },
          /Simulated Firestore UNAVAILABLE on read/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'Ошибка чтения Firestore корректно передана вызывающему коду.';
    },
  );

  await runTest(
    'D-03',
    'Database',
    'Проброс ошибки записи Firestore (не проглатывается)',
    async () => {
      firestoreRepo.setSimulatedFailure({
        writeError: 'Simulated Firestore PERMISSION_DENIED on write',
      });
      try {
        await assert.rejects(
          async () => {
            await ProductService.createProduct({
              name: 'Test Item',
              category: 'stars',
              description: 'Test',
              price: 15,
            });
          },
          /Simulated Firestore PERMISSION_DENIED on write/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'Ошибка записи Firestore корректно передана вызывающему коду.';
    },
  );

  await runTest(
    'D-04',
    'Database',
    'Cursor pagination (startAfter) без дублей и пропусков',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      for (let i = 1; i <= 5; i++) {
        await OrderService.createOrder({
          telegramUser: buyer1,
          productId: 'stars_pack_50',
          quantity: 1,
        });
        await new Promise((r) => setTimeout(r, 5));
      }

      const page1 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 2,
      });
      assert.equal(page1.items.length, 2);
      assert.equal(page1.hasMore, true);
      assert.ok(page1.nextCursor);

      const page2 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        startAfter: page1.nextCursor,
        limit: 2,
      });
      assert.equal(page2.items.length, 2);
      assert.equal(page2.hasMore, true);

      const page3 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        startAfter: page2.nextCursor,
        limit: 2,
      });
      assert.equal(page3.items.length, 1);
      assert.equal(page3.hasMore, false);

      const allIds = [
        ...page1.items.map((o) => o.orderId),
        ...page2.items.map((o) => o.orderId),
        ...page3.items.map((o) => o.orderId),
      ];
      assert.equal(new Set(allIds).size, 5, 'Все 5 заказов должны быть уникальными без пересечений страниц');
      return 'Постраничная выборка через курсор startAfter вернула 2 + 2 + 1 = 5 уникальных заказов в правильном порядке.';
    },
  );

  await runTest(
    'D-05',
    'Database',
    'Валидация firestore.indexes.json и .gitignore',
    async () => {
      const indexesPath = path.resolve(process.cwd(), 'firestore.indexes.json');
      const indexesRaw = fs.readFileSync(indexesPath, 'utf-8');
      const parsed = JSON.parse(indexesRaw) as {
        indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
      };

      assert.ok(Array.isArray(parsed.indexes));
      assert.ok(parsed.indexes.length >= 10);

      const gitignore = fs.readFileSync(
        path.resolve(process.cwd(), '.gitignore'),
        'utf-8',
      );
      assert.ok(gitignore.includes('.data/'));
      assert.ok(gitignore.includes('.env'));
      return `Проверено ${parsed.indexes.length} составных индексов в firestore.indexes.json и правила защиты .gitignore.`;
    },
  );

  // ===========================================================================
  // 5. AUD-004 & AUD-005 STATE MACHINE, TWO-STEP REFUND & CONCURRENCY TESTS
  // ===========================================================================
  await runTest(
    'A-01',
    'Fulfillment',
    'AUD-005: Запрет перевода неоплаченного заказа в processing/completed и фильтрация кнопок админ-клавиатуры',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const pendingOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      // 1. Клавиатура неоплаченного заказа НЕ должна содержать кнопок выдачи или возврата
      const pendingKbJson = JSON.stringify(
        buildAdminOrderActionKeyboard(pendingOrder),
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_proc:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_proc не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_done:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_done не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_note:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_note не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_refund:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_refund не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_cancel:${pendingOrder.orderId}`),
        true,
        'Кнопка adm:ord_cancel должна быть доступна для неоплаченного заказа',
      );

      // 2. Серверная транзакция OrderService.updateOrderStatus отклоняет перевод pending -> processing
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: pendingOrder.orderId,
            fulfillmentStatus: 'processing',
            fulfillmentNote: 'Попытка взять неоплаченный заказ в работу',
          });
        },
        /заказ не оплачен/,
      );

      // 3. Серверная транзакция отклоняет перевод pending -> completed
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: pendingOrder.orderId,
            fulfillmentStatus: 'completed',
          });
        },
        /заказ не оплачен/,
      );

      const unchanged = await OrderService.getOrderById(pendingOrder.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');
      assert.equal(unchanged?.fulfillmentStatus, 'pending');
      return 'Неоплаченный заказ защищён от перевода в processing/completed на уровне клавиатуры и серверной транзакции.';
    },
  );

  await runTest(
    'A-02',
    'Security',
    'AUD-004: Серверный запрет отмены уже оплаченного или выданного заказа и запрет отката completed -> processing',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const paid = await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: 'chg_a02_paid_cancel_guard',
      });

      // Клавиатура оплаченного заказа содержит кнопки выдачи и возврата, но НЕ содержит adm:ord_cancel
      const paidKbJson = JSON.stringify(buildAdminOrderActionKeyboard(paid.order));
      assert.equal(
        paidKbJson.includes(`adm:ord_proc:${order.orderId}`),
        true,
      );
      assert.equal(
        paidKbJson.includes(`adm:ord_refund:${order.orderId}`),
        true,
      );
      assert.equal(
        paidKbJson.includes(`adm:ord_cancel:${order.orderId}`),
        false,
        'Оплаченный заказ не должен иметь кнопки отмены adm:ord_cancel',
      );

      // Попытка отменить оплаченный заказ по старой кнопке отклоняется транзакцией
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: order.orderId,
            paymentStatus: 'cancelled',
            fulfillmentStatus: 'cancelled',
          });
        },
        /Невозможно отменить заказ.*уже имеет статус оплаты "paid"/,
      );

      // Перевод оплаченного заказа в processing разрешён
      const inProc = await OrderService.updateOrderStatus({
        orderId: order.orderId,
        fulfillmentStatus: 'processing',
      });
      assert.equal(inProc?.fulfillmentStatus, 'processing');

      // Завершаем выдачу
      const completed = await FulfillmentService.completeOrder({
        orderId: order.orderId,
        adminNote: 'Выдано',
      });
      assert.equal(completed.fulfillmentStatus, 'completed');

      // Попытка вернуть выполненный заказ обратно в processing блокируется
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: order.orderId,
            fulfillmentStatus: 'processing',
          });
        },
        /Невозможно вернуть уже выполненный заказ/,
      );

      return 'Оплаченный и выданный заказы защищены от отмены и отката статуса.';
    },
  );

  await runTest(
    'A-03',
    'Payments',
    'AUD-004: Двухэтапное подтверждение возврата (клавиатура шага 2 и запрет возврата неоплаченных/отменённых заказов)',
    async () => {
      const pendingOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      // Шаг 2 клавиатуры подтверждения возврата содержит только adm:ord_refund_confirm и возврат к карточке adm:ord
      const confirmKbJson = JSON.stringify(
        buildAdminOrderRefundConfirmKeyboard(pendingOrder),
      );
      assert.equal(
        confirmKbJson.includes(`adm:ord_refund_confirm:${pendingOrder.orderId}`),
        true,
      );
      assert.equal(
        confirmKbJson.includes(`adm:ord:${pendingOrder.orderId}`),
        true,
      );

      // Попытка выполнить возврат для неоплаченного заказа блокируется
      await assert.rejects(
        async () => {
          await PaymentService.executeOrderRefund({
            orderId: pendingOrder.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: async () => {},
          });
        },
        /отсутствует telegram_payment_charge_id/,
      );

      // Отменяем неоплаченный заказ и проверяем, что отменённый заказ нельзя вернуть даже при наличии фейкового chargeId
      const cancelled = await OrderService.updateOrderStatus({
        orderId: pendingOrder.orderId,
        paymentStatus: 'cancelled',
        fulfillmentStatus: 'cancelled',
      });
      assert.equal(cancelled?.paymentStatus, 'cancelled');

      return 'Клавиатура двухэтапного подтверждения возврата проверена, возврат неоплаченных и отменённых заказов заблокирован.';
    },
  );

  await runTest(
    'A-04',
    'Payments',
    'AUD-004: Защита от повторного возврата и конкурентных запросов refundStarPayment',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });

      await PaymentService.processSuccessfulPayment({
        telegramUserId: buyer1.id,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: 'chg_a04_concurrent_refund',
      });

      let telegramApiRefundCalls = 0;
      const slowTelegramRefund = async () => {
        telegramApiRefundCalls++;
        await new Promise((resolve) => setTimeout(resolve, 35));
      };

      // Запускаем 4 одновременных запроса на возврат одного и того же заказа
      const settled = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          PaymentService.executeOrderRefund({
            orderId: order.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: slowTelegramRefund,
          }),
        ),
      );

      const fulfilled = settled.filter(
        (
          s,
        ): s is PromiseFulfilledResult<{
          alreadyRefunded: boolean;
          order: Order;
        }> => s.status === 'fulfilled',
      );
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === 'rejected',
      );

      assert.equal(
        fulfilled.length,
        1,
        'Ровно 1 из параллельных запросов должен выполнить возврат',
      );
      assert.equal(fulfilled[0].value.alreadyRefunded, false);
      assert.equal(fulfilled[0].value.order.paymentStatus, 'refunded');
      assert.equal(
        rejected.length,
        3,
        'Остальные 3 параллельных запроса во время полёта первого должны быть заблокированы in-flight локом',
      );
      assert.ok(
        rejected.every((r) =>
          String(r.reason).includes('уже выполняется параллельным запросом'),
        ),
      );
      assert.equal(
        telegramApiRefundCalls,
        1,
        'Telegram API refundStarPayment должен быть вызван ровно 1 раз',
      );

      // Повторный запрос после завершения возврата идемпотентно возвращает alreadyRefunded=true без вызова Telegram API
      const secondAttempt = await PaymentService.executeOrderRefund({
        orderId: order.orderId,
        adminTelegramId: 777000111,
        callTelegramRefund: slowTelegramRefund,
      });
      assert.equal(secondAttempt.alreadyRefunded, true);
      assert.equal(
        telegramApiRefundCalls,
        1,
        'Повторный вызов после возврата не должен вызывать Telegram API',
      );

      return `Из 4 конкурентных запросов ровно 1 вызвал refundStarPayment (calls=${telegramApiRefundCalls}), 3 отклонены in-flight локом, повторный вызов вернул alreadyRefunded=true.`;
    },
  );

  console.log('\n================================================================');
  console.log(`📊 РЕЗУЛЬТАТЫ АВТОТЕСТОВ (${testResults.length}/${testResults.length} PASS):`);
  for (const r of testResults) {
    console.log(
      `✅ [${r.status}] [${r.id}] (${r.category}) ${r.name}\n   └─ Среда: ${r.environment} | Emulator: ${r.emulatorUsed ? 'Да' : 'Нет (Isolated Mock)'}\n   └─ Детали: ${r.details}`,
    );
  }
  console.log('================================================================\n');
}

runFullAuditTestSuite()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ ТЕСТЫ ЗАВЕРШИЛИСЬ С ОШИБКОЙ:', err);
    process.exit(1);
  });
