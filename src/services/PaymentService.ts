import crypto from 'crypto';
import { getEnvConfig } from '../config/env.ts';
import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  BalanceTopUpProvider,
  Order,
  PaymentLockRecord,
  PaymentRecord,
  PaymentRecordStatus,
  Product,
  StoreTransaction,
  StoreUser,
} from '../types.ts';
import {
  assertValidUsdCents,
  centsToUsdString,
  compareScaledDecimal,
  formatUsdCents,
  usdInputToCents,
} from './Money.ts';
import {
  OrderService,
  normalizeRecipientUsername,
} from './OrderService.ts';
import { ProductService } from './ProductService.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  PaymentProviderGateway,
  normalizeCurrencyCode,
  normalizeNetworkCode,
  paymentProviderGateway,
  redactSecretsFromText,
} from './PaymentProviders.ts';

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

export interface CreateOrderPaymentResult {
  reused: boolean;
  payment: PaymentRecord;
  order: Order;
}

export interface ProcessOrderPaymentVerificationResult {
  ok: boolean;
  duplicate: boolean;
  needsFulfillmentRecovery: boolean;
  status: PaymentRecordStatus;
  order?: Order;
  payment?: PaymentRecord;
  reason?: string;
}

export class PaymentService {
  private static defaultInstance = new PaymentService('default');
  private static pendingConfirmedCommits = new Map<
    string,
    ConfirmedTelegramRefundEntry
  >();

  public static staleRefundInProgressMs = 60_000;

  private readonly instanceConfirmedCommits = new Map<
    string,
    ConfirmedTelegramRefundEntry
  >();
  public readonly instanceId: string;
  private gateway: PaymentProviderGateway;

  constructor(
    instanceId = `ps_${Math.random().toString(36).slice(2, 8)}`,
    gateway: PaymentProviderGateway = paymentProviderGateway,
  ) {
    this.instanceId = instanceId;
    this.gateway = gateway;
  }

  public setGateway(gateway: PaymentProviderGateway): void {
    this.gateway = gateway;
  }

  public getGateway(): PaymentProviderGateway {
    return this.gateway;
  }

  public static getPaymentDocId(telegramPaymentChargeId: string): string {
    return sanitizeDocId(`pay_${telegramPaymentChargeId}`);
  }

  /**
   * Telegram Stars (XTR) as a buyer checkout method is DISABLED in QuizyStars (Stage 4.2).
   * Rejects any legacy `pre_checkout_query`.
   */
  public static async validatePreCheckout(params: {
    invoicePayload: string;
    telegramUserId: number;
    currency: string;
    totalAmount: number;
  }): Promise<PreCheckoutValidationResult> {
    void params;
    return {
      ok: false,
      errorMessage:
        'Оплата через Telegram Stars (XTR) отключена. Используйте CryptoBot, xRocket или внутренний баланс QuizyStars.',
    };
  }

  /**
   * Telegram Stars (XTR) as a buyer checkout method is DISABLED in QuizyStars (Stage 4.2).
   */
  public static async processSuccessfulPayment(params: {
    telegramUserId: number;
    invoicePayload: string;
    currency: string;
    totalAmount: number;
    telegramPaymentChargeId: string;
    providerPaymentChargeId?: string;
  }): Promise<ProcessSuccessfulPaymentResult> {
    void params;
    throw new Error(
      'XTR_CHECKOUT_DISABLED: Оплата через Telegram Stars (XTR) полностью отключена в QuizyStars.',
    );
  }

  /**
   * Creates or reuses an active pending CryptoBot / xRocket invoice for a buyer's order.
   * Locks live exchange rate and expected decimal string at invoice creation.
   */
  public async createOrReuseOrderPayment(params: {
    orderId: string;
    callerTelegramId: number;
    provider: BalanceTopUpProvider;
    currency?: string;
    network?: string;
    customRateUsdStr?: string;
    expiresInSeconds?: number;
    forceNew?: boolean;
    requireRecipient?: boolean;
  }): Promise<CreateOrderPaymentResult> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const providerMeta = PAYMENT_PROVIDER_CATALOG[params.provider];
    if (!providerMeta) {
      throw new Error(`Неизвестный платёжный провайдер: ${String(params.provider)}`);
    }

