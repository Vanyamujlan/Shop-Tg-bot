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

export class PaymentService {
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

  private static activeRefundLocks = new Set<string>();

  public static isRefundInProgress(orderId: string): boolean {
    return this.activeRefundLocks.has(orderId);
  }

  /**
   * Executes Telegram Stars refund with in-flight concurrency lock, duplicate refund protection,
   * and strict paymentStatus verification before calling Telegram API and committing to Firestore.
   */
  public static async executeOrderRefund(params: {
    orderId: string;
    adminTelegramId: number;
    callTelegramRefund: (
      userTelegramId: number,
      telegramPaymentChargeId: string,
    ) => Promise<void>;
  }): Promise<{ alreadyRefunded: boolean; order: Order }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    if (this.activeRefundLocks.has(params.orderId)) {
      throw new Error(
        `Возврат по заказу #${params.orderId} уже выполняется параллельным запросом.`,
      );
    }

    this.activeRefundLocks.add(params.orderId);
    try {
      const order = await OrderService.getOrderById(params.orderId);
      if (!order || !order.telegramPaymentChargeId) {
        throw new Error(
          'У заказа отсутствует telegram_payment_charge_id для возврата.',
        );
      }

      if (
        order.paymentStatus === 'refunded' ||
        order.fulfillmentStatus === 'refunded'
      ) {
        return { alreadyRefunded: true, order };
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

      const paymentId = this.getPaymentDocId(order.telegramPaymentChargeId);
      const existingPayment = await firestoreRepo.getDoc<PaymentRecord>(
        'payments',
        paymentId,
      );
      if (existingPayment?.status === 'refunded') {
        const syncedOrder = await this.markPaymentRefunded(
          order.orderId,
          params.adminTelegramId,
        );
        return {
          alreadyRefunded: true,
          order: syncedOrder || order,
        };
      }

      await params.callTelegramRefund(
        order.userTelegramId,
        order.telegramPaymentChargeId,
      );

      const refundedOrder = await this.markPaymentRefunded(
        order.orderId,
        params.adminTelegramId,
      );
      if (!refundedOrder) {
        throw new Error(
          `Не удалось зафиксировать возврат заказа #${order.orderId} в базе данных.`,
        );
      }

      return { alreadyRefunded: false, order: refundedOrder };
    } finally {
      this.activeRefundLocks.delete(params.orderId);
    }
  }

  /**
   * Atomically updates payment, order, and transaction records on refund.
   * Rejects unpaid/cancelled orders and ensures idempotency on repeated calls.
   */
  public static async markPaymentRefunded(
    orderId: string,
    adminTelegramId?: number,
  ): Promise<Order | null> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    return firestoreRepo.runTransaction<Order | null>(async (tx) => {
      // All reads first
      const order = await tx.get<Order>('orders', orderId);
      if (!order || !order.telegramPaymentChargeId) return null;

      if (
        order.paymentStatus === 'refunded' ||
        order.fulfillmentStatus === 'refunded'
      ) {
        return order;
      }

      const isRefundableStatus =
        order.paymentStatus === 'paid' ||
        order.paymentStatus === 'processing' ||
        order.paymentStatus === 'completed';

      if (!isRefundableStatus) {
        throw new Error(
          `Невозможно отметить возврат для заказа #${order.orderId} со статусом оплаты "${order.paymentStatus}".`,
        );
      }

      const paymentId = this.getPaymentDocId(order.telegramPaymentChargeId);
      const existingPayment = await tx.get<PaymentRecord>('payments', paymentId);

      // Atomic writes
      const now = new Date().toISOString();
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

      const adminSuffix = adminTelegramId ? ` (админ ID: ${adminTelegramId})` : '';
      const updatedOrder: Order = {
        ...order,
        paymentStatus: 'refunded',
        fulfillmentStatus: 'refunded',
        fulfillmentNote:
          `Выполнен официальный возврат Telegram Stars (refundStarPayment)${adminSuffix}.`.slice(
            0,
            500,
          ),
        updatedAt: now,
      };

      tx.set<Order>('orders', updatedOrder.orderId, updatedOrder);

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

      return updatedOrder;
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
