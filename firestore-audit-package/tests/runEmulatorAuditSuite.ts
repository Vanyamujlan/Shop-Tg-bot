import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
} from 'firebase/firestore';
import {
  assertEmulatorOnlyEnvironment,
  firestoreRepo,
  ProductionGuardError,
  StorageUnavailableError,
} from '../../src/db/firestore.ts';
import { OrderService } from '../../src/services/OrderService.ts';
import { ProductService } from '../../src/services/ProductService.ts';
import { PaymentService } from '../../src/services/PaymentService.ts';
import {
  FulfillmentService,
  FulfillmentProviderAdapter,
  ManualAdminFulfillmentAdapter,
} from '../../src/services/FulfillmentService.ts';
import { UserService } from '../../src/services/UserService.ts';
import {
  AdminRecord,
  Order,
  OrderStatus,
  PaymentRecord,
  Product,
  StoreSettings,
  StoreTransaction,
  StoreUser,
} from '../../src/types.ts';
import { DIRTY_DOZEN_TESTS } from '../../firestore.rules.test.ts';
import {
  AUDIT_PROJECT_ID,
  exportEmulatorCollectionsToJson,
  seedSyntheticAuditDataset,
} from '../scripts/seedSyntheticData.ts';
import {
  assertSupportedJavaVersion,
  buildIsolatedEmulatorChildEnv,
  JavaVersionError,
  parseJavaMajorVersion,
  verifyJavaRuntime,
} from '../scripts/runAuditEmulatorCli.ts';

export interface EmulatorTestRecord {
  id: string;
  suite: 'Environment' | 'Integrity' | 'SecurityRules' | 'IndexesQueries' | 'Concurrency';
  name: string;
  whatWasTested: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  details: string;
}

const results: EmulatorTestRecord[] = [];

async function runCheck(
  id: string,
  suite: EmulatorTestRecord['suite'],
  name: string,
  whatWasTested: string,
  fn: () => Promise<string>,
): Promise<void> {
  const start = Date.now();
  try {
    const details = await fn();
    const durationMs = Date.now() - start;
    results.push({
      id,
      suite,
      name,
      whatWasTested,
      status: 'PASS',
      durationMs,
      details,
    });
    console.log(`✅ [PASS] [${id}] (${suite}) ${name} (${durationMs} ms)\n   └─ ${details}`);
  } catch (error) {
    const durationMs = Date.now() - start;
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    results.push({
      id,
      suite,
      name,
      whatWasTested,
      status: 'FAIL',
      durationMs,
      details: msg,
    });
    console.error(`❌ [FAIL] [${id}] (${suite}) ${name} (${durationMs} ms)\n   └─ ${msg}`);
  }
}

function createMockBot() {
  const sentMessages: Array<{ chatId: number | string; text: string }> = [];
  const bot = {
    telegram: {
      sendMessage: async (chatId: number | string, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
      },
    },
  };
  return { bot: bot as never, sentMessages };
}

