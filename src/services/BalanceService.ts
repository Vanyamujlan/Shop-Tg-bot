import crypto from 'crypto';
import {
  formatUsdCents,
  getEnvConfig,
} from '../config/env.ts';
import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
  BalanceTopUpStatus,
  Order,
  PaymentLockRecord,
  PaymentRecord,
  Product,
  StoreTransaction,
  StoreUser,
} from '../types.ts';
import {
  MAX_TOPUP_AMOUNT_USD_CENTS,
  MIN_TOPUP_AMOUNT_USD_CENTS,
  assertValidUsdCents,
  bpsFeeAndNetCents,
  centsToUsdString,
  compareScaledDecimal,
  usdInputToCents,
} from './Money.ts';
import { normalizeRecipientUsername } from './OrderService.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  PaymentProviderGateway,
  normalizeCurrencyCode,
  normalizeNetworkCode,
  paymentProviderGateway,
  redactSecretsFromText,
} from './PaymentProviders.ts';
import { ProductService } from './ProductService.ts';

export interface CommissionCalculationResult {
  amountUsdCents: number;
  feeUsdCents: number;
  amountCreditedUsdCents: number;
  feeBps: number;
  amountPaid: number;
  feePercent: number;
  feeAmount: number;
  amountCredited: number;
}

/**
 * Exact integer USD cents conversion from dollar amount (for legacy callers).
 */
export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error('Сумма должна быть конечным числом.');
  }
  if (amount === 0) return 0;
  return usdInputToCents(amount);
}

export function fromMinorUnits(cents: number): number {
  const safe = Math.round(cents);
  return Number(centsToUsdString(safe));
}

/**
 * Validates a free-form user top-up amount strictly in integer USD cents.
 * Enforces server-side limits: 50 cents ($0.50) to 5,000,000 cents ($50,000.00).
 */
export function validateTopUpAmountUsdCents(rawInput: string | number): number {
  const cents = usdInputToCents(rawInput);
  if (cents < MIN_TOPUP_AMOUNT_USD_CENTS) {
    throw new Error(
      `Минимальная сумма пополнения: ${formatUsdCents(MIN_TOPUP_AMOUNT_USD_CENTS)}.`,
    );
  }
  if (cents > MAX_TOPUP_AMOUNT_USD_CENTS) {
    throw new Error(
      `Максимальная сумма пополнения за одну операцию: ${formatUsdCents(MAX_TOPUP_AMOUNT_USD_CENTS)}.`,
    );
  }
  return cents;
}

export function validateTopUpAmountUsd(rawInput: string | number): number {
  const cents = validateTopUpAmountUsdCents(rawInput);
  return fromMinorUnits(cents);
}

/**
 * Calculates store commission and net credited USD cents using exact BigInt BPS math.
 * Commission is deducted from the entered amount:
 * - CryptoBot (300 bps / 3%): $10.00 (1000) -> net $9.70 (970), fee $0.30 (30)
 * - xRocket (200 bps / 2%): $10.00 (1000) -> net $9.80 (980), fee $0.20 (20)
 */
export function calculateTopUpCommissionCents(
  amountUsdCents: number,
  provider: BalanceTopUpProvider,
): CommissionCalculationResult {
  const providerMeta = PAYMENT_PROVIDER_CATALOG[provider];
  if (!providerMeta) {
    throw new Error(`Неизвестный платёжный провайдер: ${String(provider)}`);
  }
  const safeCents = assertValidUsdCents(amountUsdCents, 'amountUsdCents');
  const breakdown = bpsFeeAndNetCents(safeCents, providerMeta.feeBps);
  if (breakdown.netCents <= 0) {
    throw new Error('Сумма зачисления после комиссии должна быть больше 0.');
  }

  return Object.freeze({
    amountUsdCents: breakdown.grossCents,
    feeUsdCents: breakdown.feeCents,
    amountCreditedUsdCents: breakdown.netCents,
    feeBps: breakdown.feeBps,
    amountPaid: fromMinorUnits(breakdown.grossCents),
    feePercent: breakdown.feePercent,
    feeAmount: fromMinorUnits(breakdown.feeCents),
    amountCredited: fromMinorUnits(breakdown.netCents),
  });
}

export function calculateTopUpCommission(
  amountPaidUsd: number,
  provider: BalanceTopUpProvider,
): CommissionCalculationResult {
  const cents = usdInputToCents(amountPaidUsd);
  return calculateTopUpCommissionCents(cents, provider);
}

function getUserBalanceCentsFromDoc(user: StoreUser | null | undefined): number {
  if (!user) return 0;
  if (typeof user.balanceUsdCents === 'number' && Number.isInteger(user.balanceUsdCents)) {
    return user.balanceUsdCents;
  }
  if (typeof user.balance === 'number' && Number.isFinite(user.balance)) {
    return Math.round(user.balance * 100);
  }
  return 0;
}

export class BalanceService {
  private gateway: PaymentProviderGateway;

  constructor(gateway: PaymentProviderGateway = paymentProviderGateway) {
    this.gateway = gateway;
  }

  public getGateway(): PaymentProviderGateway {
    return this.gateway;
  }

  public async getBalanceUsdCentsByUserId(userId: string): Promise<number> {
    const user = await firestoreRepo.getDoc<StoreUser>('users', userId);
    return getUserBalanceCentsFromDoc(user);
  }

  public async getBalanceUsdCents(telegramId: number): Promise<number> {
    return this.getBalanceUsdCentsByUserId(`tg_${telegramId}`);
  }

  public async getBalanceByUserId(userId: string): Promise<number> {
    const cents = await this.getBalanceUsdCentsByUserId(userId);
    return fromMinorUnits(cents);
  }

  public async getBalance(telegramId: number): Promise<number> {
    return this.getBalanceByUserId(`tg_${telegramId}`);
  }

  public async getTopUpById(paymentId: string): Promise<BalanceTopUpRecord | null> {
    return firestoreRepo.getDoc<BalanceTopUpRecord>('balance_topups', paymentId);
  }

