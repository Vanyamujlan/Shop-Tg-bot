export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export type ProductCategory = 'stars' | 'premium' | 'gifts';

export type FulfillmentType = 'manual' | 'provider_adapter' | 'mystars';

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'failed';

export type RefundExecutionState =
  | 'refund_in_progress'
  | 'telegram_refund_succeeded_pending_commit'
  | 'refund_failed_needs_reconciliation'
  | 'refunded';

export type BalanceTopUpProvider = 'cryptobot' | 'xrocket';

export type PaymentProviderType = 'cryptobot' | 'xrocket' | 'balance' | 'telegram_stars';

export type BalanceTopUpStatus =
  | 'pending'
  | 'paid'
  | 'underpaid'
  | 'overpaid'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'refunded';

export type PaymentRecordStatus =
  | 'pending'
  | 'paid'
  | 'underpaid'
  | 'overpaid'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'refunded';

export type OrderPaymentMethod =
  | 'cryptobot'
  | 'xrocket'
  | 'balance'
  | 'internal_balance'
  | 'stars'
  | 'telegram_stars';

export interface XRocketErrorProblemDetails {
  status?: number;
  type?: string;
  title?: string;
  detail?: string;
  instance?: string;
  kind?: string;
}

export interface BalanceTopUpRecord {
  paymentId: string;
  userId: string;
  userTelegramId: number;
  username?: string;
  provider: BalanceTopUpProvider;
  /** Gross amount entered in integer USD cents (e.g. $10.00 = 1000) */
  amountUsdCents: number;
  /** Gateway commission in integer USD cents */
  feeUsdCents: number;
  /** Net amount credited to user balance in integer USD cents */
  amountCreditedUsdCents: number;
  /** Gateway fee basis points (e.g. 300 = 3%, 200 = 2%) */
  feeBps: number;
  feePercent: number;
  /** Exact crypto/fiat payable string sent to provider invoice */
  expectedAmountStr: string;
  /** Actual amount reported by provider upon payment (if any) */
  actualAmountStr?: string;
  /** Legacy numeric mirrors derived from cents/strings */
  amountUsd?: number;
  amountPaid: number;
  feeAmount: number;
  amountCredited: number;
  /** Payment currency billed on provider invoice (e.g. USD, USDT, TON, BTC) */
  currency: string;
  originalCurrency?: string;
  originalAmountPaid?: number;
  /** Locked exchange rate string (USD per 1 unit of currency) */
  exchangeRateUsdStr?: string;
  exchangeRateUsd?: number;
  network?: string;
  paymentStatus: BalanceTopUpStatus;
  statusReason?: string;
  externalInvoiceId: string;
  payUrl?: string;
  recipientMerchantId?: string;
  failureReason?: string;
  expiresAt?: string;
  createdAt: string;
  paidAt?: string;
  confirmedAt?: string;
  updatedAt: string;
}

export interface StoreUser {
  userId: string;
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  languageCode?: string;
  isBlocked: boolean;
  totalOrders: number;
  /** Primary balance in integer USD cents (e.g. $10.00 = 1000) */
  balanceUsdCents: number;
  /** Cumulative confirmed order spend in integer USD cents */
  totalSpentUsdCents: number;
  /** Legacy/compatibility fields */
  totalSpentStars: number;
  balance?: number;
  createdAt: string;
  updatedAt: string;
}

export type KeyGeneratorAlgorithm =
  | 'none'
  | 'stars_promo_v1'
  | 'gift_voucher_v1';

export type DigitalKeyStatus =
  | 'available'
  | 'reserved'
  | 'delivered'
  | 'disabled';

