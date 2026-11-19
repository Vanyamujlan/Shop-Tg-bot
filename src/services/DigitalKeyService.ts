import crypto from 'crypto';
import { Telegraf } from 'telegraf';
import { getEnvConfig, isOwnerTelegramId } from '../config/env.ts';
import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  DigitalKeyRecord,
  DigitalKeyStatus,
  KeyGeneratorAlgorithm,
  Order,
  Product,
  StoreTransaction,
} from '../types.ts';

export class OwnerAccessDeniedError extends Error {
  public readonly code = 'OWNER_ACCESS_DENIED';
  constructor(
    message = 'Доступ запрещён: управление генератором и складом цифровых ключей разрешено исключительно владельцу бота (OWNER_TELEGRAM_ID).',
  ) {
    super(message);
    this.name = 'OwnerAccessDeniedError';
  }
}

export class DuplicateDigitalKeyError extends Error {
  public readonly code = 'DUPLICATE_DIGITAL_KEY';
  public readonly duplicates: string[];
  constructor(maskedDuplicates: string[]) {
    super(
      `Обнаружены дубликаты цифровых ключей (${maskedDuplicates.join(', ')}). Повторное добавление одинаковых ключей запрещено.`,
    );
    this.name = 'DuplicateDigitalKeyError';
    this.duplicates = maskedDuplicates;
  }
}

export class UnsupportedKeyGeneratorError extends Error {
  public readonly code = 'KEY_GENERATOR_NOT_SUPPORTED';
  constructor(productName: string) {
    super(
      `Для товара «${productName}» не задан внутренний алгоритм генерации ключей. Допустимо только ручное добавление реальных ключей владельцем.`,
    );
    this.name = 'UnsupportedKeyGeneratorError';
  }
}

export interface ProductKeyStockSummary {
  productId: string;
  productName: string;
  algorithm: KeyGeneratorAlgorithm;
  available: number;
  reserved: number;
  delivered: number;
  disabled: number;
  total: number;
}

export interface KeyFulfillmentOutcome {
  fulfilled: boolean;
  duplicate: boolean;
  awaitingStock: boolean;
  order: Order;
  deliveredKeys: DigitalKeyRecord[];
  ownerNotified: boolean;
  buyerNotified: boolean;
}

/**
 * Masks a digital key so raw key values never leak in logs, errors, or unauthorized views.
 * Example: "STARS-GIFT-ABCD-1234-EF99" -> "STAR****EF99"
 */
export function maskDigitalKey(rawKey: string): string {
  const clean = (rawKey || '').trim();
  if (clean.length <= 6) {
    return '***';
  }
  if (clean.length <= 10) {
    return `${clean.slice(0, 2)}****${clean.slice(-2)}`;
  }
  return `${clean.slice(0, 4)}****${clean.slice(-4)}`;
}

/**
 * Normalizes a raw key string (trims whitespace) and validates minimum format constraints.
 */
export function normalizeDigitalKeyValue(rawKey: string): string {
  const trimmed = (rawKey || '').trim();
  if (trimmed.length < 4 || trimmed.length > 256) {
    throw new Error(
      'Цифровой ключ должен содержать от 4 до 256 символов.',
    );
  }
  return trimmed;
}

/**
 * Computes a deterministic SHA-256 hash and document ID for a digital key.
 * Uniqueness is enforced globally across the key store so the same key can never be added twice.
 */
export function computeDigitalKeyHash(normalizedKeyValue: string): {
  keyHash: string;
  keyId: string;
} {
  const canonical = normalizedKeyValue.trim().toUpperCase();
  const keyHash = crypto
    .createHash('sha256')
    .update(`stars_shop_key_v1:${canonical}`, 'utf8')
    .digest('hex');
  const keyId = `dkey_${keyHash.slice(0, 32)}`;
  return { keyHash, keyId };
}

/**
 * Generates a cryptographically strong internal digital key ONLY for products
 * that have an explicit internal algorithm (`gift_voucher_v1` or `stars_promo_v1`).
 */
