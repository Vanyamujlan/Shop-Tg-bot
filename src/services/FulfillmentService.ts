import { Telegraf } from 'telegraf';
import { getEnvConfig } from '../config/env.ts';
import { firestoreRepo } from '../db/firestore.ts';
import { Order } from '../types.ts';
import { OrderService } from './OrderService.ts';
import { buildAdminOrderActionKeyboard } from '../bot/keyboards.ts';
import { formatAdminOrderCard, formatOrderCompletedUserNotice } from '../bot/formatters.ts';

/**
 * Official Provider Adapter Interface.
 * Ready for future verified supplier integrations without rewriting the store logic.
 * Does NOT use unofficial Fragment methods, external web scraping, seed phrases, or private keys.
 */
export interface FulfillmentProviderAdapter {
  readonly providerName: string;
  isConfigured(): boolean;
  requestFulfillment(order: Order): Promise<{
    handledAutomatically: boolean;
    status: 'processing' | 'completed';
    details: string;
  }>;
}

export class ManualAdminFulfillmentAdapter implements FulfillmentProviderAdapter {
  public readonly providerName = 'ManualAdminFulfillment (Безопасная ручная выдача)';

  public isConfigured(): boolean {
    return true;
  }

  public async requestFulfillment(order: Order): Promise<{
    handledAutomatically: boolean;
    status: 'processing' | 'completed';
    details: string;
  }> {
    return {
      handledAutomatically: false,
      status: 'processing',
      details: `Заказ #${order.orderId} передан администратору на ручную выдачу.`,
    };
  }
}

export class FulfillmentService {
  private static adapter: FulfillmentProviderAdapter =
    new ManualAdminFulfillmentAdapter();

  public static setAdapter(adapter: FulfillmentProviderAdapter): void {
    this.adapter = adapter;
  }

  public static getAdapterInfo(): { name: string; configured: boolean } {
    return {
      name: this.adapter.providerName,
      configured: this.adapter.isConfigured(),
    };
  }

  private static async sendAdminNotificationWithRetry(
    bot: Telegraf,
    adminId: number,
    order: Order,
    maxAttempts = 2,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `🔔 <b>Новый оплаченный заказ поступил на выдачу!</b>\n\n${formatAdminOrderCard(
            order,
          )}`,
          {
            parse_mode: 'HTML',
            ...buildAdminOrderActionKeyboard(order),
          },
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }

    console.warn(
      `[FulfillmentService] Не удалось отправить уведомление админу ${adminId}:`,
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  }

  /**
   * Initiates fulfillment strictly AFTER verified successful_payment commit (HIGH-01).
   * Atomically claims the order transition ('paid' -> 'processing' / 'completed') via
   * Firestore transaction to guarantee idempotency and prevent duplicate fulfillment
   * or duplicate admin notifications on retries or concurrent calls.
   */
  public static async initiateFulfillment(
    order: Order,
    bot: Telegraf,
  ): Promise<Order> {
    const latestBeforeAdapter =
      (await OrderService.getOrderById(order.orderId)) || order;

    if (
      latestBeforeAdapter.paymentStatus !== 'paid' &&
      latestBeforeAdapter.paymentStatus !== 'processing' &&
      latestBeforeAdapter.paymentStatus !== 'completed'
    ) {
      throw new Error(
        `Невозможно запустить выдачу заказа #${order.orderId} без подтверждённой оплаты.`,
      );
    }

    // Idempotent guard: if already claimed by a previous or concurrent execution, return immediately
    if (
      latestBeforeAdapter.fulfillmentStatus === 'processing' ||
      latestBeforeAdapter.fulfillmentStatus === 'completed'
    ) {
      return latestBeforeAdapter;
    }

    const result = await this.adapter.requestFulfillment(latestBeforeAdapter);

    // Atomically claim the fulfillment status transition in Firestore
    const claimResult = await firestoreRepo.runTransaction<{
      claimed: boolean;
      order: Order;
    }>(async (tx) => {
      const current = await tx.get<Order>('orders', order.orderId);
      const baseOrder = current || latestBeforeAdapter;

      if (
        baseOrder.fulfillmentStatus === 'processing' ||
        baseOrder.fulfillmentStatus === 'completed'
      ) {
        return { claimed: false, order: baseOrder };
      }

      const now = new Date().toISOString();
      const updated: Order = {
        ...baseOrder,
        fulfillmentStatus: result.status,
        fulfillmentNote: result.details.slice(0, 500),
        completedAt:
          result.status === 'completed'
            ? baseOrder.completedAt || now
            : baseOrder.completedAt,
        updatedAt: now,
      };

      tx.set<Order>('orders', updated.orderId, updated);
      return { claimed: true, order: updated };
    });

    // External side effects (admin notifications) execute ONLY for the caller that won the atomic claim
    if (claimResult.claimed) {
      const { adminIds } = getEnvConfig();
      for (const adminId of adminIds) {
        await this.sendAdminNotificationWithRetry(bot, adminId, claimResult.order);
      }
    }

    return claimResult.order;
  }

