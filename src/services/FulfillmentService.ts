import { Telegraf } from 'telegraf';
import { getEnvConfig } from '../config/env.ts';
import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import { Order, StoreTransaction } from '../types.ts';
import { OrderService } from './OrderService.ts';
import { PaymentService } from './PaymentService.ts';
import { balanceService } from './BalanceService.ts';
import { DigitalKeyService } from './DigitalKeyService.ts';
import {
  MYSTARS_FAILURE_STATUSES,
  MYSTARS_SUCCESS_STATUSES,
  MyStarsFulfillmentAdapter,
  MyStarsWebhookEvent,
  myStarsClient,
  verifyMyStarsWebhookSignature,
} from './MyStarsService.ts';
import { buildAdminOrderActionKeyboard } from '../bot/keyboards.ts';
import { formatAdminOrderCard, formatOrderCompletedUserNotice } from '../bot/formatters.ts';

export interface FulfillmentRequestContext {
  idempotencyKey: string;
  attempt: number;
}

export interface FulfillmentAdapterResult {
  handledAutomatically: boolean;
  status: 'processing' | 'completed';
  details: string;
  externalReference?: string;
}

/**
 * Official Provider Adapter Interface.
 * Ready for future verified supplier integrations without rewriting the store logic.
 * Supports idempotency keys and optional status verification after crash recovery.
 */
export interface FulfillmentProviderAdapter {
  readonly providerName: string;
  readonly supportsIdempotency?: boolean;
  isConfigured(): boolean;
  requestFulfillment(
    order: Order,
    context?: FulfillmentRequestContext,
  ): Promise<FulfillmentAdapterResult>;
  checkExternalStatus?(
    order: Order,
    idempotencyKey: string,
  ): Promise<{
    alreadyExecuted: boolean;
    status?: 'processing' | 'completed';
    details?: string;
    externalReference?: string;
  }>;
}

export class ManualAdminFulfillmentAdapter implements FulfillmentProviderAdapter {
  public readonly providerName = 'ManualAdminFulfillment (Безопасная ручная выдача)';
  public readonly supportsIdempotency = true;

  public isConfigured(): boolean {
    return true;
  }

  public async requestFulfillment(
    order: Order,
    context?: FulfillmentRequestContext,
  ): Promise<FulfillmentAdapterResult> {
    return {
      handledAutomatically: false,
      status: 'processing',
      details: `Заказ #${order.orderId} передан администратору на ручную выдачу.`,
      externalReference: context?.idempotencyKey || `manual_${order.orderId}`,
    };
  }
}

export class FulfillmentService {
  public static readonly MAX_FULFILLMENT_ATTEMPTS = 3;
  public static baseRetryDelayMs = 2000;
  public static staleProcessingLeaseMs = 60_000;

  private static manualAdapter = new ManualAdminFulfillmentAdapter();
  private static myStarsAdapter = new MyStarsFulfillmentAdapter(myStarsClient);
  private static customAdapterOverride: FulfillmentProviderAdapter | null = null;
  private static recoveryIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private static isRecoveryPassRunning = false;

  public static setAdapter(adapter: FulfillmentProviderAdapter): void {
    if (adapter instanceof ManualAdminFulfillmentAdapter) {
      this.customAdapterOverride = null;
      this.manualAdapter = adapter;
      return;
    }
    this.customAdapterOverride = adapter;
  }

  public static resetAdapterToDefault(): void {
    this.customAdapterOverride = null;
  }

  public static getActiveAdapter(): FulfillmentProviderAdapter {
    if (this.customAdapterOverride) {
      return this.customAdapterOverride;
    }
    if (myStarsClient.isConfigured()) {
      return this.myStarsAdapter;
    }
    return this.manualAdapter;
  }

  public static getAdapterInfo(): { name: string; configured: boolean } {
    const active = this.getActiveAdapter();
    return {
      name: active.providerName,
      configured: active.isConfigured(),
    };
  }