export interface DigitalKeyRecord {
  keyId: string;
  productId: string;
  productName: string;
  keyHash: string;
  keyValue: string;
  maskedPreview: string;
  status: DigitalKeyStatus;
  source: 'manual' | 'generated';
  algorithm?: KeyGeneratorAlgorithm;
  reservedOrderId?: string;
  reservedUserId?: string;
  reservedUserTelegramId?: number;
  reservedAt?: string;
  deliveredOrderId?: string;
  deliveredUserId?: string;
  deliveredUserTelegramId?: number;
  deliveredAt?: string;
  disabledAt?: string;
  disabledByTelegramId?: number;
  createdByTelegramId: number;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  name: string;
  category: ProductCategory;
  description: string;
  /** Canonical unit price in integer USD cents ($1.00 = 100) */
  priceUsdCents: number;
  /** Optional explicit per-unit USD cents for custom quantity items (e.g., 1 Star) */
  unitPriceUsdCents?: number;
  /** Mirror of priceUsdCents for backward-compatible index/sorting */
  price: number;
  currency: 'USD' | 'XTR';
  minQuantity?: number;
  maxQuantity?: number;
  durationMonths?: 3 | 6 | 12;
  imageUrl: string;
  isActive: boolean;
  fulfillmentType: FulfillmentType;
  keyGeneratorAlgorithm?: KeyGeneratorAlgorithm;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  orderId: string;
  userId: string;
  userTelegramId: number;
  username?: string;
  /** Target Telegram @username for Stars / Premium delivery (normalized without @ or lowercase) */
  recipientUsername?: string;
  productId: string;
  productName: string;
  category: ProductCategory;
  quantity: number;
  /** Subscription term in months for Telegram Premium orders (3, 6, or 12) */
  durationMonths?: 3 | 6 | 12;
  /** Canonical unit and total prices in integer USD cents */
  unitPriceUsdCents?: number;
  totalPriceUsdCents: number;
  totalPrice: number;
  currency: 'USD' | 'XTR';
  paymentMethod?: OrderPaymentMethod;
  activePaymentId?: string;
  externalInvoiceId?: string;
  balancePaymentId?: string;
  balanceRefunded?: boolean;
  paymentStatus: OrderStatus;
  fulfillmentStatus: OrderStatus;
  telegramPaymentChargeId?: string;
  providerPaymentChargeId?: string;
  /** MyStars Stage 4.3/4.4 P&L, wholesale accounting & FaaS v1 order fields */
  grossRevenueUsdCents?: number;
  providerFeeUsdCents?: number;
  mystarsCurrency?: 'usdt_ton' | 'ton';
  mystarsWholesaleCostUsdt?: string;
  mystarsCostUsdCents?: number;
  tonNetworkFeeTon?: string;
  tonNetworkFeeUsdCents?: number;
  netProfitUsdCents?: number;
  mystarsOrderId?: string;
  mystarsOrderStatus?: string;
  mystarsPayToAddress?: string;
  mystarsPaymentMemo?: string;
  mystarsPaymentAmountUsdt?: string;
  mystarsPurchaseTx?: string;
  mystarsFailureReason?: string;
  mystarsExpiresAt?: string;
  mystarsLastPolledAt?: string;
  mystarsPollAttempts?: number;
  mystarsLastPollError?: string;
  fulfillmentNote?: string;
  fulfillmentStartedAt?: string;
  fulfillmentAttempts?: number;
  fulfillmentLastError?: string;
  fulfillmentNextRetryAt?: string;
  fulfillmentIdempotencyKey?: string;
  externalExecutionReference?: string;
  needsManualReconciliation?: boolean;
  assignedKeyIds?: string[];
  deliveredKeyValues?: string[];
  awaitingKeyStock?: boolean;
  refundState?: RefundExecutionState;
  refundLockToken?: string;
  refundStartedAt?: string;
  refundLastError?: string;
  refundStatsAdjusted?: boolean;
  adminNotifiedAt?: string;
  buyerNotifiedAt?: string;
  createdAt: string;
  paidAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface PaymentRecord {
  paymentId: string;
  kind?: 'order' | 'topup';
  provider: PaymentProviderType;
  providerPaymentId?: string;
  telegramPaymentChargeId?: string;
  providerPaymentChargeId?: string;
  orderId: string;
  topUpId?: string;
  userId: string;
  userTelegramId: number;
  totalAmount: number;
  expectedUsdCents: number;
  feeUsdCents: number;
  netUsdCents: number;
  expectedAmountStr: string;
  actualAmountStr?: string;
  exchangeRateUsdStr?: string;
  currency: string;
  network?: string;
  invoicePayload: string;
  payUrl?: string;
  status: PaymentRecordStatus;
  statusReason?: string;
  expiresAt?: string;
  paidAt?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt?: string;
  refundedAt?: string;
}

/**
 * Atomic unique claim document stored in `payment_locks/{lockId}` to guarantee
 * a single external `provider + providerPaymentId` can NEVER settle twice or across different orders.
 */
export interface PaymentLockRecord {
  lockId: string;
  provider: string;
  providerPaymentId: string;
  targetType: 'order' | 'topup';
  targetId: string;
  paymentId: string;
  userId: string;
  amountUsdCents: number;
  claimedAt: string;
}

export type TransactionType =
  | 'invoice_created'
  | 'pre_checkout_ok'
  | 'payment_received'
  | 'order_underpaid'
  | 'order_overpaid'
  | 'order_expired'
  | 'fulfillment_completed'
  | 'fulfillment_failed'
  | 'fulfillment_retry'
  | 'order_cancelled'
  | 'payment_refunded'
  | 'balance_topup_created'
  | 'balance_topup_paid'
  | 'balance_topup_underpaid'
  | 'balance_topup_overpaid'
  | 'balance_topup_failed'
  | 'balance_topup_expired'
  | 'balance_deducted'
  | 'balance_refunded'
  | 'exchange_rate_locked'
  | 'key_added'
  | 'key_generated'
  | 'key_delivered'
  | 'key_disabled'
  | 'key_stock_empty'
  | 'admin_action'
  | 'error';

export interface StoreTransaction {
  transactionId: string;
  orderId: string;
  userId: string;
  type: TransactionType;
  amount: number;
  amountUsdCents?: number;
  currency: string;
  details: string;
  createdAt: string;
}

export interface AdminRecord {
  adminId: string;
  telegramId: number;
  role: 'admin' | 'superadmin';
  addedAt: string;
}

export interface StoreSettings {
  key: 'global';
  storeName: string;
  supportUsername: string;
  maintenanceMode: boolean;
  updatedAt: string;
}

export interface BotConnectionStatus {
  connected: boolean;
  mode: 'polling' | 'webhook' | 'unconfigured';
  pollingActive: boolean;
  botId?: number;
  botUsername?: string;
  botFirstName?: string;
  lastCheckedAt: string;
  error?: string;
}

export interface AdminInteractiveSession {
  action:
    | 'edit_price'
    | 'edit_name'
    | 'edit_description'
    | 'add_product_duration'
    | 'add_product_name'
    | 'add_product_description'
    | 'add_product_price'
    | 'message_user'
    | 'block_user_id'
    | 'complete_order_note'
    | 'owner_add_keys';
  targetId?: string;
  draftProduct?: {
    category: ProductCategory;
    durationMonths?: 3 | 6 | 12;
    name?: string;
    description?: string;
    price?: number;
    priceUsdCents?: number;
  };
  createdAt: number;
}
