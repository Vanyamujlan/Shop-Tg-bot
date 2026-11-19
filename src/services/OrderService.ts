import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  Order,
  OrderStatus,
  PaymentRecord,
  StoreTransaction,
  StoreUser,
  TransactionType,
} from '../types.ts';
import { formatUsdCents } from './Money.ts';
import { ProductService } from './ProductService.ts';
import { UserService } from './UserService.ts';

const TELEGRAM_USERNAME_REGEX = /^[a-zA-Z](?:[a-zA-Z0-9]|_(?=[a-zA-Z0-9])){4,31}$/;

/**
 * Validates and normalizes a Telegram recipient @username (stores without leading @, lowercased).
 * Official Telegram rules:
 * - 5..32 characters total
 * - Allowed characters: Latin letters (a-z), digits (0-9), underscore (_)
 * - Must start with a Latin letter; cannot start/end with "_" or contain "__"
 * - Only a single optional leading "@" is allowed; internal whitespace and extra "@" are rejected
 * - Explicitly passing an empty string ("", "   ", "@") throws an error; only `undefined` returns `undefined`.
 */
export function normalizeRecipientUsername(raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new Error(
      'Некорректный @username получателя: ожидается непустая строка.',
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      'Укажите @username получателя: имя пользователя не может быть пустым.',
    );
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      'Некорректный @username получателя: пробелы внутри имени пользователя недопустимы.',
    );
  }

  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!withoutAt) {
    throw new Error(
      'Укажите @username получателя: имя пользователя не может быть пустым.',
    );
  }

  if (!TELEGRAM_USERNAME_REGEX.test(withoutAt)) {
    throw new Error(
      'Некорректный @username получателя. Укажите от 5 до 32 символов латиницы, цифр или "_" (начинается с буквы, без "__" и "_" в конце).',
    );
  }

  return withoutAt.toLowerCase();
}

