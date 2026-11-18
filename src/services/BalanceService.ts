import crypto from 'crypto';
import { firestoreRepo } from '../db/firestore.ts';
import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
  BalanceTopUpStatus,
  Order,
  Product,
  StoreTransaction,
  StoreUser,
} from '../types.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  PaymentProviderGateway,
  normalizeCurrencyCode,
  paymentProviderGateway,
  redactSecretsFromText,
} from './PaymentProviders.ts';

export interface CommissionCalculationResult {
  amountPaid: number;
  feePercent: number;
  feeAmount: number;
  amountCredited: number;
}

/**
 * Converts a monetary amount to integer minor units (kopecks/cents, x100)
 * and validates that there are no fractional sub-cent digits.
 */
export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error('Сумма должна быть конечным числом.');
  }
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new Error('Сумма не может содержать более 2 знаков после запятой.');
  }
  return rounded;
}

export function fromMinorUnits(minorUnits: number): number {
  return Number((Math.round(minorUnits) / 100).toFixed(2));
}

/**
 * Calculates store commission and credited amount using integer minor-unit math.
 * Formula: amountCredited = amountPaid * (1 - feePercent / 100)
 * Examples:
 * - CryptoBot (3%): 100 -> 97 (fee 3)
 * - Lolzteam (5%): 100 -> 95 (fee 5)
 * - xRocket (2%): 100 -> 98 (fee 2)
 */
export function calculateTopUpCommission(
  amountPaid: number,
  provider: BalanceTopUpProvider,
): CommissionCalculationResult {
  const providerMeta = PAYMENT_PROVIDER_CATALOG[provider];
  if (!providerMeta) {
    throw new Error(`Неизвестный платёжный провайдер: ${String(provider)}`);
  }
  const paidMinor = toMinorUnits(amountPaid);
  if (paidMinor <= 0) {
    throw new Error('Сумма пополнения должна быть больше нуля.');
  }

  const feePercent = providerMeta.feePercent;
  const feeMinor = Math.round((paidMinor * feePercent) / 100);
  const creditedMinor = paidMinor - feeMinor;

  if (creditedMinor <= 0) {
    throw new Error('Сумма зачисления после комиссии должна быть больше нуля.');
  }

  return Object.freeze({
    amountPaid: fromMinorUnits(paidMinor),
    feePercent,
    feeAmount: fromMinorUnits(feeMinor),
    amountCredited: fromMinorUnits(creditedMinor),
  });
}

export class BalanceService {
  private gateway: PaymentProviderGateway;

  constructor(gateway: PaymentProviderGateway = paymentProviderGateway) {
    this.gateway = gateway;
  }

  public getGateway(): PaymentProviderGateway {
    return this.gateway;
  }