  public async getUserTopUps(
    telegramId: number,
    limit = 15,
  ): Promise<BalanceTopUpRecord[]> {
    const userId = `tg_${telegramId}`;
    const list = await firestoreRepo.queryDocs<BalanceTopUpRecord>('balance_topups', {
      where: [{ field: 'userId', op: '==', value: userId }],
      limit: Math.max(limit * 2, 30),
    });
    return list
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  public async getAllTopUps(
    statusFilter?: BalanceTopUpStatus,
    limit = 30,
  ): Promise<BalanceTopUpRecord[]> {
    const list = await firestoreRepo.queryDocs<BalanceTopUpRecord>('balance_topups', {
      ...(statusFilter
        ? { where: [{ field: 'paymentStatus', op: '==', value: statusFilter }] }
        : { orderBy: { field: 'createdAt', direction: 'desc' } }),
      limit: Math.max(limit * 2, 50),
    });
    return list
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /**
   * Creates or reuses an active pending balance top-up invoice with live provider exchange rates.
   */
  public async createTopUp(params: {
    telegramId: number;
    username?: string;
    firstName?: string;
    provider: BalanceTopUpProvider;
    amountUsdCents?: number;
    amountPaid?: number;
    currency?: string;
    network?: string;
    convertFromUsd?: boolean;
    customExchangeRateUsd?: number;
    customExchangeRateUsdStr?: string;
    expiresInSeconds?: number;
    forceNew?: boolean;
  }): Promise<BalanceTopUpRecord> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const providerMeta = PAYMENT_PROVIDER_CATALOG[params.provider];
    if (!providerMeta) {
      throw new Error(`Неподдерживаемый способ пополнения: ${String(params.provider)}`);
    }

    const rawCents =
      params.amountUsdCents !== undefined
        ? assertValidUsdCents(params.amountUsdCents, 'amountUsdCents')
        : params.amountPaid !== undefined
          ? validateTopUpAmountUsdCents(params.amountPaid)
          : (() => {
              throw new Error('Укажите сумму пополнения в USD.');
            })();

    if (rawCents < providerMeta.minAmountUsdCents) {
      throw new Error(
        `Минимальная сумма пополнения через ${providerMeta.shortTitle}: ${formatUsdCents(providerMeta.minAmountUsdCents)}.`,
      );
    }
    if (rawCents > providerMeta.maxAmountUsdCents) {
      throw new Error(
        `Максимальная сумма пополнения за одну операцию: ${formatUsdCents(providerMeta.maxAmountUsdCents)}.`,
      );
    }

    const { currency: normalizedCurr, network: normalizedNet } =
      await this.gateway.validateCurrencyAndNetwork(
        params.provider,
        params.currency || providerMeta.defaultCurrency,
        params.network,
      );

    const userId = `tg_${params.telegramId}`;
    const existingUser = await firestoreRepo.getDoc<StoreUser>('users', userId);
    if (existingUser?.isBlocked) {
      throw new Error('Ваш аккаунт заблокирован. Пополнение баланса недоступно.');
    }

    // Reuse an active pending invoice for same (user, provider, amountUsdCents, currency, network)
    if (!params.forceNew) {
      const existingTopUps = await firestoreRepo.queryDocs<BalanceTopUpRecord>(
        'balance_topups',
        {
          where: [{ field: 'userId', op: '==', value: userId }],
          limit: 20,
        },
      );
      const nowMs = Date.now();
      const reusable = existingTopUps.find(
        (t) =>
          t.paymentStatus === 'pending' &&
          t.provider === params.provider &&
          t.amountUsdCents === rawCents &&
          normalizeCurrencyCode(t.currency) === normalizedCurr &&
          (t.network || undefined) === normalizedNet &&
          Boolean(t.payUrl) &&
          (!t.expiresAt || Date.parse(t.expiresAt) > nowMs + 15_000),
      );
      if (reusable) {
        return reusable;
      }
    }

    const calc = calculateTopUpCommissionCents(rawCents, params.provider);

    const customRateStr =
      params.customExchangeRateUsdStr ??
      (params.customExchangeRateUsd !== undefined && params.customExchangeRateUsd > 0
        ? String(params.customExchangeRateUsd)
        : undefined);

    const shouldConvert =
      normalizedCurr === 'USD'
        ? false
        : params.convertFromUsd !== undefined
          ? params.convertFromUsd
          : true;

    const conversion = shouldConvert
      ? await this.gateway.getLiveUsdConversion({
          provider: params.provider,
          amountUsdCents: calc.amountUsdCents,
          targetCurrency: normalizedCurr,
          network: normalizedNet,
          customRateUsdStr: customRateStr,
        })
      : {
          provider: params.provider,
          amountUsdCents: calc.amountUsdCents,
          targetCurrency: normalizedCurr,
          ...(normalizedNet ? { network: normalizedNet } : {}),
          exchangeRateUsdStr: '1.00',
          convertedAmountStr: centsToUsdString(calc.amountUsdCents),
          convertedAmount: fromMinorUnits(calc.amountUsdCents),
          scaled1e18: 0n,
          requiresConversionNotice: false,
        };

    const paymentId = `topup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const networkTag = normalizedNet ? ` [${normalizedNet}]` : '';
    const storeName = getEnvConfig().storeName || 'QuizyStars';
    const description = `Пополнение баланса ${storeName} (${paymentId}) — сумма ${formatUsdCents(calc.amountUsdCents)}, к зачислению ${formatUsdCents(calc.amountCreditedUsdCents)}${networkTag}`;

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
    const topUpRecord: BalanceTopUpRecord = {
      paymentId,
      userId,
      userTelegramId: params.telegramId,
      username: params.username || existingUser?.username,
      provider: params.provider,
      amountUsdCents: calc.amountUsdCents,
      feeUsdCents: calc.feeUsdCents,
      amountCreditedUsdCents: calc.amountCreditedUsdCents,
      feeBps: calc.feeBps,
      feePercent: calc.feePercent,
      expectedAmountStr: conversion.convertedAmountStr,
      amountUsd: calc.amountPaid,
      amountPaid: conversion.convertedAmount,
      feeAmount: calc.feeAmount,
      amountCredited: calc.amountCredited,
      currency: normalizedCurr,
      originalCurrency: normalizedCurr,
      originalAmountPaid: conversion.convertedAmount,
      exchangeRateUsdStr: conversion.exchangeRateUsdStr,
      exchangeRateUsd: Number(conversion.exchangeRateUsdStr),
      ...(normalizedNet ? { network: normalizedNet } : {}),
      paymentStatus: 'pending',
      externalInvoiceId: createdInvoice.externalInvoiceId,
      payUrl: createdInvoice.payUrl,
      recipientMerchantId: createdInvoice.recipientMerchantId,
      expiresAt: createdInvoice.expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    await firestoreRepo.runTransaction(async (tx) => {
      const userSnap = await tx.get<StoreUser>('users', userId);
      if (userSnap?.isBlocked) {
        throw new Error('Ваш аккаунт заблокирован.');
      }
      if (!userSnap) {
        tx.set<StoreUser>('users', userId, {
          userId,
          telegramId: params.telegramId,
          username: params.username,
          firstName: params.firstName || 'Пользователь',
          isBlocked: false,
          totalOrders: 0,
          balanceUsdCents: 0,
          totalSpentUsdCents: 0,
          totalSpentStars: 0,
          balance: 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      tx.set<BalanceTopUpRecord>('balance_topups', paymentId, topUpRecord);

      const txId = `tx_topup_create_${paymentId}`;
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: paymentId,
        userId,
        type: 'balance_topup_created',
        amount: calc.amountUsdCents,
        amountUsdCents: calc.amountUsdCents,
        currency: 'USD',
        details: `Создан счёт пополнения ${paymentId} через ${providerMeta.shortTitle}: сумма=${formatUsdCents(calc.amountUsdCents)} (${conversion.convertedAmountStr} ${normalizedCurr}${normalizedNet ? `/${normalizedNet}` : ''}, курс=${conversion.exchangeRateUsdStr}), комиссия=${calc.feePercent}% (${formatUsdCents(calc.feeUsdCents)}), к зачислению=${formatUsdCents(calc.amountCreditedUsdCents)}`,
        createdAt: now,
      });
    });

    return topUpRecord;
  }

  public async cancelPendingTopUp(
    paymentId: string,
    callerTelegramId: number,
  ): Promise<BalanceTopUpRecord> {
    return firestoreRepo.runTransaction(async (tx) => {
      const topUp = await tx.get<BalanceTopUpRecord>('balance_topups', paymentId);
      if (!topUp) {
        throw new Error('Счёт на пополнение не найден.');
      }
      if (topUp.userTelegramId !== callerTelegramId) {
        throw new Error('Вы не можете отменить чужой счёт.');
      }
      if (topUp.paymentStatus === 'paid' || topUp.paymentStatus === 'overpaid') {
        throw new Error('Этот счёт уже оплачен и зачислен на баланс.');
      }
      if (topUp.paymentStatus !== 'pending') {
        return topUp;
      }

      const now = new Date().toISOString();
      const updated: BalanceTopUpRecord = {
        ...topUp,
        paymentStatus: 'cancelled',
        updatedAt: now,
      };
      tx.set<BalanceTopUpRecord>('balance_topups', paymentId, updated);
      return updated;
    });
  }

  /**
   * Processes an incoming provider webhook:
   * 1. Verifies HMAC-SHA256 signature BEFORE any outbound HTTP call.
   * 2. Locates top-up record by paymentId or externalInvoiceId.
   * 3. Calls authoritative provider verification before crediting.
   */
  public async processWebhook(params: {
    provider: BalanceTopUpProvider;
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
    parsedBody?: unknown;
  }): Promise<{
    ok: boolean;
    duplicate: boolean;
    status: BalanceTopUpStatus;
    topUp?: BalanceTopUpRecord;
    newBalance?: number;
    newBalanceUsdCents?: number;
    reason?: string;
  }> {
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
        status: 'failed',
        reason: error instanceof Error ? error.message : 'INVALID_WEBHOOK_PAYLOAD',
      };
    }

    let topUp: BalanceTopUpRecord | null = null;
    if (notification.paymentId) {
      topUp = await firestoreRepo.getDoc<BalanceTopUpRecord>(
        'balance_topups',
        notification.paymentId,
      );
    }
    if (!topUp && notification.externalInvoiceId) {
      const candidates = await firestoreRepo.queryDocs<BalanceTopUpRecord>(
        'balance_topups',
        {
          where: [
            {
              field: 'externalInvoiceId',
              op: '==',
              value: notification.externalInvoiceId,
            },
          ],
          limit: 5,
        },
      );
      topUp = candidates.find((c) => c.provider === params.provider) || null;
    }

    if (!topUp) {
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        reason: 'TOPUP_NOT_FOUND',
      };
    }

    if (topUp.provider !== params.provider) {
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        reason: 'PROVIDER_MISMATCH',
      };
    }

    return this.verifyAndProcessTopUp(topUp.paymentId, notification);
  }

  /**
   * Authoritatively verifies top-up payment status via provider API, detects underpaid / overpaid /
   * expired / currency-network mismatch, enforces atomic `payment_locks`, and credits integer USD cents.
   */
  public async verifyAndProcessTopUp(
    paymentId: string,
    webhookHint?: {
      amountPaidStr?: string;
      amountPaid?: number;
      currency?: string;
      network?: string;
      externalInvoiceId?: string;
      paymentId?: string;
      recipientMerchantId?: string;
    },
  ): Promise<{
    ok: boolean;
    duplicate: boolean;
    status: BalanceTopUpStatus;
    topUp: BalanceTopUpRecord;
    newBalance?: number;
    newBalanceUsdCents?: number;
    reason?: string;
  }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const existingTopUp = await firestoreRepo.getDoc<BalanceTopUpRecord>(
      'balance_topups',
      paymentId,
    );
    if (!existingTopUp) {
      throw new Error(`Счёт пополнения ${paymentId} не найден.`);
    }

    if (
      existingTopUp.paymentStatus === 'paid' ||
      existingTopUp.paymentStatus === 'overpaid'
    ) {
      const balCents = await this.getBalanceUsdCentsByUserId(existingTopUp.userId);
      return {
        ok: true,
        duplicate: true,
        status: existingTopUp.paymentStatus,
        topUp: existingTopUp,
        newBalance: fromMinorUnits(balCents),
        newBalanceUsdCents: balCents,
      };
    }

    if (
      existingTopUp.paymentStatus === 'cancelled' ||
      existingTopUp.paymentStatus === 'expired' ||
      existingTopUp.paymentStatus === 'failed' ||
      existingTopUp.paymentStatus === 'underpaid'
    ) {
      return {
        ok: false,
        duplicate: false,
        status: existingTopUp.paymentStatus,
        topUp: existingTopUp,
        reason: `TOPUP_ALREADY_${existingTopUp.paymentStatus.toUpperCase()}`,
      };
    }

    const isLocallyExpired =
      Boolean(existingTopUp.expiresAt) &&
      new Date(existingTopUp.expiresAt!).getTime() <= Date.now();

    const verified = await this.gateway.verifyInvoiceStatus({
      provider: existingTopUp.provider,
      externalInvoiceId: existingTopUp.externalInvoiceId,
      paymentId: existingTopUp.paymentId,
    });

    if (verified.status === 'expired' || isLocallyExpired) {
      const expiredTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'expired',
        'Срок действия счёта истёк (expired).',
      );
      return {
        ok: false,
        duplicate: false,
        status: 'expired',
        topUp: expiredTopUp,
        reason: 'INVOICE_EXPIRED',
      };
    }

    if (verified.status === 'cancelled' || verified.status === 'failed') {
      const failedTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        verified.status,
        `Счёт отклонён или отменён провайдером (status=${verified.status}).`,
      );
      return {
        ok: false,
        duplicate: false,
        status: verified.status,
        topUp: failedTopUp,
        reason: `INVOICE_${verified.status.toUpperCase()}`,
      };
    }

    if (verified.status === 'underpaid') {
      const underpaidTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'underpaid',
        `Частичная оплата счёта: получено ${verified.amountPaidStr} ${verified.currency}, ожидалось ${existingTopUp.expectedAmountStr} ${existingTopUp.currency}.`,
        verified.amountPaidStr,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'underpaid',
        topUp: underpaidTopUp,
        reason: 'UNDERPAID',
      };
    }

    if (verified.status !== 'paid') {
      return {
        ok: false,
        duplicate: false,
        status: 'pending',
        topUp: existingTopUp,
        reason: 'PAYMENT_STILL_PENDING',
      };
    }

    // 1. External Invoice ID match
    if (
      String(verified.externalInvoiceId) !== String(existingTopUp.externalInvoiceId) ||
      (webhookHint?.externalInvoiceId &&
        String(webhookHint.externalInvoiceId) !== String(existingTopUp.externalInvoiceId))
    ) {
      const failedTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'failed',
        `Несовпадение externalInvoiceId: ожидался ${existingTopUp.externalInvoiceId}, получен ${verified.externalInvoiceId}`,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        topUp: failedTopUp,
        reason: 'INVALID_INVOICE_ID',
      };
    }

    // 2. Payment ID / payload match
    if (
      (verified.paymentId && verified.paymentId !== existingTopUp.paymentId) ||
      (webhookHint?.paymentId && webhookHint.paymentId !== existingTopUp.paymentId)
    ) {
      const failedTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'failed',
        `Несовпадение paymentId в ответе провайдера: ожидался ${existingTopUp.paymentId}, получен ${verified.paymentId}`,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        topUp: failedTopUp,
        reason: 'INVALID_PAYMENT_ID',
      };
    }

    // 3. Recipient / Merchant ID match
    if (
      existingTopUp.recipientMerchantId &&
      ((verified.recipientMerchantId &&
        String(verified.recipientMerchantId) !==
          String(existingTopUp.recipientMerchantId)) ||
        (webhookHint?.recipientMerchantId &&
          String(webhookHint.recipientMerchantId) !==
            String(existingTopUp.recipientMerchantId)))
    ) {
      const failedTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'failed',
        `Несовпадение получателя (merchant_id): ожидался ${existingTopUp.recipientMerchantId}`,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        topUp: failedTopUp,
        reason: 'INVALID_MERCHANT_ID',
      };
    }

    // 4. Currency & network match
    const expectedCurr = normalizeCurrencyCode(existingTopUp.currency);
    const verifiedCurr = normalizeCurrencyCode(verified.currency);
    const hintCurr = webhookHint?.currency
      ? normalizeCurrencyCode(webhookHint.currency)
      : expectedCurr;

    if (verifiedCurr !== expectedCurr || hintCurr !== expectedCurr) {
      const failedTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'failed',
        `Несовпадение валюты платежа: ожидалась ${expectedCurr}, получена ${verifiedCurr} (hint: ${hintCurr})`,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        topUp: failedTopUp,
        reason: 'INVALID_CURRENCY',
      };
    }

    const expectedNet = normalizeNetworkCode(existingTopUp.network);
    const verifiedNet = normalizeNetworkCode(verified.network);
    if (expectedNet && verifiedNet && expectedNet !== verifiedNet) {
      const failedTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'failed',
        `Несовпадение сети платежа: ожидалась ${expectedNet}, получена ${verifiedNet}`,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        topUp: failedTopUp,
        reason: 'INVALID_NETWORK',
      };
    }

    // 5. Exact scaled 10^18 amount check: underpaid / exact / overpaid
    const expectedStr =
      existingTopUp.expectedAmountStr || String(existingTopUp.amountPaid);
    const verifiedStr = verified.amountPaidStr;
    const hintStr =
      webhookHint?.amountPaidStr ??
      (webhookHint?.amountPaid !== undefined ? String(webhookHint.amountPaid) : undefined);

    if (hintStr !== undefined && compareScaledDecimal(hintStr, verifiedStr) !== 0) {
      // If webhook hint doesn't match authoritative API amount, reject suspicious tampering
      if (compareScaledDecimal(hintStr, expectedStr) < 0 && compareScaledDecimal(verifiedStr, expectedStr) < 0) {
        const underpaidTopUp = await this.markTopUpTerminalFailure(
          paymentId,
          'underpaid',
          `Недостаточная сумма оплаты: получено ${verifiedStr}, ожидалось ${expectedStr}.`,
          verifiedStr,
        );
        return {
          ok: false,
          duplicate: false,
          status: 'underpaid',
          topUp: underpaidTopUp,
          reason: 'UNDERPAID',
        };
      }
    }

    const cmpVerifiedVsExpected = compareScaledDecimal(verifiedStr, expectedStr);
    if (cmpVerifiedVsExpected < 0) {
      const underpaidTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'underpaid',
        `Недоплата счёта: получено ${verifiedStr} ${expectedCurr}, ожидалось ${expectedStr} ${expectedCurr}.`,
        verifiedStr,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'underpaid',
        topUp: underpaidTopUp,
        reason: 'UNDERPAID',
      };
    }

    const isOverpaid = cmpVerifiedVsExpected > 0;
    const lockId = sanitizeDocId(
      `ext_${existingTopUp.provider}_${existingTopUp.externalInvoiceId}`,
    );

    // 6. Atomic Firestore transaction with payment_locks claim and integer USD cents crediting
    return firestoreRepo.runTransaction(async (tx) => {
      const [freshTopUp, userSnap, existingLock] = await Promise.all([
        tx.get<BalanceTopUpRecord>('balance_topups', paymentId),
        tx.get<StoreUser>('users', existingTopUp.userId),
        tx.get<PaymentLockRecord>('payment_locks', lockId),
      ]);

      if (!freshTopUp) {
        throw new Error(`Счёт пополнения ${paymentId} не найден в транзакции.`);
      }

      if (
        freshTopUp.paymentStatus === 'paid' ||
        freshTopUp.paymentStatus === 'overpaid'
      ) {
        const balCents = getUserBalanceCentsFromDoc(userSnap);
        return {
          ok: true,
          duplicate: true,
          status: freshTopUp.paymentStatus,
          topUp: freshTopUp,
          newBalance: fromMinorUnits(balCents),
          newBalanceUsdCents: balCents,
        };
      }

      if (freshTopUp.paymentStatus !== 'pending') {
        return {
          ok: false,
          duplicate: false,
          status: freshTopUp.paymentStatus,
          topUp: freshTopUp,
          reason: `TOPUP_ALREADY_${freshTopUp.paymentStatus.toUpperCase()}`,
        };
      }

      if (
        existingLock &&
        (existingLock.targetType !== 'topup' ||
          existingLock.targetId !== freshTopUp.paymentId)
      ) {
        throw new Error(
          `PAYMENT_LOCK_CONFLICT: внешний инвойс ${freshTopUp.externalInvoiceId} уже использован для ${existingLock.targetType}:${existingLock.targetId}.`,
        );
      }

      // Tamper guard in exact integer USD cents
      const expectedCalc = calculateTopUpCommissionCents(
        freshTopUp.amountUsdCents,
        freshTopUp.provider,
      );
      if (
        freshTopUp.amountCreditedUsdCents !== expectedCalc.amountCreditedUsdCents ||
        freshTopUp.feeUsdCents !== expectedCalc.feeUsdCents ||
        freshTopUp.feeBps !== expectedCalc.feeBps
      ) {
        throw new Error(
          `Обнаружено нарушение целостности расчёта комиссии для счёта ${paymentId}. Зачисление заблокировано.`,
        );
      }

      const now = new Date().toISOString();
      const currentBalanceCents = getUserBalanceCentsFromDoc(userSnap);
      const newBalanceCents = currentBalanceCents + freshTopUp.amountCreditedUsdCents;
      const newBalanceUsd = fromMinorUnits(newBalanceCents);
      const terminalPaidStatus: BalanceTopUpStatus = isOverpaid ? 'overpaid' : 'paid';

      const updatedUser: StoreUser = userSnap
        ? {
            ...userSnap,
            balanceUsdCents: newBalanceCents,
            balance: newBalanceUsd,
            updatedAt: now,
          }
        : {
            userId: freshTopUp.userId,
            telegramId: freshTopUp.userTelegramId,
            username: freshTopUp.username,
            firstName: 'Пользователь',
            isBlocked: false,
            totalOrders: 0,
            balanceUsdCents: newBalanceCents,
            totalSpentUsdCents: 0,
            totalSpentStars: 0,
            balance: newBalanceUsd,
            createdAt: now,
            updatedAt: now,
          };

      const paidTopUp: BalanceTopUpRecord = {
        ...freshTopUp,
        paymentStatus: terminalPaidStatus,
        actualAmountStr: verifiedStr,
        statusReason: isOverpaid
          ? `Переплата (${verifiedStr} > ${expectedStr}); на баланс зачислена строго сумма по тарифу ${formatUsdCents(freshTopUp.amountCreditedUsdCents)}.`
          : undefined,
        paidAt: verified.paidAt || now,
        confirmedAt: now,
        updatedAt: now,
      };

      const lockRecord: PaymentLockRecord = {
        lockId,
        provider: freshTopUp.provider,
        providerPaymentId: String(freshTopUp.externalInvoiceId),
        targetType: 'topup',
        targetId: freshTopUp.paymentId,
        paymentId: freshTopUp.paymentId,
        userId: freshTopUp.userId,
        amountUsdCents: freshTopUp.amountUsdCents,
        claimedAt: now,
      };

      const txId = `tx_topup_paid_${paymentId}`;
      const txType = isOverpaid ? 'balance_topup_overpaid' : 'balance_topup_paid';
      const txRecord: StoreTransaction = {
        transactionId: txId,
        orderId: paymentId,
        userId: freshTopUp.userId,
        type: txType,
        amount: freshTopUp.amountCreditedUsdCents,
        amountUsdCents: freshTopUp.amountCreditedUsdCents,
        currency: 'USD',
        details: `Баланс пополнен через ${PAYMENT_PROVIDER_CATALOG[freshTopUp.provider].shortTitle} (invoice=${freshTopUp.externalInvoiceId}): получено=${verifiedStr} ${freshTopUp.currency}, комиссия=${freshTopUp.feePercent}% (${formatUsdCents(freshTopUp.feeUsdCents)}), зачислено=${formatUsdCents(freshTopUp.amountCreditedUsdCents)}, новый баланс=${formatUsdCents(newBalanceCents)}`,
        createdAt: now,
      };

      tx.set<PaymentLockRecord>('payment_locks', lockId, lockRecord);
      tx.set<StoreUser>('users', freshTopUp.userId, updatedUser);
      tx.set<BalanceTopUpRecord>('balance_topups', paymentId, paidTopUp);
      tx.set<StoreTransaction>('transactions', txId, txRecord);

      return {
        ok: true,
        duplicate: false,
        status: terminalPaidStatus,
        topUp: paidTopUp,
        newBalance: newBalanceUsd,
        newBalanceUsdCents: newBalanceCents,
      };
    });
  }

  private async markTopUpTerminalFailure(
    paymentId: string,
    terminalStatus: 'failed' | 'expired' | 'cancelled' | 'underpaid',
    failureReason: string,
    actualAmountStr?: string,
  ): Promise<BalanceTopUpRecord> {
    const cleanReason = redactSecretsFromText(failureReason).slice(0, 450);
    return firestoreRepo.runTransaction(async (tx) => {
      const fresh = await tx.get<BalanceTopUpRecord>('balance_topups', paymentId);
      if (!fresh) {
        throw new Error(`Счёт пополнения ${paymentId} не найден.`);
      }
      if (fresh.paymentStatus === 'paid' || fresh.paymentStatus === 'overpaid') {
        return fresh;
      }
      const now = new Date().toISOString();
      const updated: BalanceTopUpRecord = {
        ...fresh,
        paymentStatus: terminalStatus,
        ...(actualAmountStr !== undefined ? { actualAmountStr } : {}),
        statusReason: cleanReason,
        failureReason: cleanReason,
        updatedAt: now,
      };
      tx.set<BalanceTopUpRecord>('balance_topups', paymentId, updated);

      const txType =
        terminalStatus === 'expired'
          ? 'balance_topup_expired'
          : terminalStatus === 'underpaid'
            ? 'balance_topup_underpaid'
            : 'balance_topup_failed';
      const txId = `tx_topup_${terminalStatus}_${paymentId}`;
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: paymentId,
        userId: fresh.userId,
        type: txType,
        amount: fresh.amountUsdCents,
        amountUsdCents: fresh.amountUsdCents,
        currency: 'USD',
        details: cleanReason,
        createdAt: now,
      });

      return updated;
    });
  }

  /**
   * Pays for a store product or existing pending order using internal USD balance (integer cents).
   */
  public async purchaseWithInternalBalance(params: {
    telegramId: number;
    username?: string;
    firstName?: string;
    productId: string;
    quantity?: number;
    orderId?: string;
    recipientUsername?: string;
    requireRecipient?: boolean;
  }): Promise<{
    order: Order;
    duplicate: boolean;
    newBalance: number;
    newBalanceUsdCents: number;
  }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const normalizedRecipient = normalizeRecipientUsername(params.recipientUsername);
    const userId = `tg_${params.telegramId}`;
    const resolvedOrderId =
      params.orderId ||
      `ord_bal_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    return firestoreRepo.runTransaction(async (tx) => {
      const [existingOrder, product, userSnap] = await Promise.all([
        tx.get<Order>('orders', resolvedOrderId),
        tx.get<Product>('products', params.productId),
        tx.get<StoreUser>('users', userId),
      ]);

      if (
        existingOrder &&
        (existingOrder.paymentStatus === 'paid' ||
          existingOrder.paymentStatus === 'processing' ||
          existingOrder.paymentStatus === 'completed')
      ) {
        const balCents = getUserBalanceCentsFromDoc(userSnap);
        return {
          order: existingOrder,
          duplicate: true,
          newBalance: fromMinorUnits(balCents),
          newBalanceUsdCents: balCents,
        };
      }

      if (existingOrder) {
        if (existingOrder.userTelegramId !== params.telegramId) {
          throw new Error('Вы не можете оплатить чужой заказ.');
        }
        if (
          existingOrder.paymentStatus === 'cancelled' ||
          existingOrder.paymentStatus === 'refunded' ||
          existingOrder.paymentStatus === 'failed' ||
          existingOrder.fulfillmentStatus === 'cancelled' ||
          existingOrder.fulfillmentStatus === 'refunded'
        ) {
          throw new Error(
            `Заказ ${resolvedOrderId} находится в статусе ${existingOrder.paymentStatus} и не может быть оплачен.`,
          );
        }
      }

      if (!product || !product.isActive) {
        throw new Error('Товар не найден или временно снят с продажи.');
      }

      if (userSnap?.isBlocked) {
        throw new Error('Ваш аккаунт заблокирован администратором.');
      }

      if (existingOrder) {
        ProductService.validateOrderQuantity(product, existingOrder.quantity);
      }

      const calc = existingOrder
        ? {
            quantity: existingOrder.quantity,
            unitPriceUsdCents:
              existingOrder.unitPriceUsdCents ??
              Math.round(
                (existingOrder.totalPriceUsdCents ?? existingOrder.totalPrice) /
                  Math.max(1, existingOrder.quantity),
              ),
            totalPriceUsdCents:
              existingOrder.totalPriceUsdCents ?? existingOrder.totalPrice,
          }
        : ProductService.calculateOrderPriceUsdCents(
            product,
            params.quantity === undefined ? 1 : params.quantity,
          );

      const resolvedDurationMonths =
        product.category === 'premium'
          ? (existingOrder?.durationMonths ??
            product.durationMonths ??
            (product.id === 'premium_3m'
              ? 3
              : product.id === 'premium_6m'
                ? 6
                : product.id === 'premium_12m'
                  ? 12
                  : undefined))
          : undefined;

      const existingRecipient =
        existingOrder?.recipientUsername !== undefined
          ? normalizeRecipientUsername(existingOrder.recipientUsername)
          : undefined;
      const effectiveRecipient = normalizedRecipient || existingRecipient;

      if (
        (params.requireRecipient ||
          product.id === ProductService.BUYER_STARS_PRODUCT_ID) &&
        !effectiveRecipient
      ) {
        throw new Error('Укажите @username получателя перед оплатой заказа.');
      }

      const totalPriceUsdCents = assertValidUsdCents(
        calc.totalPriceUsdCents,
        'totalPriceUsdCents',
      );
      const currentBalanceCents = getUserBalanceCentsFromDoc(userSnap);

      if (currentBalanceCents < totalPriceUsdCents) {
        throw new Error(
          `Недостаточно средств на внутреннем балансе. Требуется: ${formatUsdCents(totalPriceUsdCents)}, доступно: ${formatUsdCents(currentBalanceCents)}.`,
        );
      }

      const newBalanceCents = currentBalanceCents - totalPriceUsdCents;
      if (newBalanceCents < 0) {
        throw new Error('Баланс не может уйти в минус.');
      }
      const newBalanceUsd = fromMinorUnits(newBalanceCents);
      const now = new Date().toISOString();
      const balancePaymentId = `bal_pay_${resolvedOrderId}`;

      const updatedUser: StoreUser = userSnap
        ? {
            ...userSnap,
            balanceUsdCents: newBalanceCents,
            balance: newBalanceUsd,
            totalOrders: (userSnap.totalOrders || 0) + 1,
            totalSpentUsdCents:
              (userSnap.totalSpentUsdCents || 0) + totalPriceUsdCents,
            updatedAt: now,
          }
        : {
            userId,
            telegramId: params.telegramId,
            username: params.username,
            firstName: params.firstName || 'Покупатель',
            isBlocked: false,
            totalOrders: 1,
            balanceUsdCents: newBalanceCents,
            totalSpentUsdCents: totalPriceUsdCents,
            totalSpentStars: 0,
            balance: newBalanceUsd,
            createdAt: now,
            updatedAt: now,
          };

      const paidOrder: Order = existingOrder
        ? {
            ...existingOrder,
            ...(effectiveRecipient ? { recipientUsername: effectiveRecipient } : {}),
            ...(resolvedDurationMonths !== undefined
              ? { durationMonths: resolvedDurationMonths as 3 | 6 | 12 }
              : {}),
            unitPriceUsdCents: calc.unitPriceUsdCents,
            totalPriceUsdCents,
            totalPrice: totalPriceUsdCents,
            currency: 'USD',
            paymentMethod: 'balance',
            balancePaymentId,
            activePaymentId: balancePaymentId,
            grossRevenueUsdCents: totalPriceUsdCents,
            providerFeeUsdCents: 0,
            mystarsCurrency: 'usdt_ton',
            paymentStatus: 'paid',
            fulfillmentStatus: 'paid',
            paidAt: now,
            updatedAt: now,
          }
        : {
            orderId: resolvedOrderId,
            userId,
            userTelegramId: params.telegramId,
            username: params.username || userSnap?.username,
            ...(effectiveRecipient ? { recipientUsername: effectiveRecipient } : {}),
            productId: product.id,
            productName: product.name,
            category: product.category,
            ...(resolvedDurationMonths !== undefined
              ? { durationMonths: resolvedDurationMonths as 3 | 6 | 12 }
              : {}),
            quantity: calc.quantity,
            unitPriceUsdCents: calc.unitPriceUsdCents,
            totalPriceUsdCents,
            totalPrice: totalPriceUsdCents,
            currency: 'USD',
            paymentMethod: 'balance',
            balancePaymentId,
            activePaymentId: balancePaymentId,
            grossRevenueUsdCents: totalPriceUsdCents,
            providerFeeUsdCents: 0,
            mystarsCurrency: 'usdt_ton',
            paymentStatus: 'paid',
            fulfillmentStatus: 'paid',
            fulfillmentIdempotencyKey: `fulfill_${resolvedOrderId}`,
            fulfillmentAttempts: 0,
            createdAt: now,
            paidAt: now,
            updatedAt: now,
          };

      const paymentRecord: PaymentRecord = {
        paymentId: balancePaymentId,
        kind: 'order',
        provider: 'balance',
        providerPaymentId: balancePaymentId,
        orderId: resolvedOrderId,
        userId,
        userTelegramId: params.telegramId,
        totalAmount: totalPriceUsdCents,
        expectedUsdCents: totalPriceUsdCents,
        feeUsdCents: 0,
        netUsdCents: totalPriceUsdCents,
        expectedAmountStr: centsToUsdString(totalPriceUsdCents),
        actualAmountStr: centsToUsdString(totalPriceUsdCents),
        currency: 'USD',
        invoicePayload: resolvedOrderId,
        status: 'paid',
        paidAt: now,
        confirmedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      const txId = `tx_bal_deduct_${resolvedOrderId}`;
      const txRecord: StoreTransaction = {
        transactionId: txId,
        orderId: resolvedOrderId,
        userId,
        type: 'balance_deducted',
        amount: totalPriceUsdCents,
        amountUsdCents: totalPriceUsdCents,
        currency: 'USD',
        details: `Оплата заказа ${resolvedOrderId} (${product.name}) с внутреннего баланса: списано=${formatUsdCents(totalPriceUsdCents)}, остаток=${formatUsdCents(newBalanceCents)}`,
        createdAt: now,
      };

      tx.set<StoreUser>('users', userId, updatedUser);
      tx.set<Order>('orders', resolvedOrderId, paidOrder);
      tx.set<PaymentRecord>('payments', balancePaymentId, paymentRecord);
      tx.set<StoreTransaction>('transactions', txId, txRecord);

      return {
        order: paidOrder,
        duplicate: false,
        newBalance: newBalanceUsd,
        newBalanceUsdCents: newBalanceCents,
      };
    });
  }

  /**
   * Safely refunds an order paid with internal balance back to internal balance in integer USD cents.
   */
  public async refundOrderToInternalBalance(params: {
    orderId: string;
    reason: string;
    adminTelegramId?: number;
  }): Promise<{
    refunded: boolean;
    alreadyRefunded: boolean;
    order: Order;
    newBalance: number;
    newBalanceUsdCents: number;
    message: string;
  }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    return firestoreRepo.runTransaction(async (tx) => {
      const order = await tx.get<Order>('orders', params.orderId);
      if (!order) {
        throw new Error(`Заказ ${params.orderId} не найден.`);
      }

      if (
        order.paymentMethod !== 'balance' &&
        order.paymentMethod !== 'internal_balance'
      ) {
        throw new Error(
          `Заказ ${params.orderId} был оплачен через внешний шлюз (${order.paymentMethod || 'неизвестно'}), а не с внутреннего баланса. Автоматический возврат криптовалютных платежей не поддерживается.`,
        );
      }

      const [userSnap, existingPayment] = await Promise.all([
        tx.get<StoreUser>('users', order.userId),
        order.balancePaymentId
          ? tx.get<PaymentRecord>('payments', order.balancePaymentId)
          : Promise.resolve(null),
      ]);

      if (order.paymentStatus === 'refunded' || order.balanceRefunded === true) {
        const balCents = getUserBalanceCentsFromDoc(userSnap);
        return {
          refunded: true,
          alreadyRefunded: true,
          order,
          newBalance: fromMinorUnits(balCents),
          newBalanceUsdCents: balCents,
          message: `Возврат средств на внутренний баланс по заказу ${params.orderId} уже был выполнен ранее.`,
        };
      }

      const refundableStatuses = ['paid', 'processing', 'completed', 'failed'];
      if (!refundableStatuses.includes(order.paymentStatus)) {
        throw new Error(
          `Возврат на баланс невозможен: заказ находится в статусе "${order.paymentStatus}".`,
        );
      }

      const now = new Date().toISOString();
      const refundCents = assertValidUsdCents(
        order.totalPriceUsdCents ?? order.totalPrice,
        'totalPriceUsdCents',
      );
      const currentBalanceCents = getUserBalanceCentsFromDoc(userSnap);
      const newBalanceCents = currentBalanceCents + refundCents;
      const newBalanceUsd = fromMinorUnits(newBalanceCents);
      const shouldAdjustStats = !order.refundStatsAdjusted;

      const updatedUser: StoreUser = userSnap
        ? {
            ...userSnap,
            balanceUsdCents: newBalanceCents,
            balance: newBalanceUsd,
            totalOrders: shouldAdjustStats
              ? Math.max(0, (userSnap.totalOrders || 0) - 1)
              : userSnap.totalOrders,
            totalSpentUsdCents: shouldAdjustStats
              ? Math.max(0, (userSnap.totalSpentUsdCents || 0) - refundCents)
              : userSnap.totalSpentUsdCents,
            updatedAt: now,
          }
        : {
            userId: order.userId,
            telegramId: order.userTelegramId,
            username: order.username,
            firstName: 'Покупатель',
            isBlocked: false,
            totalOrders: 0,
            balanceUsdCents: newBalanceCents,
            totalSpentUsdCents: 0,
            totalSpentStars: 0,
            balance: newBalanceUsd,
            createdAt: now,
            updatedAt: now,
          };

      const refundedOrder: Order = {
        ...order,
        paymentStatus: 'refunded',
        fulfillmentStatus: 'refunded',
        balanceRefunded: true,
        refundState: 'refunded',
        refundStatsAdjusted: true,
        refundLastError: undefined,
        fulfillmentNote: params.reason,
        updatedAt: now,
      };

      const txId = `tx_bal_refund_${order.orderId}`;
      const adminTag = params.adminTelegramId
        ? ` (admin tg_${params.adminTelegramId})`
        : '';
      const txRecord: StoreTransaction = {
        transactionId: txId,
        orderId: order.orderId,
        userId: order.userId,
        type: 'balance_refunded',
        amount: refundCents,
        amountUsdCents: refundCents,
        currency: 'USD',
        details: `Возврат заказа ${order.orderId} на внутренний баланс${adminTag}: +${formatUsdCents(refundCents)}, новый баланс=${formatUsdCents(newBalanceCents)}. Причина: ${params.reason}`,
        createdAt: now,
      };

      if (existingPayment) {
        tx.set<PaymentRecord>('payments', existingPayment.paymentId, {
          ...existingPayment,
          status: 'refunded',
          refundedAt: existingPayment.refundedAt || now,
          updatedAt: now,
        });
      }
      tx.set<StoreUser>('users', order.userId, updatedUser);
      tx.set<Order>('orders', order.orderId, refundedOrder);
      tx.set<StoreTransaction>('transactions', txId, txRecord);

      return {
        refunded: true,
        alreadyRefunded: false,
        order: refundedOrder,
        newBalance: newBalanceUsd,
        newBalanceUsdCents: newBalanceCents,
        message: `Заказ ${order.orderId} успешно возвращён на внутренний баланс (+${formatUsdCents(refundCents)}, новый баланс: ${formatUsdCents(newBalanceCents)}).`,
      };
    });
  }
}

export const balanceService = new BalanceService();
