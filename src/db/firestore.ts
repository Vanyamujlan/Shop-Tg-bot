import {
  initializeApp as initializeAdminApp,
  getApps as getAdminApps,
  cert,
  App as AdminApp,
} from 'firebase-admin/app';
import {
  getFirestore as getAdminFirestore,
  Firestore as AdminFirestore,
  Query as AdminQuery,
  WhereFilterOp,
} from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { getEnvConfig } from '../config/env.ts';
import { INITIAL_TEST_PRODUCTS } from '../constants.ts';
import {
  StoreUser,
  Product,
  Order,
  PaymentRecord,
  StoreTransaction,
  AdminRecord,
  StoreSettings,
  OperationType,
} from '../types.ts';
import { handleFirestoreError, testConnection } from './firestoreErrorHandler.ts';

export type CollectionName =
  | 'users'
  | 'products'
  | 'orders'
  | 'payments'
  | 'transactions'
  | 'admins'
  | 'settings';

export interface QueryWhereFilter {
  field: string;
  op: WhereFilterOp;
  value: unknown;
}

export interface QueryOptions {
  where?: QueryWhereFilter[];
  orderBy?: {
    field: string;
    direction?: 'asc' | 'desc';
  };
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number;
}

export interface RepoTransaction {
  get<T>(collectionName: CollectionName, docId: string): Promise<T | null>;
  set<T extends object>(
    collectionName: CollectionName,
    docId: string,
    data: T,
  ): void;
}

interface LocalDatabaseState {
  users: Record<string, StoreUser>;
  products: Record<string, Product>;
  orders: Record<string, Order>;
  payments: Record<string, PaymentRecord>;
  transactions: Record<string, StoreTransaction>;
  admins: Record<string, AdminRecord>;
  settings: Record<string, StoreSettings>;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function sanitizeDocId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  if (!cleaned || !VALID_ID_REGEX.test(cleaned)) {
    throw new Error(`Некорректный идентификатор документа: ${rawId}`);
  }
  return cleaned;
}

function evaluateWhereFilter(
  docRecord: Record<string, unknown>,
  filter: QueryWhereFilter,
): boolean {
  const fieldVal = docRecord[filter.field];
  switch (filter.op) {
    case '==':
      return fieldVal === filter.value;
    case '!=':
      return fieldVal !== filter.value;
    case '<':
      return (fieldVal as number | string) < (filter.value as number | string);
    case '<=':
      return (fieldVal as number | string) <= (filter.value as number | string);
    case '>':
      return (fieldVal as number | string) > (filter.value as number | string);
    case '>=':
      return (fieldVal as number | string) >= (filter.value as number | string);
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(fieldVal);
    default:
      return false;
  }
}

function applyInMemorySortAndPagination<T>(
  docs: T[],
  options?: QueryOptions,
): T[] {
  let result = [...docs];
  if (options?.orderBy) {
    const { field, direction = 'asc' } = options.orderBy;
    const factor = direction === 'desc' ? -1 : 1;
    result.sort((a, b) => {
      const va = (a as Record<string, unknown>)[field];
      const vb = (b as Record<string, unknown>)[field];
      if (typeof va === 'number' && typeof vb === 'number') {
        return (va - vb) * factor;
      }
      return String(va ?? '').localeCompare(String(vb ?? '')) * factor;
    });
  }
  const offset = Math.max(0, options?.offset ?? 0);
  if (offset > 0) {
    result = result.slice(offset);
  }
  if (options?.limit !== undefined && options.limit > 0) {
    result = result.slice(0, options.limit);
  }
  return result;
}

export class FirestoreRepository {
  private adminApp: AdminApp | null = null;
  private adminDb: AdminFirestore | null = null;
  private adminReady = false;
  private adminStatusMessage = 'Не инициализирован';
  private localFilePath: string;
  private localState: LocalDatabaseState;
  private txMutex: Promise<void> = Promise.resolve();

