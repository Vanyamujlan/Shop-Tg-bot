import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import { Order, PaymentRecord, StoreTransaction, StoreUser } from '../types.ts';
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
   * Ensures order exists, belongs to the buyer, is still pending, and price matches DB.
   */
  public static async validatePreCheckout(params: {
    invoicePayload: string;
    telegramUserId: number;
    currency: string;
    totalAmount: number;
  }): Promise<PreCheckoutValidationResult> {
    try {
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
   * Processes successful_payment atomically inside a single Firestore transaction (HIGH-01):
   * 1. Checks duplicate payment by paymentId / telegramPaymentChargeId
   * 2. Writes PaymentRecord
   * 3. Updates Order status to 'paid'
   * 4. Updates StoreUser purchase statistics (totalOrders, totalSpentStars)
   * 5. Writes 'payment_received' audit transaction
   *
   * Also returns `needsFulfillmentRecovery: true` if a previous attempt committed the
   * payment transaction but crashed before FulfillmentService moved `fulfillmentStatus`
   * from `'paid'` to `'processing'` / `'completed'`.
   */
  public static async processSuccessfulPayment(params: {
    telegramUserId: number;
    invoicePayload: string;
    currency: string;
    totalAmount: number;
    telegramPaymentChargeId: string;
    providerPaymentChargeId?: string;
  }): Promise<ProcessSuccessfulPaymentResult> {
    if (!params.telegramPaymentChargeId) {
      throw new Error('Отсутствует telegram_payment_charge_id в платеже.');
    }

    if (params.currency !== 'XTR') {
      throw new Error(`Неподдерживаемая валюта платежа: ${params.currency}`);
    }

    const paymentId = this.getPaymentDocId(params.telegramPaymentChargeId);

    return firestoreRepo.runTransaction<ProcessSuccessfulPaymentResult>(async (tx) => {
      // --- ALL READS FIRST (Firestore transaction requirement) ---
      const existingPayment = await tx.get<PaymentRecord>('payments', paymentId);

      if (existingPayment) {
        const existingOrder = await tx.get<Order>('orders', existingPayment.orderId);
        if (!existingOrder) {
          throw new Error(`Заказ ${existingPayment.orderId} для платежа не найден.`);
        }
        const needsFulfillmentRecovery =
          existingOrder.paymentStatus === 'paid' &&
          (existingOrder.fulfillmentStatus === 'paid' ||
            existingOrder.fulfillmentStatus === 'pending');

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

      if (order.totalPrice !== params.totalAmount) {
        throw new Error(
          `Несовпадение суммы оплаты: ожидалось ${order.totalPrice} XTR, получено ${params.totalAmount} XTR.`,
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
              order.fulfillmentStatus === 'pending');

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

      // --- ATOMIC WRITES ---
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

  public static async markPaymentRefunded(orderId: string): Promise<Order | null> {
    return firestoreRepo.runTransaction<Order | null>(async (tx) => {
      const order = await tx.get<Order>('orders', orderId);
      if (!order || !order.telegramPaymentChargeId) return null;

      const paymentId = this.getPaymentDocId(order.telegramPaymentChargeId);
      const existingPayment = await tx.get<PaymentRecord>('payments', paymentId);

      const now = new Date().toISOString();
      if (existingPayment) {
        tx.set<PaymentRecord>('payments', paymentId, {
          ...existingPayment,
          status: 'refunded',
          refundedAt: now,
        });
      }

      const updatedOrder: Order = {
        ...order,
        paymentStatus: 'refunded',
        fulfillmentStatus: 'refunded',
        fulfillmentNote:
          'Выполнен официальный возврат Telegram Stars (refundStarPayment).',
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
        details: `Возврат ${order.totalPrice} XTR (charge_id: ${order.telegramPaymentChargeId})`.slice(
          0,
          500,
        ),
        createdAt: now,
      });

      return updatedOrder;
    });
  }

  /**
   * Server-side ordered and paginated payments query (HIGH-02).
   */
  public static async getAllPayments(
    limit = 100,
    offset = 0,
  ): Promise<PaymentRecord[]> {
    return firestoreRepo.queryDocs<PaymentRecord>('payments', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      offset,
    });
  }
}
