import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  Order,
  PaymentRecord,
  Product,
  StoreTransaction,
  StoreUser,
} from '../types.ts';
import { OrderService } from './OrderService.ts';
import { ProductService } from './ProductService.ts';
import { UserService } from './UserService.ts';

export interface PreCheckoutValidationResult {
  ok: boolean;
  errorMessage?: string;
  order?: Order;
}

export interface ProcessSuccessfulPaymentResult {
  alreadyProcessed: boolean;
  needsFulfillmentRecovery: boolean;
  order: Order;
  payment: PaymentRecord;
}

export interface ConfirmedTelegramRefundEntry {
  orderId: string;
  adminTelegramId?: number;
  lockToken?: string;
  confirmedAt: string;
  lastError?: string;
}

export class PaymentService {
  private static defaultInstance = new PaymentService('default');

  /**
   * Process-wide recovery journal of refunds where Telegram API `refundStarPayment`
   * definitively succeeded, awaiting Firestore commit if Firestore failed mid-flight.
   * Note: Telegram Bot API does not provide an idempotency key or status lookup endpoint
   * for `refundStarPayment`, so we never claim impossible network-level `exactly-once`
   * guarantees. Instead, we persist durable state transitions in Firestore (`refund_in_progress`
   * -> `telegram_refund_succeeded_pending_commit` -> `refunded` / `refund_failed_needs_reconciliation`)
   * combined with this recovery journal to prevent duplicate Telegram refund calls and
   * recover Firestore consistency.
   */
  private static pendingConfirmedCommits = new Map<
    string,
    ConfirmedTelegramRefundEntry
  >();

  public static staleRefundInProgressMs = 60_000;

  private readonly instanceConfirmedCommits = new Map<
    string,
    ConfirmedTelegramRefundEntry
  >();

  constructor(
    public readonly instanceId: string = `ps_${Math.random().toString(36).slice(2, 8)}`,
  ) {}

  public static getPaymentDocId(telegramPaymentChargeId: string): string {
    return sanitizeDocId(`pay_${telegramPaymentChargeId}`);
  }

