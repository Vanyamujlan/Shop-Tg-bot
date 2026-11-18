import fs from 'fs';
import path from 'path';
import {
  assertEmulatorOnlyEnvironment,
  firestoreRepo,
  CollectionName,
} from '../../src/db/firestore.ts';
import {
  AdminRecord,
  Order,
  PaymentRecord,
  Product,
  StoreSettings,
  StoreTransaction,
  StoreUser,
} from '../../src/types.ts';

export const AUDIT_PROJECT_ID = 'demo-stars-shop-audit';

export interface SyntheticDatasetSummary {
  projectId: string;
  emulatorHost: string;
  generatedAt: string;
  counts: Record<CollectionName, number>;
  scenarios: string[];
}

/**
 * Strips any real credentials from process.env before connecting to the Emulator.
 */
export function sanitizeProcessEnvForEmulator(): void {
  delete process.env.FIREBASE_PRIVATE_KEY;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.env.GCLOUD_PROJECT = AUDIT_PROJECT_ID;
  process.env.FIREBASE_PROJECT_ID = AUDIT_PROJECT_ID;
  process.env.FIRESTORE_EMULATOR_HOST =
    process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
}

export async function clearEmulatorCollections(): Promise<void> {
  assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID);
  const db = firestoreRepo.getAdminDbInstance();
  if (!db) {
    throw new Error('Emulator AdminFirestore не инициализирован.');
  }
  const collections: CollectionName[] = [
    'users',
    'products',
    'orders',
    'payments',
    'transactions',
    'admins',
    'settings',
  ];
  for (const col of collections) {
    const snap = await db.collection(col).get();
    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    if (snap.docs.length > 0) {
      await batch.commit();
    }
  }
}

/**
 * Seeds all 7 collections with 12 realistic, 100% synthetic scenarios in the local Firestore Emulator.
 */