    const order = await OrderService.getOrderById(params.orderId);
    if (!order) {
      throw new Error(`Заказ #${params.orderId} не найден.`);
    }
    if (order.userTelegramId !== params.callerTelegramId) {
      throw new Error('Вы не можете оплачивать чужой заказ.');
    }
    if (order.paymentStatus !== 'pending' || order.fulfillmentStatus !== 'pending') {
      throw new Error(
        `Заказ #${order.orderId} уже имеет статус оплаты "${order.paymentStatus}" и не может быть оплачен.`,
      );
    }

    const product = await firestoreRepo.getDoc<Product>('products', order.productId);
    if (!product || !product.isActive) {
      throw new Error('Товар снят с продажи.');
    }
    ProductService.validateOrderQuantity(product, order.quantity);
    const normalizedRecipient =
      order.recipientUsername !== undefined
        ? normalizeRecipientUsername(order.recipientUsername)
        : undefined;
    if (
      (params.requireRecipient ||
        product.id === ProductService.BUYER_STARS_PRODUCT_ID) &&
      !normalizedRecipient
    ) {
      throw new Error('Укажите @username получателя перед оплатой заказа.');
    }

    const { currency: normalizedCurr, network: normalizedNet } =
      await this.gateway.validateCurrencyAndNetwork(
        params.provider,
        params.currency || providerMeta.defaultCurrency,
        params.network,
      );

    // Reuse an existing active non-expired pending PaymentRecord for the same (order, provider, currency, network)
    if (!params.forceNew) {
      const existingPayments = await firestoreRepo.queryDocs<PaymentRecord>(
        'payments',
        {
          where: [{ field: 'orderId', op: '==', value: order.orderId }],
          limit: 20,
        },
      );
      const nowMs = Date.now();
      const reusable = existingPayments.find(
        (p) =>
          p.status === 'pending' &&
          p.provider === params.provider &&
          normalizeCurrencyCode(p.currency) === normalizedCurr &&
          (p.network || undefined) === normalizedNet &&
          Boolean(p.payUrl) &&
          (!p.expiresAt || Date.parse(p.expiresAt) > nowMs + 15_000),
      );
      if (reusable) {
        return { reused: true, payment: reusable, order };
      }
    }

    const orderCents = assertValidUsdCents(
      order.totalPriceUsdCents ?? order.totalPrice,
      'totalPriceUsdCents',
    );

    const conversion = await this.gateway.getLiveUsdConversion({
      provider: params.provider,
      amountUsdCents: orderCents,
      targetCurrency: normalizedCurr,
      network: normalizedNet,
      customRateUsdStr: params.customRateUsdStr,
    });

    const paymentId = sanitizeDocId(
      `ordpay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    );
    const storeName = getEnvConfig().storeName || 'QuizyStars';
    const recipientInfo = order.recipientUsername ? ` (@${order.recipientUsername})` : '';
    const netInfo = normalizedNet ? ` [${normalizedNet}]` : '';
    const description = `${storeName}: ${order.productName} x${order.quantity}${recipientInfo} — ${formatUsdCents(orderCents)}${netInfo}`;

    const createdInvoice = await this.gateway.createInvoice({
      paymentId,
      provider: params.provider,
      amountStr: conversion.convertedAmountStr,
      amountPaid: conversion.convertedAmount,
      currency: normalizedCurr,
      network: normalizedNet,
      description,
      expiresInSeconds: params.expiresInSeconds ?? 1800,
    });

    const now = new Date().toISOString();
    const paymentRecord: PaymentRecord = {
      paymentId,
      kind: 'order',
      provider: params.provider,
      providerPaymentId: createdInvoice.externalInvoiceId,
      orderId: order.orderId,
      userId: order.userId,
      userTelegramId: order.userTelegramId,
      totalAmount: orderCents,
      expectedUsdCents: orderCents,
      feeUsdCents: 0,
      netUsdCents: orderCents,
      expectedAmountStr: conversion.convertedAmountStr,
      exchangeRateUsdStr: conversion.exchangeRateUsdStr,
      currency: normalizedCurr,
      ...(normalizedNet ? { network: normalizedNet } : {}),
      invoicePayload: order.orderId,
      payUrl: createdInvoice.payUrl,
      status: 'pending',
      expiresAt: createdInvoice.expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    const updatedOrder = await firestoreRepo.runTransaction(async (tx) => {
      const freshOrder = await tx.get<Order>('orders', order.orderId);
      if (!freshOrder) {
        throw new Error(`Заказ #${order.orderId} не найден.`);
      }
      if (freshOrder.paymentStatus !== 'pending') {
        throw new Error(
          `Заказ #${order.orderId} уже имеет статус оплаты "${freshOrder.paymentStatus}".`,
        );
      }

