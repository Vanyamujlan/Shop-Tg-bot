import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  Order,
  OrderStatus,
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
   * Server-side filtered and paginated user orders query (HIGH-02).
   */
  public static async getUserOrders(
    telegramId: number,
    limit = 20,
    offset = 0,
  ): Promise<Order[]> {
    return firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'userTelegramId', op: '==', value: telegramId }],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      offset,
    });
  }

  /**
   * Server-side filtered and paginated orders query for admin views (HIGH-02).
   */
  public static async getAllOrders(
    statusFilter?: OrderStatus,
    limit = 50,
    offset = 0,
  ): Promise<Order[]> {
    if (!statusFilter) {
      return firestoreRepo.queryDocs<Order>('orders', {
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit,
        offset,
      });
    }

    const fetchWindow = limit + offset;
    const [byFulfillment, byPayment] = await Promise.all([
      firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: statusFilter }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: fetchWindow,
      }),
      firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'paymentStatus', op: '==', value: statusFilter }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: fetchWindow,
      }),
    ]);

    const mergedMap = new Map<string, Order>();
    for (const ord of [...byFulfillment, ...byPayment]) {
      mergedMap.set(ord.orderId, ord);
    }

    return Array.from(mergedMap.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit);
  }

  public static async markOrderPaid(params: {
    orderId: string;
    telegramPaymentChargeId: string;
    providerPaymentChargeId?: string;
  }): Promise<Order> {
    return firestoreRepo.runTransaction(async (tx) => {
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
   * Server-side ordered and limited recent transactions query (HIGH-02).
   */
  public static async getRecentTransactions(
    limit = 15,
    offset = 0,
  ): Promise<StoreTransaction[]> {
    return firestoreRepo.queryDocs<StoreTransaction>('transactions', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      offset,
    });
  }
}