export async function seedSyntheticAuditDataset(): Promise<SyntheticDatasetSummary> {
  sanitizeProcessEnvForEmulator();
  const { emulatorHost, projectId } = assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID);
  await firestoreRepo.initWithEmulator(projectId);
  await clearEmulatorCollections();

  // 1. Settings (1 document)
  const settingsGlobal: StoreSettings = {
    key: 'global',
    storeName: 'Stars Shop (Synthetic Audit Store)',
    supportUsername: 'synthetic_support_bot',
    maintenanceMode: false,
    updatedAt: '2026-11-17T08:00:00.000Z',
  };
  await firestoreRepo.setDoc<StoreSettings>('settings', settingsGlobal.key, settingsGlobal);

  // 2. Admins (2 synthetic documents)
  const admins: AdminRecord[] = [
    {
      adminId: 'tg_900000001',
      telegramId: 900000001,
      role: 'superadmin',
      addedAt: '2026-11-17T08:00:00.000Z',
    },
    {
      adminId: 'tg_900000002',
      telegramId: 900000002,
      role: 'admin',
      addedAt: '2026-11-17T08:05:00.000Z',
    },
  ];
  for (const admin of admins) {
    await firestoreRepo.setDoc<AdminRecord>('admins', admin.adminId, admin);
  }

  // 3. Products (6 synthetic products across stars, premium, gifts; active & inactive)
  const products: Product[] = [
    {
      id: 'stars_pack_100',
      name: '100 Telegram Stars (Synthetic)',
      category: 'stars',
      description: 'Пакет из 100 звёзд Telegram для реакций и цифровых покупок.',
      price: 100,
      currency: 'XTR',
      imageUrl: 'https://picsum.photos/seed/syn_stars_100/600/400',
      isActive: true,
      fulfillmentType: 'manual',
      createdAt: '2026-11-17T08:10:00.000Z',
      updatedAt: '2026-11-17T08:10:00.000Z',
    },
    {
      id: 'stars_pack_500',
      name: '500 Telegram Stars (Synthetic)',
      category: 'stars',
      description: 'Пакет из 500 звёзд Telegram с приоритетной выдачей.',
      price: 450,
      currency: 'XTR',
      imageUrl: 'https://picsum.photos/seed/syn_stars_500/600/400',
      isActive: true,
      fulfillmentType: 'provider_adapter',
      createdAt: '2026-11-17T08:11:00.000Z',
      updatedAt: '2026-11-17T08:11:00.000Z',
    },
    {
      id: 'premium_3m',
      name: 'Telegram Premium — 3 месяца (Synthetic)',
      category: 'premium',
      description: 'Подписка Telegram Premium на 90 дней.',
      price: 1000,
      currency: 'XTR',
      imageUrl: 'https://picsum.photos/seed/syn_prem_3m/600/400',
      isActive: true,
      fulfillmentType: 'manual',
      createdAt: '2026-11-17T08:12:00.000Z',
      updatedAt: '2026-11-17T08:12:00.000Z',
    },
    {
      id: 'premium_12m',
      name: 'Telegram Premium — 12 месяцев (Synthetic)',
      category: 'premium',
      description: 'Годовая подписка Telegram Premium с максимальной выгодой.',
      price: 3000,
      currency: 'XTR',
      imageUrl: 'https://picsum.photos/seed/syn_prem_12m/600/400',
      isActive: true,
      fulfillmentType: 'provider_adapter',
      createdAt: '2026-11-17T08:13:00.000Z',
      updatedAt: '2026-11-17T08:13:00.000Z',
    },
    {
      id: 'gift_crystal_star',
      name: 'Коллекционный подарок «Хрустальная Звезда»',
      category: 'gifts',
      description: 'Редкий цифровой подарок для профиля Telegram.',
      price: 250,
      currency: 'XTR',
      imageUrl: 'https://picsum.photos/seed/syn_gift_star/600/400',
      isActive: true,
      fulfillmentType: 'manual',
      createdAt: '2026-11-17T08:14:00.000Z',
      updatedAt: '2026-11-17T08:14:00.000Z',
    },
    {
      id: 'gift_archived_limited',
      name: 'Архивный подарок «Лимитированный Кубок»',
      category: 'gifts',
      description: 'Снятый с продажи лимитированный подарок (isActive: false).',
      price: 750,
      currency: 'XTR',
      imageUrl: 'https://picsum.photos/seed/syn_gift_arch/600/400',
      isActive: false,
      fulfillmentType: 'manual',
      createdAt: '2026-11-17T08:15:00.000Z',
      updatedAt: '2026-11-17T08:15:00.000Z',
    },
  ];
  for (const product of products) {
    await firestoreRepo.setDoc<Product>('products', product.id, product);
  }

  // 4. Users (4 synthetic users covering new, single-order, multi-order, and blocked states)
  // User totals strictly match all paid/processing/completed/failed/refunded orders associated with them!
  const users: StoreUser[] = [
    {
      // Scenario 1: Brand new user with 0 orders
      userId: 'tg_900001001',
      telegramId: 900001001,
      username: 'syn_new_buyer',
      firstName: 'Алексей (Новый)',
      lastName: 'Тестов',
      languageCode: 'ru',
      isBlocked: false,
      totalOrders: 0,
      totalSpentStars: 0,
      createdAt: '2026-11-17T09:00:00.000Z',
      updatedAt: '2026-11-17T09:00:00.000Z',
    },
    {
      // Scenario 12: Active buyer with multiple orders across all statuses
      // Paid orders for tg_900001002:
      // ord_syn_paid_02 (100) + ord_syn_processing_03 (450) + ord_syn_completed_04 (1000) +
      // ord_syn_dup_payment_07 (250) + ord_syn_retry_08 (450) + ord_syn_refunded_09 (100) +
      // ord_syn_same_ts_10 (100) + ord_syn_same_ts_11 (200) = 8 paid orders, 2650 XTR total
      userId: 'tg_900001002',
      telegramId: 900001002,
      username: 'syn_multi_buyer',
      firstName: 'Мария (Мультизаказ)',
      lastName: 'Синтетик',
      languageCode: 'ru',
      isBlocked: false,
      totalOrders: 8,
      totalSpentStars: 2650,
      createdAt: '2026-11-17T09:05:00.000Z',
      updatedAt: '2026-11-17T10:00:00.000Z',
    },
    {
      // Edge-case buyer with failed fulfillment & manual reconciliation orders
      // ord_syn_failed_05 (450) + ord_syn_reconcile_06 (3000) = 2 paid orders, 3450 XTR total
      userId: 'tg_900001003',
      telegramId: 900001003,
      username: 'syn_edge_buyer',
      firstName: 'Дмитрий (Сверка)',
      lastName: 'Аудитов',
      languageCode: 'en',
      isBlocked: false,
      totalOrders: 2,
      totalSpentStars: 3450,
      createdAt: '2026-11-17T09:10:00.000Z',
      updatedAt: '2026-11-17T09:50:00.000Z',
    },
    {
      // Blocked user
      userId: 'tg_900001004',
      telegramId: 900001004,
      username: 'syn_blocked_user',
      firstName: 'Виктор (Заблокирован)',
      lastName: 'Блок',
      languageCode: 'ru',
      isBlocked: true,
      totalOrders: 0,
      totalSpentStars: 0,
      createdAt: '2026-11-17T09:12:00.000Z',
      updatedAt: '2026-11-17T09:15:00.000Z',
    },
  ];
  for (const user of users) {
    await firestoreRepo.setDoc<StoreUser>('users', user.userId, user);
  }

  // 5. Orders (11 synthetic orders covering all required scenarios + identical timestamp tie-breaker)
  const orders: Order[] = [
    // Scenario 3: Unpaid pending order
    {
      orderId: 'ord_syn_pending_01',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'stars_pack_100',
      productName: '100 Telegram Stars (Synthetic)',
      category: 'stars',
      quantity: 1,
      totalPrice: 100,
      currency: 'XTR',
      paymentStatus: 'pending',
      fulfillmentStatus: 'pending',
      fulfillmentAttempts: 0,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_pending_01',
      createdAt: '2026-11-17T09:20:00.000Z',
      updatedAt: '2026-11-17T09:20:00.000Z',
    },
    // Scenario 4: Successfully paid order (awaiting fulfillment claim)
    {
      orderId: 'ord_syn_paid_02',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'stars_pack_100',
      productName: '100 Telegram Stars (Synthetic)',
      category: 'stars',
      quantity: 1,
      totalPrice: 100,
      currency: 'XTR',
      paymentStatus: 'paid',
      fulfillmentStatus: 'paid',
      telegramPaymentChargeId: 'chg_syn_paid_02',
      providerPaymentChargeId: 'prov_syn_02',
      fulfillmentAttempts: 0,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_paid_02',
      createdAt: '2026-11-17T09:25:00.000Z',
      paidAt: '2026-11-17T09:25:10.000Z',
      updatedAt: '2026-11-17T09:25:10.000Z',
    },
    // Scenario 5: Order currently in processing
    {
      orderId: 'ord_syn_processing_03',
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
      telegramPaymentChargeId: 'chg_syn_processing_03',
      providerPaymentChargeId: 'prov_syn_03',
      fulfillmentStartedAt: '2026-11-17T09:30:05.000Z',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_processing_03',
      externalExecutionReference: 'manual_ord_syn_processing_03',
      fulfillmentNote: 'Заказ #ord_syn_processing_03 передан администратору на ручную выдачу.',
      adminNotifiedAt: '2026-11-17T09:30:06.000Z',
      createdAt: '2026-11-17T09:30:00.000Z',
      paidAt: '2026-11-17T09:30:04.000Z',
      updatedAt: '2026-11-17T09:30:06.000Z',
    },
    // Scenario 6: Completed order
    {
      orderId: 'ord_syn_completed_04',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'premium_3m',
      productName: 'Telegram Premium — 3 месяца (Synthetic)',
      category: 'premium',
      quantity: 1,
      totalPrice: 1000,
      currency: 'XTR',
      paymentStatus: 'completed',
      fulfillmentStatus: 'completed',
      telegramPaymentChargeId: 'chg_syn_completed_04',
      providerPaymentChargeId: 'prov_syn_04',
      fulfillmentStartedAt: '2026-11-17T09:35:05.000Z',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_completed_04',
      externalExecutionReference: 'manual_ord_syn_completed_04',
      fulfillmentNote: 'Код активации подписки: SYN-PREM-3M-9941',
      needsManualReconciliation: false,
      adminNotifiedAt: '2026-11-17T09:35:06.000Z',
      buyerNotifiedAt: '2026-11-17T09:36:00.000Z',
      createdAt: '2026-11-17T09:35:00.000Z',
      paidAt: '2026-11-17T09:35:04.000Z',
      completedAt: '2026-11-17T09:36:00.000Z',
      updatedAt: '2026-11-17T09:36:00.000Z',
    },
    // Scenario 7: Failed fulfillment after MAX_FULFILLMENT_ATTEMPTS = 3
    {
      orderId: 'ord_syn_failed_05',
      userId: 'tg_900001003',
      userTelegramId: 900001003,
      username: 'syn_edge_buyer',
      productId: 'stars_pack_500',
      productName: '500 Telegram Stars (Synthetic)',
      category: 'stars',
      quantity: 1,
      totalPrice: 450,
      currency: 'XTR',
      paymentStatus: 'paid',
      fulfillmentStatus: 'failed',
      telegramPaymentChargeId: 'chg_syn_failed_05',
      providerPaymentChargeId: 'prov_syn_05',
      fulfillmentStartedAt: '2026-11-17T09:42:00.000Z',
      fulfillmentAttempts: 3,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_failed_05',
      fulfillmentLastError: 'Provider timeout after 3 attempts (HTTP 504)',
      needsManualReconciliation: true,
      fulfillmentNote: 'Выдача остановлена после 3 попыток: Provider timeout after 3 attempts (HTTP 504). Требуется ручная выдача админом.',
      adminNotifiedAt: '2026-11-17T09:42:05.000Z',
      createdAt: '2026-11-17T09:40:00.000Z',
      paidAt: '2026-11-17T09:40:05.000Z',
      updatedAt: '2026-11-17T09:42:05.000Z',
    },
    // Scenario 8: Order requiring manual reconciliation after crash on non-idempotent provider
    {
      orderId: 'ord_syn_reconcile_06',
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
      fulfillmentStatus: 'failed',
      telegramPaymentChargeId: 'chg_syn_reconcile_06',
      providerPaymentChargeId: 'prov_syn_06',
      fulfillmentStartedAt: '2026-11-17T09:45:10.000Z',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_reconcile_06',
      fulfillmentLastError: 'Сервер перезапустился во время внешнего вызова без подтверждения статуса. Автоповтор заблокирован для защиты от двойной выдачи.',
      needsManualReconciliation: true,
      fulfillmentNote: 'Требуется ручная сверка администратором (защита от двойной выдачи после перезапуска).',
      adminNotifiedAt: '2026-11-17T09:46:20.000Z',
      createdAt: '2026-11-17T09:45:00.000Z',
      paidAt: '2026-11-17T09:45:05.000Z',
      updatedAt: '2026-11-17T09:46:20.000Z',
    },
    // Scenario 9: Order that received duplicate payment notifications (idempotently deduplicated)
    {
      orderId: 'ord_syn_dup_payment_07',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'gift_crystal_star',
      productName: 'Коллекционный подарок «Хрустальная Звезда»',
      category: 'gifts',
      quantity: 1,
      totalPrice: 250,
      currency: 'XTR',
      paymentStatus: 'completed',
      fulfillmentStatus: 'completed',
      telegramPaymentChargeId: 'chg_syn_dup_07',
      providerPaymentChargeId: 'prov_syn_07',
      fulfillmentStartedAt: '2026-11-17T09:50:10.000Z',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_dup_payment_07',
      externalExecutionReference: 'manual_ord_syn_dup_payment_07',
      fulfillmentNote: 'Подарок отправлен в профиль покупателя (дубль вебхука оплаты проигнорирован идемпотентно).',
      needsManualReconciliation: false,
      adminNotifiedAt: '2026-11-17T09:50:12.000Z',
      buyerNotifiedAt: '2026-11-17T09:51:00.000Z',
      createdAt: '2026-11-17T09:50:00.000Z',
      paidAt: '2026-11-17T09:50:05.000Z',
      completedAt: '2026-11-17T09:51:00.000Z',
      updatedAt: '2026-11-17T09:51:00.000Z',
    },
    // Scenario 10: Order scheduled for fulfillment retry (attempt 1 failed, waiting for backoff)
    {
      orderId: 'ord_syn_retry_08',
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
      fulfillmentStatus: 'failed',
      telegramPaymentChargeId: 'chg_syn_retry_08',
      providerPaymentChargeId: 'prov_syn_08',
      fulfillmentStartedAt: '2026-11-17T09:55:10.000Z',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_retry_08',
      fulfillmentLastError: 'Temporary network glitch (ECONNRESET)',
      fulfillmentNextRetryAt: '2026-11-17T09:55:14.000Z',
      needsManualReconciliation: false,
      fulfillmentNote: 'Ошибка попытки выдачи #1: Temporary network glitch (ECONNRESET). Запланирован повтор.',
      createdAt: '2026-11-17T09:55:00.000Z',
      paidAt: '2026-11-17T09:55:05.000Z',
      updatedAt: '2026-11-17T09:55:10.000Z',
    },
    // Scenario 11: Refunded payment & order
    {
      orderId: 'ord_syn_refunded_09',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'stars_pack_100',
      productName: '100 Telegram Stars (Synthetic)',
      category: 'stars',
      quantity: 1,
      totalPrice: 100,
      currency: 'XTR',
      paymentStatus: 'refunded',
      fulfillmentStatus: 'refunded',
      telegramPaymentChargeId: 'chg_syn_refunded_09',
      providerPaymentChargeId: 'prov_syn_09',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_refunded_09',
      fulfillmentNote: 'Выполнен официальный возврат Telegram Stars (refundStarPayment) (админ ID: 900000001).',
      createdAt: '2026-11-17T09:58:00.000Z',
      paidAt: '2026-11-17T09:58:05.000Z',
      updatedAt: '2026-11-17T09:59:00.000Z',
    },
    // Scenario 12a & 12b: Multiple orders with the EXACT SAME createdAt timestamp for tie-breaker pagination testing
    {
      orderId: 'ord_syn_same_ts_10',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'stars_pack_100',
      productName: '100 Telegram Stars (Synthetic)',
      category: 'stars',
      quantity: 1,
      totalPrice: 100,
      currency: 'XTR',
      paymentStatus: 'completed',
      fulfillmentStatus: 'completed',
      telegramPaymentChargeId: 'chg_syn_same_ts_10',
      providerPaymentChargeId: 'prov_syn_10',
      fulfillmentStartedAt: '2026-11-17T10:00:05.000Z',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_same_ts_10',
      externalExecutionReference: 'manual_ord_syn_same_ts_10',
      fulfillmentNote: 'Выдано (пакет 1 из 3 с одинаковым timestamp).',
      needsManualReconciliation: false,
      adminNotifiedAt: '2026-11-17T10:00:06.000Z',
      buyerNotifiedAt: '2026-11-17T10:00:10.000Z',
      createdAt: '2026-11-17T10:00:00.000Z',
      paidAt: '2026-11-17T10:00:02.000Z',
      completedAt: '2026-11-17T10:00:10.000Z',
      updatedAt: '2026-11-17T10:00:10.000Z',
    },
    {
      orderId: 'ord_syn_same_ts_11',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'stars_pack_100',
      productName: '100 Telegram Stars (Synthetic)',
      category: 'stars',
      quantity: 2,
      totalPrice: 200,
      currency: 'XTR',
      paymentStatus: 'completed',
      fulfillmentStatus: 'completed',
      telegramPaymentChargeId: 'chg_syn_same_ts_11',
      providerPaymentChargeId: 'prov_syn_11',
      fulfillmentStartedAt: '2026-11-17T10:00:05.000Z',
      fulfillmentAttempts: 1,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_same_ts_11',
      externalExecutionReference: 'manual_ord_syn_same_ts_11',
      fulfillmentNote: 'Выдано (пакет 2 из 3 с одинаковым timestamp).',
      needsManualReconciliation: false,
      adminNotifiedAt: '2026-11-17T10:00:06.000Z',
      buyerNotifiedAt: '2026-11-17T10:00:12.000Z',
      createdAt: '2026-11-17T10:00:00.000Z',
      paidAt: '2026-11-17T10:00:03.000Z',
      completedAt: '2026-11-17T10:00:12.000Z',
      updatedAt: '2026-11-17T10:00:12.000Z',
    },
    {
      orderId: 'ord_syn_same_ts_12',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      username: 'syn_multi_buyer',
      productId: 'gift_crystal_star',
      productName: 'Коллекционный подарок «Хрустальная Звезда»',
      category: 'gifts',
      quantity: 1,
      totalPrice: 250,
      currency: 'XTR',
      paymentStatus: 'cancelled',
      fulfillmentStatus: 'cancelled',
      fulfillmentAttempts: 0,
      fulfillmentIdempotencyKey: 'fulfill_ord_syn_same_ts_12',
      fulfillmentNote: 'Отменён покупателем до оплаты (пакет 3 из 3 с одинаковым timestamp).',
      createdAt: '2026-11-17T10:00:00.000Z',
      updatedAt: '2026-11-17T10:00:15.000Z',
    },
  ];
  for (const order of orders) {
    await firestoreRepo.setDoc<Order>('orders', order.orderId, order);
  }

  // 6. Payments (10 verified PaymentRecords matching every paid/processing/completed/failed/refunded order)
  const payments: PaymentRecord[] = [
    {
      paymentId: 'pay_chg_syn_paid_02',
      telegramPaymentChargeId: 'chg_syn_paid_02',
      providerPaymentChargeId: 'prov_syn_02',
      orderId: 'ord_syn_paid_02',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 100,
      currency: 'XTR',
      invoicePayload: 'ord_syn_paid_02',
      status: 'paid',
      createdAt: '2026-11-17T09:25:10.000Z',
    },
    {
      paymentId: 'pay_chg_syn_processing_03',
      telegramPaymentChargeId: 'chg_syn_processing_03',
      providerPaymentChargeId: 'prov_syn_03',
      orderId: 'ord_syn_processing_03',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 450,
      currency: 'XTR',
      invoicePayload: 'ord_syn_processing_03',
      status: 'paid',
      createdAt: '2026-11-17T09:30:04.000Z',
    },
    {
      paymentId: 'pay_chg_syn_completed_04',
      telegramPaymentChargeId: 'chg_syn_completed_04',
      providerPaymentChargeId: 'prov_syn_04',
      orderId: 'ord_syn_completed_04',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 1000,
      currency: 'XTR',
      invoicePayload: 'ord_syn_completed_04',
      status: 'paid',
      createdAt: '2026-11-17T09:35:04.000Z',
    },
    {
      paymentId: 'pay_chg_syn_failed_05',
      telegramPaymentChargeId: 'chg_syn_failed_05',
      providerPaymentChargeId: 'prov_syn_05',
      orderId: 'ord_syn_failed_05',
      userId: 'tg_900001003',
      userTelegramId: 900001003,
      totalAmount: 450,
      currency: 'XTR',
      invoicePayload: 'ord_syn_failed_05',
      status: 'paid',
      createdAt: '2026-11-17T09:40:05.000Z',
    },
    {
      paymentId: 'pay_chg_syn_reconcile_06',
      telegramPaymentChargeId: 'chg_syn_reconcile_06',
      providerPaymentChargeId: 'prov_syn_06',
      orderId: 'ord_syn_reconcile_06',
      userId: 'tg_900001003',
      userTelegramId: 900001003,
      totalAmount: 3000,
      currency: 'XTR',
      invoicePayload: 'ord_syn_reconcile_06',
      status: 'paid',
      createdAt: '2026-11-17T09:45:05.000Z',
    },
    {
      paymentId: 'pay_chg_syn_dup_07',
      telegramPaymentChargeId: 'chg_syn_dup_07',
      providerPaymentChargeId: 'prov_syn_07',
      orderId: 'ord_syn_dup_payment_07',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 250,
      currency: 'XTR',
      invoicePayload: 'ord_syn_dup_payment_07',
      status: 'paid',
      createdAt: '2026-11-17T09:50:05.000Z',
    },
    {
      paymentId: 'pay_chg_syn_retry_08',
      telegramPaymentChargeId: 'chg_syn_retry_08',
      providerPaymentChargeId: 'prov_syn_08',
      orderId: 'ord_syn_retry_08',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 450,
      currency: 'XTR',
      invoicePayload: 'ord_syn_retry_08',
      status: 'paid',
      createdAt: '2026-11-17T09:55:05.000Z',
    },
    {
      paymentId: 'pay_chg_syn_refunded_09',
      telegramPaymentChargeId: 'chg_syn_refunded_09',
      providerPaymentChargeId: 'prov_syn_09',
      orderId: 'ord_syn_refunded_09',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 100,
      currency: 'XTR',
      invoicePayload: 'ord_syn_refunded_09',
      status: 'refunded',
      createdAt: '2026-11-17T09:58:05.000Z',
      refundedAt: '2026-11-17T09:59:00.000Z',
    },
    {
      paymentId: 'pay_chg_syn_same_ts_10',
      telegramPaymentChargeId: 'chg_syn_same_ts_10',
      providerPaymentChargeId: 'prov_syn_10',
      orderId: 'ord_syn_same_ts_10',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 100,
      currency: 'XTR',
      invoicePayload: 'ord_syn_same_ts_10',
      status: 'paid',
      createdAt: '2026-11-17T10:00:02.000Z',
    },
    {
      paymentId: 'pay_chg_syn_same_ts_11',
      telegramPaymentChargeId: 'chg_syn_same_ts_11',
      providerPaymentChargeId: 'prov_syn_11',
      orderId: 'ord_syn_same_ts_11',
      userId: 'tg_900001002',
      userTelegramId: 900001002,
      totalAmount: 200,
      currency: 'XTR',
      invoicePayload: 'ord_syn_same_ts_11',
      status: 'paid',
      createdAt: '2026-11-17T10:00:03.000Z',
    },
  ];
  for (const payment of payments) {
    await firestoreRepo.setDoc<PaymentRecord>('payments', payment.paymentId, payment);
  }

  // 7. Transactions (16 audit log entries covering all TransactionType values)
  const transactions: StoreTransaction[] = [
    {
      transactionId: 'tx_syn_001_invoice',
      orderId: 'ord_syn_pending_01',
      userId: 'tg_900001002',
      type: 'invoice_created',
      amount: 100,
      currency: 'XTR',
      details: 'Создан заказ на "100 Telegram Stars (Synthetic)" (100 XTR)',
      createdAt: '2026-11-17T09:20:00.000Z',
    },
    {
      transactionId: 'tx_syn_002_precheckout',
      orderId: 'ord_syn_paid_02',
      userId: 'tg_900001002',
      type: 'pre_checkout_ok',
      amount: 100,
      currency: 'XTR',
      details: 'Проверка pre_checkout_query успешно пройдена',
      createdAt: '2026-11-17T09:25:05.000Z',
    },
    {
      transactionId: 'tx_syn_003_paid',
      orderId: 'ord_syn_paid_02',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 100,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_paid_02)',
      createdAt: '2026-11-17T09:25:10.000Z',
    },
    {
      transactionId: 'tx_syn_004_proc_paid',
      orderId: 'ord_syn_processing_03',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 450,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_processing_03)',
      createdAt: '2026-11-17T09:30:04.000Z',
    },
    {
      transactionId: 'tx_syn_005_comp_paid',
      orderId: 'ord_syn_completed_04',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 1000,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_completed_04)',
      createdAt: '2026-11-17T09:35:04.000Z',
    },
    {
      transactionId: 'tx_syn_006_comp_done',
      orderId: 'ord_syn_completed_04',
      userId: 'tg_900001002',
      type: 'fulfillment_completed',
      amount: 1000,
      currency: 'XTR',
      details: 'Заказ выдан покупателю (админ ID: 900000001): Код активации подписки: SYN-PREM-3M-9941',
      createdAt: '2026-11-17T09:36:00.000Z',
    },
    {
      transactionId: 'tx_syn_007_fail_paid',
      orderId: 'ord_syn_failed_05',
      userId: 'tg_900001003',
      type: 'payment_received',
      amount: 450,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_failed_05)',
      createdAt: '2026-11-17T09:40:05.000Z',
    },
    {
      transactionId: 'tx_syn_008_fail_err',
      orderId: 'ord_syn_failed_05',
      userId: 'tg_900001003',
      type: 'fulfillment_failed',
      amount: 450,
      currency: 'XTR',
      details: 'Ошибка выдачи (попытка 3/3): Provider timeout after 3 attempts (HTTP 504)',
      createdAt: '2026-11-17T09:42:00.000Z',
    },
    {
      transactionId: 'tx_syn_009_rec_paid',
      orderId: 'ord_syn_reconcile_06',
      userId: 'tg_900001003',
      type: 'payment_received',
      amount: 3000,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_reconcile_06)',
      createdAt: '2026-11-17T09:45:05.000Z',
    },
    {
      transactionId: 'tx_syn_010_dup_paid',
      orderId: 'ord_syn_dup_payment_07',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 250,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_dup_07)',
      createdAt: '2026-11-17T09:50:05.000Z',
    },
    {
      transactionId: 'tx_syn_011_dup_done',
      orderId: 'ord_syn_dup_payment_07',
      userId: 'tg_900001002',
      type: 'fulfillment_completed',
      amount: 250,
      currency: 'XTR',
      details: 'Подарок отправлен в профиль покупателя (дубль вебхука оплаты проигнорирован идемпотентно).',
      createdAt: '2026-11-17T09:51:00.000Z',
    },
    {
      transactionId: 'tx_syn_012_retry_paid',
      orderId: 'ord_syn_retry_08',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 450,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_retry_08)',
      createdAt: '2026-11-17T09:55:05.000Z',
    },
    {
      transactionId: 'tx_syn_013_retry_sched',
      orderId: 'ord_syn_retry_08',
      userId: 'tg_900001002',
      type: 'fulfillment_retry',
      amount: 450,
      currency: 'XTR',
      details: 'Запланирована повторная попытка выдачи #2 после временного сбоя сети',
      createdAt: '2026-11-17T09:55:10.000Z',
    },
    {
      transactionId: 'tx_syn_014_ref_paid',
      orderId: 'ord_syn_refunded_09',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 100,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_refunded_09)',
      createdAt: '2026-11-17T09:58:05.000Z',
    },
    {
      transactionId: 'tx_syn_015_ref_done',
      orderId: 'ord_syn_refunded_09',
      userId: 'tg_900001002',
      type: 'payment_refunded',
      amount: 100,
      currency: 'XTR',
      details: 'Возврат 100 XTR (charge_id: chg_syn_refunded_09) (админ ID: 900000001)',
      createdAt: '2026-11-17T09:59:00.000Z',
    },
    {
      transactionId: 'tx_syn_016_admin_act',
      orderId: 'ord_syn_completed_04',
      userId: 'tg_900000001',
      type: 'admin_action',
      amount: 1000,
      currency: 'XTR',
      details: 'Администратор tg_900000001 завершил выдачу заказа с передачей кода активации',
      createdAt: '2026-11-17T09:36:01.000Z',
    },
    {
      transactionId: 'tx_syn_017_same_ts_10',
      orderId: 'ord_syn_same_ts_10',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 100,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_same_ts_10)',
      createdAt: '2026-11-17T10:00:02.000Z',
    },
    {
      transactionId: 'tx_syn_018_same_ts_11',
      orderId: 'ord_syn_same_ts_11',
      userId: 'tg_900001002',
      type: 'payment_received',
      amount: 200,
      currency: 'XTR',
      details: 'Оплата подтверждена (charge_id: chg_syn_same_ts_11)',
      createdAt: '2026-11-17T10:00:03.000Z',
    },
    {
      transactionId: 'tx_syn_019_cancelled_12',
      orderId: 'ord_syn_same_ts_12',
      userId: 'tg_900001002',
      type: 'order_cancelled',
      amount: 250,
      currency: 'XTR',
      details: 'Заказ отменён пользователем до оплаты',
      createdAt: '2026-11-17T10:00:15.000Z',
    },
  ];
  for (const tx of transactions) {
    await firestoreRepo.setDoc<StoreTransaction>('transactions', tx.transactionId, tx);
  }

  const summary: SyntheticDatasetSummary = {
    projectId,
    emulatorHost,
    generatedAt: new Date().toISOString(),
    counts: {
      users: users.length,
      products: products.length,
      orders: orders.length,
      payments: payments.length,
      transactions: transactions.length,
      admins: admins.length,
      settings: 1,
    },
    scenarios: [
      '1. Новый пользователь без заказов (tg_900001001)',
      '2. Набор из 6 товаров в категориях stars, premium, gifts (включая архивный товар)',
      '3. Неоплаченный заказ в статусе pending (ord_syn_pending_01)',
      '4. Успешно оплаченный заказ в статусе paid (ord_syn_paid_02)',
      '5. Заказ в активной обработке processing (ord_syn_processing_03)',
      '6. Успешно завершённый заказ completed с кодом активации (ord_syn_completed_04)',
      '7. Неудачная выдача после 3 попыток failed (ord_syn_failed_05)',
      '8. Заказ, требующий ручной сверки needsManualReconciliation=true (ord_syn_reconcile_06)',
      '9. Идемпотентно обработанный заказ после повторного уведомления об оплате (ord_syn_dup_payment_07)',
      '10. Заказ с запланированной повторной попыткой выдачи fulfillmentNextRetryAt (ord_syn_retry_08)',
      '11. Официальный возврат платежа refunded (ord_syn_refunded_09)',
      '12. Серия заказов одного покупателя + 3 заказа с идентичным createdAt для проверки tie-breaker пагинации (ord_syn_same_ts_10..12)',
    ],
  };

  return summary;
}

