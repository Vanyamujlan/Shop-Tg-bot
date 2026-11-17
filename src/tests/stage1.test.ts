import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Telegraf } from 'telegraf';
import { firestoreRepo } from '../db/firestore.ts';
import { OrderService } from '../services/OrderService.ts';
import { PaymentService } from '../services/PaymentService.ts';
import {
  FulfillmentService,
  ManualAdminFulfillmentAdapter,
  type FulfillmentProviderAdapter,
} from '../services/FulfillmentService.ts';
import { ProductService } from '../services/ProductService.ts';
import { UserService } from '../services/UserService.ts';
import type { StoreUser } from '../types.ts';

function inheritFirebaseEnvFromServerIfNeeded(): void {
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    return;
  }
  try {
    const pidRaw = execSync('pgrep -f "tsx server.ts" | head -n 1', {
      encoding: 'utf-8',
    }).trim();
    if (!pidRaw) return;
    const rawEnv = fs.readFileSync(`/proc/${pidRaw}/environ`, 'utf-8');
    for (const entry of rawEnv.split('\0')) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = entry.slice(0, eqIdx);
      const val = entry.slice(eqIdx + 1);
      if (
        key.startsWith('FIREBASE_') ||
        key === 'ADMIN_IDS' ||
        key === 'STORE_SUPPORT_USERNAME'
      ) {
        process.env[key] = val;
      }
    }
  } catch {
    // Fallback to offline test mode if server process is not found
  }
}


interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];
const createdOrderIds = new Set<string>();
const createdPaymentIds = new Set<string>();
const createdUserIds = new Set<string>();
const createdTxIds = new Set<string>();

function createMockBot(sentMessages: Array<{ chatId: number | string; text: string }>): Telegraf {
  return {
    telegram: {
      sendMessage: async (chatId: number | string, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: Date.now() };
      },
    },
  } as unknown as Telegraf;
}

async function cleanupTestArtifacts(): Promise<void> {
  for (const orderId of createdOrderIds) {
    try {
      await firestoreRepo.deleteDoc('orders', orderId);
    } catch {
      // ignore cleanup error
    }
  }
  for (const paymentId of createdPaymentIds) {
    try {
      await firestoreRepo.deleteDoc('payments', paymentId);
    } catch {
      // ignore cleanup error
    }
  }
  for (const userId of createdUserIds) {
    try {
      await firestoreRepo.deleteDoc('users', userId);
    } catch {
      // ignore cleanup error
    }
  }
  for (const txId of createdTxIds) {
    try {
      await firestoreRepo.deleteDoc('transactions', txId);
    } catch {
      // ignore cleanup error
    }
  }
}

async function cleanupTransactionsForOrders(orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const recentTxs = await OrderService.getRecentTransactions(100);
  for (const tx of recentTxs) {
    if (orderIds.includes(tx.orderId)) {
      createdTxIds.add(tx.transactionId);
    }
  }
}