  /**
   * Recovery mechanism for orders where payment transaction committed ('paid'),
   * but a partial failure occurred before fulfillment was initiated ('fulfillmentStatus === "paid"').
   */
  public static async recoverPendingFulfillments(bot: Telegraf): Promise<Order[]> {
    const stuckOrders = await firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'fulfillmentStatus', op: '==', value: 'paid' }],
      orderBy: { field: 'createdAt', direction: 'asc' },
      limit: 25,
    });

    const recovered: Order[] = [];
    for (const stuckOrder of stuckOrders) {
      if (stuckOrder.paymentStatus === 'paid') {
        try {
          const updated = await this.initiateFulfillment(stuckOrder, bot);
          recovered.push(updated);
        } catch (error) {
          console.error(
            `[FulfillmentService] Ошибка восстановления выдачи заказа #${stuckOrder.orderId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    return recovered;
  }

  /**
   * Completes an order (called by admin after manual delivery or by verified adapter)
   * and notifies the buyer in Telegram chat.
   */
  public static async completeOrder(params: {
    orderId: string;
    adminNote?: string;
    bot: Telegraf;
  }): Promise<Order> {
    const note =
      params.adminNote?.trim() || 'Товар успешно выдан администратором магазина.';

    const claimResult = await firestoreRepo.runTransaction<{
      newlyCompleted: boolean;
      order: Order;
    }>(async (tx) => {
      const existing = await tx.get<Order>('orders', params.orderId);
      if (!existing) {
        throw new Error(`Заказ #${params.orderId} не найден.`);
      }

      if (existing.fulfillmentStatus === 'completed') {
        return { newlyCompleted: false, order: existing };
      }

      if (
        existing.paymentStatus !== 'paid' &&
        existing.paymentStatus !== 'processing'
      ) {
        throw new Error(
          `Заказ #${params.orderId} не имеет статуса подтверждённой оплаты (${existing.paymentStatus}).`,
        );
      }

      const now = new Date().toISOString();
      const completedOrder: Order = {
        ...existing,
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        fulfillmentNote: note.slice(0, 500),
        completedAt: existing.completedAt || now,
        updatedAt: now,
      };

      tx.set<Order>('orders', completedOrder.orderId, completedOrder);
      return { newlyCompleted: true, order: completedOrder };
    });

    if (!claimResult.newlyCompleted) {
      return claimResult.order;
    }

    const completedOrder = claimResult.order;

    await OrderService.logTransaction({
      orderId: completedOrder.orderId,
      userId: completedOrder.userId,
      type: 'fulfillment_completed',
      amount: completedOrder.totalPrice,
      details: `Заказ выдан покупателю: ${note}`,
    });

    // Notify the customer in Telegram
    try {
      await params.bot.telegram.sendMessage(
        completedOrder.userTelegramId,
        formatOrderCompletedUserNotice(completedOrder),
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      console.warn(
        `[FulfillmentService] Не удалось уведомить покупателя ${completedOrder.userTelegramId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    return completedOrder;
  }
}
