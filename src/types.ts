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

export type FulfillmentType = 'manual' | 'provider_adapter';

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'failed';

export interface StoreUser {
  userId: string;
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  languageCode?: string;
  isBlocked: boolean;
  totalOrders: number;
  totalSpentStars: number;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  name: string;
  category: ProductCategory;
  description: string;
  price: number;
  currency: 'XTR';
  imageUrl: string;
  isActive: boolean;
  fulfillmentType: FulfillmentType;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  orderId: string;
  userId: string;
  userTelegramId: number;
  username?: string;
  productId: string;
  productName: string;
  category: ProductCategory;
  quantity: number;
  totalPrice: number;
  currency: 'XTR';
  paymentStatus: OrderStatus;
  fulfillmentStatus: OrderStatus;
  telegramPaymentChargeId?: string;
  providerPaymentChargeId?: string;
  fulfillmentNote?: string;
  fulfillmentStartedAt?: string;
  fulfillmentAttempts?: number;
  fulfillmentLastError?: string;
  fulfillmentNextRetryAt?: string;
  fulfillmentIdempotencyKey?: string;
  externalExecutionReference?: string;
  needsManualReconciliation?: boolean;
  adminNotifiedAt?: string;
  buyerNotifiedAt?: string;
  createdAt: string;
  paidAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface PaymentRecord {
  paymentId: string;
  telegramPaymentChargeId: string;
  providerPaymentChargeId?: string;
  orderId: string;
  userId: string;
  userTelegramId: number;
  totalAmount: number;
  currency: 'XTR';
  invoicePayload: string;
  status: 'paid' | 'refunded';
  createdAt: string;
  refundedAt?: string;
}

export type TransactionType =
  | 'invoice_created'
  | 'pre_checkout_ok'
  | 'payment_received'
  | 'fulfillment_completed'
  | 'fulfillment_failed'
  | 'fulfillment_retry'
  | 'order_cancelled'
  | 'payment_refunded'
  | 'admin_action'
  | 'error';

export interface StoreTransaction {
  transactionId: string;
  orderId: string;
  userId: string;
  type: TransactionType;
  amount: number;
  currency: 'XTR';
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
    | 'add_product_name'
    | 'add_product_description'
    | 'add_product_price'
    | 'message_user'
    | 'block_user_id'
    | 'complete_order_note';
  targetId?: string;
  draftProduct?: {
    category: ProductCategory;
    name?: string;
    description?: string;
    price?: number;
  };
  createdAt: number;
}