export function generateFormattedDigitalKey(
  product: Product,
  algorithm: KeyGeneratorAlgorithm,
): string {
  if (!algorithm || algorithm === 'none') {
    throw new UnsupportedKeyGeneratorError(product.name);
  }

  const prodPrefix = product.id
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, 'X');

  const randA = crypto.randomBytes(3).toString('hex').toUpperCase();
  const randB = crypto.randomBytes(3).toString('hex').toUpperCase();
  const randC = crypto.randomBytes(2).toString('hex').toUpperCase();
  const payload = `${prodPrefix}-${randA}-${randB}-${randC}`;
  const checksum = crypto
    .createHash('sha256')
    .update(`${algorithm}:${product.id}:${payload}`, 'utf8')
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();

  if (algorithm === 'gift_voucher_v1') {
    return `STARS-GIFT-${payload}-${checksum}`;
  }
  if (algorithm === 'stars_promo_v1') {
    return `STARS-PROMO-${payload}-${checksum}`;
  }

  throw new UnsupportedKeyGeneratorError(product.name);
}

export class DigitalKeyService {
  /**
   * Server-side authorization guard: verifies that `actorTelegramId` is strictly
   * the configured bot owner (`OWNER_TELEGRAM_ID`).
   */
  public static assertOwnerAccess(actorTelegramId: number | undefined | null): number {
    if (!actorTelegramId || !isOwnerTelegramId(actorTelegramId)) {
      throw new OwnerAccessDeniedError();
    }
    return actorTelegramId;
  }