export class OrderService {
  /**
   * Creates a new pending order strictly using the product USD cents price stored in DB.
   * Never trusts price sent from client callbacks.
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
    recipientUsername?: string;
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

    const { quantity, unitPriceUsdCents, totalPriceUsdCents } =
      ProductService.calculateOrderPriceUsdCents(
        product,
        params.quantity === undefined ? 1 : params.quantity,
      );

    const normalizedRecipient = normalizeRecipientUsername(params.recipientUsername);
    const now = new Date().toISOString();
    const orderId = sanitizeDocId(
      `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    );

    const order: Order = {
      orderId,
      userId: user.userId,
      userTelegramId: user.telegramId,
      username: user.username,
      ...(normalizedRecipient ? { recipientUsername: normalizedRecipient } : {}),
      productId: product.id,
      productName: product.name,
      category: product.category,
      quantity,
      unitPriceUsdCents,
      totalPriceUsdCents,
      totalPrice: totalPriceUsdCents,
      currency: 'USD',
      paymentStatus: 'pending',
      fulfillmentStatus: 'pending',
      grossRevenueUsdCents: totalPriceUsdCents,
      mystarsCurrency: 'usdt_ton',
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
      amount: order.totalPriceUsdCents,
      amountUsdCents: order.totalPriceUsdCents,
      currency: 'USD',
      details: `Создан заказ #${order.orderId} на «${order.productName}» x${order.quantity} (${formatUsdCents(order.totalPriceUsdCents)})${normalizedRecipient ? ` для @${normalizedRecipient}` : ''}`,
    });

    return order;
  }

  public static async setOrderRecipientUsername(
    orderId: string,
    callerTelegramId: number,
    rawRecipientUsername: string,
  ): Promise<Order> {
    const normalizedRecipient = normalizeRecipientUsername(rawRecipientUsername);
    if (!normalizedRecipient) {
      throw new Error('Укажите @username получателя.');
    }

    return firestoreRepo.runTransaction(async (tx) => {
      const existing = await tx.get<Order>('orders', orderId);
      if (!existing) {
        throw new Error(`Заказ ${orderId} не найден.`);
      }
      if (existing.userTelegramId !== callerTelegramId) {
        throw new Error('Вы не можете изменять чужой заказ.');
      }
      if (existing.paymentStatus !== 'pending') {
        throw new Error('Нельзя изменить получателя после оплаты заказа.');
      }

      const updated: Order = {
        ...existing,
        recipientUsername: normalizedRecipient,
        updatedAt: new Date().toISOString(),
      };
      tx.set<Order>('orders', orderId, updated);
      return updated;
    });
  }

  public static async getOrderById(orderId: string): Promise<Order | null> {
    return firestoreRepo.getDoc<Order>('orders', orderId);
  }

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
    paymentId?: string;
    telegramPaymentChargeId?: string;
    providerPaymentChargeId?: string;
  }): Promise<Order> {
    firestoreRepo.assertReadyForOrdersAndPayments();
    const resolvedPaymentDocId = params.paymentId
      ? sanitizeDocId(params.paymentId)
      : params.telegramPaymentChargeId
        ? sanitizeDocId(`pay_${params.telegramPaymentChargeId}`)
        : '';

    if (!resolvedPaymentDocId) {
      throw new Error(
        'Запрещено переводить заказ в статус paid без подтверждённого paymentId.',
      );
    }

    return firestoreRepo.runTransaction(async (tx) => {
      const verifiedPayment = await tx.get<PaymentRecord>(
        'payments',
        resolvedPaymentDocId,
      );
      if (
        !verifiedPayment ||
        verifiedPayment.orderId !== params.orderId ||
        (verifiedPayment.status !== 'paid' && verifiedPayment.status !== 'overpaid')
      ) {
        throw new Error(
          `Запрещено отмечать заказ #${params.orderId} оплаченным без подтверждённого успешного платежа (PaymentRecord не найден или не оплачен).`,
        );
      }

      const existing = await tx.get<Order>('orders', params.orderId);
      if (!existing) {
        throw new Error(`Заказ ${params.orderId} не найден.`);
      }

      if (existing.paymentStatus === 'paid' || existing.paymentStatus === 'completed') {
        return existing;
      }

      const existingUser = await tx.get<StoreUser>('users', existing.userId);
      const now = new Date().toISOString();
      const orderCents = existing.totalPriceUsdCents ?? existing.totalPrice;

      const updated: Order = {
        ...existing,
        paymentStatus: 'paid',
        fulfillmentStatus:
          existing.fulfillmentStatus === 'pending' ? 'paid' : existing.fulfillmentStatus,
        activePaymentId: verifiedPayment.paymentId,
        ...(params.telegramPaymentChargeId
          ? { telegramPaymentChargeId: params.telegramPaymentChargeId }
          : {}),
        ...(params.providerPaymentChargeId
          ? { providerPaymentChargeId: params.providerPaymentChargeId }
          : {}),
        paidAt: now,
        updatedAt: now,
      };

      tx.set<Order>('orders', updated.orderId, updated);

      if (existingUser) {
        tx.set<StoreUser>('users', existingUser.userId, {
          ...existingUser,
          totalOrders: (existingUser.totalOrders || 0) + 1,
          totalSpentUsdCents: (existingUser.totalSpentUsdCents || 0) + orderCents,
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
        amount: orderCents,
        amountUsdCents: orderCents,
        currency: updated.currency || 'USD',
        details: `Оплата подтверждена (paymentId: ${verifiedPayment.paymentId})`.slice(
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
        'Перевод заказа в статус paid разрешён только через подтверждённый платёжный сервис (PaymentService / BalanceService).',
      );
    }

    if (
      params.paymentStatus === 'refunded' ||
      params.fulfillmentStatus === 'refunded'
    ) {
      throw new Error(
        'Перевод заказа в статус refunded разрешён только через сервис возврата (PaymentService / BalanceService).',
      );
    }

    return firestoreRepo.runTransaction(async (tx) => {
      const existing = await tx.get<Order>('orders', params.orderId);
      if (!existing) return null;

      const now = new Date().toISOString();
      const nextFulfillment = params.fulfillmentStatus ?? existing.fulfillmentStatus;
      const nextPayment = params.paymentStatus ?? existing.paymentStatus;

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
    amountUsdCents?: number;
    currency?: string;
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
      ...(params.amountUsdCents !== undefined
        ? { amountUsdCents: params.amountUsdCents }
        : {}),
      currency: params.currency || 'USD',
      details: params.details.slice(0, 500),
      createdAt: now,
    };

    await firestoreRepo.setDoc<StoreTransaction>('transactions', transactionId, tx);
    return tx;
  }

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