/**
 * Exports all 7 collections from the live Firestore Emulator into a human- and AI-readable JSON file.
 */
export async function exportEmulatorCollectionsToJson(outputPath: string): Promise<void> {
  assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID);
  const db = firestoreRepo.getAdminDbInstance();
  if (!db) {
    throw new Error('Emulator AdminFirestore не инициализирован.');
  }

  const collections: CollectionName[] = [
    'settings',
    'admins',
    'products',
    'users',
    'orders',
    'payments',
    'transactions',
  ];

  const dump: Record<string, unknown> = {
    metadata: {
      exportedAt: new Date().toISOString(),
      projectId: AUDIT_PROJECT_ID,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
      containsRealData: false,
      containsPII: false,
      currency: 'XTR',
    },
    collections: {},
  };

  const collectionsObj = dump.collections as Record<string, Record<string, unknown>>;
  for (const col of collections) {
    const snap = await db.collection(col).get();
    const docsMap: Record<string, unknown> = {};
    const sortedDocs = [...snap.docs].sort((a, b) => a.id.localeCompare(b.id));
    for (const d of sortedDocs) {
      docsMap[d.id] = d.data();
    }
    collectionsObj[col] = docsMap;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(dump, null, 2), 'utf-8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedSyntheticAuditDataset()
    .then(async (summary) => {
      const dumpPath = path.resolve(
        process.cwd(),
        'firestore-audit-package/export/firestore-collections-dump.json',
      );
      await exportEmulatorCollectionsToJson(dumpPath);
      console.log('[SeedSyntheticData] Успешно создана тестовая база в Emulator:', summary);
    })
    .catch((err) => {
      console.error('[SeedSyntheticData] Ошибка:', err);
      process.exit(1);
    });
}