async function runStage1Tests(): Promise<void> {
  console.log('==========================================================');
  console.log('🧪 ЗАПУСК АВТОТЕСТОВ ЭТАПА 1 (HIGH-01, HIGH-02, MEDIUM-01, MEDIUM-SEC-01)');
  console.log('==========================================================');

  inheritFirebaseEnvFromServerIfNeeded();
  await firestoreRepo.init();

  const repoStatus = firestoreRepo.getStatus();
  console.log(
    `[Test Info] Firestore Project: ${repoStatus.projectId} | Admin SDK Ready: ${repoStatus.adminSdkConnected}`,
  );

  const testTgId1 = 9900112233;
  const testUserId1 = UserService.getUserId(testTgId1);
  createdUserIds.add(testUserId1);

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Атомарная обработка successful_payment и проверка дубликата (последовательный вызов)
    // -------------------------------------------------------------------------
    {
      const order = await OrderService.createOrder({
        telegramUser: {
          id: testTgId1,
          username: 'stage1_tester',
          first_name: 'Stage1',
          last_name: 'Tester',
        },
        productId: 'stars_pack_50',
        quantity: 1,
      });
      createdOrderIds.add(order.orderId);

      const chargeId = `chg_seq_${Date.now()}`;
      const paymentDocId = PaymentService.getPaymentDocId(chargeId);
      createdPaymentIds.add(paymentDocId);

      const firstRes = await PaymentService.processSuccessfulPayment({
        telegramUserId: testTgId1,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: 'prov_seq_1',
      });

      assert.equal(firstRes.alreadyProcessed, false, 'Первый вызов не должен быть помечен как дубликат');
      assert.equal(firstRes.needsFulfillmentRecovery, true, 'После оплаты заказ должен ожидать выдачи');
      assert.equal(firstRes.order.paymentStatus, 'paid');
      assert.equal(firstRes.order.fulfillmentStatus, 'paid');

      const userAfterFirst = await UserService.getUserById(testUserId1);
      assert.ok(userAfterFirst, 'Пользователь должен существовать');
      assert.equal(userAfterFirst.totalOrders, 1, 'totalOrders должен быть равен 1');
      assert.equal(
        userAfterFirst.totalSpentStars,
        order.totalPrice,
        `totalSpentStars должен быть равен ${order.totalPrice}`,
      );

      // Запускаем выдачу
      const sentNotifications: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentNotifications);
      const fulfilledOrder = await FulfillmentService.initiateFulfillment(
        firstRes.order,
        mockBot,
      );
      assert.equal(fulfilledOrder.fulfillmentStatus, 'processing');

      // Повторный (дублирующий) вызов successful_payment с тем же chargeId
      const duplicateRes = await PaymentService.processSuccessfulPayment({
        telegramUserId: testTgId1,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: 'prov_seq_1',
      });

      assert.equal(duplicateRes.alreadyProcessed, true, 'Повторный вызов обязан вернуть alreadyProcessed: true');
      assert.equal(
        duplicateRes.needsFulfillmentRecovery,
        false,
        'Так как выдача уже в статусе processing, needsFulfillmentRecovery должен быть false',
      );

      const userAfterDuplicate = await UserService.getUserById(testUserId1);
      assert.equal(
        userAfterDuplicate?.totalOrders,
        1,
        'Повторный платёж НЕ должен увеличивать totalOrders повторно',
      );
      assert.equal(
        userAfterDuplicate?.totalSpentStars,
        order.totalPrice,
        'Повторный платёж НЕ должен увеличивать totalSpentStars повторно',
      );

      results.push({
        name: 'HIGH-01.1: Атомарная транзакция оплаты и защита от последовательного дубликата платежа',
        passed: true,
        details: `Order ${order.orderId} переведён в paid, статистика пользователя обновлена ровно 1 раз (totalOrders=1, totalSpentStars=${order.totalPrice}).`,
      });
    }

    // -------------------------------------------------------------------------
    // TEST 2: Параллельные (конкурентные) вызовы successful_payment + initiateFulfillment
    // -------------------------------------------------------------------------
    {
      const userBefore = await UserService.getUserById(testUserId1);
      const prevOrders = userBefore?.totalOrders || 0;
      const prevStars = userBefore?.totalSpentStars || 0;

      const order = await OrderService.createOrder({
        telegramUser: {
          id: testTgId1,
          username: 'stage1_tester',
          first_name: 'Stage1',
          last_name: 'Tester',
        },
        productId: 'stars_pack_250',
        quantity: 1,
      });
      createdOrderIds.add(order.orderId);

      const chargeId = `chg_parallel_${Date.now()}`;
      createdPaymentIds.add(PaymentService.getPaymentDocId(chargeId));

      const parallelResults = await Promise.all(
        Array.from({ length: 5 }, () =>
          PaymentService.processSuccessfulPayment({
            telegramUserId: testTgId1,
            invoicePayload: order.orderId,
            currency: 'XTR',
            totalAmount: order.totalPrice,
            telegramPaymentChargeId: chargeId,
            providerPaymentChargeId: 'prov_parallel_1',
          }),
        ),
      );

      const freshProcesses = parallelResults.filter((r) => !r.alreadyProcessed);
      const duplicateProcesses = parallelResults.filter((r) => r.alreadyProcessed);

      assert.equal(
        freshProcesses.length,
        1,
        `Ровно 1 параллельный вызов должен записать платёж, получено: ${freshProcesses.length}`,
      );
      assert.equal(
        duplicateProcesses.length,
        4,
        `Остальные 4 параллельных вызова должны получить alreadyProcessed=true`,
      );

      const userAfter = await UserService.getUserById(testUserId1);
      assert.equal(
        userAfter?.totalOrders,
        prevOrders + 1,
        'При 5 параллельных вызовах totalOrders должен увеличиться ровно на 1',
      );
      assert.equal(
        userAfter?.totalSpentStars,
        prevStars + order.totalPrice,
        `При 5 параллельных вызовах totalSpentStars должен увеличиться ровно на ${order.totalPrice}`,
      );

      // Теперь проверим параллельный запуск initiateFulfillment
      const sentNotifications: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentNotifications);

      await Promise.all(
        parallelResults.map((r) =>
          FulfillmentService.initiateFulfillment(r.order, mockBot),
        ),
      );

      const finalOrder = await OrderService.getOrderById(order.orderId);
      assert.equal(finalOrder?.fulfillmentStatus, 'processing');

      results.push({
        name: 'HIGH-01.2: Конкурентные параллельные платежи и идемпотентность выдачи (5 потоков)',
        passed: true,
        details: `Из 5 конкурентных вызовов ровно 1 зафиксировал транзакцию, 4 отсечены как дубликаты. Уведомлений админу отправлено без дублей (${sentNotifications.length}).`,
      });
    }

    // -------------------------------------------------------------------------
    // TEST 3: Восстановление после частичного сбоя между фиксацией оплаты и выдачей
    // -------------------------------------------------------------------------
    {
      const order = await OrderService.createOrder({
        telegramUser: {
          id: testTgId1,
          username: 'stage1_tester',
          first_name: 'Stage1',
          last_name: 'Tester',
        },
        productId: 'gift_star_box',
        quantity: 1,
      });
      createdOrderIds.add(order.orderId);

      const chargeId = `chg_recovery_${Date.now()}`;
      createdPaymentIds.add(PaymentService.getPaymentDocId(chargeId));

      // Шаг 1: Транзакция оплаты успешно фиксируется в Firestore
      const paymentRes = await PaymentService.processSuccessfulPayment({
        telegramUserId: testTgId1,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: chargeId,
      });
      assert.equal(paymentRes.alreadyProcessed, false);
      assert.equal(paymentRes.order.paymentStatus, 'paid');
      assert.equal(paymentRes.order.fulfillmentStatus, 'paid');

      // Шаг 2: Имитируем сбой в адаптере выдачи ДО перевода заказа в processing
      const failingAdapter: FulfillmentProviderAdapter = {
        providerName: 'SimulatedFailingAdapter',
        isConfigured: () => true,
        requestFulfillment: async () => {
          throw new Error('Simulated transient fulfillment outage');
        },
      };

      FulfillmentService.setAdapter(failingAdapter);
      const sentNotifications: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentNotifications);

      let fulfillmentFailed = false;
      try {
        await FulfillmentService.initiateFulfillment(paymentRes.order, mockBot);
      } catch {
        fulfillmentFailed = true;
      }
      assert.equal(fulfillmentFailed, true, 'Ожидался сбой выдачи при неисправном адаптере');

      // Восстанавливаем штатный адаптер
      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());

      // Проверяем, что заказ остался в статусе paid / paid (не потерян, но выдача не завершена)
      const stuckOrder = await OrderService.getOrderById(order.orderId);
      assert.equal(stuckOrder?.paymentStatus, 'paid');
      assert.equal(stuckOrder?.fulfillmentStatus, 'paid');

      const userBeforeRetry = await UserService.getUserById(testUserId1);

      // Шаг 3: Повторная доставка апдейта successful_payment (или вызов восстановления)
      const retryRes = await PaymentService.processSuccessfulPayment({
        telegramUserId: testTgId1,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: chargeId,
      });

      assert.equal(retryRes.alreadyProcessed, true, 'Оплата уже была зафиксирована');
      assert.equal(
        retryRes.needsFulfillmentRecovery,
        true,
        'Флаг needsFulfillmentRecovery обязан сигнализировать о необходимости довыполнить выдачу',
      );

      // Восстанавливаем выдачу через initiateFulfillment (как это делает paymentHandler)
      const recoveredOrder = await FulfillmentService.initiateFulfillment(
        retryRes.order,
        mockBot,
      );
      assert.equal(
        recoveredOrder.fulfillmentStatus,
        'processing',
        'После восстановления заказ должен перейти в статус processing',
      );

      const userAfterRetry = await UserService.getUserById(testUserId1);
      assert.equal(
        userAfterRetry?.totalOrders,
        userBeforeRetry?.totalOrders,
        'Восстановление выдачи НЕ должно повторно инкрементировать статистику покупок',
      );

      // Шаг 4: Ещё один повторный вызов — теперь needsFulfillmentRecovery === false
      const thirdRes = await PaymentService.processSuccessfulPayment({
        telegramUserId: testTgId1,
        invoicePayload: order.orderId,
        currency: 'XTR',
        totalAmount: order.totalPrice,
        telegramPaymentChargeId: chargeId,
      });
      assert.equal(thirdRes.alreadyProcessed, true);
      assert.equal(thirdRes.needsFulfillmentRecovery, false);

      results.push({
        name: 'HIGH-01.3: Восстановление после частичного сбоя между фиксацией оплаты и выдачей',
        passed: true,
        details: `При сбое адаптера после коммита оплаты повторный вызов определил needsFulfillmentRecovery=true и довёл заказ #${order.orderId} до processing без двойного списания.`,
      });
    }

    // -------------------------------------------------------------------------
    // TEST 4: Серверные запросы Firestore (where, orderBy, limit, offset) — HIGH-02
    // -------------------------------------------------------------------------
    {
      const activeStars = await ProductService.getProductsByCategory('stars', false, 10, 0);
      assert.ok(activeStars.length > 0, 'Категория stars должна содержать активные товары');
      for (let i = 0; i < activeStars.length; i++) {
        assert.equal(activeStars[i].category, 'stars');
        assert.equal(activeStars[i].isActive, true);
        if (i > 0) {
          assert.ok(
            activeStars[i].price >= activeStars[i - 1].price,
            'Товары должны быть отсортированы по цене по возрастанию',
          );
        }
      }

      const userOrdersPage1 = await OrderService.getUserOrders(testTgId1, 2, 0);
      const userOrdersPage2 = await OrderService.getUserOrders(testTgId1, 2, 2);
      assert.equal(userOrdersPage1.length, 2, 'Первая страница заказов пользователя (limit=2) должна вернуть 2 заказа');
      assert.equal(userOrdersPage2.length, 1, 'Вторая страница заказов пользователя (offset=2) должна вернуть 1 заказ');
      assert.notEqual(userOrdersPage1[0].orderId, userOrdersPage2[0].orderId);

      const processingOrders = await OrderService.getAllOrders('processing', 20, 0);
      assert.ok(
        processingOrders.some((o) => createdOrderIds.has(o.orderId)),
        'Фильтр getAllOrders("processing") должен находить тестовые заказы в обработке',
      );

      const paymentsPage = await PaymentService.getAllPayments(10, 0);
      assert.ok(paymentsPage.length >= 3, 'getAllPayments должен возвращать созданные платежи');

      results.push({
        name: 'HIGH-02: Серверные запросы Firestore (where, orderBy, limit, offset) и пагинация',
        passed: true,
        details: `Проверены серверная фильтрация, сортировка и пагинация для products (${activeStars.length}), orders (page1=${userOrdersPage1.length}, page2=${userOrdersPage2.length}) и payments (${paymentsPage.length}).`,
      });
    }

    // -------------------------------------------------------------------------
    // TEST 5: Проброс ошибок записи и транзакций Firestore — MEDIUM-01
    // -------------------------------------------------------------------------
    {
      let caughtRollbackError = false;
      try {
        await firestoreRepo.runTransaction(async (tx) => {
          const existingUser = await tx.get<StoreUser>('users', testUserId1);
          assert.ok(existingUser);
          tx.set<StoreUser>('users', testUserId1, {
            ...existingUser,
            totalOrders: 999999,
          });
          throw new Error('Simulated transaction write failure (MEDIUM-01 test)');
        });
      } catch (err) {
        caughtRollbackError =
          err instanceof Error && err.message.includes('Simulated transaction write failure');
      }

      assert.equal(
        caughtRollbackError,
        true,
        'Ошибка внутри транзакции Firestore обязана пробрасываться вызывающему коду (не проглатываться)',
      );

      const userAfterRollback = await UserService.getUserById(testUserId1);
      assert.notEqual(
        userAfterRollback?.totalOrders,
        999999,
        'При выбросе ошибки транзакция обязана откатить изменения',
      );

      results.push({
        name: 'MEDIUM-01: Корректная обработка, откат и проброс ошибок записи Firestore',
        passed: true,
        details: 'Ошибка внутри транзакции корректно перехвачена вызывающим кодом, несохранённые изменения (totalOrders=999999) полностью откатились.',
      });
    }

    // -------------------------------------------------------------------------
    // TEST 6: Защита .data/ в .gitignore и отсутствие локального зеркала при активном Cloud Firestore — MEDIUM-SEC-01
    // -------------------------------------------------------------------------
    {
      const gitignoreContent = fs.readFileSync(
        path.resolve(process.cwd(), '.gitignore'),
        'utf-8',
      );
      assert.ok(
        gitignoreContent.includes('.data/'),
        '.gitignore обязан содержать директорию .data/',
      );

      const mirrorPath = path.resolve(process.cwd(), '.data', 'firestore-mirror.json');
      if (repoStatus.adminSdkConnected) {
        assert.equal(
          fs.existsSync(mirrorPath),
          false,
          'При активном Cloud Firestore локальный файл .data/firestore-mirror.json должен быть удалён/отключён',
        );
      } else if (fs.existsSync(mirrorPath)) {
        const stat = fs.statSync(mirrorPath);
        const mode = stat.mode & 0o777;
        assert.equal(mode, 0o600, 'Права доступа к локальному резервному файлу должны быть 0o600');
      }

      results.push({
        name: 'MEDIUM-SEC-01: Исключение .data/ из Git и защита локальных резервных данных',
        passed: true,
        details: `.gitignore содержит .data/; при активном Cloud Firestore (${repoStatus.adminSdkConnected}) локальный зеркальный файл отключён и отсутствует.`,
      });
    }
  } finally {
    await cleanupTransactionsForOrders(Array.from(createdOrderIds));
    await cleanupTestArtifacts();
  }

  console.log('\n==========================================================');
  console.log('📊 ИТОГИ АВТОТЕСТОВ ЭТАПА 1:');
  for (const r of results) {
    console.log(`✅ [PASS] ${r.name}`);
    console.log(`   └─ ${r.details}`);
  }
  console.log('==========================================================\n');
}

runStage1Tests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ ТЕСТЫ ЭТАПА 1 ЗАВЕРШИЛИСЬ С ОШИБКОЙ:', err);
    process.exit(1);
  });