  /**
   * Validates pre_checkout_query within Telegram's strict timeout window.
   * Ensures storage is healthy, order exists, belongs to the buyer, is still pending, and price matches DB.
   */
  public static async validatePreCheckout(params: {
    invoicePayload: string;
    telegramUserId: number;
    currency: string;
    totalAmount: number;
  }): Promise<PreCheckoutValidationResult> {
    try {
      firestoreRepo.assertReadyForOrdersAndPayments();

      if (params.currency !== 'XTR') {
        return {
          ok: false,
          errorMessage: 'Поддерживается только оплата в Telegram Stars (XTR).',
        };
      }

      const user = await UserService.getUserByTelegramId(params.telegramUserId);
      if (user?.isBlocked) {
        return {
          ok: false,
          errorMessage: 'Ваш аккаунт заблокирован в магазине.',
        };
      }

      const order = await OrderService.getOrderById(params.invoicePayload);
      if (!order) {
        return {
          ok: false,
          errorMessage: 'Заказ не найден или устарел. Создайте новый заказ в каталоге.',
        };
      }

      if (order.userTelegramId !== params.telegramUserId) {
        return {
          ok: false,
          errorMessage: 'Этот счёт принадлежит другому пользователю.',
        };
      }

      if (order.paymentStatus !== 'pending') {
        return {
          ok: false,
          errorMessage: `Заказ уже обработан (статус: ${order.paymentStatus}).`,
        };
      }

      const product = await ProductService.getProductById(order.productId);
      if (!product || !product.isActive) {
        return {
          ok: false,
          errorMessage: 'Товар больше не активен в каталоге.',
        };
      }

      if (order.totalPrice !== params.totalAmount) {
        return {
          ok: false,
          errorMessage: 'Сумма платежа не совпадает со стоимостью заказа.',
        };
      }

      await OrderService.logTransaction({
        orderId: order.orderId,
        userId: order.userId,
        type: 'pre_checkout_ok',
        amount: order.totalPrice,
        details: 'Проверка pre_checkout_query успешно пройдена',
      });

      return { ok: true, order };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        errorMessage: `Ошибка проверки заказа: ${msg}`,
      };
    }
  }

  /**
   * Processes successful_payment atomically inside a single Firestore transaction:
   * - All reads execute strictly BEFORE any writes.
   * - Validates telegram_payment_charge_id, order existence, buyer ownership, amount, currency (XTR),
   *   product correspondence, and order status.
   * - Prevents duplicate payments on repeated or concurrent updates.
   * - Performs zero external network side-effects inside the transaction.
   */
  public static async processSuccessfulPayment(params: {
    telegramUserId: number;
    invoicePayload: string;
    currency: string;
    totalAmount: number;
    telegramPaymentChargeId: string;
    providerPaymentChargeId?: string;
  }): Promise<ProcessSuccessfulPaymentResult> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    if (
      !params.telegramPaymentChargeId ||
      typeof params.telegramPaymentChargeId !== 'string' ||
      !params.telegramPaymentChargeId.trim()
    ) {
      throw new Error('Отсутствует telegram_payment_charge_id в платеже.');
    }

    if (params.currency !== 'XTR') {
      throw new Error(`Неподдерживаемая валюта платежа: ${params.currency}`);
    }

    if (
      !Number.isInteger(params.totalAmount) ||
      params.totalAmount <= 0
    ) {
      throw new Error(`Некорректная сумма платежа: ${params.totalAmount}`);
    }

    const paymentId = this.getPaymentDocId(params.telegramPaymentChargeId);

    return firestoreRepo.runTransaction<ProcessSuccessfulPaymentResult>(async (tx) => {
      // =========================================================================
      // STEP 1: ALL READS FIRST (Firestore transaction requirement)
      // =========================================================================
      const existingPayment = await tx.get<PaymentRecord>('payments', paymentId);

      if (existingPayment) {
        const existingOrder = await tx.get<Order>('orders', existingPayment.orderId);
        if (!existingOrder) {
          throw new Error(`Заказ ${existingPayment.orderId} для платежа не найден.`);
        }
        if (existingOrder.userTelegramId !== params.telegramUserId) {
          throw new Error('Попытка подтверждения чужого платежа.');
        }

        const needsFulfillmentRecovery =
          existingOrder.paymentStatus === 'paid' &&
          (existingOrder.fulfillmentStatus === 'paid' ||
            existingOrder.fulfillmentStatus === 'pending' ||
            existingOrder.fulfillmentStatus === 'failed');

        return {
          alreadyProcessed: true,
          needsFulfillmentRecovery,
          order: existingOrder,
          payment: existingPayment,
        };
      }

      const order = await tx.get<Order>('orders', params.invoicePayload);
      if (!order) {
        throw new Error(`Заказ ${params.invoicePayload} не найден при обработке оплаты.`);
      }

      if (order.userTelegramId !== params.telegramUserId) {
        throw new Error('Несовпадение владельца заказа при подтверждении оплаты.');
      }

      if (order.currency !== 'XTR') {
        throw new Error(`Неверная валюта в заказе: ${order.currency}`);
      }

      if (order.totalPrice !== params.totalAmount) {
        throw new Error(
          `Несовпадение суммы оплаты: ожидалось ${order.totalPrice} XTR, получено ${params.totalAmount} XTR.`,
        );
      }

      // Check product correspondence in DB before writes
      const product = await tx.get<Product>('products', order.productId);
      if (!product || product.id !== order.productId) {
        throw new Error(
          `Товар "${order.productId}" для заказа #${order.orderId} не найден в каталоге.`,
        );
      }

      if (order.paymentStatus !== 'pending') {
        if (order.telegramPaymentChargeId === params.telegramPaymentChargeId) {
          const fallbackPayment: PaymentRecord = {
            paymentId,
            telegramPaymentChargeId: params.telegramPaymentChargeId,
            providerPaymentChargeId: params.providerPaymentChargeId || '',
            orderId: order.orderId,
            userId: order.userId,
            userTelegramId: order.userTelegramId,
            totalAmount: params.totalAmount,
            currency: 'XTR',
            invoicePayload: params.invoicePayload,
            status: 'paid',
            createdAt: order.paidAt || new Date().toISOString(),
          };
          const needsFulfillmentRecovery =
            order.paymentStatus === 'paid' &&
            (order.fulfillmentStatus === 'paid' ||
              order.fulfillmentStatus === 'pending' ||
              order.fulfillmentStatus === 'failed');

          return {
            alreadyProcessed: true,
            needsFulfillmentRecovery,
            order,
            payment: fallbackPayment,
          };
        }

        throw new Error(
          `Заказ #${order.orderId} уже имеет статус "${order.paymentStatus}" и не может быть оплачен повторно другим платежом.`,
        );
      }

      const existingUser = await tx.get<StoreUser>('users', order.userId);

      // =========================================================================
      // STEP 2: ATOMIC WRITES (Zero reads after this point)
      // =========================================================================
      const now = new Date().toISOString();

      const paymentRecord: PaymentRecord = {
        paymentId,
        telegramPaymentChargeId: params.telegramPaymentChargeId,
        providerPaymentChargeId: params.providerPaymentChargeId || '',
        orderId: order.orderId,
        userId: order.userId,
        userTelegramId: order.userTelegramId,
        totalAmount: params.totalAmount,
        currency: 'XTR',
        invoicePayload: params.invoicePayload,
        status: 'paid',
        createdAt: now,
      };

      const updatedOrder: Order = {
        ...order,
        paymentStatus: 'paid',
        fulfillmentStatus:
          order.fulfillmentStatus === 'pending' ? 'paid' : order.fulfillmentStatus,
        telegramPaymentChargeId: params.telegramPaymentChargeId,
        providerPaymentChargeId: params.providerPaymentChargeId || '',
        fulfillmentAttempts: order.fulfillmentAttempts ?? 0,
        fulfillmentIdempotencyKey:
          order.fulfillmentIdempotencyKey || `fulfill_${order.orderId}`,
        paidAt: now,
        updatedAt: now,
      };

      tx.set<PaymentRecord>('payments', paymentId, paymentRecord);
      tx.set<Order>('orders', updatedOrder.orderId, updatedOrder);

      if (existingUser) {
        tx.set<StoreUser>('users', existingUser.userId, {
          ...existingUser,
          totalOrders: existingUser.totalOrders + 1,
          totalSpentStars: existingUser.totalSpentStars + order.totalPrice,
          updatedAt: now,
        });
      } else {
        tx.set<StoreUser>('users', order.userId, {
          userId: order.userId,
          telegramId: order.userTelegramId,
          username: order.username || '',
          firstName: 'Покупатель',
          lastName: '',
          languageCode: 'ru',
          isBlocked: false,
          totalOrders: 1,
          totalSpentStars: order.totalPrice,
          createdAt: now,
          updatedAt: now,
        });
      }

      const transactionId = sanitizeDocId(
        `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      );
      tx.set<StoreTransaction>('transactions', transactionId, {
        transactionId,
        orderId: updatedOrder.orderId,
        userId: updatedOrder.userId,
        type: 'payment_received',
        amount: updatedOrder.totalPrice,
        currency: 'XTR',
        details: `Оплата подтверждена (charge_id: ${params.telegramPaymentChargeId})`.slice(
          0,
          500,
        ),
        createdAt: now,
      });

      return {
        alreadyProcessed: false,
        needsFulfillmentRecovery: true,
        order: updatedOrder,
        payment: paymentRecord,
      };
    });
  }

  /**
   * Checks whether an order currently holds a distributed refund lock in Firestore.
   */
  public static async isRefundInProgress(orderId: string): Promise<boolean> {
    const order = await OrderService.getOrderById(orderId);
    return order?.refundState === 'refund_in_progress';
  }

  /**
   * Instance method: Executes Telegram Stars refund using a 3-phase protocol:
   * - Phase 1 (Firestore Transaction): Atomically claims distributed lock (`refundState = 'refund_in_progress'`)
   *   in Firestore. Never expires or overrides an existing `refund_in_progress` lock to prevent duplicate
   *   calls to Telegram API across independent PaymentService instances.
   * - Phase 2 (External Telegram Call — outside transaction): Calls `refundStarPayment`.
   *   If the call fails before refunding, releases the distributed lock so the admin can retry.
   * - Phase 3 (Atomic Commit & Recovery): Persists `telegram_refund_succeeded_pending_commit` / `refunded`
   *   atomically with user statistics decrement (`AUD-003`). If Firestore fails after Telegram succeeded
   *   (`AUD-016`), records the confirmed refund for automatic recovery without calling Telegram again.
   */
  public async executeOrderRefund(params: {
    orderId: string;
    adminTelegramId: number;
    callTelegramRefund: (
      userTelegramId: number,
      telegramPaymentChargeId: string,
    ) => Promise<void>;
  }): Promise<{ alreadyRefunded: boolean; order: Order }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const lockToken = `rflock_${this.instanceId}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    type RefundClaimOutcome =
      | { action: 'already_refunded'; order: Order }
      | { action: 'needs_commit_only'; order: Order }
      | { action: 'claimed'; order: Order };

    const hasConfirmedRefundInJournal =
      this.instanceConfirmedCommits.has(params.orderId) ||
      PaymentService.pendingConfirmedCommits.has(params.orderId);

    // =========================================================================
    // PHASE 1: DISTRIBUTED LOCK & STATE CHECK VIA FIRESTORE TRANSACTION (AUD-015)
    // =========================================================================
    const claim = await firestoreRepo.runTransaction<RefundClaimOutcome>(
      async (tx) => {
        const order = await tx.get<Order>('orders', params.orderId);
        if (!order || !order.telegramPaymentChargeId) {
          throw new Error(
            'У заказа отсутствует telegram_payment_charge_id для возврата.',
          );
        }

        const paymentId = PaymentService.getPaymentDocId(
          order.telegramPaymentChargeId,
        );
        const existingPayment = await tx.get<PaymentRecord>(
          'payments',
          paymentId,
        );

        const isFullyCommitted =
          order.paymentStatus === 'refunded' &&
          order.fulfillmentStatus === 'refunded' &&
          order.refundState === 'refunded' &&
          existingPayment?.status === 'refunded' &&
          order.refundStatsAdjusted === true;

        if (isFullyCommitted) {
          return { action: 'already_refunded', order };
        }

        // If Telegram refund already succeeded earlier (in durable state, payment doc, or journal),
        // skip calling Telegram API and proceed directly to Phase 3 Firestore commit.
        if (
          hasConfirmedRefundInJournal ||
          order.refundState === 'telegram_refund_succeeded_pending_commit' ||
          existingPayment?.status === 'refunded' ||
          order.paymentStatus === 'refunded' ||
          order.fulfillmentStatus === 'refunded'
        ) {
          return { action: 'needs_commit_only', order };
        }

        if (order.refundState === 'refund_in_progress') {
          throw new Error(
            `Возврат по заказу #${order.orderId} уже выполняется параллельным запросом.`,
          );
        }

        if (order.refundState === 'refund_failed_needs_reconciliation') {
          throw new Error(
            `Возврат по заказу #${order.orderId} прерван после внешнего вызова и требует ручной сверки статуса (защита от повторного возврата Stars).`,
          );
        }

        const isRefundableStatus =
          order.paymentStatus === 'paid' ||
          order.paymentStatus === 'processing' ||
          order.paymentStatus === 'completed';

        if (!isRefundableStatus) {
          throw new Error(
            `Невозможно выполнить возврат для заказа #${order.orderId} со статусом оплаты "${order.paymentStatus}".`,
          );
        }

        const nowIso = new Date().toISOString();
        const claimedOrder: Order = {
          ...order,
          refundState: 'refund_in_progress',
          refundLockToken: lockToken,
          refundStartedAt: nowIso,
          refundLastError: undefined,
          updatedAt: nowIso,
        };

        tx.set<Order>('orders', claimedOrder.orderId, claimedOrder);
        return { action: 'claimed', order: claimedOrder };
      },
    );

    if (claim.action === 'already_refunded') {
      this.instanceConfirmedCommits.delete(params.orderId);
      PaymentService.pendingConfirmedCommits.delete(params.orderId);
      return { alreadyRefunded: true, order: claim.order };
    }

    if (claim.action === 'needs_commit_only') {
      const syncedOrder = await this.markPaymentRefunded(
        claim.order.orderId,
        params.adminTelegramId,
      );
      this.instanceConfirmedCommits.delete(params.orderId);
      PaymentService.pendingConfirmedCommits.delete(params.orderId);
      return {
        alreadyRefunded: true,
        order: syncedOrder || claim.order,
      };
    }

    // =========================================================================
    // PHASE 2: EXTERNAL TELEGRAM API CALL OUTSIDE TRANSACTION
    // =========================================================================
    const { order: claimedOrder } = claim;
    try {
      await params.callTelegramRefund(
        claimedOrder.userTelegramId,
        claimedOrder.telegramPaymentChargeId!,
      );
    } catch (telegramError) {
      const errMsg =
        telegramError instanceof Error
          ? telegramError.message
          : String(telegramError);

      // If Telegram explicitly reports the charge was already refunded, proceed to commit in Firestore
      const isAlreadyRefundedInTelegram =
        /CHARGE_ALREADY_REFUNDED|ALREADY_REFUNDED/i.test(errMsg);

      if (!isAlreadyRefundedInTelegram) {
        // Release the distributed lock because Telegram rejected the request before refunding
        await firestoreRepo.runTransaction<void>(async (tx) => {
          const latest = await tx.get<Order>('orders', claimedOrder.orderId);
          if (
            !latest ||
            latest.refundState !== 'refund_in_progress' ||
            latest.refundLockToken !== lockToken
          ) {
            return;
          }
          tx.set<Order>('orders', latest.orderId, {
            ...latest,
            refundState: undefined,
            refundLockToken: undefined,
            refundStartedAt: undefined,
            refundLastError: errMsg.slice(0, 500),
            updatedAt: new Date().toISOString(),
          });
        });
        throw telegramError;
      }
    }

    // =========================================================================
    // PHASE 3: RECORD CONFIRMED REFUND & ATOMICALLY COMMIT TO FIRESTORE (AUD-016 & AUD-003)
    // =========================================================================
    const confirmedEntry: ConfirmedTelegramRefundEntry = {
      orderId: claimedOrder.orderId,
      adminTelegramId: params.adminTelegramId,
      lockToken,
      confirmedAt: new Date().toISOString(),
    };
    this.instanceConfirmedCommits.set(claimedOrder.orderId, confirmedEntry);
    PaymentService.pendingConfirmedCommits.set(
      claimedOrder.orderId,
      confirmedEntry,
    );

    try {
      const refundedOrder = await this.markPaymentRefunded(
        claimedOrder.orderId,
        params.adminTelegramId,
      );
      if (!refundedOrder) {
        throw new Error(
          `Не удалось зафиксировать возврат заказа #${claimedOrder.orderId} в базе данных.`,
        );
      }

      this.instanceConfirmedCommits.delete(claimedOrder.orderId);
      PaymentService.pendingConfirmedCommits.delete(claimedOrder.orderId);

      return { alreadyRefunded: false, order: refundedOrder };
    } catch (commitError) {
      const commitErrMsg =
        commitError instanceof Error
          ? commitError.message
          : String(commitError);
      confirmedEntry.lastError = commitErrMsg;

      // Best-effort durable checkpoint in Firestore if single-doc update can succeed
      try {
        await firestoreRepo.updateDoc<Order>('orders', claimedOrder.orderId, {
          refundState: 'telegram_refund_succeeded_pending_commit',
          refundLastError:
            `Возврат в Telegram выполнен, ошибка фиксации в Firestore: ${commitErrMsg}`.slice(
              0,
              500,
            ),
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Firestore is completely unreachable right now; order remains in 'refund_in_progress'
        // in Firestore (blocking any duplicate Telegram calls) and is queued in pendingConfirmedCommits.
      }

      throw commitError;
    }
  }

  public static async executeOrderRefund(params: {
    orderId: string;
    adminTelegramId: number;
    callTelegramRefund: (
      userTelegramId: number,
      telegramPaymentChargeId: string,
    ) => Promise<void>;
  }): Promise<{ alreadyRefunded: boolean; order: Order }> {
    return this.defaultInstance.executeOrderRefund(params);
  }

  /**
   * Atomically updates payment, order, user statistics (AUD-003), and transaction records on refund.
   * Rejects unpaid/cancelled orders and guarantees idempotency (never double-decrements user stats).
   */
  public async markPaymentRefunded(
    orderId: string,
    adminTelegramId?: number,
  ): Promise<Order | null> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    return firestoreRepo.runTransaction<Order | null>(async (tx) => {
      // =========================================================================
      // STEP 1: ALL READS FIRST
      // =========================================================================
      const order = await tx.get<Order>('orders', orderId);
      if (!order || !order.telegramPaymentChargeId) return null;

      const paymentId = PaymentService.getPaymentDocId(
        order.telegramPaymentChargeId,
      );
      const existingPayment = await tx.get<PaymentRecord>(
        'payments',
        paymentId,
      );
      const existingUser = await tx.get<StoreUser>('users', order.userId);

      const isFullyRefunded =
        order.paymentStatus === 'refunded' &&
        order.fulfillmentStatus === 'refunded' &&
        order.refundState === 'refunded' &&
        existingPayment?.status === 'refunded' &&
        order.refundStatsAdjusted === true;

      if (isFullyRefunded) {
        return order;
      }

      const isRefundableStatus =
        order.paymentStatus === 'paid' ||
        order.paymentStatus === 'processing' ||
        order.paymentStatus === 'completed' ||
        order.paymentStatus === 'refunded' ||
        order.fulfillmentStatus === 'refunded';

      if (!isRefundableStatus) {
        throw new Error(
          `Невозможно отметить возврат для заказа #${order.orderId} со статусом оплаты "${order.paymentStatus}".`,
        );
      }

      // =========================================================================
      // STEP 2: ATOMIC WRITES (Order, PaymentRecord, User stats, Transaction log)
      // =========================================================================
      const now = new Date().toISOString();
      const wasAlreadyMarkedRefunded =
        order.paymentStatus === 'refunded' &&
        existingPayment?.status === 'refunded';

      if (existingPayment) {
        tx.set<PaymentRecord>('payments', paymentId, {
          ...existingPayment,
          status: 'refunded',
          refundedAt: existingPayment.refundedAt || now,
        });
      } else {
        tx.set<PaymentRecord>('payments', paymentId, {
          paymentId,
          telegramPaymentChargeId: order.telegramPaymentChargeId,
          providerPaymentChargeId: order.providerPaymentChargeId || '',
          orderId: order.orderId,
          userId: order.userId,
          userTelegramId: order.userTelegramId,
          totalAmount: order.totalPrice,
          currency: 'XTR',
          invoicePayload: order.orderId,
          status: 'refunded',
          createdAt: order.paidAt || now,
          refundedAt: now,
        });
      }

      // AUD-003: Decrement user statistics exactly once per refunded order
      const shouldDecrementUserStats = !order.refundStatsAdjusted;
      if (existingUser && shouldDecrementUserStats) {
        tx.set<StoreUser>('users', existingUser.userId, {
          ...existingUser,
          totalOrders: Math.max(0, existingUser.totalOrders - 1),
          totalSpentStars: Math.max(
            0,
            existingUser.totalSpentStars - order.totalPrice,
          ),
          updatedAt: now,
        });
      }

      const adminSuffix = adminTelegramId
        ? ` (админ ID: ${adminTelegramId})`
        : '';
      const updatedOrder: Order = {
        ...order,
        paymentStatus: 'refunded',
        fulfillmentStatus: 'refunded',
        refundState: 'refunded',
        refundStatsAdjusted: true,
        refundLockToken: undefined,
        refundLastError: undefined,
        needsManualReconciliation: false,
        fulfillmentNote:
          `Выполнен официальный возврат Telegram Stars (refundStarPayment)${adminSuffix}.`.slice(
            0,
            500,
          ),
        updatedAt: now,
      };

      tx.set<Order>('orders', updatedOrder.orderId, updatedOrder);

      if (!wasAlreadyMarkedRefunded) {
        const transactionId = sanitizeDocId(
          `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        tx.set<StoreTransaction>('transactions', transactionId, {
          transactionId,
          orderId: order.orderId,
          userId: order.userId,
          type: 'payment_refunded',
          amount: order.totalPrice,
          currency: 'XTR',
          details:
            `Возврат ${order.totalPrice} XTR (charge_id: ${order.telegramPaymentChargeId})${adminSuffix}`.slice(
              0,
              500,
            ),
          createdAt: now,
        });
      }

      return updatedOrder;
    });
  }

  public static async markPaymentRefunded(
    orderId: string,
    adminTelegramId?: number,
  ): Promise<Order | null> {
    return this.defaultInstance.markPaymentRefunded(orderId, adminTelegramId);
  }

  /**
   * AUD-016 Recovery Mechanism:
   * 1. Finalizes orders where Telegram refund succeeded (`telegram_refund_succeeded_pending_commit`
   *    or in `pendingConfirmedCommits` journal) by committing `markPaymentRefunded` to Firestore
   *    WITHOUT calling Telegram API again.
   * 2. Handles orders stuck in `refund_in_progress` after an unconfirmed process restart:
   *    if the lock is stale (or `quarantineStaleInProgress` is enabled) and there is no confirmation
   *    record, transitions the order to `refund_failed_needs_reconciliation` (`needsManualReconciliation: true`)
   *    so `refundStarPayment` is NEVER invoked a second time automatically.
   */
  public async recoverPendingRefunds(options?: {
    quarantineStaleInProgress?: boolean;
  }): Promise<Order[]> {
    if (!firestoreRepo.isProductionStorageHealthy()) {
      return [];
    }

    const recovered: Order[] = [];
    const processedIds = new Set<string>();

    // 1. Recover all confirmed refunds from in-memory journals (instance + static)
    const journalEntries = new Map<string, ConfirmedTelegramRefundEntry>([
      ...PaymentService.pendingConfirmedCommits.entries(),
      ...this.instanceConfirmedCommits.entries(),
    ]);

    for (const [orderId, entry] of journalEntries.entries()) {
      try {
        const finalized = await this.markPaymentRefunded(
          orderId,
          entry.adminTelegramId,
        );
        if (finalized) {
          this.instanceConfirmedCommits.delete(orderId);
          PaymentService.pendingConfirmedCommits.delete(orderId);
          recovered.push(finalized);
          processedIds.add(orderId);
        }
      } catch (error) {
        console.error(
          `[PaymentService] Ошибка финализации подтверждённого возврата заказа #${orderId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // 2. Recover orders durably marked as 'telegram_refund_succeeded_pending_commit' in Firestore
    const pendingCommitOrders = await firestoreRepo.queryDocs<Order>('orders', {
      where: [
        {
          field: 'refundState',
          op: '==',
          value: 'telegram_refund_succeeded_pending_commit',
        },
      ],
      limit: 50,
    });

    for (const ord of pendingCommitOrders) {
      if (processedIds.has(ord.orderId)) continue;
      try {
        const finalized = await this.markPaymentRefunded(ord.orderId);
        if (finalized) {
          this.instanceConfirmedCommits.delete(ord.orderId);
          PaymentService.pendingConfirmedCommits.delete(ord.orderId);
          recovered.push(finalized);
          processedIds.add(ord.orderId);
        }
      } catch (error) {
        console.error(
          `[PaymentService] Ошибка восстановления возврата заказа #${ord.orderId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // 3. Check orders stuck in 'refund_in_progress' after a process crash/restart
    const inProgressOrders = await firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'refundState', op: '==', value: 'refund_in_progress' }],
      limit: 50,
    });

    const nowMs = Date.now();
    for (const ord of inProgressOrders) {
      if (processedIds.has(ord.orderId)) continue;

      // Check if PaymentRecord was already marked refunded
      if (ord.telegramPaymentChargeId) {
        const paymentId = PaymentService.getPaymentDocId(
          ord.telegramPaymentChargeId,
        );
        const paymentDoc = await firestoreRepo.getDoc<PaymentRecord>(
          'payments',
          paymentId,
        );
        if (paymentDoc?.status === 'refunded') {
          const finalized = await this.markPaymentRefunded(ord.orderId);
          if (finalized) {
            recovered.push(finalized);
            processedIds.add(ord.orderId);
            continue;
          }
        }
      }

      const startedMs = ord.refundStartedAt
        ? Date.parse(ord.refundStartedAt)
        : 0;
      const isStale =
        options?.quarantineStaleInProgress === true ||
        (startedMs > 0 &&
          nowMs - startedMs >= PaymentService.staleRefundInProgressMs);

      if (isStale) {
        const quarantined = await firestoreRepo.runTransaction<Order | null>(
          async (tx) => {
            const latest = await tx.get<Order>('orders', ord.orderId);
            if (!latest || latest.refundState !== 'refund_in_progress') {
              return null;
            }
            const nowIso = new Date().toISOString();
            const updated: Order = {
              ...latest,
              refundState: 'refund_failed_needs_reconciliation',
              needsManualReconciliation: true,
              refundLastError:
                'Возврат был прерван во время внешнего вызова Telegram API. Автоповтор заблокирован для защиты от двойного возврата Stars.',
              updatedAt: nowIso,
            };
            tx.set<Order>('orders', updated.orderId, updated);
            return updated;
          },
        );
        if (quarantined) {
          recovered.push(quarantined);
          processedIds.add(ord.orderId);
        }
      }
    }

    return recovered;
  }

  public static async recoverPendingRefunds(options?: {
    quarantineStaleInProgress?: boolean;
  }): Promise<Order[]> {
    return this.defaultInstance.recoverPendingRefunds(options);
  }

  /**
   * Reconciles an interrupted refund (`refund_in_progress` or `refund_failed_needs_reconciliation`)
   * after the administrator verifies whether Telegram Stars were already returned to the buyer:
   * - If `telegramRefundConfirmed === true`, finalizes the refund in Firestore and decrements user stats
   *   without calling Telegram API.
   * - If `telegramRefundConfirmed === false`, clears the refund lock so the refund can be safely retried.
   */
  public static async reconcileInterruptedRefund(params: {
    orderId: string;
    telegramRefundConfirmed: boolean;
    adminTelegramId?: number;
  }): Promise<Order | null> {
    if (params.telegramRefundConfirmed) {
      const finalized = await this.markPaymentRefunded(
        params.orderId,
        params.adminTelegramId,
      );
      this.pendingConfirmedCommits.delete(params.orderId);
      return finalized;
    }

    return firestoreRepo.runTransaction<Order | null>(async (tx) => {
      const order = await tx.get<Order>('orders', params.orderId);
      if (!order) return null;
      if (order.paymentStatus === 'refunded') return order;

      const updated: Order = {
        ...order,
        refundState: undefined,
        refundLockToken: undefined,
        refundStartedAt: undefined,
        refundLastError: undefined,
        needsManualReconciliation: false,
        updatedAt: new Date().toISOString(),
      };
      tx.set<Order>('orders', updated.orderId, updated);
      return updated;
    });
  }

  /**
   * Server-side ordered and cursor-paginated payments query.
   */
  public static async getAllPayments(
    limit = 100,
    startAfterCursor?: unknown,
  ): Promise<PaymentRecord[]> {
    const isLegacyOffset =
      typeof startAfterCursor === 'number' && startAfterCursor > 0;
    return firestoreRepo.queryDocs<PaymentRecord>('payments', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      startAfter: isLegacyOffset ? undefined : startAfterCursor,
      offset: isLegacyOffset ? startAfterCursor : undefined,
      limit,
    });
  }
}