  /**
   * Sends admin notification with retry and records `adminNotifiedAt` on success.
   * Never throws or rolls back confirmed payment/fulfillment if Telegram API fails.
   */
  public static async ensureAdminNotified(
    order: Order,
    bot: Telegraf | null | undefined,
    forceResend = false,
  ): Promise<Order> {
    if (!forceResend && order.adminNotifiedAt) {
      return order;
    }
    if (!bot) {
      return order;
    }

    const { adminIds } = getEnvConfig();
    if (adminIds.length === 0) {
      const now = new Date().toISOString();
      return (
        (await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
          adminNotifiedAt: now,
          updatedAt: now,
        })) || order
      );
    }

    let deliveredCount = 0;
    for (const adminId of adminIds) {
      const ok = await this.sendTelegramMessageWithRetry(
        bot,
        adminId,
        `🔔 <b>Новый оплаченный заказ поступил на выдачу!</b>\n\n${formatAdminOrderCard(
          order,
        )}`,
        {
          parse_mode: 'HTML',
          ...buildAdminOrderActionKeyboard(order),
        },
      );
      if (ok) {
        deliveredCount++;
      }
    }

    if (deliveredCount > 0) {
      const now = new Date().toISOString();
      return (
        (await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
          adminNotifiedAt: now,
          updatedAt: now,
        })) || order
      );
    }

    return order;
  }

  /**
   * Sends buyer completion notification with retry and records `buyerNotifiedAt` on success.
   * Never throws or cancels completed fulfillment if Telegram API fails.
   */
  public static async ensureBuyerNotified(
    order: Order,
    bot: Telegraf | null | undefined,
    forceResend = false,
  ): Promise<Order> {
    if (!forceResend && order.buyerNotifiedAt) {
      return order;
    }
    if (!bot) {
      return order;
    }

    const ok = await this.sendTelegramMessageWithRetry(
      bot,
      order.userTelegramId,
      formatOrderCompletedUserNotice(order),
      { parse_mode: 'HTML' },
    );

    if (ok) {
      const now = new Date().toISOString();
      return (
        (await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
          buyerNotifiedAt: now,
          updatedAt: now,
        })) || order
      );
    }

    return order;
  }

  public static async retryOrderNotifications(
    orderId: string,
    bot: Telegraf,
  ): Promise<{ order: Order; adminNotified: boolean; buyerNotified: boolean }> {
    let order = await OrderService.getOrderById(orderId);
    if (!order) {
      throw new Error(`Заказ #${orderId} не найден.`);
    }

    order = await this.ensureAdminNotified(order, bot, true);
    if (order.fulfillmentStatus === 'completed') {
      order = await this.ensureBuyerNotified(order, bot, true);
    }

    return {
      order,
      adminNotified: Boolean(order.adminNotifiedAt),
      buyerNotified: Boolean(order.buyerNotifiedAt),
    };
  }

  private static async sendTelegramMessageWithRetry(
    bot: Telegraf,
    chatId: number | string,
    htmlText: string,
    extra: Record<string, unknown>,
    maxAttempts = 2,
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await bot.telegram.sendMessage(chatId, htmlText, extra);
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
        }
      }
    }

    console.warn(
      `[FulfillmentService] Не удалось отправить уведомление в чат ${chatId}:`,
      lastError instanceof Error ? lastError.message : String(lastError),
    );
    return false;
  }

  /**
   * Initiates fulfillment strictly AFTER verified successful_payment commit.
   * 1. Atomically claims the order in Firestore BEFORE invoking the external adapter.
   * 2. Prevents parallel workers from executing fulfillment for the same order.
   * 3. Tracks start time, attempts count, idempotency key, and last error.
   * 4. Handles crash recovery when external execution succeeded before state persistence.
   * 5. Caps retries at MAX_FULFILLMENT_ATTEMPTS so orders never stay in 'processing' forever.
   */
  public static async initiateFulfillment(
    orderInput: Order,
    bot: Telegraf | null | undefined,
    options?: { allowStaleTakeover?: boolean },
  ): Promise<Order> {
    const idempotencyKey =
      orderInput.fulfillmentIdempotencyKey || `fulfill_${orderInput.orderId}`;
    const activeAdapter = this.getActiveAdapter();

    // Stage 3.3: Check if digital keys are available for this product (for ManualAdminFulfillmentAdapter or gifts category)
    if (
      activeAdapter instanceof ManualAdminFulfillmentAdapter ||
      orderInput.category === 'gifts'
    ) {
      const candidateKeyIds = await DigitalKeyService.getAvailableCandidateKeyIds(
        orderInput.productId,
        orderInput.quantity,
      );
      if (candidateKeyIds.length >= orderInput.quantity) {
        const keyOutcome = await DigitalKeyService.fulfillOrderWithDigitalKey(
          orderInput,
          bot,
        );
        if (keyOutcome.fulfilled) {
          return keyOutcome.order;
        }
      }
    }

    type ClaimOutcome =
      | { action: 'already_completed'; order: Order }
      | { action: 'already_processing'; order: Order }
      | { action: 'needs_admin_notification_only'; order: Order }
      | { action: 'needs_reconciliation_check'; order: Order }
      | { action: 'exhausted'; order: Order }
      | { action: 'claimed'; order: Order; attempt: number };

    // =========================================================================
    // PHASE 1: ATOMIC CLAIM BEFORE EXTERNAL ADAPTER CALL
    // =========================================================================
    const claim = await firestoreRepo.runTransaction<ClaimOutcome>(async (tx) => {
      const current = (await tx.get<Order>('orders', orderInput.orderId)) || orderInput;

      if (
        current.paymentStatus !== 'paid' &&
        current.paymentStatus !== 'processing' &&
        current.paymentStatus !== 'completed'
      ) {
        throw new Error(
          `Невозможно запустить выдачу заказа #${current.orderId} без подтверждённой оплаты (текущий статус: ${current.paymentStatus}).`,
        );
      }

      if (current.fulfillmentStatus === 'completed') {
        return { action: 'already_completed', order: current };
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const startedMs = current.fulfillmentStartedAt
        ? Date.parse(current.fulfillmentStartedAt)
        : 0;
      const isLeaseActive =
        startedMs > 0 && nowMs - startedMs < this.staleProcessingLeaseMs;

      if (current.fulfillmentStatus === 'processing') {
        // If external reference is already recorded, the adapter already finished; only ensure admin notification
        if (current.externalExecutionReference) {
          if (!current.adminNotifiedAt) {
            return { action: 'needs_admin_notification_only', order: current };
          }
          return { action: 'already_processing', order: current };
        }

        // Another worker holds an active lease right now
        if (isLeaseActive && !options?.allowStaleTakeover) {
          return { action: 'already_processing', order: current };
        }

        // Stale processing state: server crashed after claiming 'processing' before saving adapter result
        if ((current.fulfillmentAttempts ?? 0) >= 1) {
          return { action: 'needs_reconciliation_check', order: current };
        }
      }

      const prevAttempts = current.fulfillmentAttempts ?? 0;
      if (prevAttempts >= this.MAX_FULFILLMENT_ATTEMPTS) {
        const exhaustedOrder: Order = {
          ...current,
          fulfillmentStatus: 'failed',
          needsManualReconciliation: true,
          fulfillmentLastError:
            current.fulfillmentLastError ||
            `Превышен лимит попыток автоматической выдачи (${this.MAX_FULFILLMENT_ATTEMPTS}). Требуется ручная проверка администратором.`,
          fulfillmentNextRetryAt: undefined,
          updatedAt: nowIso,
        };
        tx.set<Order>('orders', exhaustedOrder.orderId, exhaustedOrder);
        return { action: 'exhausted', order: exhaustedOrder };
      }

      const nextAttempt = prevAttempts + 1;
      const claimedOrder: Order = {
        ...current,
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: nowIso,
        fulfillmentAttempts: nextAttempt,
        fulfillmentIdempotencyKey: current.fulfillmentIdempotencyKey || idempotencyKey,
        updatedAt: nowIso,
      };

      tx.set<Order>('orders', claimedOrder.orderId, claimedOrder);
      return { action: 'claimed', order: claimedOrder, attempt: nextAttempt };
    });

    if (claim.action === 'already_completed') {
      return this.ensureBuyerNotified(claim.order, bot);
    }

    if (claim.action === 'already_processing') {
      return claim.order;
    }

    if (claim.action === 'needs_admin_notification_only') {
      return this.ensureAdminNotified(claim.order, bot);
    }

    if (claim.action === 'exhausted') {
      return this.ensureAdminNotified(claim.order, bot);
    }

    // Handle crash recovery where previous worker crashed during external execution
    if (claim.action === 'needs_reconciliation_check') {
      return this.reconcileStaleProcessingOrder(claim.order, bot);
    }

    // =========================================================================
    // PHASE 2: EXECUTE EXTERNAL ADAPTER (ONLY FOR THE WORKER THAT WON THE CLAIM)
    // =========================================================================
    const { order: claimedOrder, attempt } = claim;
    try {
      const adapterResult = await activeAdapter.requestFulfillment(claimedOrder, {
        idempotencyKey: claimedOrder.fulfillmentIdempotencyKey || idempotencyKey,
        attempt,
      });

      // =========================================================================
      // PHASE 3: PERSIST ADAPTER RESULT ATOMICALLY
      // =========================================================================
      const finalizedOrder = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const latest = (await tx.get<Order>('orders', claimedOrder.orderId)) || claimedOrder;
        if (latest.fulfillmentStatus === 'completed') {
          return latest;
        }

        const nowIso = new Date().toISOString();
        const isAutoCompleted =
          adapterResult.handledAutomatically && adapterResult.status === 'completed';

        const updated: Order = {
          ...latest,
          paymentStatus: isAutoCompleted ? 'completed' : latest.paymentStatus,
          fulfillmentStatus: adapterResult.status,
          fulfillmentNote: adapterResult.details.slice(0, 500),
          externalExecutionReference:
            adapterResult.externalReference ||
            `${activeAdapter.providerName}:${idempotencyKey}`,
          fulfillmentLastError: undefined,
          fulfillmentNextRetryAt: undefined,
          completedAt: isAutoCompleted ? latest.completedAt || nowIso : latest.completedAt,
          updatedAt: nowIso,
        };

        tx.set<Order>('orders', updated.orderId, updated);

        if (isAutoCompleted) {
          const txId = sanitizeDocId(
            `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          );
          tx.set<StoreTransaction>('transactions', txId, {
            transactionId: txId,
            orderId: updated.orderId,
            userId: updated.userId,
            type: 'fulfillment_completed',
            amount: updated.totalPriceUsdCents ?? updated.totalPrice,
            amountUsdCents: updated.totalPriceUsdCents ?? updated.totalPrice,
            currency: updated.currency || 'USD',
            details: `Автоматическая выдача завершена: ${adapterResult.details}`.slice(
              0,
              500,
            ),
            createdAt: nowIso,
          });
        }

        return updated;
      });

      // =========================================================================
      // PHASE 4: SEND NOTIFICATIONS OUTSIDE TRANSACTION (FAULT-TOLERANT)
      // =========================================================================
      let notifiedOrder = await this.ensureAdminNotified(finalizedOrder, bot);
      if (notifiedOrder.fulfillmentStatus === 'completed') {
        notifiedOrder = await this.ensureBuyerNotified(notifiedOrder, bot);
      }
      return notifiedOrder;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const isNonRetryable =
        (error as { retryable?: boolean })?.retryable === false;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const canRetry = !isNonRetryable && attempt < this.MAX_FULFILLMENT_ATTEMPTS;
      const delayMs = this.baseRetryDelayMs * Math.pow(2, Math.max(0, attempt - 1));
      const nextRetryIso = canRetry ? new Date(nowMs + delayMs).toISOString() : undefined;

      const failedOrder = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const latest = (await tx.get<Order>('orders', claimedOrder.orderId)) || claimedOrder;
        const failed: Order = {
          ...latest,
          fulfillmentStatus: 'failed',
          fulfillmentLastError: errMsg.slice(0, 500),
          fulfillmentNextRetryAt: nextRetryIso,
          needsManualReconciliation: !canRetry,
          fulfillmentNote: canRetry
            ? `Ошибка попытки выдачи #${attempt}: ${errMsg}. Запланирован повтор.`
            : isNonRetryable
              ? `Выдача отклонена провайдером (неповторяемая ошибка): ${errMsg}. Требуется проверка администратором.`
              : `Выдача остановлена после ${attempt} попыток: ${errMsg}. Требуется ручная выдача админом.`,
          updatedAt: nowIso,
        };
        tx.set<Order>('orders', failed.orderId, failed);

        const txId = sanitizeDocId(
          `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        tx.set<StoreTransaction>('transactions', txId, {
          transactionId: txId,
          orderId: failed.orderId,
          userId: failed.userId,
          type: 'fulfillment_failed',
          amount: failed.totalPriceUsdCents ?? failed.totalPrice,
          amountUsdCents: failed.totalPriceUsdCents ?? failed.totalPrice,
          currency: failed.currency || 'USD',
          details: `Ошибка выдачи (попытка ${attempt}/${this.MAX_FULFILLMENT_ATTEMPTS}): ${errMsg}`.slice(
            0,
            500,
          ),
          createdAt: nowIso,
        });

        return failed;
      });

      if (!canRetry) {
        await this.ensureAdminNotified(failedOrder, bot);
      }

      throw error;
    }
  }

  /**
   * Reconciles an order that was left in 'processing' without an externalExecutionReference
   * due to a server crash mid-execution.
   * - If the adapter supports `checkExternalStatus`, queries the provider first.
   * - If the adapter does not support status checking and is not idempotent, marks the order
   *   for manual reconciliation (`fulfillmentStatus: 'failed'`, `needsManualReconciliation: true`)
   *   so the product is NEVER delivered twice!
   */
  private static async reconcileStaleProcessingOrder(
    staleOrder: Order,
    bot: Telegraf | null | undefined,
  ): Promise<Order> {
    const idempotencyKey =
      staleOrder.fulfillmentIdempotencyKey || `fulfill_${staleOrder.orderId}`;
    const activeAdapter = this.getActiveAdapter();

    if (activeAdapter.checkExternalStatus) {
      const extStatus = await activeAdapter.checkExternalStatus(
        staleOrder,
        idempotencyKey,
      );
      if (extStatus.alreadyExecuted) {
        const nowIso = new Date().toISOString();
        const finalStatus = extStatus.status || 'completed';
        const reconciled = await firestoreRepo.runTransaction<Order>(async (tx) => {
          const current = (await tx.get<Order>('orders', staleOrder.orderId)) || staleOrder;
          const updated: Order = {
            ...current,
            paymentStatus:
              finalStatus === 'completed' ? 'completed' : current.paymentStatus,
            fulfillmentStatus: finalStatus,
            fulfillmentNote: (
              extStatus.details ||
              'Статус выдачи восстановлен после сверки с внешним провайдером.'
            ).slice(0, 500),
            externalExecutionReference:
              extStatus.externalReference || `reconciled_${idempotencyKey}`,
            fulfillmentLastError: undefined,
            completedAt:
              finalStatus === 'completed'
                ? current.completedAt || nowIso
                : current.completedAt,
            updatedAt: nowIso,
          };
          tx.set<Order>('orders', updated.orderId, updated);
          return updated;
        });

        let notified = await this.ensureAdminNotified(reconciled, bot);
        if (notified.fulfillmentStatus === 'completed') {
          notified = await this.ensureBuyerNotified(notified, bot);
        }
        return notified;
      }
    }

    // If provider does not support idempotency and we cannot verify external status,
    // NEVER re-execute automatically to prevent double fulfillment!
    if (!activeAdapter.supportsIdempotency && !activeAdapter.checkExternalStatus) {
      const nowIso = new Date().toISOString();
      const quarantined = await firestoreRepo.runTransaction<Order>(async (tx) => {
        const current = (await tx.get<Order>('orders', staleOrder.orderId)) || staleOrder;
        const updated: Order = {
          ...current,
          fulfillmentStatus: 'failed',
          needsManualReconciliation: true,
          fulfillmentLastError:
            'Сервер перезапустился во время внешнего вызова без подтверждения статуса. Автоповтор заблокирован для защиты от двойной выдачи.',
          fulfillmentNote:
            'Требуется ручная сверка администратором (защита от двойной выдачи после перезапуска).',
          updatedAt: nowIso,
        };
        tx.set<Order>('orders', updated.orderId, updated);
        return updated;
      });
      return this.ensureAdminNotified(quarantined, bot);
    }

    // Adapter is explicitly idempotent (or checkExternalStatus confirmed it wasn't executed yet):
    // Reset to 'paid' inside transaction and run initiateFulfillment with the same idempotencyKey
    await firestoreRepo.runTransaction<void>(async (tx) => {
      const current = await tx.get<Order>('orders', staleOrder.orderId);
      if (!current || current.fulfillmentStatus !== 'processing') return;
      tx.set<Order>('orders', current.orderId, {
        ...current,
        fulfillmentStatus: 'paid',
        updatedAt: new Date().toISOString(),
      });
    });

    const refreshed = (await OrderService.getOrderById(staleOrder.orderId)) || staleOrder;
    return this.initiateFulfillment(refreshed, bot, { allowStaleTakeover: true });
  }

  /**
   * Recovery worker pass:
   * - Recovers orders in 'paid' (payment committed, fulfillment not started)
   * - Retries eligible orders in 'failed' whose backoff delay has elapsed and attempts < MAX_FULFILLMENT_ATTEMPTS
   * - Recovers stale 'processing' orders or retries missing admin/buyer notifications
   * Guarded by `isRecoveryPassRunning` mutex so two recovery passes never overlap.
   */
  public static async recoverPendingFulfillments(
    bot: Telegraf | null | undefined,
  ): Promise<Order[]> {
    if (this.isRecoveryPassRunning) {
      return [];
    }
    if (!firestoreRepo.isProductionStorageHealthy()) {
      return [];
    }

    this.isRecoveryPassRunning = true;
    const recovered: Order[] = [];

    try {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      // 1. Orders in 'paid' status
      const paidOrders = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'paid' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 25,
      });

      for (const ord of paidOrders) {
        if (ord.paymentStatus === 'paid') {
          try {
            const updated = await this.initiateFulfillment(ord, bot);
            recovered.push(updated);
          } catch (error) {
            console.error(
              `[FulfillmentService] Ошибка восстановления paid-заказа #${ord.orderId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }

      // 2. Retryable 'failed' orders whose backoff timer has elapsed
      const failedOrders = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'failed' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 25,
      });

      for (const ord of failedOrders) {
        const attempts = ord.fulfillmentAttempts ?? 0;
        const retryDue =
          !ord.fulfillmentNextRetryAt || ord.fulfillmentNextRetryAt <= nowIso;
        if (
          !ord.needsManualReconciliation &&
          attempts < this.MAX_FULFILLMENT_ATTEMPTS &&
          retryDue
        ) {
          try {
            const updated = await this.initiateFulfillment(ord, bot);
            recovered.push(updated);
          } catch (error) {
            console.error(
              `[FulfillmentService] Повторная попытка выдачи заказа #${ord.orderId} завершилась ошибкой:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        } else if (!ord.adminNotifiedAt) {
          await this.ensureAdminNotified(ord, bot);
        }
      }

      // 3. Stale 'processing' orders, in-flight MyStars orders, or orders with undelivered admin notifications
      const processingOrders = await firestoreRepo.queryDocs<Order>('orders', {
        where: [{ field: 'fulfillmentStatus', op: '==', value: 'processing' }],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: 25,
      });

      const activeAdapter = this.getActiveAdapter();

      for (const ord of processingOrders) {
        const startedMs = ord.fulfillmentStartedAt
          ? Date.parse(ord.fulfillmentStartedAt)
          : 0;
        const isStale =
          startedMs > 0 && nowMs - startedMs >= this.staleProcessingLeaseMs;

        if (!ord.externalExecutionReference && isStale) {
          try {
            const reconciled = await this.reconcileStaleProcessingOrder(ord, bot);
            recovered.push(reconciled);
          } catch (error) {
            console.error(
              `[FulfillmentService] Ошибка сверки зависшего заказа #${ord.orderId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
          continue;
        }

        // Poll external status for in-flight MyStars orders (e.g. awaiting_payment -> delivered)
        if (
          ord.mystarsOrderId &&
          activeAdapter.checkExternalStatus &&
          activeAdapter.isConfigured()
        ) {
          try {
            const extStatus = await activeAdapter.checkExternalStatus(
              ord,
              ord.fulfillmentIdempotencyKey || `fulfill_${ord.orderId}`,
            );
            if (extStatus.alreadyExecuted && extStatus.status === 'completed') {
              const completed = await this.completeOrder({
                orderId: ord.orderId,
                adminNote:
                  extStatus.details ||
                  `Автоматическая выдача MyStars завершена (${ord.mystarsOrderId}).`,
                bot,
              });
              recovered.push(completed);
              continue;
            }
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const isPermanent =
              (error as { retryable?: boolean })?.retryable === false;
            if (isPermanent) {
              const failedOrd = await this.markOrderFulfillmentFailedPermanent(
                ord.orderId,
                errMsg,
                bot,
              );
              if (failedOrd) {
                recovered.push(failedOrd);
                continue;
              }
            }
          }
        }

        if (!ord.adminNotifiedAt) {
          const notified = await this.ensureAdminNotified(ord, bot);
          if (notified.adminNotifiedAt) {
            recovered.push(notified);
          }
        }
      }

      // 4. AUD-016: Recover pending/interrupted refunds where Telegram succeeded before Firestore commit
      try {
        const recoveredRefunds = await PaymentService.recoverPendingRefunds();
        for (const r of recoveredRefunds) {
          recovered.push(r);
        }
      } catch (error) {
        console.error(
          '[FulfillmentService] Ошибка фонового восстановления возвратов:',
          error instanceof Error ? error.message : String(error),
        );
      }

      // 5. Reconcile pending CryptoBot & xRocket order payments and balance top-ups
      try {
        const settledOrderPayments = await PaymentService.reconcilePendingOrderPayments();
        for (const settled of settledOrderPayments) {
          if (settled.ok && settled.order) {
            try {
              const fulfilled = await this.initiateFulfillment(settled.order, bot);
              recovered.push(fulfilled);
            } catch (err) {
              console.error(
                `[FulfillmentService] Ошибка выдачи после фоновой сверки платежа заказа #${settled.order.orderId}:`,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
        await balanceService.reconcilePendingTopUps();
      } catch (error) {
        console.error(
          '[FulfillmentService] Ошибка фоновой сверки инвойсов CryptoBot/xRocket:',
          error instanceof Error ? error.message : String(error),
        );
      }

      return recovered;
    } finally {
      this.isRecoveryPassRunning = false;
    }
  }

  private static async markOrderFulfillmentFailedPermanent(
    orderId: string,
    errorMessage: string,
    bot: Telegraf | null | undefined,
    mystarsStatus?: string,
  ): Promise<Order | null> {
    const nowIso = new Date().toISOString();
    const updated = await firestoreRepo.runTransaction<Order | null>(async (tx) => {
      const current = await tx.get<Order>('orders', orderId);
      if (!current) return null;
      if (current.fulfillmentStatus === 'completed') return current;

      const failed: Order = {
        ...current,
        ...(mystarsStatus ? { mystarsOrderStatus: mystarsStatus } : {}),
        mystarsFailureReason: errorMessage.slice(0, 500),
        fulfillmentStatus: 'failed',
        needsManualReconciliation: true,
        fulfillmentLastError: errorMessage.slice(0, 500),
        fulfillmentNextRetryAt: undefined,
        fulfillmentNote: `Ошибка выдачи MyStars: ${errorMessage}`.slice(0, 500),
        updatedAt: nowIso,
      };
      tx.set<Order>('orders', failed.orderId, failed);

      const txId = sanitizeDocId(
        `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      );
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: failed.orderId,
        userId: failed.userId,
        type: 'fulfillment_failed',
        amount: failed.totalPriceUsdCents ?? failed.totalPrice,
        amountUsdCents: failed.totalPriceUsdCents ?? failed.totalPrice,
        currency: failed.currency || 'USD',
        details: `Постоянная ошибка выдачи MyStars: ${errorMessage}`.slice(0, 500),
        createdAt: nowIso,
      });

      return failed;
    });

    if (updated && updated.fulfillmentStatus === 'failed') {
      return this.ensureAdminNotified(updated, bot, true);
    }
    return updated;
  }

  /**
   * Verifies and processes incoming MyStars FaaS v1 terminal webhooks (`POST /webhook/mystars`).
   * - Validates `X-Faas-Signature` header (HMAC-SHA256 of raw UTF-8 body, supporting `"current,previous"` rotation).
   * - Authoritatively fetches `GET /v1/orders/{order_id}` from MyStars when configured.
   * - Transitions order to `completed` (and notifies buyer) when `status === "delivered"`.
   * - Transitions order to `failed` (with `needsManualReconciliation: true` and admin alert) when `status` is `"failed" | "reversed" | "expired"`.
   */
  public static async processMyStarsWebhook(params: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
    parsedBody?: unknown;
    bot?: Telegraf | null;
  }): Promise<{
    ok: boolean;
    duplicate: boolean;
    mystarsOrderId: string;
    mystarsStatus: string;
    order?: Order;
    reason?: string;
  }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    let sigHeader: string | undefined;
    for (const [k, v] of Object.entries(params.headers || {})) {
      if (k.toLowerCase() === 'x-faas-signature') {
        sigHeader = Array.isArray(v) ? v[0] : v;
        break;
      }
    }

    const secret = myStarsClient.getCredentials().webhookSecret;
    if (!verifyMyStarsWebhookSignature(params.rawBody, sigHeader, secret)) {
      throw new Error(
        '[WEBHOOK_UNAUTHORIZED] Неверная подпись вебхука MyStars (X-Faas-Signature).',
      );
    }

    let bodyObj: Record<string, unknown> | null = null;
    if (params.parsedBody && typeof params.parsedBody === 'object') {
      bodyObj = params.parsedBody as Record<string, unknown>;
    } else if (params.rawBody) {
      bodyObj = JSON.parse(params.rawBody) as Record<string, unknown>;
    }

    const mystarsOrderId =
      typeof bodyObj?.order_id === 'string' ? bodyObj.order_id.trim() : '';
    const webhookStatus =
      typeof bodyObj?.status === 'string' ? bodyObj.status.trim().toLowerCase() : '';

    if (!mystarsOrderId || !webhookStatus) {
      throw new Error('Некорректный формат вебхука MyStars: отсутствуют order_id или status.');
    }

    const event: MyStarsWebhookEvent = {
      order_id: mystarsOrderId,
      status: webhookStatus,
      failure_reason:
        typeof bodyObj?.failure_reason === 'string' ? bodyObj.failure_reason : null,
      purchase_tx:
        typeof bodyObj?.purchase_tx === 'string' ? bodyObj.purchase_tx : null,
    };

    // Locate corresponding Order in Firestore
    let targetOrder: Order | null = null;
    const byMyStarsId = await firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'mystarsOrderId', op: '==', value: mystarsOrderId }],
      limit: 1,
    });
    if (byMyStarsId.length > 0) {
      targetOrder = byMyStarsId[0];
    } else {
      const byExtRef = await firestoreRepo.queryDocs<Order>('orders', {
        where: [
          { field: 'externalExecutionReference', op: '==', value: mystarsOrderId },
        ],
        limit: 1,
      });
      if (byExtRef.length > 0) {
        targetOrder = byExtRef[0];
      }
    }

    if (!targetOrder) {
      return {
        ok: false,
        duplicate: false,
        mystarsOrderId,
        mystarsStatus: webhookStatus,
        reason: 'ORDER_NOT_FOUND',
      };
    }

    if (targetOrder.fulfillmentStatus === 'completed') {
      return {
        ok: true,
        duplicate: true,
        mystarsOrderId,
        mystarsStatus: webhookStatus,
        order: targetOrder,
      };
    }

    // Authoritatively re-verify via GET /v1/orders/{order_id} if MYSTARS_API_KEY is configured
    let effectiveStatus = webhookStatus;
    let purchaseTx = event.purchase_tx || undefined;
    let failureReason = event.failure_reason || undefined;
    let wholesaleTotalUsdt: string | undefined;

    if (myStarsClient.isConfigured()) {
      try {
        const remote = await myStarsClient.getOrder(mystarsOrderId);
        if (remote && typeof remote.status === 'string') {
          effectiveStatus = remote.status.trim().toLowerCase();
          purchaseTx = remote.purchase_tx || purchaseTx;
          failureReason =
            remote.failure_reason || remote.telegram_message || failureReason;
          const remoteRec = remote as unknown as Record<string, unknown>;
          wholesaleTotalUsdt =
            remote.payment?.fee?.total ||
            remote.payment?.amount ||
            (typeof remoteRec.payment_amount === 'string'
              ? remoteRec.payment_amount
              : undefined);
        }
      } catch {
        // Fallback to HMAC-verified webhook payload if upstream GET fails transiently
      }
    }

    if (!wholesaleTotalUsdt && typeof bodyObj?.payment_amount === 'string') {
      wholesaleTotalUsdt = bodyObj.payment_amount;
    }

    const pnlUpdates: Partial<Order> = {};
    if (wholesaleTotalUsdt) {
      const grossCents =
        targetOrder.grossRevenueUsdCents ??
        targetOrder.totalPriceUsdCents ??
        targetOrder.totalPrice;
      const providerFeeCents = targetOrder.providerFeeUsdCents ?? 0;
      const costCents = Math.round(Number(wholesaleTotalUsdt) * 100);
      if (Number.isFinite(costCents) && costCents >= 0) {
        pnlUpdates.mystarsWholesaleCostUsdt = wholesaleTotalUsdt;
        pnlUpdates.mystarsCostUsdCents = costCents;
        pnlUpdates.netProfitUsdCents = grossCents - providerFeeCents - costCents;
      }
    }

    await firestoreRepo.updateDoc<Order>('orders', targetOrder.orderId, {
      ...pnlUpdates,
      mystarsOrderId,
      mystarsOrderStatus: effectiveStatus,
      ...(purchaseTx ? { mystarsPurchaseTx: purchaseTx } : {}),
      ...(failureReason ? { mystarsFailureReason: failureReason } : {}),
      updatedAt: new Date().toISOString(),
    });

    if (MYSTARS_SUCCESS_STATUSES.has(effectiveStatus)) {
      const completed = await this.completeOrder({
        orderId: targetOrder.orderId,
        adminNote: `Автоматическая выдача через MyStars завершена (${mystarsOrderId}${purchaseTx ? `, tx: ${purchaseTx}` : ''}).`,
        bot: params.bot,
      });
      return {
        ok: true,
        duplicate: false,
        mystarsOrderId,
        mystarsStatus: effectiveStatus,
        order: completed,
      };
    }

    if (MYSTARS_FAILURE_STATUSES.has(effectiveStatus)) {
      const errDetail =
        failureReason || `Заказ MyStars ${mystarsOrderId} завершился со статусом ${effectiveStatus}`;
      const failed = await this.markOrderFulfillmentFailedPermanent(
        targetOrder.orderId,
        errDetail,
        params.bot,
        effectiveStatus,
      );
      return {
        ok: false,
        duplicate: false,
        mystarsOrderId,
        mystarsStatus: effectiveStatus,
        order: failed || targetOrder,
        reason: `MYSTARS_${effectiveStatus.toUpperCase()}`,
      };
    }

    return {
      ok: true,
      duplicate: false,
      mystarsOrderId,
      mystarsStatus: effectiveStatus,
      order: (await OrderService.getOrderById(targetOrder.orderId)) || targetOrder,
    };
  }

  /**
   * Starts the singleton background recovery worker after DB initialization.
   * Calling multiple times is safe and never creates duplicate workers.
   */
  public static startRecoveryWorker(
    getBot: () => Telegraf | null,
    intervalMs = 30_000,
  ): void {
    if (this.recoveryIntervalHandle) {
      return;
    }

    // Run initial recovery pass asynchronously without blocking startup
    void this.recoverPendingFulfillments(getBot()).catch((err) => {
      console.error(
        '[FulfillmentService] Ошибка стартового прохода recoverPendingFulfillments:',
        err instanceof Error ? err.message : String(err),
      );
    });

    this.recoveryIntervalHandle = setInterval(() => {
      void this.recoverPendingFulfillments(getBot()).catch((err) => {
        console.error(
          '[FulfillmentService] Ошибка фонового прохода recoverPendingFulfillments:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, intervalMs);

    this.recoveryIntervalHandle.unref?.();
  }

  public static stopRecoveryWorker(): void {
    if (this.recoveryIntervalHandle) {
      clearInterval(this.recoveryIntervalHandle);
      this.recoveryIntervalHandle = null;
    }
  }

  public static isRecoveryWorkerActive(): boolean {
    return this.recoveryIntervalHandle !== null;
  }

  /**
   * Completes an order (called by admin after manual delivery or by verified adapter)
   * and notifies the buyer in Telegram chat (with optional delivery message, code, or link).
   */
  public static async completeOrder(params: {
    orderId: string;
    adminNote?: string;
    adminTelegramId?: number;
    bot?: Telegraf | null;
  }): Promise<Order> {
    const note =
      params.adminNote?.trim() || 'Товар успешно выдан администратором магазина.';
    const adminInfo = params.adminTelegramId
      ? ` (админ ID: ${params.adminTelegramId})`
      : '';

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
        fulfillmentLastError: undefined,
        fulfillmentNextRetryAt: undefined,
        needsManualReconciliation: false,
        completedAt: existing.completedAt || now,
        updatedAt: now,
      };

      tx.set<Order>('orders', completedOrder.orderId, completedOrder);

      const txId = sanitizeDocId(
        `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      );
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: completedOrder.orderId,
        userId: completedOrder.userId,
        type: 'fulfillment_completed',
        amount: completedOrder.totalPriceUsdCents ?? completedOrder.totalPrice,
        amountUsdCents: completedOrder.totalPriceUsdCents ?? completedOrder.totalPrice,
        currency: completedOrder.currency || 'USD',
        details: `Заказ выдан покупателю${adminInfo}: ${note}`.slice(0, 500),
        createdAt: now,
      });

      return { newlyCompleted: true, order: completedOrder };
    });

    // Ensure buyer notification is sent (or retried if previously undelivered)
    const finalOrder = await this.ensureBuyerNotified(
      claimResult.order,
      params.bot,
    );

    return finalOrder;
  }
}