  /**
   * Parses raw multiline / comma / semicolon separated text or string[] into distinct normalized keys.
   */
  public static parseKeyBatchInput(input: string | string[]): string[] {
    const rawList = Array.isArray(input)
      ? input
      : input
          .split(/[\r\n,;]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

    if (rawList.length === 0) {
      throw new Error('Список ключей пуст. Укажите хотя бы один цифровой ключ.');
    }
    if (rawList.length > 100) {
      throw new Error('За одну операцию можно добавить не более 100 ключей.');
    }

    const normalized: string[] = [];
    const seenHashes = new Set<string>();
    const duplicateMasks: string[] = [];

    for (const item of rawList) {
      const norm = normalizeDigitalKeyValue(item);
      const { keyHash } = computeDigitalKeyHash(norm);
      if (seenHashes.has(keyHash)) {
        duplicateMasks.push(maskDigitalKey(norm));
      } else {
        seenHashes.add(keyHash);
        normalized.push(norm);
      }
    }

    if (duplicateMasks.length > 0) {
      throw new DuplicateDigitalKeyError(duplicateMasks);
    }

    return normalized;
  }

  /**
   * Adds one or multiple digital keys manually for a product.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   * Enforces uniqueness inside an atomic Firestore transaction.
   */
  public static async addKeys(params: {
    actorTelegramId: number;
    productId: string;
    keys: string | string[];
  }): Promise<DigitalKeyRecord[]> {
    const ownerId = this.assertOwnerAccess(params.actorTelegramId);
    firestoreRepo.assertReadyForOrdersAndPayments();

    const parsedKeys = this.parseKeyBatchInput(params.keys);
    const keyEntries = parsedKeys.map((keyValue) => {
      const { keyHash, keyId } = computeDigitalKeyHash(keyValue);
      return {
        keyId,
        keyHash,
        keyValue,
        maskedPreview: maskDigitalKey(keyValue),
      };
    });

    return firestoreRepo.runTransaction<DigitalKeyRecord[]>(async (tx) => {
      // ALL READS FIRST
      const product = await tx.get<Product>('products', params.productId);
      if (!product) {
        throw new Error(`Товар ${params.productId} не найден.`);
      }

      const existingSnaps = await Promise.all(
        keyEntries.map((entry) =>
          tx.get<DigitalKeyRecord>('digital_keys', entry.keyId),
        ),
      );

      const existingDuplicates: string[] = [];
      for (let i = 0; i < existingSnaps.length; i++) {
        if (existingSnaps[i]) {
          existingDuplicates.push(keyEntries[i].maskedPreview);
        }
      }

      if (existingDuplicates.length > 0) {
        throw new DuplicateDigitalKeyError(existingDuplicates);
      }

      // ALL WRITES AFTER READS
      const now = new Date().toISOString();
      const createdRecords: DigitalKeyRecord[] = [];

      for (const entry of keyEntries) {
        const record: DigitalKeyRecord = {
          keyId: entry.keyId,
          productId: product.id,
          productName: product.name,
          keyHash: entry.keyHash,
          keyValue: entry.keyValue,
          maskedPreview: entry.maskedPreview,
          status: 'available',
          source: 'manual',
          createdByTelegramId: ownerId,
          createdAt: now,
          updatedAt: now,
        };
        tx.set<DigitalKeyRecord>('digital_keys', record.keyId, record);
        createdRecords.push(record);
      }

      const txId = sanitizeDocId(
        `tx_key_add_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      );
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: `keys_${product.id}`,
        userId: `tg_${ownerId}`,
        type: 'key_added',
        amount: createdRecords.length,
        currency: 'KEY',
        details: `Владелец (tg_${ownerId}) вручную добавил ${createdRecords.length} ключ(ей) для товара ${product.id} (${createdRecords
          .map((k) => k.maskedPreview)
          .join(', ')})`.slice(0, 500),
        createdAt: now,
      });

      return createdRecords;
    });
  }

  /**
   * Configures or updates the internal key generator algorithm for a product.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   */
  public static async setProductKeyAlgorithm(params: {
    actorTelegramId: number;
    productId: string;
    algorithm: KeyGeneratorAlgorithm;
  }): Promise<Product> {
    this.assertOwnerAccess(params.actorTelegramId);
    const allowed: KeyGeneratorAlgorithm[] = [
      'none',
      'stars_promo_v1',
      'gift_voucher_v1',
    ];
    if (!allowed.includes(params.algorithm)) {
      throw new Error(`Недопустимый алгоритм генерации: ${String(params.algorithm)}`);
    }

    return firestoreRepo.runTransaction<Product>(async (tx) => {
      const product = await tx.get<Product>('products', params.productId);
      if (!product) {
        throw new Error(`Товар ${params.productId} не найден.`);
      }
      const updated: Product = {
        ...product,
        keyGeneratorAlgorithm: params.algorithm,
        updatedAt: new Date().toISOString(),
      };
      tx.set<Product>('products', product.id, updated);
      return updated;
    });
  }

  /**
   * Generates digital keys for a product ONLY if the product has an explicit internal
   * key generation algorithm (`gift_voucher_v1` or `stars_promo_v1`).
   * Never generates fake keys for products without a configured internal format.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   */
  public static async generateKeys(params: {
    actorTelegramId: number;
    productId: string;
    count: number;
    algorithmOverride?: KeyGeneratorAlgorithm;
  }): Promise<DigitalKeyRecord[]> {
    const ownerId = this.assertOwnerAccess(params.actorTelegramId);
    firestoreRepo.assertReadyForOrdersAndPayments();

    if (!Number.isInteger(params.count) || params.count < 1 || params.count > 50) {
      throw new Error('Количество генерируемых ключей должно быть от 1 до 50.');
    }

    return firestoreRepo.runTransaction<DigitalKeyRecord[]>(async (tx) => {
      // ALL READS FIRST
      const product = await tx.get<Product>('products', params.productId);
      if (!product) {
        throw new Error(`Товар ${params.productId} не найден.`);
      }

      const effectiveAlgorithm =
        params.algorithmOverride ?? product.keyGeneratorAlgorithm ?? 'none';

      if (!effectiveAlgorithm || effectiveAlgorithm === 'none') {
        throw new UnsupportedKeyGeneratorError(product.name);
      }

      const candidateEntries: Array<{
        keyId: string;
        keyHash: string;
        keyValue: string;
        maskedPreview: string;
      }> = [];
      const seenHashes = new Set<string>();

      for (let i = 0; i < params.count; i++) {
        let attempts = 0;
        while (attempts < 10) {
          attempts++;
          const keyValue = generateFormattedDigitalKey(product, effectiveAlgorithm);
          const { keyHash, keyId } = computeDigitalKeyHash(keyValue);
          if (!seenHashes.has(keyHash)) {
            seenHashes.add(keyHash);
            candidateEntries.push({
              keyId,
              keyHash,
              keyValue,
              maskedPreview: maskDigitalKey(keyValue),
            });
            break;
          }
        }
      }

      const existingSnaps = await Promise.all(
        candidateEntries.map((entry) =>
          tx.get<DigitalKeyRecord>('digital_keys', entry.keyId),
        ),
      );

      for (let i = 0; i < existingSnaps.length; i++) {
        if (existingSnaps[i]) {
          throw new DuplicateDigitalKeyError([candidateEntries[i].maskedPreview]);
        }
      }

      // ALL WRITES AFTER READS
      const now = new Date().toISOString();
      const generatedRecords: DigitalKeyRecord[] = [];

      for (const entry of candidateEntries) {
        const record: DigitalKeyRecord = {
          keyId: entry.keyId,
          productId: product.id,
          productName: product.name,
          keyHash: entry.keyHash,
          keyValue: entry.keyValue,
          maskedPreview: entry.maskedPreview,
          status: 'available',
          source: 'generated',
          algorithm: effectiveAlgorithm,
          createdByTelegramId: ownerId,
          createdAt: now,
          updatedAt: now,
        };
        tx.set<DigitalKeyRecord>('digital_keys', record.keyId, record);
        generatedRecords.push(record);
      }

      const txId = sanitizeDocId(
        `tx_key_gen_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      );
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: `keys_${product.id}`,
        userId: `tg_${ownerId}`,
        type: 'key_generated',
        amount: generatedRecords.length,
        currency: 'KEY',
        details: `Владелец (tg_${ownerId}) сгенерировал ${generatedRecords.length} ключ(ей) [${effectiveAlgorithm}] для товара ${product.id} (${generatedRecords
          .map((k) => k.maskedPreview)
          .join(', ')})`.slice(0, 500),
        createdAt: now,
      });

      return generatedRecords;
    });
  }

  /**
   * Disables an available key so it will not be issued to buyers.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   */
  public static async disableKey(params: {
    actorTelegramId: number;
    keyId: string;
  }): Promise<DigitalKeyRecord> {
    const ownerId = this.assertOwnerAccess(params.actorTelegramId);

    return firestoreRepo.runTransaction<DigitalKeyRecord>(async (tx) => {
      const existing = await tx.get<DigitalKeyRecord>('digital_keys', params.keyId);
      if (!existing) {
        throw new Error(`Ключ ${params.keyId} не найден.`);
      }
      if (existing.status === 'delivered') {
        throw new Error(
          `Ключ ${existing.maskedPreview} уже был выдан по заказу #${existing.deliveredOrderId} и не может быть отключён.`,
        );
      }
      if (existing.status === 'reserved') {
        throw new Error(
          `Ключ ${existing.maskedPreview} зарезервирован заказом #${existing.reservedOrderId}.`,
        );
      }
      if (existing.status === 'disabled') {
        return existing;
      }

      const now = new Date().toISOString();
      const updated: DigitalKeyRecord = {
        ...existing,
        status: 'disabled',
        disabledAt: now,
        disabledByTelegramId: ownerId,
        updatedAt: now,
      };
      tx.set<DigitalKeyRecord>('digital_keys', updated.keyId, updated);

      const txId = sanitizeDocId(
        `tx_key_dis_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      );
      tx.set<StoreTransaction>('transactions', txId, {
        transactionId: txId,
        orderId: `keys_${existing.productId}`,
        userId: `tg_${ownerId}`,
        type: 'key_disabled',
        amount: 1,
        currency: 'KEY',
        details: `Владелец (tg_${ownerId}) отключил ключ ${existing.maskedPreview} (${existing.keyId}) товара ${existing.productId}`,
        createdAt: now,
      });

      return updated;
    });
  }

  /**
   * Returns stock counts for a specific product.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   */
  public static async getProductStockSummary(params: {
    actorTelegramId: number;
    productId: string;
  }): Promise<ProductKeyStockSummary> {
    this.assertOwnerAccess(params.actorTelegramId);

    const [product, keys] = await Promise.all([
      firestoreRepo.getDoc<Product>('products', params.productId),
      firestoreRepo.queryDocs<DigitalKeyRecord>('digital_keys', {
        where: [{ field: 'productId', op: '==', value: params.productId }],
        limit: 1000,
      }),
    ]);

    if (!product) {
      throw new Error(`Товар ${params.productId} не найден.`);
    }

    const summary: ProductKeyStockSummary = {
      productId: product.id,
      productName: product.name,
      algorithm: product.keyGeneratorAlgorithm || 'none',
      available: 0,
      reserved: 0,
      delivered: 0,
      disabled: 0,
      total: keys.length,
    };

    for (const k of keys) {
      if (k.status === 'available') summary.available++;
      else if (k.status === 'reserved') summary.reserved++;
      else if (k.status === 'delivered') summary.delivered++;
      else if (k.status === 'disabled') summary.disabled++;
    }

    return summary;
  }

  /**
   * Returns stock summaries across all products in the catalog.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   */
  public static async getAllProductsStockSummary(
    actorTelegramId: number,
  ): Promise<ProductKeyStockSummary[]> {
    this.assertOwnerAccess(actorTelegramId);

    const [products, allKeys] = await Promise.all([
      firestoreRepo.listDocs<Product>('products', 200),
      firestoreRepo.listDocs<DigitalKeyRecord>('digital_keys', 2000),
    ]);

    const map = new Map<string, ProductKeyStockSummary>();
    for (const p of products) {
      map.set(p.id, {
        productId: p.id,
        productName: p.name,
        algorithm: p.keyGeneratorAlgorithm || 'none',
        available: 0,
        reserved: 0,
        delivered: 0,
        disabled: 0,
        total: 0,
      });
    }

    for (const k of allKeys) {
      let entry = map.get(k.productId);
      if (!entry) {
        entry = {
          productId: k.productId,
          productName: k.productName,
          algorithm: 'none',
          available: 0,
          reserved: 0,
          delivered: 0,
          disabled: 0,
          total: 0,
        };
        map.set(k.productId, entry);
      }
      entry.total++;
      if (k.status === 'available') entry.available++;
      else if (k.status === 'reserved') entry.reserved++;
      else if (k.status === 'delivered') entry.delivered++;
      else if (k.status === 'disabled') entry.disabled++;
    }

    return Array.from(map.values());
  }

  /**
   * Lists keys for a product filtered by status.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   */
  public static async listKeysForProduct(params: {
    actorTelegramId: number;
    productId: string;
    status?: DigitalKeyStatus;
    limit?: number;
  }): Promise<DigitalKeyRecord[]> {
    this.assertOwnerAccess(params.actorTelegramId);

    const allForProduct = await firestoreRepo.queryDocs<DigitalKeyRecord>(
      'digital_keys',
      {
        where: [{ field: 'productId', op: '==', value: params.productId }],
        limit: 500,
      },
    );

    const filtered = params.status
      ? allForProduct.filter((k) => k.status === params.status)
      : allForProduct;

    return filtered
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, params.limit ?? 30);
  }

  /**
   * Returns delivery history of digital keys across the store.
   * Strictly owner-only (`OWNER_TELEGRAM_ID`).
   */
  public static async getKeyDeliveryHistory(params: {
    actorTelegramId: number;
    productId?: string;
    limit?: number;
  }): Promise<DigitalKeyRecord[]> {
    this.assertOwnerAccess(params.actorTelegramId);

    const delivered = await firestoreRepo.queryDocs<DigitalKeyRecord>(
      'digital_keys',
      {
        where: [{ field: 'status', op: '==', value: 'delivered' }],
        limit: 500,
      },
    );

    const filtered = params.productId
      ? delivered.filter((k) => k.productId === params.productId)
      : delivered;

    return filtered
      .sort((a, b) =>
        String(b.deliveredAt || b.updatedAt).localeCompare(
          String(a.deliveredAt || a.updatedAt),
        ),
      )
      .slice(0, params.limit ?? 25);
  }

  /**
   * Internal helper to check whether any available keys exist for a product.
   */
  public static async getAvailableCandidateKeyIds(
    productId: string,
    maxCount = 25,
  ): Promise<string[]> {
    const candidates = await firestoreRepo.queryDocs<DigitalKeyRecord>(
      'digital_keys',
      {
        where: [{ field: 'productId', op: '==', value: productId }],
        limit: 500,
      },
    );

    return candidates
      .filter((k) => k.status === 'available')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, maxCount)
      .map((k) => k.keyId);
  }

  /**
   * Atomically claims and delivers digital key(s) for a paid order:
   * 1. Verifies server-side confirmed payment status (`paid` | `processing` | `completed`).
   * 2. Idempotent if order already has assigned keys (`assignedKeyIds.length >= order.quantity`) —
   *    duplicate webhooks or repeated invocations never issue a second key.
   * 3. Atomically finds `order.quantity` keys with `status === 'available'`, reserves and transitions
   *    them to `'delivered'` with `deliveredOrderId`, `deliveredUserId`, `deliveredUserTelegramId`, `deliveredAt`.
   * 4. Prevents two concurrent orders from receiving the same key via Firestore transaction isolation.
   * 5. If insufficient keys are available:
   *    - Does NOT mark the order as `completed`.
   *    - Marks the order as `fulfillmentStatus: 'processing'`, `awaitingKeyStock: true`.
   *    - Notifies the bot owner (`OWNER_TELEGRAM_ID`) about the stock shortage.
   * 6. Sends the key(s) to the buyer in Telegram AFTER the Firestore transaction commits.
   *    If Telegram message sending fails, the key remains bound to the order in Firestore and is NEVER lost.
   */
  public static async fulfillOrderWithDigitalKey(
    orderInput: Order,
    bot?: Telegraf | null,
  ): Promise<KeyFulfillmentOutcome> {
    firestoreRepo.assertReadyForOrdersAndPayments();

    const candidateKeyIds = await this.getAvailableCandidateKeyIds(
      orderInput.productId,
      Math.max(orderInput.quantity * 8, 25),
    );

    type TxResult = {
      fulfilled: boolean;
      duplicate: boolean;
      awaitingStock: boolean;
      order: Order;
      deliveredKeys: DigitalKeyRecord[];
    };

    const txResult = await firestoreRepo.runTransaction<TxResult>(async (tx) => {
      // ALL READS FIRST
      const freshOrder =
        (await tx.get<Order>('orders', orderInput.orderId)) || orderInput;

      if (
        freshOrder.paymentStatus !== 'paid' &&
        freshOrder.paymentStatus !== 'processing' &&
        freshOrder.paymentStatus !== 'completed'
      ) {
        throw new Error(
          `Выдача цифрового ключа запрещена: заказ #${freshOrder.orderId} не оплачен (статус: ${freshOrder.paymentStatus}).`,
        );
      }

      // Idempotency guard: if order already has assigned keys, read them and return duplicate=true
      if (
        freshOrder.assignedKeyIds &&
        freshOrder.assignedKeyIds.length >= freshOrder.quantity
      ) {
        const existingKeys = await Promise.all(
          freshOrder.assignedKeyIds.map((kId) =>
            tx.get<DigitalKeyRecord>('digital_keys', kId),
          ),
        );
        return {
          fulfilled: true,
          duplicate: true,
          awaitingStock: false,
          order: freshOrder,
          deliveredKeys: existingKeys.filter(
            (k): k is DigitalKeyRecord => k !== null,
          ),
        };
      }

      if (freshOrder.fulfillmentStatus === 'completed') {
        return {
          fulfilled: true,
          duplicate: true,
          awaitingStock: false,
          order: freshOrder,
          deliveredKeys: [],
        };
      }

      const candidateDocs = await Promise.all(
        candidateKeyIds.map((kId) =>
          tx.get<DigitalKeyRecord>('digital_keys', kId),
        ),
      );

      // Filter strictly to keys that are still 'available' inside this atomic transaction
      const availableDocs = candidateDocs.filter(
        (doc): doc is DigitalKeyRecord =>
          doc !== null &&
          doc.productId === freshOrder.productId &&
          doc.status === 'available',
      );

      const now = new Date().toISOString();

      // If not enough available keys exist: do NOT mark order as completed!
      if (availableDocs.length < freshOrder.quantity) {
        const waitingOrder: Order = {
          ...freshOrder,
          fulfillmentStatus: 'processing',
          awaitingKeyStock: true,
          fulfillmentNote: `Ожидание пополнения склада ключей для товара «${freshOrder.productName}» (требуется: ${freshOrder.quantity}, доступно: ${availableDocs.length}).`,
          updatedAt: now,
        };
        tx.set<Order>('orders', waitingOrder.orderId, waitingOrder);

        const stockTxId = sanitizeDocId(
          `tx_key_empty_${freshOrder.orderId}`,
        );
        tx.set<StoreTransaction>('transactions', stockTxId, {
          transactionId: stockTxId,
          orderId: freshOrder.orderId,
          userId: freshOrder.userId,
          type: 'key_stock_empty',
          amount: freshOrder.quantity,
          currency: 'KEY',
          details: `Заказ #${freshOrder.orderId} ожидает пополнения склада ключей товара ${freshOrder.productId} (нужно=${freshOrder.quantity}, доступно=${availableDocs.length})`,
          createdAt: now,
        });

        return {
          fulfilled: false,
          duplicate: false,
          awaitingStock: true,
          order: waitingOrder,
          deliveredKeys: [],
        };
      }

      // Claim exactly `freshOrder.quantity` keys atomically: available -> reserved -> delivered
      const selectedKeys = availableDocs.slice(0, freshOrder.quantity);
      const deliveredRecords: DigitalKeyRecord[] = [];

      for (const keyDoc of selectedKeys) {
        const deliveredKey: DigitalKeyRecord = {
          ...keyDoc,
          status: 'delivered',
          reservedOrderId: freshOrder.orderId,
          reservedUserId: freshOrder.userId,
          reservedUserTelegramId: freshOrder.userTelegramId,
          reservedAt: now,
          deliveredOrderId: freshOrder.orderId,
          deliveredUserId: freshOrder.userId,
          deliveredUserTelegramId: freshOrder.userTelegramId,
          deliveredAt: now,
          updatedAt: now,
        };
        tx.set<DigitalKeyRecord>('digital_keys', deliveredKey.keyId, deliveredKey);
        deliveredRecords.push(deliveredKey);
      }

      const assignedKeyIds = deliveredRecords.map((k) => k.keyId);
      const deliveredKeyValues = deliveredRecords.map((k) => k.keyValue);
      const maskedList = deliveredRecords.map((k) => k.maskedPreview).join(', ');

      const completedOrder: Order = {
        ...freshOrder,
        paymentStatus: 'completed',
        fulfillmentStatus: 'completed',
        assignedKeyIds,
        deliveredKeyValues,
        awaitingKeyStock: false,
        fulfillmentNote: `Автоматическая выдача цифрового ключа (${deliveredRecords.length} шт.) выполнена.`,
        externalExecutionReference: `digital_key:${assignedKeyIds.join(',')}`,
        fulfillmentLastError: undefined,
        fulfillmentNextRetryAt: undefined,
        needsManualReconciliation: false,
        completedAt: freshOrder.completedAt || now,
        updatedAt: now,
      };

      tx.set<Order>('orders', completedOrder.orderId, completedOrder);

      const deliveryTxId = sanitizeDocId(`tx_key_deliv_${completedOrder.orderId}`);
      tx.set<StoreTransaction>('transactions', deliveryTxId, {
        transactionId: deliveryTxId,
        orderId: completedOrder.orderId,
        userId: completedOrder.userId,
        type: 'key_delivered',
        amount: deliveredRecords.length,
        currency: 'KEY',
        details: `Выдан(ы) цифровой(ые) ключ(и) [${maskedList}] по заказу #${completedOrder.orderId} пользователю ${completedOrder.userId}`,
        createdAt: now,
      });

      return {
        fulfilled: true,
        duplicate: false,
        awaitingStock: false,
        order: completedOrder,
        deliveredKeys: deliveredRecords,
      };
    });

    let ownerNotified = false;
    let buyerNotified = Boolean(txResult.order.buyerNotifiedAt);

    // If stock is empty, notify the bot owner (OWNER_TELEGRAM_ID) outside transaction
    if (txResult.awaitingStock && bot) {
      const { ownerTelegramId } = getEnvConfig();
      if (ownerTelegramId) {
        try {
          await bot.telegram.sendMessage(
            ownerTelegramId,
            [
              '⚠️ <b>НЕХВАТКА ЦИФРОВЫХ КЛЮЧЕЙ НА СКЛАДЕ</b>',
              '',
              `📦 <b>Заказ:</b> <code>${txResult.order.orderId}</code>`,
              `🛍 <b>Товар:</b> ${txResult.order.productName} (<code>${txResult.order.productId}</code>)`,
              `🔢 <b>Требуется ключей:</b> ${txResult.order.quantity}`,
              `👤 <b>Покупатель:</b> <code>${txResult.order.userTelegramId}</code>`,
              '',
              'Заказ переведён в статус ожидания выдачи (не помечен как выполненный). Пополните склад ключей в разделе «🔑 Генератор ключей».',
            ].join('\n'),
            { parse_mode: 'HTML' },
          );
          ownerNotified = true;
        } catch (err) {
          console.warn(
            '[DigitalKeyService] Не удалось отправить уведомление владельцу о нехватке ключей:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // If keys were delivered, send them to the buyer in Telegram (fault-tolerant: never loses key on sendMessage failure)
    if (txResult.fulfilled && bot && !txResult.order.buyerNotifiedAt) {
      const keysText = (txResult.order.deliveredKeyValues || [])
        .map((k, idx) => `🔑 Ключ #${idx + 1}: <code>${k}</code>`)
        .join('\n');

      try {
        await bot.telegram.sendMessage(
          txResult.order.userTelegramId,
          [
            '🎉 <b>Ваш заказ успешно оплачен и выполнен!</b>',
            '',
            `📦 <b>Номер заказа:</b> <code>${txResult.order.orderId}</code>`,
            `🛍 <b>Товар:</b> ${txResult.order.productName}`,
            '',
            keysText,
            '',
            '<i>Сохраните ваш ключ. Он также привязан к заказу в истории покупок вашего профиля.</i>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
        const now = new Date().toISOString();
        const updatedWithNotice = await firestoreRepo.updateDoc<Order>(
          'orders',
          txResult.order.orderId,
          {
            buyerNotifiedAt: now,
            updatedAt: now,
          },
        );
        if (updatedWithNotice) {
          txResult.order = updatedWithNotice;
        }
        buyerNotified = true;
      } catch (err) {
        // Key remains safely bound to the order in Firestore (`assignedKeyIds` & `deliveredKeyValues`)
        console.warn(
          `[DigitalKeyService] Ошибка отправки ключа в Telegram для заказа #${txResult.order.orderId} (ключ сохранён за заказом в БД):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      ...txResult,
      ownerNotified,
      buyerNotified,
    };
  }
}