  public async getBalanceByUserId(userId: string): Promise<number> {
    const user = await firestoreRepo.getDoc<StoreUser>('users', userId);
    if (!user) return 0;
    return fromMinorUnits(toMinorUnits(user.balance ?? 0));
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
   * Creates a new balance top-up invoice with a provider and stores a pending record in Firestore.
   */
  public async createTopUp(params: {
    telegramId: number;
    username?: string;
    firstName?: string;
    provider: BalanceTopUpProvider;
    amountPaid: number;
    currency?: string;
    expiresInSeconds?: number;
  }): Promise<BalanceTopUpRecord> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const providerMeta = PAYMENT_PROVIDER_CATALOG[params.provider];
    if (!providerMeta) {
      throw new Error(`Неподдерживаемый способ пополнения: ${String(params.provider)}`);
    }

    if (!Number.isFinite(params.amountPaid) || params.amountPaid <= 0) {
      throw new Error('Сумма пополнения должна быть положительным числом.');
    }

    if (params.amountPaid < providerMeta.minAmount) {
      throw new Error(
        `Минимальная сумма пополнения через ${providerMeta.shortTitle}: ${providerMeta.minAmount} ${params.currency || providerMeta.defaultCurrency}.`,
      );
    }

    if (params.amountPaid > providerMeta.maxAmount) {
      throw new Error(
        `Максимальная сумма пополнения за одну операцию: ${providerMeta.maxAmount}.`,
      );
    }

    const requestedCurrency = (
      params.currency || providerMeta.defaultCurrency
    )
      .trim()
      .toUpperCase();

    if (!providerMeta.supportedCurrencies.includes(requestedCurrency)) {
      throw new Error(
        `Валюта ${requestedCurrency} не поддерживается провайдером ${providerMeta.shortTitle}. Доступные валюты: ${providerMeta.supportedCurrencies.join(', ')}.`,
      );
    }

    const userId = `tg_${params.telegramId}`;
    const existingUser = await firestoreRepo.getDoc<StoreUser>('users', userId);
    if (existingUser?.isBlocked) {
      throw new Error('Ваш аккаунт заблокирован. Пополнение баланса недоступно.');
    }

    const calc = calculateTopUpCommission(params.amountPaid, params.provider);
    const paymentId = `topup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const description = `Пополнение баланса Stars Shop (${paymentId}) — к зачислению ${calc.amountCredited} ${ normalizeCurrencyCode(requestedCurrency) }`;

    const createdInvoice = await this.gateway.createInvoice({
      paymentId,
      provider: params.provider,
      amountPaid: calc.amountPaid,
      currency: requestedCurrency,
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
      externalInvoiceId: createdInvoice.externalInvoiceId,
      payUrl: createdInvoice.payUrl,
      amountPaid: calc.amountPaid,
      feePercent: calc.feePercent,
      feeAmount: calc.feeAmount,
      amountCredited: calc.amountCredited,
      currency: normalizeCurrencyCode(requestedCurrency),
      paymentStatus: 'pending',
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
        amount: calc.amountPaid,
        currency: topUpRecord.currency,
        details: `Создан счёт пополнения ${paymentId} через ${providerMeta.shortTitle}: сумма=${calc.amountPaid} ${topUpRecord.currency}, комиссия=${calc.feePercent}% (${calc.feeAmount}), к зачислению=${calc.amountCredited}`,
        createdAt: now,
      });
    });

    return topUpRecord;
  }

  /**
   * Cancels a pending top-up request on user request if it has not been paid yet.
   */
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
      if (topUp.paymentStatus === 'paid') {
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
   * 1. Verifies cryptographic signature / secret header.
   * 2. Locates the top-up record by paymentId or externalInvoiceId.
   * 3. Calls authoritative server-side provider API (`verifyAndProcessTopUp`) before crediting.
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
      topUp =
        candidates.find((c) => c.provider === params.provider) || null;
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
   * Authoritatively verifies top-up payment status via the provider's server-side API,
   * validates amount, currency, invoice ID, payment ID, merchant ID, and expiration,
   * and credits user balance inside an atomic Firestore transaction.
   */
  public async verifyAndProcessTopUp(
    paymentId: string,
    webhookHint?: {
      amountPaid?: number;
      currency?: string;
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

    // Fast idempotent return if already paid
    if (existingTopUp.paymentStatus === 'paid') {
      const currentBal = await this.getBalanceByUserId(existingTopUp.userId);
      return {
        ok: true,
        duplicate: true,
        status: 'paid',
        topUp: existingTopUp,
        newBalance: currentBal,
      };
    }

    if (
      existingTopUp.paymentStatus === 'cancelled' ||
      existingTopUp.paymentStatus === 'expired' ||
      existingTopUp.paymentStatus === 'failed'
    ) {
      return {
        ok: false,
        duplicate: false,
        status: existingTopUp.paymentStatus,
        topUp: existingTopUp,
        reason: `TOPUP_ALREADY_${existingTopUp.paymentStatus.toUpperCase()}`,
      };
    }

    // Check local expiration timestamp before or alongside provider check
    const isLocallyExpired =
      Boolean(existingTopUp.expiresAt) &&
      new Date(existingTopUp.expiresAt!).getTime() <= Date.now();

    const verified = await this.gateway.verifyInvoiceStatus({
      provider: existingTopUp.provider,
      externalInvoiceId: existingTopUp.externalInvoiceId,
      paymentId: existingTopUp.paymentId,
    });

    // If invoice has expired (either reported by provider or local expiration reached)
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

    if (verified.status !== 'paid') {
      return {
        ok: false,
        duplicate: false,
        status: 'pending',
        topUp: existingTopUp,
        reason: 'PAYMENT_STILL_PENDING',
      };
    }

    // Strict security verification of paid invoice parameters:
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

    // 3. Recipient / Merchant ID match (when applicable, e.g., Lolzteam merchant_id)
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

    // 4. Currency match (check both webhookHint if present and authoritative API response)
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

    // 5. Amount match (strict integer minor-unit equality)
    const expectedAmountMinor = toMinorUnits(existingTopUp.amountPaid);
    const verifiedAmountMinor = toMinorUnits(verified.amountPaid);
    const hintAmountMinor =
      webhookHint?.amountPaid !== undefined
        ? toMinorUnits(webhookHint.amountPaid)
        : expectedAmountMinor;

    if (
      verifiedAmountMinor !== expectedAmountMinor ||
      hintAmountMinor !== expectedAmountMinor
    ) {
      const failedTopUp = await this.markTopUpTerminalFailure(
        paymentId,
        'failed',
        `Несовпадение суммы платежа: ожидалась ${existingTopUp.amountPaid}, получена ${verified.amountPaid} (hint: ${webhookHint?.amountPaid ?? 'n/a'})`,
      );
      return {
        ok: false,
        duplicate: false,
        status: 'failed',
        topUp: failedTopUp,
        reason: 'INVALID_AMOUNT',
      };
    }

    // 6. Atomic Firestore transaction to credit balance and prevent duplicate crediting
    return firestoreRepo.runTransaction(async (tx) => {
      const freshTopUp = await tx.get<BalanceTopUpRecord>(
        'balance_topups',
        paymentId,
      );
      if (!freshTopUp) {
        throw new Error(`Счёт пополнения ${paymentId} не найден в транзакции.`);
      }

      const userSnap = await tx.get<StoreUser>('users', freshTopUp.userId);

      // Idempotency guard inside transaction
      if (freshTopUp.paymentStatus === 'paid') {
        return {
          ok: true,
          duplicate: true,
          status: 'paid' as const,
          topUp: freshTopUp,
          newBalance: fromMinorUnits(toMinorUnits(userSnap?.balance ?? 0)),
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

      // Guard against tampering with amountCredited after invoice creation
      const expectedCalc = calculateTopUpCommission(
        freshTopUp.amountPaid,
        freshTopUp.provider,
      );
      if (
        toMinorUnits(freshTopUp.amountCredited) !==
          toMinorUnits(expectedCalc.amountCredited) ||
        toMinorUnits(freshTopUp.feeAmount) !==
          toMinorUnits(expectedCalc.feeAmount) ||
        freshTopUp.feePercent !== expectedCalc.feePercent
      ) {
        throw new Error(
          `Обнаружено нарушение целостности расчёта комиссии для счёта ${paymentId}. Зачисление заблокировано.`,
        );
      }

      const now = new Date().toISOString();
      const currentBalanceMinor = toMinorUnits(userSnap?.balance ?? 0);
      const creditMinor = toMinorUnits(freshTopUp.amountCredited);
      const newBalance = fromMinorUnits(currentBalanceMinor + creditMinor);

      const updatedUser: StoreUser = userSnap
        ? {
            ...userSnap,
            balance: newBalance,
            updatedAt: now,
          }
        : {
            userId: freshTopUp.userId,
            telegramId: freshTopUp.userTelegramId,
            username: freshTopUp.username,
            firstName: 'Пользователь',
            isBlocked: false,
            totalOrders: 0,
            totalSpentStars: 0,
            balance: newBalance,
            createdAt: now,
            updatedAt: now,
          };

      const paidTopUp: BalanceTopUpRecord = {
        ...freshTopUp,
        paymentStatus: 'paid',
        paidAt: verified.paidAt || now,
        updatedAt: now,
      };

      const txId = `tx_topup_paid_${paymentId}`;
      const txRecord: StoreTransaction = {
        transactionId: txId,
        orderId: paymentId,
        userId: freshTopUp.userId,
        type: 'balance_topup_paid',
        amount: freshTopUp.amountCredited,
        currency: freshTopUp.currency,
        details: `Баланс пополнен через ${PAYMENT_PROVIDER_CATALOG[freshTopUp.provider].shortTitle} (invoice=${freshTopUp.externalInvoiceId}): внесено=${freshTopUp.amountPaid} ${freshTopUp.currency}, комиссия=${freshTopUp.feePercent}% (${freshTopUp.feeAmount}), зачислено=${freshTopUp.amountCredited}, новый баланс=${newBalance}`,
        createdAt: now,
      };

      tx.set<StoreUser>('users', freshTopUp.userId, updatedUser);
      tx.set<BalanceTopUpRecord>('balance_topups', paymentId, paidTopUp);
      tx.set<StoreTransaction>('transactions', txId, txRecord);

      return {
        ok: true,
        duplicate: false,
        status: 'paid' as const,
        topUp: paidTopUp,
        newBalance,
      };
    });
  }

  private async markTopUpTerminalFailure(
    paymentId: string,
    terminalStatus: 'failed' | 'expired' | 'cancelled',
    failureReason: string,
  ): Promise<BalanceTopUpRecord> {
    const cleanReason = redactSecretsFromText(failureReason).slice(0, 450);
    return firestoreRepo.runTransaction(async (tx) => {
      const fresh = await tx.get<BalanceTopUpRecord>('balance_topups', paymentId);
      if (!fresh) {
        throw new Error(`Счёт пополнения ${paymentId} не найден.`);
      }
      if (fresh.paymentStatus === 'paid') {
        return fresh;
      }
      const now = new Date().toISOString();
      const updated: BalanceTopUpRecord = {
        ...fresh,
        paymentStatus: terminalStatus,
        failureReason: cleanReason,
        updatedAt: now,
      };
      tx.set<BalanceTopUpRecord>('balance_topups', paymentId, updated);

      const txType =
        terminalStatus === 'expired'
          ? 'balance_topup_expired'
          : 'balance_topup_failed';
      const txId = `tx_topup_${terminalStatus}_${paymentId}`;
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: paymentId,
        userId: fresh.userId,
        type: txType,
        amount: fresh.amountPaid,
        currency: fresh.currency,
        details: cleanReason,
        createdAt: now,
      });

      return updated;
    });
  }

  /**
   * Pays for a store product or existing pending order using the user's internal balance.
   * - Atomic balance deduction via Firestore transaction
   * - Balance can never become negative
   * - Prevents double deduction on repeated callback clicks / concurrent requests via deterministic orderId / idempotencyKey
   * - Logs deduction in `transactions`
   * - Never mixes internal balance with Telegram Stars (`totalSpentStars` is untouched)
   */
  public async purchaseWithInternalBalance(params: {
    telegramId: number;
    username?: string;
    firstName?: string;
    productId: string;
    quantity?: number;
    orderId?: string;
  }): Promise<{
    order: Order;
    duplicate: boolean;
    newBalance: number;
  }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const quantity = params.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new Error('Некорректное количество товара (допустимо от 1 до 10).');
    }

    const userId = `tg_${params.telegramId}`;
    const resolvedOrderId =
      params.orderId ||
      `ord_bal_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    return firestoreRepo.runTransaction(async (tx) => {
      // ALL READS FIRST
      const [existingOrder, product, userSnap] = await Promise.all([
        tx.get<Order>('orders', resolvedOrderId),
        tx.get<Product>('products', params.productId),
        tx.get<StoreUser>('users', userId),
      ]);

      // Idempotency guard: if this order was already paid/processed/completed, do NOT deduct again!
      if (
        existingOrder &&
        (existingOrder.paymentStatus === 'paid' ||
          existingOrder.paymentStatus === 'processing' ||
          existingOrder.paymentStatus === 'completed')
      ) {
        return {
          order: existingOrder,
          duplicate: true,
          newBalance: fromMinorUnits(toMinorUnits(userSnap?.balance ?? 0)),
        };
      }

      if (existingOrder) {
        if (existingOrder.userTelegramId !== params.telegramId) {
          throw new Error('Вы не можете оплатить чужой заказ.');
        }
        if (
          existingOrder.paymentStatus === 'cancelled' ||
          existingOrder.paymentStatus === 'refunded' ||
          existingOrder.paymentStatus === 'failed'
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

      const totalPrice = existingOrder
        ? existingOrder.totalPrice
        : product.price * quantity;
      const totalPriceMinor = toMinorUnits(totalPrice);
      const currentBalanceMinor = toMinorUnits(userSnap?.balance ?? 0);

      if (currentBalanceMinor < totalPriceMinor) {
        const currentBalFormatted = fromMinorUnits(currentBalanceMinor);
        throw new Error(
          `Недостаточно средств на внутреннем балансе. Требуется: ${totalPrice}, доступно: ${currentBalFormatted}.`,
        );
      }

      const newBalanceMinor = currentBalanceMinor - totalPriceMinor;
      if (newBalanceMinor < 0) {
        throw new Error('Баланс не может уйти в минус.');
      }
      const newBalance = fromMinorUnits(newBalanceMinor);
      const now = new Date().toISOString();
      const balancePaymentId = `bal_pay_${resolvedOrderId}`;

      const updatedUser: StoreUser = userSnap
        ? {
            ...userSnap,
            balance: newBalance,
            totalOrders: (userSnap.totalOrders || 0) + 1,
            updatedAt: now,
          }
        : {
            userId,
            telegramId: params.telegramId,
            username: params.username,
            firstName: params.firstName || 'Покупатель',
            isBlocked: false,
            totalOrders: 1,
            totalSpentStars: 0,
            balance: newBalance,
            createdAt: now,
            updatedAt: now,
          };

      const paidOrder: Order = existingOrder
        ? {
            ...existingOrder,
            paymentMethod: 'balance',
            balancePaymentId,
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
            productId: product.id,
            productName: product.name,
            category: product.category,
            quantity,
            totalPrice,
            currency: product.currency,
            paymentMethod: 'balance',
            balancePaymentId,
            paymentStatus: 'paid',
            fulfillmentStatus: 'paid',
            fulfillmentIdempotencyKey: `fulfill_${resolvedOrderId}`,
            fulfillmentAttempts: 0,
            createdAt: now,
            paidAt: now,
            updatedAt: now,
          };

      const txId = `tx_bal_deduct_${resolvedOrderId}`;
      const txRecord: StoreTransaction = {
        transactionId: txId,
        orderId: resolvedOrderId,
        userId,
        type: 'balance_deducted',
        amount: totalPrice,
        currency: 'BAL',
        details: `Оплата заказа ${resolvedOrderId} (${product.name}) с внутреннего баланса: списано=${totalPrice}, остаток баланса=${newBalance}`,
        createdAt: now,
      };

      // ALL WRITES AFTER READS
      tx.set<StoreUser>('users', userId, updatedUser);
      tx.set<Order>('orders', resolvedOrderId, paidOrder);
      tx.set<StoreTransaction>('transactions', txId, txRecord);

      return {
        order: paidOrder,
        duplicate: false,
        newBalance,
      };
    });
  }

  /**
   * Safely refunds an order paid with internal balance back to the buyer's internal balance.
   * Atomic Firestore transaction guarantees idempotency (cannot double-refund).
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
    message: string;
  }> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    return firestoreRepo.runTransaction(async (tx) => {
      // ALL READS FIRST
      const order = await tx.get<Order>('orders', params.orderId);
      if (!order) {
        throw new Error(`Заказ ${params.orderId} не найден.`);
      }

      if (order.paymentMethod !== 'balance') {
        throw new Error(
          `Заказ ${params.orderId} был оплачен через Telegram Stars, а не с внутреннего баланса. Используйте возврат Telegram Stars.`,
        );
      }

      const userSnap = await tx.get<StoreUser>('users', order.userId);

      // Idempotent guard if already refunded
      if (order.paymentStatus === 'refunded' || order.balanceRefunded === true) {
        return {
          refunded: true,
          alreadyRefunded: true,
          order,
          newBalance: fromMinorUnits(toMinorUnits(userSnap?.balance ?? 0)),
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
      const currentBalanceMinor = toMinorUnits(userSnap?.balance ?? 0);
      const refundMinor = toMinorUnits(order.totalPrice);
      const newBalance = fromMinorUnits(currentBalanceMinor + refundMinor);
      const shouldAdjustStats = !order.refundStatsAdjusted;

      const updatedUser: StoreUser = userSnap
        ? {
            ...userSnap,
            balance: newBalance,
            totalOrders: shouldAdjustStats
              ? Math.max(0, (userSnap.totalOrders || 0) - 1)
              : userSnap.totalOrders,
            updatedAt: now,
          }
        : {
            userId: order.userId,
            telegramId: order.userTelegramId,
            username: order.username,
            firstName: 'Покупатель',
            isBlocked: false,
            totalOrders: 0,
            totalSpentStars: 0,
            balance: newBalance,
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
        amount: order.totalPrice,
        currency: 'BAL',
        details: `Возврат заказа ${order.orderId} на внутренний баланс${adminTag}: +${order.totalPrice}, новый баланс=${newBalance}. Причина: ${params.reason}`,
        createdAt: now,
      };

      // ALL WRITES AFTER READS
      tx.set<StoreUser>('users', order.userId, updatedUser);
      tx.set<Order>('orders', order.orderId, refundedOrder);
      tx.set<StoreTransaction>('transactions', txId, txRecord);

      return {
        refunded: true,
        alreadyRefunded: false,
        order: refundedOrder,
        newBalance,
        message: `Заказ ${order.orderId} успешно возвращён на внутренний баланс (+${order.totalPrice}, новый баланс: ${newBalance}).`,
      };
    });
  }
}

export const balanceService = new BalanceService();