      const nextOrder: Order = {
        ...freshOrder,
        paymentMethod: params.provider,
        activePaymentId: paymentId,
        externalInvoiceId: createdInvoice.externalInvoiceId,
        grossRevenueUsdCents: orderCents,
        mystarsCurrency: 'usdt_ton',
        updatedAt: now,
      };

      tx.set<PaymentRecord>('payments', paymentId, paymentRecord);
      tx.set<Order>('orders', nextOrder.orderId, nextOrder);

      const txId = sanitizeDocId(`tx_ord_inv_${paymentId}`);
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: nextOrder.orderId,
        userId: nextOrder.userId,
        type: normalizedCurr === 'USD' ? 'invoice_created' : 'exchange_rate_locked',
        amount: orderCents,
        amountUsdCents: orderCents,
        currency: 'USD',
        details: `Выставлен счёт ${paymentId} (${providerMeta.shortTitle}): ${formatUsdCents(orderCents)} -> ${conversion.convertedAmountStr} ${normalizedCurr}${netInfo}, курс=${conversion.exchangeRateUsdStr}, ext=${createdInvoice.externalInvoiceId}`,
        createdAt: now,
      });

      return nextOrder;
    });

    return {
      reused: false,
      payment: paymentRecord,
      order: updatedOrder,
    };
  }

  public static createOrReuseOrderPayment(params: {
    orderId: string;
    callerTelegramId: number;
    provider: BalanceTopUpProvider;
    currency?: string;
    network?: string;
    customRateUsdStr?: string;
    expiresInSeconds?: number;
    forceNew?: boolean;
    requireRecipient?: boolean;
  }): Promise<CreateOrderPaymentResult> {
    return this.defaultInstance.createOrReuseOrderPayment(params);
  }

  /**
   * Processes incoming provider webhooks for direct order payments.
   * Verifies cryptographic signature BEFORE making any outbound provider API call.
   */
  public async processOrderWebhook(params: {
    provider: BalanceTopUpProvider;
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
    parsedBody?: unknown;
  }): Promise<ProcessOrderPaymentVerificationResult> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const isSignatureValid = this.gateway.verifyWebhookSignature(
      params.provider,
      params.rawBody,
      params.headers,
    );
    if (!isSignatureValid) {
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        reason: 'INVALID_WEBHOOK_SIGNATURE',
      };
    }

    let bodyObj = params.parsedBody;
    if (bodyObj === undefined) {
      try {
        bodyObj = JSON.parse(params.rawBody);
      } catch {
        return {
          ok: false,
          duplicate: false,
          needsFulfillmentRecovery: false,
          status: 'failed',
          reason: 'INVALID_WEBHOOK_JSON',
        };
      }
    }

    let notification;
    try {
      notification = this.gateway.parseWebhookPayload(params.provider, bodyObj);
    } catch (error) {
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        reason: error instanceof Error ? error.message : 'INVALID_WEBHOOK_PAYLOAD',
      };
    }

    let payment: PaymentRecord | null = null;
    if (notification.paymentId) {
      payment = await firestoreRepo.getDoc<PaymentRecord>(
        'payments',
        notification.paymentId,
      );
    }
    if (!payment && notification.externalInvoiceId) {
      const candidates = await firestoreRepo.queryDocs<PaymentRecord>('payments', {
        where: [
          {
            field: 'providerPaymentId',
            op: '==',
            value: notification.externalInvoiceId,
          },
        ],
        limit: 5,
      });
      payment = candidates.find((p) => p.provider === params.provider) || null;
    }

    if (!payment) {
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        reason: 'ORDER_PAYMENT_NOT_FOUND',
      };
    }

    if (payment.provider !== params.provider) {
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        reason: 'PROVIDER_MISMATCH',
      };
    }

    return this.verifyAndProcessOrderPayment(payment.paymentId, notification);
  }

  public static processOrderWebhook(params: {
    provider: BalanceTopUpProvider;
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
    parsedBody?: unknown;
  }): Promise<ProcessOrderPaymentVerificationResult> {
    return this.defaultInstance.processOrderWebhook(params);
  }

  /**
   * Authoritatively verifies order payment via CryptoBot / xRocket API, validates invoice parameters,
   * detects underpaid / overpaid / expired / mismatch, claims unique atomic `payment_locks/{lockId}`,
   * and marks Order as `paid` inside a Firestore transaction.
   */
  public async verifyAndProcessOrderPayment(
    paymentId: string,
    webhookHint?: {
      amountPaidStr?: string;
      amountPaid?: number;
      currency?: string;
      network?: string;
      externalInvoiceId?: string;
      paymentId?: string;
    },
  ): Promise<ProcessOrderPaymentVerificationResult> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const existingPayment = await firestoreRepo.getDoc<PaymentRecord>(
      'payments',
      paymentId,
    );
    if (!existingPayment) {
      throw new Error(`Платёж по заказу ${paymentId} не найден.`);
    }

    if (
      existingPayment.status === 'paid' ||
      existingPayment.status === 'overpaid'
    ) {
      const existingOrder = await OrderService.getOrderById(existingPayment.orderId);
      const needsFulfillmentRecovery =
        Boolean(existingOrder) &&
        existingOrder!.paymentStatus === 'paid' &&
        (existingOrder!.fulfillmentStatus === 'paid' ||
          existingOrder!.fulfillmentStatus === 'pending' ||
          existingOrder!.fulfillmentStatus === 'failed');
      return {
        ok: true,
        duplicate: true,
        needsFulfillmentRecovery,
        status: existingPayment.status,
        order: existingOrder || undefined,
        payment: existingPayment,
      };
    }

    if (
      existingPayment.status === 'cancelled' ||
      existingPayment.status === 'expired' ||
      existingPayment.status === 'failed' ||
      existingPayment.status === 'underpaid'
    ) {
      const ord = await OrderService.getOrderById(existingPayment.orderId);
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: existingPayment.status,
        order: ord || undefined,
        payment: existingPayment,
        reason: `PAYMENT_ALREADY_${existingPayment.status.toUpperCase()}`,
      };
    }

    if (
      existingPayment.provider !== 'cryptobot' &&
      existingPayment.provider !== 'xrocket'
    ) {
      throw new Error(
        `Проверка внешнего инвойса не поддерживается для провайдера "${existingPayment.provider}".`,
      );
    }

    const externalInvoiceId = existingPayment.providerPaymentId || '';
    if (!externalInvoiceId) {
      throw new Error(`У платежа ${paymentId} отсутствует providerPaymentId.`);
    }

    const isLocallyExpired =
      Boolean(existingPayment.expiresAt) &&
      new Date(existingPayment.expiresAt!).getTime() <= Date.now();

    const verified = await this.gateway.verifyInvoiceStatus({
      provider: existingPayment.provider,
      externalInvoiceId,
      paymentId: existingPayment.paymentId,
    });

    if (verified.status === 'expired' || isLocallyExpired) {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        'expired',
        'order_expired',
        'Срок действия счёта на оплату заказа истёк.',
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'expired',
        order: order || undefined,
        payment,
        reason: 'INVOICE_EXPIRED',
      };
    }

    if (verified.status === 'cancelled' || verified.status === 'failed') {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        verified.status,
        'error',
        `Инвойс заказа отменён или отклонён провайдером (status=${verified.status}).`,
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: verified.status,
        order: order || undefined,
        payment,
        reason: `INVOICE_${verified.status.toUpperCase()}`,
      };
    }

    if (verified.status === 'underpaid') {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        'underpaid',
        'order_underpaid',
        `Недоплата заказа #${existingPayment.orderId}: получено ${verified.amountPaidStr} ${verified.currency}, ожидалось ${existingPayment.expectedAmountStr} ${existingPayment.currency}.`,
        verified.amountPaidStr,
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'underpaid',
        order: order || undefined,
        payment,
        reason: 'UNDERPAID',
      };
    }

    if (verified.status !== 'paid') {
      const ord = await OrderService.getOrderById(existingPayment.orderId);
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'pending',
        order: ord || undefined,
        payment: existingPayment,
        reason: 'PAYMENT_STILL_PENDING',
      };
    }

    // 1. External invoice ID and payload match
    if (
      String(verified.externalInvoiceId) !== String(externalInvoiceId) ||
      (webhookHint?.externalInvoiceId &&
        String(webhookHint.externalInvoiceId) !== String(externalInvoiceId))
    ) {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        'failed',
        'error',
        `Несовпадение externalInvoiceId: ожидался ${externalInvoiceId}, получен ${verified.externalInvoiceId}.`,
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        order: order || undefined,
        payment,
        reason: 'INVALID_INVOICE_ID',
      };
    }

    if (
      (verified.paymentId && verified.paymentId !== existingPayment.paymentId) ||
      (webhookHint?.paymentId && webhookHint.paymentId !== existingPayment.paymentId)
    ) {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        'failed',
        'error',
        `Несовпадение paymentId в ответе провайдера: ожидался ${existingPayment.paymentId}, получен ${verified.paymentId}.`,
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        order: order || undefined,
        payment,
        reason: 'INVALID_PAYMENT_ID',
      };
    }

    // 2. Currency & network match
    const expectedCurr = normalizeCurrencyCode(existingPayment.currency);
    const verifiedCurr = normalizeCurrencyCode(verified.currency);
    const hintCurr = webhookHint?.currency
      ? normalizeCurrencyCode(webhookHint.currency)
      : expectedCurr;

    if (verifiedCurr !== expectedCurr || hintCurr !== expectedCurr) {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        'failed',
        'error',
        `Несовпадение валюты заказа: ожидалась ${expectedCurr}, получена ${verifiedCurr}.`,
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        order: order || undefined,
        payment,
        reason: 'INVALID_CURRENCY',
      };
    }

    const expectedNet = normalizeNetworkCode(existingPayment.network);
    const verifiedNet = normalizeNetworkCode(verified.network);
    if (expectedNet && verifiedNet && expectedNet !== verifiedNet) {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        'failed',
        'error',
        `Несовпадение сети заказа: ожидалась ${expectedNet}, получена ${verifiedNet}.`,
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'failed',
        order: order || undefined,
        payment,
        reason: 'INVALID_NETWORK',
      };
    }

    // 3. Exact scaled 10^18 amount check
    const expectedStr = existingPayment.expectedAmountStr;
    const verifiedStr = verified.amountPaidStr;
    const cmp = compareScaledDecimal(verifiedStr, expectedStr);

    if (cmp < 0) {
      const { payment, order } = await this.markOrderPaymentIssue(
        existingPayment.paymentId,
        'underpaid',
        'order_underpaid',
        `Недоплата заказа #${existingPayment.orderId}: получено ${verifiedStr} ${expectedCurr}, ожидалось ${expectedStr} ${expectedCurr}.`,
        verifiedStr,
      );
      return {
        ok: false,
        duplicate: false,
        needsFulfillmentRecovery: false,
        status: 'underpaid',
        order: order || undefined,
        payment,
        reason: 'UNDERPAID',
      };
    }

    const isOverpaid = cmp > 0;
    let providerFeeUsdCents = 0;
    if (verified.feeInUsdStr) {
      try {
        // Quantize fee string to nearest integer USD cent safely
        const normalizedFee = verified.feeInUsdStr.trim().replace(',', '.');
        const parts = normalizedFee.split('.');
        const twoDec = `${parts[0] || '0'}.${(parts[1] || '00').slice(0, 2).padEnd(2, '0')}`;
        if (compareScaledDecimal(twoDec, '0.01') >= 0) {
          providerFeeUsdCents = usdInputToCents(twoDec);
        }
      } catch {
        providerFeeUsdCents = 0;
      }
    }

    const lockId = sanitizeDocId(
      `ext_${existingPayment.provider}_${externalInvoiceId}`,
    );

    // 4. Atomic Firestore settlement + payment_locks uniqueness claim
    return firestoreRepo.runTransaction<ProcessOrderPaymentVerificationResult>(
      async (tx) => {
        const [freshPayment, freshOrder, existingLock] = await Promise.all([
          tx.get<PaymentRecord>('payments', existingPayment.paymentId),
          tx.get<Order>('orders', existingPayment.orderId),
          tx.get<PaymentLockRecord>('payment_locks', lockId),
        ]);

        if (!freshPayment || !freshOrder) {
          throw new Error(
            `Платёж ${existingPayment.paymentId} или заказ ${existingPayment.orderId} не найден в транзакции.`,
          );
        }

        const existingUser = await tx.get<StoreUser>('users', freshOrder.userId);

        if (
          freshPayment.status === 'paid' ||
          freshPayment.status === 'overpaid'
        ) {
          const needsRecovery =
            freshOrder.paymentStatus === 'paid' &&
            (freshOrder.fulfillmentStatus === 'paid' ||
              freshOrder.fulfillmentStatus === 'pending' ||
              freshOrder.fulfillmentStatus === 'failed');
          return {
            ok: true,
            duplicate: true,
            needsFulfillmentRecovery: needsRecovery,
            status: freshPayment.status,
            order: freshOrder,
            payment: freshPayment,
          };
        }

        if (
          existingLock &&
          (existingLock.targetType !== 'order' ||
            existingLock.targetId !== freshOrder.orderId)
        ) {
          throw new Error(
            `PAYMENT_LOCK_CONFLICT: внешний инвойс ${externalInvoiceId} уже привязан к ${existingLock.targetType}:${existingLock.targetId}.`,
          );
        }

        if (
          freshOrder.paymentStatus !== 'pending' ||
          freshOrder.fulfillmentStatus !== 'pending'
        ) {
          throw new Error(
            `Заказ #${freshOrder.orderId} уже имеет статус оплаты "${freshOrder.paymentStatus}" и не может быть повторно оплачен другим платежом.`,
          );
        }

        const now = new Date().toISOString();
        const orderCents = assertValidUsdCents(
          freshOrder.totalPriceUsdCents ?? freshOrder.totalPrice,
          'totalPriceUsdCents',
        );
        if (orderCents !== freshPayment.expectedUsdCents) {
          throw new Error(
            `Нарушение целостности суммы заказа #${freshOrder.orderId}: ожидалось ${freshPayment.expectedUsdCents} центов, в заказе ${orderCents} центов.`,
          );
        }
        const finalPaymentStatus: PaymentRecordStatus = isOverpaid
          ? 'overpaid'
          : 'paid';
        const netUsdCents = Math.max(0, orderCents - providerFeeUsdCents);

        const updatedPayment: PaymentRecord = {
          ...freshPayment,
          status: finalPaymentStatus,
          actualAmountStr: verifiedStr,
          feeUsdCents: providerFeeUsdCents,
          netUsdCents,
          statusReason: isOverpaid
            ? `Переплата: получено ${verifiedStr} > ${expectedStr} ${expectedCurr}. Заказ закрыт на сумму ${formatUsdCents(orderCents)}.`
            : undefined,
          paidAt: verified.paidAt || now,
          confirmedAt: now,
          updatedAt: now,
        };

        const updatedOrder: Order = {
          ...freshOrder,
          paymentMethod: freshPayment.provider as Order['paymentMethod'],
          activePaymentId: freshPayment.paymentId,
          externalInvoiceId,
          paymentStatus: 'paid',
          fulfillmentStatus:
            freshOrder.fulfillmentStatus === 'pending'
              ? 'paid'
              : freshOrder.fulfillmentStatus,
          grossRevenueUsdCents: orderCents,
          providerFeeUsdCents,
          mystarsCurrency: 'usdt_ton',
          fulfillmentAttempts: freshOrder.fulfillmentAttempts ?? 0,
          fulfillmentIdempotencyKey:
            freshOrder.fulfillmentIdempotencyKey ||
            `fulfill_${freshOrder.orderId}`,
          paidAt: verified.paidAt || now,
          updatedAt: now,
        };

        const lockRecord: PaymentLockRecord = {
          lockId,
          provider: freshPayment.provider,
          providerPaymentId: externalInvoiceId,
          targetType: 'order',
          targetId: freshOrder.orderId,
          paymentId: freshPayment.paymentId,
          userId: freshOrder.userId,
          amountUsdCents: orderCents,
          claimedAt: now,
        };

        tx.set<PaymentLockRecord>('payment_locks', lockId, lockRecord);
        tx.set<PaymentRecord>('payments', updatedPayment.paymentId, updatedPayment);
        tx.set<Order>('orders', updatedOrder.orderId, updatedOrder);

        if (existingUser) {
          tx.set<StoreUser>('users', existingUser.userId, {
            ...existingUser,
            totalOrders: (existingUser.totalOrders || 0) + 1,
            totalSpentUsdCents:
              (existingUser.totalSpentUsdCents || 0) + orderCents,
            updatedAt: now,
          });
        } else {
          tx.set<StoreUser>('users', freshOrder.userId, {
            userId: freshOrder.userId,
            telegramId: freshOrder.userTelegramId,
            username: freshOrder.username || '',
            firstName: 'Покупатель',
            lastName: '',
            languageCode: 'ru',
            isBlocked: false,
            totalOrders: 1,
            balanceUsdCents: 0,
            totalSpentUsdCents: orderCents,
            totalSpentStars: 0,
            balance: 0,
            createdAt: now,
            updatedAt: now,
          });
        }

        const txId = sanitizeDocId(`tx_ord_paid_${freshPayment.paymentId}`);
        tx.set<StoreTransaction>('transactions', txId, {
          transactionId: txId,
          orderId: updatedOrder.orderId,
          userId: updatedOrder.userId,
          type: isOverpaid ? 'order_overpaid' : 'payment_received',
          amount: orderCents,
          amountUsdCents: orderCents,
          currency: 'USD',
          details: `Оплата заказа #${updatedOrder.orderId} через ${PAYMENT_PROVIDER_CATALOG[freshPayment.provider as BalanceTopUpProvider].shortTitle}: ${formatUsdCents(orderCents)} (${verifiedStr} ${expectedCurr}, invoice=${externalInvoiceId})`,
          createdAt: now,
        });

        return {
          ok: true,
          duplicate: false,
          needsFulfillmentRecovery: true,
          status: finalPaymentStatus,
          order: updatedOrder,
          payment: updatedPayment,
        };
      },
    );
  }

  public static verifyAndProcessOrderPayment(
    paymentId: string,
    webhookHint?: {
      amountPaidStr?: string;
      amountPaid?: number;
      currency?: string;
      network?: string;
      externalInvoiceId?: string;
      paymentId?: string;
    },
  ): Promise<ProcessOrderPaymentVerificationResult> {
    return this.defaultInstance.verifyAndProcessOrderPayment(paymentId, webhookHint);
  }

  private async markOrderPaymentIssue(
    paymentId: string,
    terminalStatus: 'underpaid' | 'expired' | 'cancelled' | 'failed',
    txType: StoreTransaction['type'],
    reason: string,
    actualAmountStr?: string,
  ): Promise<{ payment: PaymentRecord; order: Order | null }> {
    const cleanReason = redactSecretsFromText(reason).slice(0, 450);
    return firestoreRepo.runTransaction(async (tx) => {
      const freshPayment = await tx.get<PaymentRecord>('payments', paymentId);
      if (!freshPayment) {
        throw new Error(`Платёж ${paymentId} не найден.`);
      }
      const order = await tx.get<Order>('orders', freshPayment.orderId);
      if (freshPayment.status === 'paid' || freshPayment.status === 'overpaid') {
        return { payment: freshPayment, order };
      }

      const now = new Date().toISOString();
      const updatedPayment: PaymentRecord = {
        ...freshPayment,
        status: terminalStatus,
        ...(actualAmountStr !== undefined ? { actualAmountStr } : {}),
        statusReason: cleanReason,
        updatedAt: now,
      };
      tx.set<PaymentRecord>('payments', paymentId, updatedPayment);

      const txId = sanitizeDocId(`tx_ord_${terminalStatus}_${paymentId}`);
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: freshPayment.orderId,
        userId: freshPayment.userId,
        type: txType,
        amount: freshPayment.expectedUsdCents,
        amountUsdCents: freshPayment.expectedUsdCents,
        currency: 'USD',
        details: cleanReason,
        createdAt: now,
      });

      return { payment: updatedPayment, order };
    });
  }

  public static async isRefundInProgress(orderId: string): Promise<boolean> {
    const order = await OrderService.getOrderById(orderId);
    return order?.refundState === 'refund_in_progress';
  }

  /**
   * Executes legacy XTR refund ONLY if order was historically paid via telegram_stars.
   * Rejects refundStarPayment for crypto or disabled XTR flow.
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

    const existingCheck = await OrderService.getOrderById(params.orderId);
    if (!existingCheck || !existingCheck.telegramPaymentChargeId) {
      throw new Error(
        'Возврат Telegram Stars (refundStarPayment) отключён / неприменим: у заказа отсутствует исторический telegram_payment_charge_id.',
      );
    }

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
            `Возврат по заказу #${order.orderId} прерван после внешнего вызова и требует ручной сверки статуса.`,
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
      const isAlreadyRefundedInTelegram =
        /CHARGE_ALREADY_REFUNDED|ALREADY_REFUNDED/i.test(errMsg);

      if (!isAlreadyRefundedInTelegram) {
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
        // Firestore unreachable
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

  public async markPaymentRefunded(
    orderId: string,
    adminTelegramId?: number,
  ): Promise<Order | null> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    return firestoreRepo.runTransaction<Order | null>(async (tx) => {
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
      }

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
          `Выполнен возврат исторического платежа Telegram Stars${adminSuffix}.`.slice(
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
          currency: order.currency || 'XTR',
          details:
            `Возврат (charge_id: ${order.telegramPaymentChargeId})${adminSuffix}`.slice(
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

  public async recoverPendingRefunds(options?: {
    quarantineStaleInProgress?: boolean;
  }): Promise<Order[]> {
    if (!firestoreRepo.isProductionStorageHealthy()) {
      return [];
    }

    const recovered: Order[] = [];
    const processedIds = new Set<string>();

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
          `[PaymentService] Ошибка финализации возврата заказа #${orderId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

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

    const inProgressOrders = await firestoreRepo.queryDocs<Order>('orders', {
      where: [{ field: 'refundState', op: '==', value: 'refund_in_progress' }],
      limit: 50,
    });

    const nowMs = Date.now();
    for (const ord of inProgressOrders) {
      if (processedIds.has(ord.orderId)) continue;

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
                'Возврат был прерван во время внешнего вызова. Требуется ручная сверка.',
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
