import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  Order,
  OrderStatus,
  PaymentRecord,
  StoreTransaction,
  StoreUser,
  TransactionType,
} from '../types.ts';
import { ProductService } from './ProductService.ts';
import { UserService } from './UserService.ts';

export class OrderService {
  /**
   * Creates a new pending order strictly using the product price stored in the database.
   * Never trusts price sent from client callbacks.
   * Fails safely if production storage is unavailable.
   */
  public static async createOrder(params: {
    telegramUser: {
      id: number;
      username?: string;
      first_name: string;
      last_name?: string;
    };
    productId: string;
    quantity?: number;
  }): Promise<Order> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const user = await UserService.upsertFromTelegram(params.telegramUser);
    if (user.isBlocked) {
      throw new Error('Ваш аккаунт заблокирован в магазине. Обратитесь в поддержку.');
    }

    const product = await ProductService.getProductById(params.productId);
    if (!product || !product.isActive) {
      throw new Error('Товар временно недоступен или снят с продажи.');
    }

    const quantity = Math.max(1, Math.min(10, Math.round(params.quantity || 1)));
    const totalPrice = product.price * quantity;
    const now = new Date().toISOString();
    const orderId = sanitizeDocId(
      `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    );

    const order: Order = {
      orderId,
      userId: user.userId,
      userTelegramId: user.telegramId,
      username: user.username,
      productId: product.id,
      productName: product.name,
      category: product.category,
      quantity,
      totalPrice,
      currency: 'XTR',
      paymentStatus: 'pending',
      fulfillmentStatus: 'pending',
      fulfillmentAttempts: 0,
      fulfillmentIdempotencyKey: `fulfill_${orderId}`,
      createdAt: now,
      updatedAt: now,
    };

    await firestoreRepo.setDoc<Order>('orders', order.orderId, order);
    await this.logTransaction({
      orderId: order.orderId,
      userId: order.userId,
      type: 'invoice_created',
      amount: order.totalPrice,
      details: `Создан заказ на "${order.productName}" (${order.totalPrice} XTR)`,
    });

    return order;
  }

  public static async getOrderById(orderId: string): Promise<Order | null> {
    return firestoreRepo.getDoc<Order>('orders', orderId);
  }

  /**
   * Server-side filtered and cursor-paginated user orders query.
   */
  public static async getUserOrders(
    telegramId: number,
    limit = 20,
    startAfterCursor?: unknown,
  ): Promise<Order[]> {
    const isLegacyOffset =
      typeof startAfterCursor === 'number' && startAfterCursor > 0;
    return firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'userTelegramId', op: '==', value: telegramId }],
      orderBy: { field: 'createdAt', direction: 'desc' },
      startAfter: isLegacyOffset ? undefined : startAfterCursor,
      offset: isLegacyOffset ? startAfterCursor : undefined,
      limit,
    });
  }

  /**
   * Server-side filtered and cursor-paginated orders query for admin views.
   * Uses `fulfillmentStatus` (which tracks pending -> paid -> processing -> completed / failed / cancelled / refunded).
   */
  public static async getAllOrders(
    statusFilter?: OrderStatus,
    limit = 50,
    startAfterCursor?: unknown,
  ): Promise<Order[]> {
    const isLegacyOffset =
      typeof startAfterCursor === 'number' && startAfterCursor > 0;

    if (!statusFilter) {
      return firestoreRepo.queryDocs<Order>('orders', {
        orderBy: { field: 'createdAt', direction: 'desc' },
        startAfter: isLegacyOffset ? undefined : startAfterCursor,
        offset: isLegacyOffset ? startAfterCursor : undefined,
        limit,
      });
    }

    return firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'fulfillmentStatus', op: '==', value: statusFilter }],
      orderBy: { field: 'createdAt', direction: 'desc' },
      startAfter: isLegacyOffset ? undefined : startAfterCursor,
      offset: isLegacyOffset ? startAfterCursor : undefined,
      limit,
    });
  }

  /**
   * Cannot mark an order paid without a verified PaymentRecord in Firestore.
   */
  public static async markOrderPaid(params: {
    orderId: string;
    telegramPaymentChargeId: string;
    providerPaymentChargeId?: string;
  }): Promise<Order> {
    firestoreRepo.assertReadyForOrdersAndPayments();
    if (!params.telegramPaymentChargeId) {
      throw new Error(
        'Запрещено переводить заказ в статус paid без подтверждённого telegram_payment_charge_id.',
      );
    }

    const paymentDocId = sanitizeDocId(`pay_${params.telegramPaymentChargeId}`);

    return firestoreRepo.runTransaction(async (tx) => {
      // All reads before writes
      const verifiedPayment = await tx.get<PaymentRecord>('payments', paymentDocId);
      if (!verifiedPayment || verifiedPayment.orderId !== params.orderId) {
        throw new Error(
          `Запрещено отмечать заказ #${params.orderId} оплаченным без подтверждённого успешного платежа (PaymentRecord не найден).`,
        );
      }

      const existing = await tx.get<Order>('orders', params.orderId);
      if (!existing) {
        throw new Error(`Заказ ${params.orderId} не найден.`);
      }

      const existingUser = await tx.get<StoreUser>('users', existing.userId);
      const now = new Date().toISOString();

      const updated: Order = {
        ...existing,
        paymentStatus: 'paid',
        fulfillmentStatus:
          existing.fulfillmentStatus === 'pending' ? 'paid' : existing.fulfillmentStatus,
        telegramPaymentChargeId: params.telegramPaymentChargeId,
        providerPaymentChargeId: params.providerPaymentChargeId || '',
        paidAt: now,
        updatedAt: now,
      };

      tx.set<Order>('orders', updated.orderId, updated);

      if (existingUser) {
        tx.set<StoreUser>('users', existingUser.userId, {
          ...existingUser,
          totalOrders: existingUser.totalOrders + 1,
          totalSpentStars: existingUser.totalSpentStars + existing.totalPrice,
          updatedAt: now,
        });
      }

      const transactionId = sanitizeDocId(
        `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      );
      tx.set<StoreTransaction>('transactions', transactionId, {
        transactionId,
        orderId: updated.orderId,
        userId: updated.userId,
        type: 'payment_received',
        amount: updated.totalPrice,
        currency: 'XTR',
        details: `Оплата подтверждена (charge_id: ${params.telegramPaymentChargeId})`.slice(
          0,
          500,
        ),
        createdAt: now,
      });

      return updated;
    });
  }

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

      const updated: Order = {
        ...existing,
        paymentStatus: nextPayment,
        fulfillmentStatus: nextFulfillment,
        fulfillmentNote:
          params.fulfillmentNote !== undefined
            ? params.fulfillmentNote.slice(0, 500)
            : existing.fulfillmentNote,
        completedAt:
          nextFulfillment === 'completed'
            ? existing.completedAt || now
            : existing.completedAt,
        updatedAt: now,
      };

      tx.set<Order>('orders', updated.orderId, updated);
      return updated;
    });
  }

  public static async logTransaction(params: {
    orderId: string;
    userId: string;
    type: TransactionType;
    amount: number;
    details: string;
  }): Promise<StoreTransaction> {
    const now = new Date().toISOString();
    const transactionId = sanitizeDocId(
      `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    );

    const tx: StoreTransaction = {
      transactionId,
      orderId: params.orderId,
      userId: params.userId,
      type: params.type,
      amount: params.amount,
      currency: 'XTR',
      details: params.details.slice(0, 500),
      createdAt: now,
    };

    await firestoreRepo.setDoc<StoreTransaction>('transactions', transactionId, tx);
    return tx;
  }

  /**
   * Server-side ordered and cursor-paginated recent transactions query.
   */
  public static async getRecentTransactions(
    limit = 15,
    startAfterCursor?: unknown,
  ): Promise<StoreTransaction[]> {
    const isLegacyOffset =
      typeof startAfterCursor === 'number' && startAfterCursor > 0;
    return firestoreRepo.queryDocs<StoreTransaction>('transactions', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      startAfter: isLegacyOffset ? undefined : startAfterCursor,
      offset: isLegacyOffset ? startAfterCursor : undefined,
      limit,
    });
  }
}