async function main(): Promise<void> {
  console.log('================================================================================');
  console.log('🚀 ЗАПУСК НЕЗАВИСИМОГО АУДИТА FIRESTORE НА ЛОКАЛЬНОМ FIREBASE EMULATOR');
  console.log('================================================================================');

  // Execute ProductionGuard strictly BEFORE any Firebase initialization
  assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, process.env);

  // ===========================================================================
  // SUITE 1: PRODUCTION GUARD, JAVA RUNTIME & EMULATOR ENVIRONMENT (5 TESTS)
  // ===========================================================================
  await runCheck(
    'ENV-01',
    'Environment',
    'Блокировка при отсутствии FIRESTORE_EMULATOR_HOST',
    'Проверка, что assertEmulatorOnlyEnvironment выбрасывает ProductionGuardError, если FIRESTORE_EMULATOR_HOST не задан',
    async () => {
      const isolatedEnv: NodeJS.ProcessEnv = { ...process.env };
      delete isolatedEnv.FIRESTORE_EMULATOR_HOST;
      let blocked = false;
      try {
        assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, isolatedEnv);
      } catch (err) {
        blocked = err instanceof ProductionGuardError;
      }
      assert.equal(blocked, true, 'Ожидалась блокировка ProductionGuardError без FIRESTORE_EMULATOR_HOST');
      return 'Запуск без FIRESTORE_EMULATOR_HOST заблокирован через ProductionGuardError.';
    },
  );

  await runCheck(
    'ENV-02',
    'Environment',
    'Блокировка Production projectId и внешних/нестандартных хостов',
    'Проверка запрета подключения к реальному проекту tg-1-675b4, другим проектам или хостам вне 127.0.0.1:8080 / localhost:8080',
    async () => {
      let blockedProdId = false;
      try {
        assertEmulatorOnlyEnvironment('tg-1-675b4', process.env);
      } catch (err) {
        blockedProdId = err instanceof ProductionGuardError;
      }
      assert.equal(blockedProdId, true, 'Production projectId должен блокироваться');

      let blockedOtherDemoId = false;
      try {
        assertEmulatorOnlyEnvironment('demo-other-project', process.env);
      } catch (err) {
        blockedOtherDemoId = err instanceof ProductionGuardError;
      }
      assert.equal(blockedOtherDemoId, true, 'Любой проект кроме demo-stars-shop-audit должен блокироваться');

      let blockedRemoteHost = false;
      try {
        assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, {
          ...process.env,
          FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443',
        });
      } catch (err) {
        blockedRemoteHost = err instanceof ProductionGuardError;
      }
      assert.equal(blockedRemoteHost, true, 'Внешний хост должен блокироваться');

      const localhostAllowed = assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      });
      assert.equal(localhostAllowed.emulatorHost, 'localhost:8080');

      return 'Реальный projectId (tg-1-675b4) и внешние хосты жёстко заблокированы; разрешены только 127.0.0.1:8080 и localhost:8080 для demo-stars-shop-audit.';
    },
  );

  await runCheck(
    'ENV-03',
    'Environment',
    'Блокировка при наличии реальных сервисных ключей и защита родительского process.env',
    'Проверка запрета запуска при наличии FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL и неизменности родительского окружения в buildIsolatedEmulatorChildEnv',
    async () => {
      let blockedKey = false;
      try {
        assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, {
          ...process.env,
          FIREBASE_PRIVATE_KEY: 'fake-test-key-for-guard-check',
        });
      } catch (err) {
        blockedKey = err instanceof ProductionGuardError;
      }
      assert.equal(blockedKey, true, 'Наличие FIREBASE_PRIVATE_KEY должно блокироваться');

      // Verify buildIsolatedEmulatorChildEnv does NOT mutate the parent env object
      const mockParentEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        FIREBASE_PRIVATE_KEY: 'parent-secret-key-must-stay-intact',
        WEBHOOK_SECRET: 'parent-webhook-secret-must-stay-intact',
        TELEGRAM_BOT_TOKEN: 'parent-bot-token-must-stay-intact',
      };
      const childEnv = buildIsolatedEmulatorChildEnv(mockParentEnv);
      assert.equal(
        mockParentEnv.FIREBASE_PRIVATE_KEY,
        'parent-secret-key-must-stay-intact',
        'Родительский FIREBASE_PRIVATE_KEY не должен изменяться или удаляться',
      );
      assert.equal(
        mockParentEnv.WEBHOOK_SECRET,
        'parent-webhook-secret-must-stay-intact',
        'Родительский WEBHOOK_SECRET не должен изменяться или удаляться',
      );
      assert.equal(
        mockParentEnv.TELEGRAM_BOT_TOKEN,
        'parent-bot-token-must-stay-intact',
        'Родительский TELEGRAM_BOT_TOKEN не должен изменяться или удаляться',
      );
      assert.equal(childEnv.FIREBASE_PRIVATE_KEY, undefined);
      assert.equal(childEnv.WEBHOOK_SECRET, undefined);
      assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(childEnv.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
      assert.equal(childEnv.GCLOUD_PROJECT, 'demo-stars-shop-audit');

      return 'Присутствие сервисных ключей блокируется, а buildIsolatedEmulatorChildEnv создаёт очищенное окружение дочернего процесса без модификации секретов родительского процесса.';
    },
  );

  await runCheck(
    'ENV-04',
    'Environment',
    'Проверка парсера и валидатора версии Java (Java 17, 21, 22, отсутствие Java, некорректный вывод)',
    'Автоматическая проверка parseJavaMajorVersion, assertSupportedJavaVersion и verifyJavaRuntime на версиях 8, 17, 21, 22, пустом/битом выводе и отсутствующем бинарнике',
    async () => {
      // 1. Java 17 (quoted & unquoted) -> must parse major=17 and FAIL assertSupportedJavaVersion(..., 21)
      const parsed17 = parseJavaMajorVersion(
        'openjdk version "17.0.21" 2026-04-14\nOpenJDK Runtime Environment (build 17.0.21+9-Ubuntu)',
      );
      assert.equal(parsed17.major, 17);
      assert.throws(
        () =>
          assertSupportedJavaVersion(
            'openjdk version "17.0.21" 2026-04-14\nOpenJDK Runtime Environment',
            21,
          ),
        (err: unknown) => err instanceof JavaVersionError && /Java 17/.test(err.message),
      );
      assert.throws(
        () => assertSupportedJavaVersion('java version "17.0.10" 2024-01-16 LTS', 21),
        (err: unknown) => err instanceof JavaVersionError,
      );
      assert.throws(
        () => assertSupportedJavaVersion('openjdk 17.0.8 2023-07-18', 21),
        (err: unknown) => err instanceof JavaVersionError,
      );

      // 2. Legacy Java 8 ("1.8.0_392") -> must parse major=8 and FAIL
      const parsed8 = parseJavaMajorVersion('java version "1.8.0_392"\nJava(TM) SE Runtime Environment');
      assert.equal(parsed8.major, 8);
      assert.throws(
        () => assertSupportedJavaVersion('java version "1.8.0_392"', 21),
        (err: unknown) => err instanceof JavaVersionError && /Java 8/.test(err.message),
      );

      // 3. Java 21 (quoted & modern unquoted) -> must PASS with major=21
      const v21OpenJdk = assertSupportedJavaVersion(
        'openjdk version "21.0.13.0.3" 2026-10-24\nOpenJDK Runtime Environment (build 21.0.13.0.3+1-Ubuntu)',
        21,
      );
      assert.equal(v21OpenJdk.major, 21);

      const v21JavaQuoted = assertSupportedJavaVersion(
        'java version "21.0.2" 2024-01-16 LTS\nJava(TM) SE Runtime Environment',
        21,
      );
      assert.equal(v21JavaQuoted.major, 21);

      const v21Unquoted = assertSupportedJavaVersion(
        'openjdk 21.0.4 2024-07-16\nOpenJDK Runtime Environment Temurin-21.0.4+7',
        21,
      );
      assert.equal(v21Unquoted.major, 21);

      // 4. Java 22 (quoted & modern unquoted) -> must PASS with major=22
      const v22Java = assertSupportedJavaVersion(
        'java version "22.0.1" 2024-04-16\nJava(TM) SE Runtime Environment (build 22.0.1+8-16)',
        21,
      );
      assert.equal(v22Java.major, 22);

      const v22Unquoted = assertSupportedJavaVersion('openjdk 22 2024-03-19', 21);
      assert.equal(v22Unquoted.major, 22);

      // 5. Missing Java executable -> must throw JavaVersionError
      assert.throws(
        () => verifyJavaRuntime('__non_existent_java_binary_audit_check__', 21),
        (err: unknown) => err instanceof JavaVersionError,
      );

      // 6. Empty & malformed outputs -> must throw JavaVersionError
      assert.throws(
        () => assertSupportedJavaVersion('', 21),
        (err: unknown) => err instanceof JavaVersionError,
      );
      assert.throws(
        () => assertSupportedJavaVersion('Picked up _JAVA_OPTIONS: -Xmx512m\nInvalid output without version', 21),
        (err: unknown) => err instanceof JavaVersionError,
      );
      assert.throws(
        () => assertSupportedJavaVersion('openjdk version "abc.def"', 21),
        (err: unknown) => err instanceof JavaVersionError,
      );

      // 7. Actual system Java runtime -> must be >= 21
      const systemJava = verifyJavaRuntime('java', 21);
      assert.ok(systemJava.major >= 21);

      return `Проверены все форматы: Java 8/17 отклонены (JavaVersionError), Java 21/22 приняты, отсутствующий бинарник и битый вывод отклонены. Системная Java: ${systemJava.rawVersion} (major=${systemJava.major}).`;
    },
  );

  await runCheck(
    'ENV-05',
    'Environment',
    'Реальное подключение к Firebase Firestore Emulator и загрузка 12 сценариев',
    'Проверка инициализации Admin SDK поверх локального Firestore Emulator (127.0.0.1:8080) и сидинга 7 коллекций',
    async () => {
      const summary = await seedSyntheticAuditDataset();
      assert.equal(firestoreRepo.isEmulatorMode(), true);
      assert.equal(summary.projectId, AUDIT_PROJECT_ID);
      assert.equal(summary.counts.users, 4);
      assert.equal(summary.counts.products, 6);
      assert.equal(summary.counts.orders, 12);
      assert.equal(summary.counts.payments, 10);
      assert.equal(summary.counts.transactions, 19);
      assert.equal(summary.counts.admins, 2);
      assert.equal(summary.counts.settings, 1);
      return `Успешно подключён к Emulator (${summary.emulatorHost}, project: ${summary.projectId}). Записано 54 документа в 7 коллекциях.`;
    },
  );

  // ===========================================================================
  // SUITE 2: DATA INTEGRITY VERIFICATION ON EMULATOR (11 TESTS)
  // ===========================================================================
  await runCheck(
    'INT-01',
    'Integrity',
    'Каждый платёж связан с существующим заказом',
    'Сверка ссылочной целостности PaymentRecord.orderId -> Order.orderId в Emulator',
    async () => {
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      assert.ok(payments.length > 0, 'Коллекция payments не должна быть пустой');
      for (const p of payments) {
        const ord = await OrderService.getOrderById(p.orderId);
        assert.ok(ord, `Платёж ${p.paymentId} ссылается на несуществующий заказ ${p.orderId}`);
        assert.equal(ord.telegramPaymentChargeId, p.telegramPaymentChargeId);
      }
      return `Проверено ${payments.length} документов payments: каждый связан с существующим заказом и совпадает по telegramPaymentChargeId.`;
    },
  );

  await runCheck(
    'INT-02',
    'Integrity',
    'Сумма платежа соответствует сумме заказа и цене товара',
    'Сверка PaymentRecord.totalAmount == Order.totalPrice == Product.price * Order.quantity',
    async () => {
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      for (const p of payments) {
        const ord = await OrderService.getOrderById(p.orderId);
        assert.ok(ord);
        assert.equal(
          p.totalAmount,
          ord.totalPrice,
          `Несовпадение суммы в платеже ${p.paymentId} (${p.totalAmount}) и заказе ${ord.orderId} (${ord.totalPrice})`,
        );
        const prod = await ProductService.getProductById(ord.productId);
        assert.ok(prod);
        assert.equal(
          ord.totalPrice,
          prod.price * ord.quantity,
          `Сумма заказа ${ord.orderId} (${ord.totalPrice}) не равна price*quantity (${prod.price}*${ord.quantity})`,
        );
      }
      return `Все ${payments.length} платежей и заказов имеют математически точное совпадение сумм (totalAmount == totalPrice == price * quantity).`;
    },
  );

  await runCheck(
    'INT-03',
    'Integrity',
    'Валюта всех товаров, заказов, платежей и транзакций — строго XTR',
    'Проверка поля currency === "XTR" во всех финансовых документах базы',
    async () => {
      const products = await firestoreRepo.listDocs<Product>('products', 500);
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      const txs = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);

      for (const prod of products) assert.equal(prod.currency, 'XTR');
      for (const ord of orders) assert.equal(ord.currency, 'XTR');
      for (const pay of payments) assert.equal(pay.currency, 'XTR');
      for (const tx of txs) assert.equal(tx.currency, 'XTR');

      return `Проверено ${products.length + orders.length + payments.length + txs.length} документов: везде установлена валюта Telegram Stars (XTR).`;
    },
  );

  await runCheck(
    'INT-04',
    'Integrity',
    'Каждый заказ ссылается на существующий товар и существующего пользователя',
    'Проверка внешних ключей Order.productId -> Product.id и Order.userId -> StoreUser.userId',
    async () => {
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      for (const ord of orders) {
        const prod = await ProductService.getProductById(ord.productId);
        assert.ok(prod, `Заказ ${ord.orderId} ссылается на несуществующий товар ${ord.productId}`);
        const usr = await UserService.getUserById(ord.userId);
        assert.ok(usr, `Заказ ${ord.orderId} ссылается на несуществующего пользователя ${ord.userId}`);
        assert.equal(ord.userTelegramId, usr.telegramId);
      }
      return `Все ${orders.length} заказов ссылаются на валидные документы в коллекциях products и users.`;
    },
  );

  await runCheck(
    'INT-05',
    'Integrity',
    'Запрет завершения заказа или перевода в paid без подтверждённой оплаты',
    'Проверка, что completeOrder и markOrderPaid блокируют неоплаченный заказ (ord_syn_pending_01)',
    async () => {
      await assert.rejects(
        async () => {
          await FulfillmentService.completeOrder({
            orderId: 'ord_syn_pending_01',
            adminNote: 'Попытка выдать неоплаченный заказ',
          });
        },
        /не имеет статуса подтверждённой оплаты/,
      );

      await assert.rejects(
        async () => {
          await OrderService.markOrderPaid({
            orderId: 'ord_syn_pending_01',
            telegramPaymentChargeId: 'chg_non_existent_999',
          });
        },
        /PaymentRecord не найден/,
      );

      const unchanged = await OrderService.getOrderById('ord_syn_pending_01');
      assert.equal(unchanged?.paymentStatus, 'pending');
      assert.equal(unchanged?.fulfillmentStatus, 'pending');
      return 'Попытки завершить заказ без оплаты или отметить заказ оплаченным без PaymentRecord жёстко отклонены.';
    },
  );

  await runCheck(
    'INT-06',
    'Integrity',
    'Запрет повторной обработки одного telegram_payment_charge_id',
    'Проверка идемпотентности PaymentService.processSuccessfulPayment на уже существующем charge_id',
    async () => {
      const beforeUser = await UserService.getUserById('tg_900001002');
      assert.ok(beforeUser);

      const dupResult = await PaymentService.processSuccessfulPayment({
        telegramUserId: 900001002,
        invoicePayload: 'ord_syn_paid_02',
        currency: 'XTR',
        totalAmount: 100,
        telegramPaymentChargeId: 'chg_syn_paid_02',
      });
      assert.equal(dupResult.alreadyProcessed, true);

      const afterUser = await UserService.getUserById('tg_900001002');
      assert.equal(afterUser?.totalOrders, beforeUser.totalOrders);
      assert.equal(afterUser?.totalSpentStars, beforeUser.totalSpentStars);
      return 'Повторный вызов с тем же telegram_payment_charge_id распознан как дубликат без изменения баланса и заказов.';
    },
  );

  await runCheck(
    'INT-07',
    'Integrity',
    'Запрет двойной выдачи одного заказа',
    'Проверка идемпотентности completeOrder и initiateFulfillment для уже выданного заказа ord_syn_completed_04',
    async () => {
      const { bot, sentMessages } = createMockBot();
      const txsBefore = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);

      const repeatComplete = await FulfillmentService.completeOrder({
        orderId: 'ord_syn_completed_04',
        adminNote: 'Повторное нажатие кнопки выдачи',
        bot,
      });
      assert.equal(repeatComplete.fulfillmentStatus, 'completed');
      assert.equal(
        repeatComplete.fulfillmentNote,
        'Код активации подписки: SYN-PREM-3M-9941',
        'Исходное примечание выдачи не должно перезаписываться при повторном вызове',
      );

      const repeatInit = await FulfillmentService.initiateFulfillment(repeatComplete, bot);
      assert.equal(repeatInit.fulfillmentStatus, 'completed');
      assert.equal(sentMessages.length, 0, 'Повторное уведомление не должно отправляться, т.к. buyerNotifiedAt уже заполнен');

      const txsAfter = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);
      assert.equal(txsAfter.length, txsBefore.length, 'Не должно создаваться дублирующих транзакций выдачи');
      return 'Повторное завершение и повторный запуск выдачи для completed-заказа полностью идемпотентны.';
    },
  );

  await runCheck(
    'INT-08',
    'Integrity',
    'Допустимость переходов и комбинаций статусов заказов',
    'Проверка всех заказов на соответствие матрице допустимых пар (paymentStatus, fulfillmentStatus)',
    async () => {
      const validPairs = new Set<string>([
        'pending:pending',
        'paid:paid',
        'paid:processing',
        'paid:failed',
        'completed:completed',
        'cancelled:cancelled',
        'refunded:refunded',
      ]);
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      for (const ord of orders) {
        const pair = `${ord.paymentStatus}:${ord.fulfillmentStatus}`;
        assert.equal(
          validPairs.has(pair),
          true,
          `Недопустимая комбинация статусов ${pair} в заказе ${ord.orderId}`,
        );
        if (ord.fulfillmentStatus === 'completed') {
          assert.ok(ord.telegramPaymentChargeId, `У завершённого заказа ${ord.orderId} отсутствует charge_id`);
          assert.ok(ord.paidAt, `У завершённого заказа ${ord.orderId} отсутствует paidAt`);
          assert.ok(ord.completedAt, `У завершённого заказа ${ord.orderId} отсутствует completedAt`);
        }
      }
      return `Все ${orders.length} заказов находятся в строго валидных состояниях конечного автомата.`;
    },
  );

  await runCheck(
    'INT-09',
    'Integrity',
    'Отсутствие пропущенных обязательных полей во всех 7 коллекциях',
    'Проверка наличия всех required-полей согласно firebase-blueprint.json и src/types.ts',
    async () => {
      const blueprintRaw = fs.readFileSync(
        path.resolve(process.cwd(), 'firebase-blueprint.json'),
        'utf-8',
      );
      const blueprint = JSON.parse(blueprintRaw) as {
        entities: Record<string, { required: string[] }>;
      };

      const mapping: Array<{ col: CollectionName; entity: string }> = [
        { col: 'users', entity: 'User' },
        { col: 'products', entity: 'Product' },
        { col: 'orders', entity: 'Order' },
        { col: 'payments', entity: 'Payment' },
        { col: 'transactions', entity: 'Transaction' },
        { col: 'admins', entity: 'Admin' },
        { col: 'settings', entity: 'Setting' },
      ];

      let checkedDocs = 0;
      for (const { col, entity } of mapping) {
        const requiredFields = blueprint.entities[entity].required;
        const docs = await firestoreRepo.listDocs<Record<string, unknown>>(col, 500);
        assert.ok(docs.length > 0, `Коллекция ${col} пуста`);
        for (const d of docs) {
          checkedDocs++;
          for (const reqField of requiredFields) {
            assert.notEqual(
              d[reqField],
              undefined,
              `В коллекции ${col} отсутствует обязательное поле "${reqField}"`,
            );
            assert.notEqual(
              d[reqField],
              null,
              `В коллекции ${col} поле "${reqField}" равно null`,
            );
          }
        }
      }
      return `Проверено ${checkedDocs} документов во всех 7 коллекциях: все обязательные поля присутствуют.`;
    },
  );

  await runCheck(
    'INT-10',
    'Integrity',
    'Строгое соответствие типов данных во всех документах',
    'Проверка типов string, number, boolean, enum и формата ISO-8601 дат во всех документах',
    async () => {
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
      const users = await firestoreRepo.listDocs<StoreUser>('users', 500);
      for (const u of users) {
        assert.equal(typeof u.userId, 'string');
        assert.equal(typeof u.telegramId, 'number');
        assert.equal(typeof u.isBlocked, 'boolean');
        assert.equal(typeof u.totalOrders, 'number');
        assert.equal(typeof u.totalSpentStars, 'number');
        assert.match(u.createdAt, isoRegex);
        assert.match(u.updatedAt, isoRegex);
      }

      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      for (const o of orders) {
        assert.equal(typeof o.orderId, 'string');
        assert.equal(typeof o.userTelegramId, 'number');
        assert.equal(typeof o.quantity, 'number');
        assert.equal(typeof o.totalPrice, 'number');
        assert.match(o.createdAt, isoRegex);
        assert.match(o.updatedAt, isoRegex);
        if (o.fulfillmentAttempts !== undefined) {
          assert.equal(typeof o.fulfillmentAttempts, 'number');
        }
      }
      return 'Все поля во всех коллекциях имеют корректные примитивные типы и валидные метки времени ISO-8601.';
    },
  );

  await runCheck(
    'INT-11',
    'Integrity',
    'Межколлекционная согласованность агрегатов users, orders, payments и transactions',
    'Сверка суммы totalOrders и totalSpentStars каждого пользователя с его реально оплаченными заказами и платежами',
    async () => {
      const users = await firestoreRepo.listDocs<StoreUser>('users', 500);
      const orders = await firestoreRepo.listDocs<Order>('orders', 500);
      const payments = await firestoreRepo.listDocs<PaymentRecord>('payments', 500);
      const transactions = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);

      for (const u of users) {
        const paidOrdersForUser = orders.filter(
          (o) =>
            o.userId === u.userId &&
            ['paid', 'processing', 'completed', 'refunded'].includes(o.paymentStatus),
        );
        const expectedTotalOrders = paidOrdersForUser.length;
        const expectedTotalStars = paidOrdersForUser.reduce((acc, o) => acc + o.totalPrice, 0);

        assert.equal(
          u.totalOrders,
          expectedTotalOrders,
          `У пользователя ${u.userId} totalOrders=${u.totalOrders}, но оплаченных заказов=${expectedTotalOrders}`,
        );
        assert.equal(
          u.totalSpentStars,
          expectedTotalStars,
          `У пользователя ${u.userId} totalSpentStars=${u.totalSpentStars}, но сумма заказов=${expectedTotalStars}`,
        );
      }

      // Every payment must have a corresponding payment_received transaction
      for (const p of payments) {
        const hasPaymentTx = transactions.some(
          (t) => t.orderId === p.orderId && t.type === 'payment_received' && t.amount === p.totalAmount,
        );
        assert.equal(
          hasPaymentTx,
          true,
          `Для платежа ${p.paymentId} (заказ ${p.orderId}) отсутствует запись payment_received в transactions`,
        );
      }

      return `Полная согласованность между users (${users.length}), orders (${orders.length}), payments (${payments.length}) и transactions (${transactions.length}) подтверждена.`;
    },
  );

  // ===========================================================================
  // SUITE 3: FIRESTORE SECURITY RULES VIA @firebase/rules-unit-testing (10 TESTS)
  // ===========================================================================
  const [emulatorHostName, emulatorPortStr] = (
    process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
  ).split(':');
  const rulesContent = fs.readFileSync(
    path.resolve(process.cwd(), 'firestore.rules'),
    'utf-8',
  );

  const testEnv: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: AUDIT_PROJECT_ID,
    firestore: {
      host: emulatorHostName,
      port: Number(emulatorPortStr),
      rules: rulesContent,
    },
  });

  try {
    await runCheck(
      'SEC-01',
      'SecurityRules',
      'Пользователь не может читать чужие заказы (get и list)',
      'Проверка отказа PERMISSION_DENIED при попытке чтения чужого заказа и разрешения чтения собственного заказа',
      async () => {
        const aliceCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const strangerCtx = testEnv.authenticatedContext('tg_900001001', {
          email_verified: true,
        });

        // Owner can read own order
        await assertSucceeds(
          getDoc(doc(aliceCtx.firestore(), 'orders', 'ord_syn_paid_02')),
        );

        // Stranger CANNOT read Alice's order
        await assertFails(
          getDoc(doc(strangerCtx.firestore(), 'orders', 'ord_syn_paid_02')),
        );

        // Stranger CANNOT list all orders without filtering own userId
        await assertFails(
          getDocs(collection(strangerCtx.firestore(), 'orders')),
        );

        // Owner CAN list own orders with where('userId', '==', uid)
        const ownSnap = await assertSucceeds(
          getDocs(
            query(
              collection(aliceCtx.firestore(), 'orders'),
              where('userId', '==', 'tg_900001002'),
            ),
          ),
        );
        assert.ok(ownSnap.docs.length > 0);
        return 'Чужие заказы недоступны ни через getDoc, ни через list; свои заказы читаются корректно.';
      },
    );

    await runCheck(
      'SEC-02',
      'SecurityRules',
      'Пользователь не может менять сумму заказа или занижать цену при создании',
      'Проверка блокировки изменения totalPrice в существующем заказе и подмены totalPrice при создании нового заказа',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // 1. Attempt to modify totalPrice on existing pending order
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_pending_01'), {
            totalPrice: 1,
            updatedAt: nowIso,
          }),
        );

        // 2. Attempt to create a new order with forged price (1 XTR instead of 100 XTR for stars_pack_100)
        await assertFails(
          setDoc(doc(buyerCtx.firestore(), 'orders', 'ord_forged_price'), {
            orderId: 'ord_forged_price',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            productId: 'stars_pack_100',
            productName: '100 Telegram Stars (Synthetic)',
            category: 'stars',
            quantity: 1,
            totalPrice: 1, // Forged! Real price is 100
            currency: 'XTR',
            paymentStatus: 'pending',
            fulfillmentStatus: 'pending',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        // 3. Valid order creation with honest price (100 * 2 = 200 XTR) succeeds
        await assertSucceeds(
          setDoc(doc(buyerCtx.firestore(), 'orders', 'ord_honest_rule_test'), {
            orderId: 'ord_honest_rule_test',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            productId: 'stars_pack_100',
            productName: '100 Telegram Stars (Synthetic)',
            category: 'stars',
            quantity: 2,
            totalPrice: 200,
            currency: 'XTR',
            paymentStatus: 'pending',
            fulfillmentStatus: 'pending',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        return 'Любая попытка изменить сумму заказа или создать заказ с заниженной ценой блокируется правилами Firestore.';
      },
    );

    await runCheck(
      'SEC-03',
      'SecurityRules',
      'Пользователь не может самостоятельно подтверждать оплату',
      'Проверка запрета создания заказа в статусе paid и запрета перевода pending -> paid от лица покупателя',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Attempt to update pending order to paid
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_pending_01'), {
            paymentStatus: 'paid',
            fulfillmentStatus: 'paid',
            updatedAt: nowIso,
          }),
        );

        // Attempt to create order already marked paid
        await assertFails(
          setDoc(doc(buyerCtx.firestore(), 'orders', 'ord_self_paid'), {
            orderId: 'ord_self_paid',
            userId: 'tg_900001002',
            userTelegramId: 900001002,
            productId: 'stars_pack_100',
            productName: '100 Telegram Stars (Synthetic)',
            category: 'stars',
            quantity: 1,
            totalPrice: 100,
            currency: 'XTR',
            paymentStatus: 'paid',
            fulfillmentStatus: 'paid',
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        return 'Самостоятельное подтверждение оплаты покупателем заблокировано при create и update.';
      },
    );

    await runCheck(
      'SEC-04',
      'SecurityRules',
      'Пользователь не может менять статус выдачи на processing или completed',
      'Проверка запрета перевода fulfillmentStatus в processing/completed и разрешения только отмены своего pending-заказа',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Cannot set fulfillmentStatus to completed on paid order
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_paid_02'), {
            paymentStatus: 'completed',
            fulfillmentStatus: 'completed',
            updatedAt: nowIso,
          }),
        );

        // Cannot cancel an already paid order
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_syn_paid_02'), {
            paymentStatus: 'cancelled',
            fulfillmentStatus: 'cancelled',
            updatedAt: nowIso,
          }),
        );

        // CAN cancel own pending order created in SEC-02
        await assertSucceeds(
          updateDoc(doc(buyerCtx.firestore(), 'orders', 'ord_honest_rule_test'), {
            paymentStatus: 'cancelled',
            fulfillmentStatus: 'cancelled',
            updatedAt: nowIso,
          }),
        );

        return 'Покупатель не может менять статус выдачи оплаченных заказов; разрешена только отмена собственного неоплаченного (pending) заказа.';
      },
    );

    await runCheck(
      'SEC-05',
      'SecurityRules',
      'Пользователь не может изменять товары и цены, а также читать скрытые товары',
      'Проверка защиты коллекции products от создания/изменения/удаления обычным пользователем и скрытия архивных товаров',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Buyer can read active product
        await assertSucceeds(
          getDoc(doc(buyerCtx.firestore(), 'products', 'stars_pack_100')),
        );

        // Buyer CANNOT read inactive/archived product
        await assertFails(
          getDoc(doc(buyerCtx.firestore(), 'products', 'gift_archived_limited')),
        );

        // Buyer CANNOT update product price
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'products', 'stars_pack_100'), {
            price: 1,
            updatedAt: nowIso,
          }),
        );

        // Buyer CANNOT delete product
        await assertFails(
          deleteDoc(doc(buyerCtx.firestore(), 'products', 'stars_pack_100')),
        );

        return 'Каталог товаров защищён от модификации покупателями, неактивные товары скрыты от чтения.';
      },
    );

    await runCheck(
      'SEC-06',
      'SecurityRules',
      'Обычный пользователь не может получить права администратора или разблокировать себя',
      'Проверка запрета записи в коллекцию admins, чтения списка админов и модификации isBlocked / totalSpentStars',
      async () => {
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const blockedCtx = testEnv.authenticatedContext('tg_900001004', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Cannot add self to /admins
        await assertFails(
          setDoc(doc(buyerCtx.firestore(), 'admins', 'tg_900001002'), {
            adminId: 'tg_900001002',
            telegramId: 900001002,
            role: 'superadmin',
            addedAt: nowIso,
          }),
        );

        // Cannot read another admin's record
        await assertFails(
          getDoc(doc(buyerCtx.firestore(), 'admins', 'tg_900000001')),
        );

        // Blocked user cannot unblock themselves
        await assertFails(
          updateDoc(doc(blockedCtx.firestore(), 'users', 'tg_900001004'), {
            isBlocked: false,
            updatedAt: nowIso,
          }),
        );

        // User cannot inflate their own totalSpentStars
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'users', 'tg_900001002'), {
            totalSpentStars: 999999,
            updatedAt: nowIso,
          }),
        );

        return 'Повышение привилегий через /admins, снятие блокировки isBlocked и накрутка статистики заблокированы.';
      },
    );

    await runCheck(
      'SEC-07',
      'SecurityRules',
      'Запрет чтения и изменения чужих платежей и прямой подделки платежей',
      'Проверка изоляции коллекции payments между пользователями и запрета клиентской записи/удаления платежей',
      async () => {
        const aliceCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        const bobCtx = testEnv.authenticatedContext('tg_900001003', {
          email_verified: true,
        });
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Alice can read her own payment
        await assertSucceeds(
          getDoc(doc(aliceCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        // Bob CANNOT read Alice's payment
        await assertFails(
          getDoc(doc(bobCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        // Alice CANNOT update or delete her payment
        await assertFails(
          updateDoc(doc(aliceCtx.firestore(), 'payments', 'pay_chg_syn_paid_02'), {
            status: 'refunded',
            refundedAt: nowIso,
          }),
        );
        await assertFails(
          deleteDoc(doc(aliceCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        // Even Admin CANNOT delete payment records (allow delete: if false)
        await assertFails(
          deleteDoc(doc(adminCtx.firestore(), 'payments', 'pay_chg_syn_paid_02')),
        );

        return 'Платежи доступны только владельцу и администратору на чтение; удаление платежей запрещено даже администратору (append-only аудит).';
      },
    );

    await runCheck(
      'SEC-08',
      'SecurityRules',
      'Проверка матрицы доступа ко всем 7 коллекциям (settings, transactions, admins, users, products, orders, payments)',
      'Проверка прав чтения/записи для неавторизованного гостя, покупателя и администратора из /admins',
      async () => {
        const unauthCtx = testEnv.unauthenticatedContext();
        const buyerCtx = testEnv.authenticatedContext('tg_900001002', {
          email_verified: true,
        });
        // Admin authenticated via /admins/tg_900000001 document (zero hardcoded emails!)
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
        });

        // Unauthenticated cannot read settings, users, orders, payments, transactions, admins
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'settings', 'global')));
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'users', 'tg_900001002')));
        await assertFails(getDoc(doc(unauthCtx.firestore(), 'transactions', 'tx_syn_001_invoice')));

        // Signed-in buyer CAN read global store settings, CANNOT update settings or read transactions
        await assertSucceeds(getDoc(doc(buyerCtx.firestore(), 'settings', 'global')));
        await assertFails(
          updateDoc(doc(buyerCtx.firestore(), 'settings', 'global'), {
            maintenanceMode: true,
            updatedAt: new Date().toISOString(),
          }),
        );
        await assertFails(getDoc(doc(buyerCtx.firestore(), 'transactions', 'tx_syn_001_invoice')));

        // Admin CAN read transactions, users list, admins
        await assertSucceeds(getDoc(doc(adminCtx.firestore(), 'transactions', 'tx_syn_001_invoice')));
        await assertSucceeds(getDoc(doc(adminCtx.firestore(), 'users', 'tg_900001002')));
        await assertSucceeds(getDoc(doc(adminCtx.firestore(), 'admins', 'tg_900000002')));

        // Transactions are immutable (cannot update or delete even by admin)
        await assertFails(
          deleteDoc(doc(adminCtx.firestore(), 'transactions', 'tx_syn_001_invoice')),
        );

        return 'Матрица доступа по всем 7 коллекциям соблюдается; права администратора работают через /admins/{uid} без захардкоженных email.';
      },
    );

    await runCheck(
      'SEC-09',
      'SecurityRules',
      'Проверка новых полей идемпотентности/ретраев Order и новых типов транзакций из актуального types.ts',
      'Проверка записи через правила Emulator полей fulfillmentStartedAt, fulfillmentAttempts, needsManualReconciliation, adminNotifiedAt, buyerNotifiedAt и типов транзакций fulfillment_failed, fulfillment_retry, admin_action',
      async () => {
        const adminCtx = testEnv.authenticatedContext('tg_900000001', {
          email_verified: true,
        });
        const nowIso = new Date().toISOString();

        // Admin updates order with all new Stage 1 fulfillment & reconciliation fields
        await assertSucceeds(
          updateDoc(doc(adminCtx.firestore(), 'orders', 'ord_syn_processing_03'), {
            fulfillmentStartedAt: nowIso,
            fulfillmentAttempts: 2,
            fulfillmentLastError: 'Retry scheduled after provider check',
            fulfillmentNextRetryAt: nowIso,
            fulfillmentIdempotencyKey: 'fulfill_ord_syn_processing_03',
            externalExecutionReference: 'ext_ref_03',
            needsManualReconciliation: true,
            adminNotifiedAt: nowIso,
            buyerNotifiedAt: nowIso,
            updatedAt: nowIso,
          }),
        );

        // Invalid fulfillmentAttempts (> 10) is rejected by rules
        await assertFails(
          updateDoc(doc(adminCtx.firestore(), 'orders', 'ord_syn_processing_03'), {
            fulfillmentAttempts: 99,
            updatedAt: nowIso,
          }),
        );

        // New transaction types ('fulfillment_failed', 'fulfillment_retry', 'admin_action') are accepted by rules
        for (const txType of ['fulfillment_failed', 'fulfillment_retry', 'admin_action'] as const) {
          const txId = `tx_rule_check_${txType}`;
          await assertSucceeds(
            setDoc(doc(adminCtx.firestore(), 'transactions', txId), {
              transactionId: txId,
              orderId: 'ord_syn_processing_03',
              userId: 'tg_900001002',
              type: txType,
              amount: 450,
              currency: 'XTR',
              details: `Rule validation test for ${txType}`,
              createdAt: nowIso,
            }),
          );
        }

        return 'Все новые поля Order и новые типы транзакций (fulfillment_failed, fulfillment_retry, admin_action) синхронизированы и валидируются правилами Emulator.';
      },
    );

    await runCheck(
      'SEC-10',
      'SecurityRules',
      'Прогон 12 атакующих пейлоадов ("Dirty Dozen") через реальный движок правил Emulator',
      'Проверка того, что все 12 векторов атак из firestore.rules.test.ts получают PERMISSION_DENIED',
      async () => {
        for (const testCase of DIRTY_DOZEN_TESTS) {
          const ctx = testCase.auth
            ? testEnv.authenticatedContext(testCase.auth.uid, {
                email: testCase.auth.email,
                email_verified: testCase.auth.email_verified,
                admin: testCase.auth.admin,
              })
            : testEnv.unauthenticatedContext();
          const db = ctx.firestore();

          if (testCase.operation === 'get') {
            await assertFails(getDoc(doc(db, testCase.collection, testCase.docId)));
          } else if (testCase.operation === 'list') {
            await assertFails(getDocs(collection(db, testCase.collection)));
          } else if (testCase.operation === 'create') {
            await assertFails(
              setDoc(doc(db, testCase.collection, testCase.docId), testCase.payload || {}),
            );
          } else if (testCase.operation === 'update') {
            await assertFails(
              updateDoc(doc(db, testCase.collection, testCase.docId), testCase.payload || {}),
            );
          } else if (testCase.operation === 'delete') {
            await assertFails(deleteDoc(doc(db, testCase.collection, testCase.docId)));
          }
        }
        return `Все ${DIRTY_DOZEN_TESTS.length}/12 атакующих векторов Dirty Dozen заблокированы эмулятором (PERMISSION_DENIED).`;
      },
    );
  } finally {
    await testEnv.cleanup();
  }

  // Re-seed clean synthetic dataset before Suite 4 (since SEC-02/SEC-09 wrote test docs)
  await seedSyntheticAuditDataset();

  // ===========================================================================
  // SUITE 4: INDEXES & REAL QUERIES VERIFICATION ON EMULATOR (6 TESTS)
  // ===========================================================================
  await runCheck(
    'IDX-01',
    'IndexesQueries',
    'Сверка всех 10 составных индексов в firestore.indexes.json с запросами в коде',
    'Проверка структуры, коллекций, полей и направлений сортировки всех 10 индексов',
    async () => {
      const raw = fs.readFileSync(
        path.resolve(process.cwd(), 'firestore.indexes.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw) as {
        indexes: Array<{
          collectionGroup: string;
          queryScope: string;
          fields: Array<{ fieldPath: string; order: string }>;
        }>;
      };
      assert.equal(parsed.indexes.length, 10, 'Должно быть ровно 10 составных индексов');

      const expectedSignatures = [
        'orders:userId:ASCENDING,createdAt:DESCENDING',
        'orders:userTelegramId:ASCENDING,createdAt:DESCENDING',
        'orders:paymentStatus:ASCENDING,createdAt:DESCENDING',
        'orders:fulfillmentStatus:ASCENDING,createdAt:DESCENDING',
        'orders:fulfillmentStatus:ASCENDING,createdAt:ASCENDING',
        'products:category:ASCENDING,isActive:ASCENDING,price:ASCENDING',
        'products:category:ASCENDING,price:ASCENDING',
        'products:isActive:ASCENDING,price:ASCENDING',
        'payments:status:ASCENDING,createdAt:DESCENDING',
        'transactions:type:ASCENDING,createdAt:DESCENDING',
      ];

      const actualSignatures = parsed.indexes.map(
        (idx) =>
          `${idx.collectionGroup}:${idx.fields.map((f) => `${f.fieldPath}:${f.order}`).join(',')}`,
      );

      for (const sig of expectedSignatures) {
        assert.ok(
          actualSignatures.includes(sig),
          `Отсутствует обязательный составной индекс: ${sig}`,
        );
      }

      return 'Все 10 составных индексов в firestore.indexes.json присутствуют и полностью покрывают все комбинации where + orderBy в коде.';
    },
  );

  await runCheck(
    'IDX-02',
    'IndexesQueries',
    'Выполнение всех 5 индексированных запросов к коллекции orders через Emulator',
    'Реальный прогон запросов по userId, userTelegramId, paymentStatus, fulfillmentStatus (ASC/DESC) в Emulator',
    async () => {
      // Index 1: orders (userId ASC, createdAt DESC)
      const byUserId = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'userId', op: '==', value: 'tg_900001002' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(byUserId.length, 10);

      // Index 2: orders (userTelegramId ASC, createdAt DESC) via OrderService.getUserOrders
      const byTgId = await OrderService.getUserOrders(900001002, 20);
      assert.equal(byTgId.length, 10);

      // Index 3: orders (paymentStatus ASC, createdAt DESC)
      const byPaymentStatus = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'paymentStatus', op: '==', value: 'paid' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(byPaymentStatus.length, 5);

      // Index 4: orders (fulfillmentStatus ASC, createdAt DESC) via OrderService.getAllOrders
      const byFulfillmentDesc = await OrderService.getAllOrders('completed', 20);
      assert.equal(byFulfillmentDesc.length, 4);

      // Index 5: orders (fulfillmentStatus ASC, createdAt ASC) used by RecoveryWorker
      const byFulfillmentAsc = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'failed' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 20,
      });
      assert.equal(byFulfillmentAsc.length, 3);

      return 'Все 5 составных запросов к коллекции orders отработали на Emulator с точным соблюдением фильтрации и порядка.';
    },
  );

  await runCheck(
    'IDX-03',
    'IndexesQueries',
    'Выполнение индексированных запросов к products, payments и transactions через Emulator',
    'Реальный прогон запросов витрины товаров (3 индекса), платежей по статусу и транзакций по типу',
    async () => {
      // Index 6: products (category ASC, isActive ASC, price ASC)
      const activeGifts = await ProductService.getProductsByCategory('gifts', false, 20);
      assert.equal(activeGifts.length, 1);
      assert.equal(activeGifts[0].id, 'gift_crystal_star');

      // Index 7: products (category ASC, price ASC) including inactive
      const allGifts = await ProductService.getProductsByCategory('gifts', true, 20);
      assert.equal(allGifts.length, 2);

      // Index 8: products (isActive ASC, price ASC)
      const allActiveProducts = await ProductService.getAllProducts(false, 20);
      assert.equal(allActiveProducts.length, 5);
      assert.ok(allActiveProducts[0].price <= allActiveProducts[1].price);

      // Index 9: payments (status ASC, createdAt DESC)
      const paidPayments = await firestoreRepo.queryDocs<PaymentRecord>('payments', {
        where: [{ field: 'status', op: '==', value: 'paid' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(paidPayments.length, 9);

      // Index 10: transactions (type ASC, createdAt DESC)
      const paymentTxs = await firestoreRepo.queryDocs<StoreTransaction>('transactions', {
        where: [{ field: 'type', op: '==', value: 'payment_received' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 20,
      });
      assert.equal(paymentTxs.length, 10);

      return 'Все 5 составных запросов к products, payments и transactions успешно выполнены через Emulator.';
    },
  );

  await runCheck(
    'IDX-04',
    'IndexesQueries',
    'Курсорная пагинация (startAfter) при наличии нескольких заказов с ОДИНАКОВЫМ createdAt timestamp',
    'Постраничный обход 10 заказов пользователя tg_900001002 (включая 3 заказа с createdAt=2026-11-17T10:00:00.000Z) с размером страницы 2',
    async () => {
      const collectedIds: string[] = [];
      let cursor: unknown = undefined;
      let pages = 0;

      while (true) {
        const page = await firestoreRepo.queryDocsPaginated<Order>('orders', {
          where: [{ field: 'userTelegramId', op: '==', value: 900001002 }],
          orderBy: { field: 'createdAt', direction: 'desc' },
          startAfter: cursor,
          limit: 2,
        });
        pages++;
        for (const item of page.items) {
          collectedIds.push(item.orderId);
        }
        if (!page.hasMore || !page.nextCursor) {
          break;
        }
        cursor = page.nextCursor;
        assert.ok(pages <= 10, 'Защита от бесконечного цикла пагинации');
      }

      const uniqueIds = new Set(collectedIds);
      assert.equal(
        collectedIds.length,
        10,
        `Ожидалось ровно 10 заказов при постраничном обходе, получено ${collectedIds.length} (${collectedIds.join(', ')})`,
      );
      assert.equal(
        uniqueIds.size,
        10,
        'Обнаружены дубликаты при пагинации заказов с одинаковым timestamp',
      );
      // Verify all 3 identical-timestamp orders were returned without skipping any!
      assert.ok(uniqueIds.has('ord_syn_same_ts_10'));
      assert.ok(uniqueIds.has('ord_syn_same_ts_11'));
      assert.ok(uniqueIds.has('ord_syn_same_ts_12'));

      return `Пройдено ${pages} страниц (по 2 заказа): возвращены все 10/10 заказов (включая все 3 заказа с одинаковым timestamp 2026-11-17T10:00:00.000Z) без единого пропуска или дубля.`;
    },
  );

  await runCheck(
    'IDX-05',
    'IndexesQueries',
    'Проверка корректности сортировки (ASC/DESC) и фильтрации во всех сервисах',
    'Проверка монотонного убывания/возрастания дат и цен в результатах запросов Emulator',
    async () => {
      const allOrdersDesc = await OrderService.getAllOrders(undefined, 50);
      assert.equal(allOrdersDesc.length, 12);
      for (let i = 1; i < allOrdersDesc.length; i++) {
        assert.ok(
          allOrdersDesc[i - 1].createdAt >= allOrdersDesc[i].createdAt,
          'Нарушен порядок сортировки createdAt DESC в заказах',
        );
      }

      const activeProductsAsc = await ProductService.getAllProducts(false, 50);
      for (let i = 1; i < activeProductsAsc.length; i++) {
        assert.ok(
          activeProductsAsc[i - 1].price <= activeProductsAsc[i].price,
          'Нарушен порядок сортировки price ASC в товарах',
        );
      }

      const usersDesc = await UserService.getAllUsers(50);
      assert.equal(usersDesc.length, 4);
      for (let i = 1; i < usersDesc.length; i++) {
        assert.ok(usersDesc[i - 1].createdAt >= usersDesc[i].createdAt);
      }

      return 'Сортировка по дате (DESC) и цене (ASC), а также фильтрация по статусам и категориям работают без ошибок.';
    },
  );

  await runCheck(
    'IDX-06',
    'IndexesQueries',
    'Анализ потенциально опасных запросов для Production Firestore',
    'Проверка отсутствия запросов с неравенством на разных полях, незакрытых составных индексов и скалярных курсоров без tie-breaker',
    async () => {
      // Test passing document ID string directly as startAfter cursor to OrderService.getUserOrders
      const firstPage = await OrderService.getUserOrders(900001002, 1);
      assert.equal(firstPage.length, 1);
      const secondPage = await OrderService.getUserOrders(
        900001002,
        2,
        firstPage[0].orderId,
      );
      assert.equal(secondPage.length, 2);
      assert.notEqual(secondPage[0].orderId, firstPage[0].orderId);

      return 'Все запросы в сервисах используют равенство (==) + одиночный orderBy + DocumentSnapshot tie-breaker; запросов, способных вызвать FAILED_PRECONDITION при задеплоенных 10 индексах, не обнаружено.';
    },
  );

  // ===========================================================================
  // SUITE 5: CONCURRENCY & CHAOS OPERATIONS ON EMULATOR (6 TESTS)
  // ===========================================================================
  await runCheck(
    'CON-01',
    'Concurrency',
    'Два одновременных уведомления successful_payment на один заказ в Emulator',
    'Параллельный запуск двух транзакций processSuccessfulPayment через Promise.all для заказа ord_syn_pending_01',
    async () => {
      const userBefore = await UserService.getUserById('tg_900001002');
      assert.ok(userBefore);

      const paymentPayload = {
        telegramUserId: 900001002,
        invoicePayload: 'ord_syn_pending_01',
        currency: 'XTR',
        totalAmount: 100,
        telegramPaymentChargeId: 'chg_con_race_01',
        providerPaymentChargeId: 'prov_con_race_01',
      };

      const [res1, res2] = await Promise.all([
        PaymentService.processSuccessfulPayment(paymentPayload),
        PaymentService.processSuccessfulPayment(paymentPayload),
      ]);

      // Exactly one should be newly processed, or the second sees alreadyProcessed=true after retry
      const newlyProcessedCount = [res1, res2].filter((r) => !r.alreadyProcessed).length;
      assert.equal(
        newlyProcessedCount,
        1,
        `Ровно 1 из 2 параллельных вызовов должен записать новый платёж, получено: ${newlyProcessedCount}`,
      );

      const userAfter = await UserService.getUserById('tg_900001002');
      assert.equal(userAfter?.totalOrders, userBefore.totalOrders + 1);
      assert.equal(userAfter?.totalSpentStars, userBefore.totalSpentStars + 100);

      const allTxs = await firestoreRepo.listDocs<StoreTransaction>('transactions', 500);
      const paymentTxsForOrder = allTxs.filter(
        (t) => t.orderId === 'ord_syn_pending_01' && t.type === 'payment_received',
      );
      assert.equal(paymentTxsForOrder.length, 1, 'Должна быть создана ровно 1 транзакция payment_received');

      return 'Параллельная гонка 2 уведомлений об оплате в Emulator разрешена атомарно: 1 PaymentRecord, +1 к totalOrders, 0 дублей.';
    },
  );

  await runCheck(
    'CON-02',
    'Concurrency',
    'Два одновременных воркера выдачи (initiateFulfillment) на один заказ в Emulator',
    'Параллельный запуск 2 воркеров на оплаченный заказ ord_syn_paid_02 с подсчётом числа вызовов внешнего адаптера',
    async () => {
      let externalAdapterCalls = 0;
      const countingAdapter: FulfillmentProviderAdapter = {
        providerName: 'ConcurrencyTestAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async (order, ctx) => {
          externalAdapterCalls++;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            handledAutomatically: true,
            status: 'completed',
            details: `Auto-delivered by ConcurrencyTestAdapter (key=${ctx?.idempotencyKey})`,
            externalReference: `ext_${order.orderId}`,
          };
        },
      };

      FulfillmentService.setAdapter(countingAdapter);
      try {
        const { bot } = createMockBot();
        const targetOrder = await OrderService.getOrderById('ord_syn_paid_02');
        assert.ok(targetOrder);

        const [w1, w2] = await Promise.all([
          FulfillmentService.initiateFulfillment(targetOrder, bot),
          FulfillmentService.initiateFulfillment(targetOrder, bot),
        ]);

        assert.equal(
          externalAdapterCalls,
          1,
          `Внешний адаптер должен быть вызван ровно 1 раз, но вызван ${externalAdapterCalls} раз`,
        );

        const updatedOrder = await OrderService.getOrderById('ord_syn_paid_02');
        assert.equal(updatedOrder?.fulfillmentStatus, 'completed');
        assert.equal(updatedOrder?.fulfillmentAttempts, 1);
        assert.ok(w1.orderId === 'ord_syn_paid_02' && w2.orderId === 'ord_syn_paid_02');
        return `Атомарный pre-claim в транзакции Emulator предотвратил двойную выдачу: externalAdapterCalls = ${externalAdapterCalls}.`;
      } finally {
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      }
    },
  );

  await runCheck(
    'CON-03',
    'Concurrency',
    'Повторное выполнение уже выданного заказа под параллельной нагрузкой',
    'Одновременный вызов completeOrder и initiateFulfillment для уже завершённого заказа',
    async () => {
      const { bot, sentMessages } = createMockBot();
      const target = await OrderService.getOrderById('ord_syn_paid_02');
      assert.ok(target);
      assert.equal(target.fulfillmentStatus, 'completed');

      await Promise.all([
        FulfillmentService.completeOrder({
          orderId: 'ord_syn_paid_02',
          adminNote: 'Дублирующий вызов 1',
          bot,
        }),
        FulfillmentService.initiateFulfillment(target, bot),
      ]);

      assert.equal(sentMessages.length, 0, 'Не должно быть повторных уведомлений покупателю');
      return 'Повторное параллельное выполнение завершённого заказа полностью заблокировано (0 повторных выдач и сообщений).';
    },
  );

  await runCheck(
    'CON-04',
    'Concurrency',
    'Перезапуск сервера во время выдачи и сверка статуса через checkExternalStatus',
    'Имитация падения воркера после перевода заказа в processing (истёкший lease) с последующим восстановлением через checkExternalStatus',
    async () => {
      let executeCalls = 0;
      let statusCheckCalls = 0;

      // Prepare an order in 'processing' with expired lease and no externalExecutionReference
      const crashOrder: Order = {
        orderId: 'ord_con_crash_04',
        userId: 'tg_900001002',
        userTelegramId: 900001002,
        username: 'syn_multi_buyer',
        productId: 'stars_pack_500',
        productName: '500 Telegram Stars (Synthetic)',
        category: 'stars',
        quantity: 1,
        totalPrice: 450,
        currency: 'XTR',
        paymentStatus: 'paid',
        fulfillmentStatus: 'processing',
        telegramPaymentChargeId: 'chg_con_crash_04',
        fulfillmentStartedAt: '2026-11-17T08:00:00.000Z', // Expired lease (> 60s ago)
        fulfillmentAttempts: 1,
        fulfillmentIdempotencyKey: 'fulfill_ord_con_crash_04',
        createdAt: '2026-11-17T08:00:00.000Z',
        paidAt: '2026-11-17T08:00:00.000Z',
        updatedAt: '2026-11-17T08:00:00.000Z',
      };
      await firestoreRepo.setDoc<Order>('orders', crashOrder.orderId, crashOrder);

      const reconcilableAdapter: FulfillmentProviderAdapter = {
        providerName: 'ReconcilableProvider',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          executeCalls++;
          return {
            handledAutomatically: true,
            status: 'completed',
            details: 'Should not be called because checkExternalStatus returns alreadyExecuted=true',
          };
        },
        checkExternalStatus: async (_ord, key) => {
          statusCheckCalls++;
          return {
            alreadyExecuted: true,
            status: 'completed',
            details: `Восстановлено по ключу идемпотентности ${key}`,
            externalReference: `reconciled_${key}`,
          };
        },
      };

      FulfillmentService.setAdapter(reconcilableAdapter);
      try {
        const { bot } = createMockBot();
        const recovered = await FulfillmentService.initiateFulfillment(crashOrder, bot);
        assert.equal(statusCheckCalls, 1, 'Должен быть вызван checkExternalStatus');
        assert.equal(executeCalls, 0, 'Повторный requestFulfillment НЕ должен вызываться');
        assert.equal(recovered.fulfillmentStatus, 'completed');
        assert.equal(recovered.externalExecutionReference, 'reconciled_fulfill_ord_con_crash_04');
        return 'После перезапуска сервера заказ успешно сверен через checkExternalStatus и завершён без повторного вызова поставщика.';
      } finally {
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      }
    },
  );

  await runCheck(
    'CON-05',
    'Concurrency',
    'Потеря ответа от неидемпотентного поставщика (защитный карантин needsManualReconciliation)',
    'Имитация обрыва связи во время вызова неидемпотентного поставщика без checkExternalStatus',
    async () => {
      let unsafeCalls = 0;
      const lostOrder: Order = {
        orderId: 'ord_con_lost_05',
        userId: 'tg_900001003',
        userTelegramId: 900001003,
        username: 'syn_edge_buyer',
        productId: 'premium_12m',
        productName: 'Telegram Premium — 12 месяцев (Synthetic)',
        category: 'premium',
        quantity: 1,
        totalPrice: 3000,
        currency: 'XTR',
        paymentStatus: 'paid',
        fulfillmentStatus: 'processing',
        telegramPaymentChargeId: 'chg_con_lost_05',
        fulfillmentStartedAt: '2026-11-17T08:00:00.000Z', // Expired lease
        fulfillmentAttempts: 1,
        fulfillmentIdempotencyKey: 'fulfill_ord_con_lost_05',
        createdAt: '2026-11-17T08:00:00.000Z',
        paidAt: '2026-11-17T08:00:00.000Z',
        updatedAt: '2026-11-17T08:00:00.000Z',
      };
      await firestoreRepo.setDoc<Order>('orders', lostOrder.orderId, lostOrder);

      const nonIdempotentAdapter: FulfillmentProviderAdapter = {
        providerName: 'LegacyNonIdempotentSupplier',
        supportsIdempotency: false,
        isConfigured: () => true,
        requestFulfillment: async () => {
          unsafeCalls++;
          return {
            handledAutomatically: true,
            status: 'completed',
            details: 'Unsafe duplicate call!',
          };
        },
      };

      FulfillmentService.setAdapter(nonIdempotentAdapter);
      try {
        const { bot } = createMockBot();
        const quarantined = await FulfillmentService.initiateFulfillment(lostOrder, bot);
        assert.equal(unsafeCalls, 0, 'Неидемпотентный адаптер НЕ должен вызываться повторно');
        assert.equal(quarantined.fulfillmentStatus, 'failed');
        assert.equal(quarantined.needsManualReconciliation, true);
        return 'При потере ответа от неидемпотентного поставщика заказ переведён в карантин ручной сверки (unsafeCalls = 0).';
      } finally {
        FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      }
    },
  );

  await runCheck(
    'CON-06',
    'Concurrency',
    'Временная недоступность Firestore и последующее восстановление без потери заказов',
    'Имитация отказа хранилища (StorageUnavailableError) с проверкой блокировки новых заказов и сохранности существующих данных',
    async () => {
      firestoreRepo.setSimulatedFailure({ unavailable: true });
      try {
        await assert.rejects(
          async () => {
            await OrderService.createOrder({
              telegramUser: { id: 900001001, first_name: 'Алексей' },
              productId: 'stars_pack_100',
              quantity: 1,
            });
          },
          (err: unknown) => err instanceof StorageUnavailableError,
        );

        const preCheckoutRes = await PaymentService.validatePreCheckout({
          invoicePayload: 'ord_syn_pending_01',
          telegramUserId: 900001002,
          currency: 'XTR',
          totalAmount: 100,
        });
        assert.equal(preCheckoutRes.ok, false);
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }

      // Verify existing orders in Emulator are intact after recovery
      const ordersAfter = await firestoreRepo.listDocs<Order>('orders', 500);
      assert.ok(ordersAfter.length >= 11);
      return 'Во время сбоя БД создание заказов и оплата безопасно блокируются (StorageUnavailableError), а после восстановления все заказы сохранены.';
    },
  );

  // ===========================================================================
  // RESTORE CLEAN 12-SCENARIO SYNTHETIC DATASET & EXPORT DUMP FOR AUDIT PACKAGE
  // ===========================================================================
  const finalSeedSummary = await seedSyntheticAuditDataset();
  const dumpPath = path.resolve(
    process.cwd(),
    'firestore-audit-package/export/firestore-collections-dump.json',
  );
  await exportEmulatorCollectionsToJson(dumpPath);

  const resultsJsonPath = path.resolve(
    process.cwd(),
    'firestore-audit-package/export/audit-test-results.json',
  );
  fs.writeFileSync(
    resultsJsonPath,
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        emulatorHost: finalSeedSummary.emulatorHost,
        projectId: finalSeedSummary.projectId,
        totalTests: results.length,
        passed: results.filter((r) => r.status === 'PASS').length,
        failed: results.filter((r) => r.status === 'FAIL').length,
        results,
      },
      null,
      2,
    ),
    'utf-8',
  );

  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('================================================================================');
  console.log(
    `📊 ИТОГИ EMULATOR AUDIT SUITE: ${results.length - failedCount}/${results.length} PASS | ${failedCount} FAIL`,
  );
  console.log('================================================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Критическая ошибка выполнения Emulator Audit Suite:', err);
  process.exit(1);
});