  constructor() {
    const dataDir = path.resolve(process.cwd(), '.data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    this.localFilePath = path.join(dataDir, 'firestore-mirror.json');
    this.localState = this.loadLocalState();
  }

  private createEmptyState(): LocalDatabaseState {
    return {
      users: {},
      products: {},
      orders: {},
      payments: {},
      transactions: {},
      admins: {},
      settings: {},
    };
  }

  private loadLocalState(): LocalDatabaseState {
    try {
      if (fs.existsSync(this.localFilePath)) {
        const raw = fs.readFileSync(this.localFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<LocalDatabaseState>;
        return {
          users: parsed.users || {},
          products: parsed.products || {},
          orders: parsed.orders || {},
          payments: parsed.payments || {},
          transactions: parsed.transactions || {},
          admins: parsed.admins || {},
          settings: parsed.settings || {},
        };
      }
    } catch (error) {
      console.error('[Firestore] Ошибка чтения локального кэша:', error);
    }
    return this.createEmptyState();
  }

  /**
   * MEDIUM-SEC-01: Never persist plaintext user/payment records to local disk
   * when Cloud Firestore (adminReady) is active. In offline fallback mode, write with 0o600 permissions.
   */
  private saveLocalState(): void {
    if (this.adminReady) {
      return;
    }
    try {
      fs.writeFileSync(
        this.localFilePath,
        JSON.stringify(this.localState, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
    } catch (error) {
      console.error('[Firestore] Ошибка сохранения локального кэша:', error);
    }
  }

  private cleanupLocalMirrorFileIfCloudActive(): void {
    if (!this.adminReady) return;
    try {
      if (fs.existsSync(this.localFilePath)) {
        fs.unlinkSync(this.localFilePath);
      }
      this.localState = this.createEmptyState();
    } catch (error) {
      console.warn('[Firestore] Не удалось удалить локальный кэш-файл:', error);
    }
  }

  public async init(): Promise<void> {
    const config = getEnvConfig();
    const connCheck = await testConnection();

    if (
      config.firebaseProjectId &&
      config.firebaseClientEmail &&
      config.firebasePrivateKey
    ) {
      try {
        const existingApps = getAdminApps();
        this.adminApp =
          existingApps.length > 0
            ? existingApps[0]
            : initializeAdminApp({
                credential: cert({
                  projectId: config.firebaseProjectId,
                  clientEmail: config.firebaseClientEmail,
                  privateKey: config.firebasePrivateKey,
                }),
                projectId: config.firebaseProjectId,
              });

        this.adminDb =
          config.firebaseDatabaseId && config.firebaseDatabaseId !== '(default)'
            ? getAdminFirestore(this.adminApp, config.firebaseDatabaseId)
            : getAdminFirestore(this.adminApp);

        this.adminDb.settings({ ignoreUndefinedProperties: true });

        // Verify read/write/delete access with Admin SDK and clean up test doc
        const probeRef = this.adminDb.collection('_health_probe').doc('startup_test');
        await probeRef.set({ checkedAt: new Date().toISOString(), ok: true });
        const probeSnap = await probeRef.get();
        if (!probeSnap.exists) {
          throw new Error('Тестовый документ не найден после записи.');
        }
        await probeRef.delete();

        this.adminReady = true;
        this.cleanupLocalMirrorFileIfCloudActive();
        this.adminStatusMessage = `Firebase Admin SDK активен (проект: ${config.firebaseProjectId}, БД: ${config.firebaseDatabaseId}, Read/Write/Delete проверены)`;
        console.log(`[Firestore] ${this.adminStatusMessage}`);
      } catch (error) {
        this.adminReady = false;
        const msg = error instanceof Error ? error.message : String(error);
        this.adminStatusMessage = `Ошибка Firebase Admin SDK (${msg}). Используется резервное хранилище + проект ${config.firebaseProjectId}.`;
        console.warn(`[Firestore] ${this.adminStatusMessage}`);
      }
    } else {
      this.adminReady = false;
      this.adminStatusMessage = `${connCheck.details} (Для прямой серверной записи через Firebase Admin SDK укажите FIREBASE_CLIENT_EMAIL и FIREBASE_PRIVATE_KEY в Secrets; данные синхронизируются с локальным хранилищем сервера).`;
      console.log(`[Firestore] ${this.adminStatusMessage}`);
    }

    await this.seedInitialData();
  }

  public getStatus(): {
    adminSdkConnected: boolean;
    projectId: string;
    databaseId: string;
    statusMessage: string;
  } {
    const config = getEnvConfig();
    return {
      adminSdkConnected: this.adminReady,
      projectId: config.firebaseProjectId,
      databaseId: config.firebaseDatabaseId,
      statusMessage: this.adminStatusMessage,
    };
  }

  private async seedInitialData(): Promise<void> {
    const config = getEnvConfig();
    const now = new Date().toISOString();

    // 1. Seed or sync global settings
    const existingSettings = await this.getDoc<StoreSettings>('settings', 'global');
    await this.setDoc<StoreSettings>('settings', 'global', {
      key: 'global',
      storeName: existingSettings?.storeName || 'Telegram Digital Store',
      supportUsername: config.storeSupportUsername,
      maintenanceMode: existingSettings?.maintenanceMode ?? false,
      updatedAt: now,
    });

    // 2. Seed admins from ADMIN_IDS
    for (const adminTelegramId of config.adminIds) {
      const adminDocId = `tg_${adminTelegramId}`;
      const existingAdmin = await this.getDoc<AdminRecord>('admins', adminDocId);
      if (!existingAdmin) {
        await this.setDoc<AdminRecord>('admins', adminDocId, {
          adminId: adminDocId,
          telegramId: adminTelegramId,
          role: 'superadmin',
          addedAt: now,
        });
      }
    }

    // 3. Seed initial test products if catalog is empty
    const existingProducts = await this.queryDocs<Product>('products', { limit: 1 });
    if (existingProducts.length === 0) {
      for (const item of INITIAL_TEST_PRODUCTS) {
        const product: Product = {
          ...item,
          createdAt: now,
          updatedAt: now,
        };
        await this.setDoc<Product>('products', product.id, product);
      }
      console.log(
        `[Firestore] Загружено ${INITIAL_TEST_PRODUCTS.length} тестовых товаров в каталог.`,
      );
    }
  }

  /**
   * MEDIUM-01: Rethrows Firestore errors when adminReady is true instead of swallowing them.
   */
  private handleOrRethrow(
    error: unknown,
    operationType: OperationType,
    pathStr: string,
  ): never {
    if (
      error instanceof Error &&
      error.message.includes('Missing or insufficient permissions')
    ) {
      handleFirestoreError(error, operationType, pathStr);
    }
    console.error(`[Firestore] Ошибка операции ${operationType} на ${pathStr}:`, error);
    throw error instanceof Error ? error : new Error(String(error));
  }

  public async getDoc<T>(
    collectionName: CollectionName,
    docId: string,
  ): Promise<T | null> {
    const safeId = sanitizeDocId(docId);
    const pathStr = `${collectionName}/${safeId}`;

    if (this.adminReady && this.adminDb) {
      try {
        const snap = await this.adminDb.collection(collectionName).doc(safeId).get();
        if (!snap.exists) return null;
        return snap.data() as T;
      } catch (error) {
        this.handleOrRethrow(error, OperationType.GET, pathStr);
      }
    }

    const bucket = this.localState[collectionName] as Record<string, unknown>;
    return (bucket[safeId] as T) ?? null;
  }

  public async setDoc<T extends object>(
    collectionName: CollectionName,
    docId: string,
    data: T,
  ): Promise<void> {
    const safeId = sanitizeDocId(docId);
    const pathStr = `${collectionName}/${safeId}`;

    if (this.adminReady && this.adminDb) {
      try {
        await this.adminDb.collection(collectionName).doc(safeId).set(data);
        return;
      } catch (error) {
        this.handleOrRethrow(error, OperationType.WRITE, pathStr);
      }
    }

    const bucket = this.localState[collectionName] as Record<string, unknown>;
    bucket[safeId] = { ...data };
    this.saveLocalState();
  }

  public async updateDoc<T extends object>(
    collectionName: CollectionName,
    docId: string,
    partial: Partial<T>,
  ): Promise<T | null> {
    const safeId = sanitizeDocId(docId);

    return this.runTransaction<T | null>(async (tx) => {
      const existing = await tx.get<T>(collectionName, safeId);
      if (!existing) return null;

      const updated = {
        ...existing,
        ...partial,
      } as T;

      tx.set<T>(collectionName, safeId, updated);
      return updated;
    });
  }

  public async deleteDoc(
    collectionName: CollectionName,
    docId: string,
  ): Promise<boolean> {
    const safeId = sanitizeDocId(docId);
    const pathStr = `${collectionName}/${safeId}`;

    if (this.adminReady && this.adminDb) {
      try {
        await this.adminDb.collection(collectionName).doc(safeId).delete();
        return true;
      } catch (error) {
        this.handleOrRethrow(error, OperationType.DELETE, pathStr);
      }
    }

    const bucket = this.localState[collectionName] as Record<string, unknown>;
    const existed = Boolean(bucket[safeId]);
    delete bucket[safeId];
    this.saveLocalState();
    return existed;
  }

  /**
   * HIGH-02: Server-side indexed Firestore queries with filtering, sorting, and pagination.
   */
  public async queryDocs<T>(
    collectionName: CollectionName,
    options?: QueryOptions,
  ): Promise<T[]> {
    if (this.adminReady && this.adminDb) {
      try {
        let query: AdminQuery = this.adminDb.collection(collectionName);
        if (options?.where) {
          for (const filter of options.where) {
            query = query.where(filter.field, filter.op, filter.value);
          }
        }
        if (options?.orderBy) {
          query = query.orderBy(
            options.orderBy.field,
            options.orderBy.direction || 'asc',
          );
        }
        if (options?.offset && options.offset > 0) {
          query = query.offset(options.offset);
        }
        if (options?.limit && options.limit > 0) {
          query = query.limit(options.limit);
        }

        const snap = await query.get();
        return snap.docs.map((d) => d.data() as T);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // If a composite index is still building in Firestore, execute server-side single-field where filter
        // and apply sort/pagination on the filtered subset without scanning the entire collection
        if (
          options?.where &&
          options.where.length > 0 &&
          options?.orderBy &&
          (msg.includes('requires an index') || msg.includes('FAILED_PRECONDITION'))
        ) {
          try {
            const primaryFilter = options.where[0];
            const restFilters = options.where.slice(1);
            const fallbackQuery = this.adminDb
              .collection(collectionName)
              .where(primaryFilter.field, primaryFilter.op, primaryFilter.value);
            const snap = await fallbackQuery.get();
            let docs = snap.docs.map((d) => d.data() as T);
            if (restFilters.length > 0) {
              docs = docs.filter((item) =>
                restFilters.every((f) =>
                  evaluateWhereFilter(item as Record<string, unknown>, f),
                ),
              );
            }
            return applyInMemorySortAndPagination(docs, options);
          } catch (fallbackError) {
            this.handleOrRethrow(fallbackError, OperationType.LIST, collectionName);
          }
        }
        this.handleOrRethrow(error, OperationType.LIST, collectionName);
      }
    }

    const bucket = this.localState[collectionName] as Record<string, T>;
    let docs = Object.values(bucket);
    if (options?.where) {
      docs = docs.filter((item) =>
        options.where!.every((f) =>
          evaluateWhereFilter(item as Record<string, unknown>, f),
        ),
      );
    }
    return applyInMemorySortAndPagination(docs, options);
  }

  public async queryDocsPaginated<T>(
    collectionName: CollectionName,
    options?: QueryOptions,
  ): Promise<PaginatedResult<T>> {
    const limit = Math.max(1, options?.limit ?? 20);
    const offset = Math.max(0, options?.offset ?? 0);

    const fetched = await this.queryDocs<T>(collectionName, {
      ...options,
      offset,
      limit: limit + 1,
    });

    const hasMore = fetched.length > limit;
    const items = hasMore ? fetched.slice(0, limit) : fetched;

    return {
      items,
      hasMore,
      nextOffset: offset + items.length,
    };
  }

  public async listDocs<T>(
    collectionName: CollectionName,
    limit = 200,
  ): Promise<T[]> {
    return this.queryDocs<T>(collectionName, { limit });
  }

  /**
   * HIGH-01: Atomic Firestore Transaction runner.
   * Executes all reads and writes atomically in Cloud Firestore (or under an isolated
   * rollback-safe mutex lock when running in offline/test mode).
   */
  public async runTransaction<R>(
    updateFn: (tx: RepoTransaction) => Promise<R>,
  ): Promise<R> {
    if (this.adminReady && this.adminDb) {
      const db = this.adminDb;
      try {
        return await db.runTransaction(async (firestoreTx) => {
          const stagedWrites = new Map<string, unknown>();
          const repoTx: RepoTransaction = {
            get: async <T>(
              collectionName: CollectionName,
              docId: string,
            ): Promise<T | null> => {
              const safeId = sanitizeDocId(docId);
              const key = `${collectionName}/${safeId}`;
              if (stagedWrites.has(key)) {
                return stagedWrites.get(key) as T;
              }
              const ref = db.collection(collectionName).doc(safeId);
              const snap = await firestoreTx.get(ref);
              if (!snap.exists) return null;
              return snap.data() as T;
            },
            set: <T extends object>(
              collectionName: CollectionName,
              docId: string,
              data: T,
            ): void => {
              const safeId = sanitizeDocId(docId);
              const key = `${collectionName}/${safeId}`;
              stagedWrites.set(key, { ...data });
              const ref = db.collection(collectionName).doc(safeId);
              firestoreTx.set(ref, data);
            },
          };

          return await updateFn(repoTx);
        });
      } catch (error) {
        this.handleOrRethrow(error, OperationType.WRITE, 'transaction');
      }
    }

    // Serialized atomic transaction for offline/unit-test mode with full rollback on error
    let releaseLock!: () => void;
    const prevMutex = this.txMutex;
    this.txMutex = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await prevMutex;

    const snapshot = JSON.parse(
      JSON.stringify(this.localState),
    ) as LocalDatabaseState;

    try {
      const stagedWrites = new Map<
        string,
        { collectionName: CollectionName; docId: string; data: unknown }
      >();

      const repoTx: RepoTransaction = {
        get: async <T>(
          collectionName: CollectionName,
          docId: string,
        ): Promise<T | null> => {
          const safeId = sanitizeDocId(docId);
          const key = `${collectionName}/${safeId}`;
          if (stagedWrites.has(key)) {
            return stagedWrites.get(key)!.data as T;
          }
          const bucket = this.localState[collectionName] as Record<string, unknown>;
          const val = bucket[safeId];
          return val ? (JSON.parse(JSON.stringify(val)) as T) : null;
        },
        set: <T extends object>(
          collectionName: CollectionName,
          docId: string,
          data: T,
        ): void => {
          const safeId = sanitizeDocId(docId);
          const key = `${collectionName}/${safeId}`;
          stagedWrites.set(key, {
            collectionName,
            docId: safeId,
            data: JSON.parse(JSON.stringify(data)),
          });
        },
      };

      const result = await updateFn(repoTx);

      for (const write of stagedWrites.values()) {
        const bucket = this.localState[write.collectionName] as Record<
          string,
          unknown
        >;
        bucket[write.docId] = write.data;
      }
      this.saveLocalState();
      return result;
    } catch (error) {
      this.localState = snapshot;
      throw error;
    } finally {
      releaseLock();
    }
  }
}

export const firestoreRepo = new FirestoreRepository();
