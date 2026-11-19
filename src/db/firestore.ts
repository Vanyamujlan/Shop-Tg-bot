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
  BalanceTopUpRecord,
  DigitalKeyRecord,
  PaymentLockRecord,
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

export type StoreCollectionName =
  | CollectionName
  | 'balance_topups'
  | 'digital_keys'
  | 'payment_locks';

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
  /**
   * Cursor pagination: value of the orderBy field (or [orderByValue, docId]) to start after.
   */
  startAfter?: unknown;
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number;
  nextCursor: unknown | null;
}

export interface RepoTransaction {
  get<T>(collectionName: StoreCollectionName, docId: string): Promise<T | null>;
  set<T extends object>(
    collectionName: StoreCollectionName,
    docId: string,
    data: T,
  ): void;
}

interface LocalDatabaseState {
  users: Record<string, StoreUser>;
  products: Record<string, Product>;
  orders: Record<string, Order>;
  payments: Record<string, PaymentRecord>;
  balance_topups: Record<string, BalanceTopUpRecord>;
  digital_keys: Record<string, DigitalKeyRecord>;
  payment_locks: Record<string, PaymentLockRecord>;
  transactions: Record<string, StoreTransaction>;
  admins: Record<string, AdminRecord>;
  settings: Record<string, StoreSettings>;
}

export interface SimulatedFailureConfig {
  unavailable?: boolean;
  readError?: string | null;
  writeError?: string | null;
  transactionError?: string | null;
}

export class StorageUnavailableError extends Error {
  public readonly code = 'STORAGE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export class ProductionGuardError extends Error {
  public readonly code = 'PRODUCTION_GUARD_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'ProductionGuardError';
  }
}

/**
 * Hard safety barrier that forbids running audit/seed/test scripts against Production Firestore.
 * Requires FIRESTORE_EMULATOR_HOST on 127.0.0.1:8080 or localhost:8080, projectId === "demo-stars-shop-audit",
 * and zero real credentials in the inspected environment.
 */
export function assertEmulatorOnlyEnvironment(
  targetProjectId?: string,
  envObj: NodeJS.ProcessEnv = process.env,
): { emulatorHost: string; projectId: string } {
  const resolvedProjectId =
    targetProjectId !== undefined
      ? targetProjectId
      : envObj.GCLOUD_PROJECT || envObj.FIREBASE_PROJECT_ID || 'demo-stars-shop-audit';

  const emulatorHost = (envObj.FIRESTORE_EMULATOR_HOST || '').trim();
  if (!emulatorHost) {
    throw new ProductionGuardError(
      'CRITICAL SAFETY LOCK: Переменная FIRESTORE_EMULATOR_HOST не задана. Запуск аудита/тестов вне локального Firebase Emulator категорически запрещён.',
    );
  }

  if (!/^(127\.0\.0\.1|localhost):8080$/i.test(emulatorHost)) {
    throw new ProductionGuardError(
      `CRITICAL SAFETY LOCK: Недопустимый адрес эмулятора "${emulatorHost}". Разрешены только локальные адреса 127.0.0.1:8080 или localhost:8080.`,
    );
  }

  const projectId = (resolvedProjectId || '').trim();
  if (projectId === 'tg-1-675b4' || projectId !== 'demo-stars-shop-audit') {
    throw new ProductionGuardError(
      `CRITICAL SAFETY LOCK: Недопустимый projectId "${projectId}". Для независимого аудита разрешён исключительно изолированный проект "demo-stars-shop-audit".`,
    );
  }

  if (
    envObj.FIREBASE_PRIVATE_KEY ||
    envObj.FIREBASE_CLIENT_EMAIL ||
    envObj.GOOGLE_APPLICATION_CREDENTIALS
  ) {
    throw new ProductionGuardError(
      'CRITICAL SAFETY LOCK: Обнаружены переменные реальных сервисных ключей Firebase (FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL / GOOGLE_APPLICATION_CREDENTIALS). Использование реальных учётных данных запрещено.',
    );
  }

  return { emulatorHost, projectId };
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function sanitizeDocId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  if (!cleaned || !VALID_ID_REGEX.test(cleaned)) {
    throw new Error(`Некорректный идентификатор документа: ${rawId}`);
  }
  return cleaned;
}

function getDocumentPrimaryKey(doc: Record<string, unknown>): string {
  return String(
    doc.orderId ??
      doc.lockId ??
      doc.keyId ??
      doc.id ??
      doc.userId ??
      doc.paymentId ??
      doc.transactionId ??
      doc.adminId ??
      doc.key ??
      '',
  );
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

function applyInMemorySortAndCursorPagination<T>(
  docs: T[],
  options?: QueryOptions,
): T[] {
  let result = [...docs];
  const orderField = options?.orderBy?.field;
  const direction = options?.orderBy?.direction || 'asc';
  const factor = direction === 'desc' ? -1 : 1;

  if (orderField) {
    result.sort((a, b) => {
      const recA = a as Record<string, unknown>;
      const recB = b as Record<string, unknown>;
      const va = recA[orderField];
      const vb = recB[orderField];
      if (typeof va === 'number' && typeof vb === 'number') {
        const diff = (va - vb) * factor;
        if (diff !== 0) return diff;
      } else {
        const cmp = String(va ?? '').localeCompare(String(vb ?? '')) * factor;
        if (cmp !== 0) return cmp;
      }
      return getDocumentPrimaryKey(recA).localeCompare(getDocumentPrimaryKey(recB)) * factor;
    });
  }

  // Cursor pagination (startAfter) with deterministic tie-breaker on document primary key
  if (options?.startAfter !== undefined && options.startAfter !== null && orderField) {
    const cursorVal = options.startAfter;
    const cursorIndex = result.findIndex((item) => {
      const rec = item as Record<string, unknown>;
      const pk = getDocumentPrimaryKey(rec);
      const fieldVal = rec[orderField];
      if (typeof cursorVal === 'object' && cursorVal !== null && 'id' in cursorVal && 'value' in cursorVal) {
        const typedCursor = cursorVal as { value: unknown; id: string };
        return fieldVal === typedCursor.value && pk === typedCursor.id;
      }
      return fieldVal === cursorVal || pk === cursorVal;
    });

    if (cursorIndex >= 0) {
      result = result.slice(cursorIndex + 1);
    } else {
      // Value comparison fallback if exact item was deleted
      const compareVal =
        typeof cursorVal === 'object' && cursorVal !== null && 'value' in cursorVal
          ? (cursorVal as { value: unknown }).value
          : cursorVal;
      const compareId =
        typeof cursorVal === 'object' && cursorVal !== null && 'id' in cursorVal
          ? String((cursorVal as { id: unknown }).id)
          : null;
      result = result.filter((item) => {
        const rec = item as Record<string, unknown>;
        const fieldVal = rec[orderField];
        if (typeof fieldVal === 'number' && typeof compareVal === 'number') {
          if (fieldVal !== compareVal) {
            return direction === 'desc' ? fieldVal < compareVal : fieldVal > compareVal;
          }
        } else {
          const cmp = String(fieldVal ?? '').localeCompare(String(compareVal ?? ''));
          if (cmp !== 0) {
            return direction === 'desc' ? cmp < 0 : cmp > 0;
          }
        }
        if (compareId) {
          const pkCmp = getDocumentPrimaryKey(rec).localeCompare(compareId);
          return direction === 'desc' ? pkCmp < 0 : pkCmp > 0;
        }
        return false;
      });
    }
  } else if (options?.offset && options.offset > 0) {
    result = result.slice(options.offset);
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
  private emulatorConnected = false;
  private degradedMode = false;
  private isolatedTestMode = false;
  private simulatedFailures: SimulatedFailureConfig = {};
  private adminStatusMessage = 'Не инициализирован';
  private dataDir: string;
  private localFilePath: string;
  private localState: LocalDatabaseState;
  private backupPreservedThisSession = false;
  private txMutex: Promise<void> = Promise.resolve();

  constructor() {
    this.dataDir = path.resolve(process.cwd(), '.data');
    this.localFilePath = path.join(this.dataDir, 'firestore-mirror.json');
    this.ensureSecureDataDirPermissions();
    this.localState = this.createEmptyState();
  }

  private ensureSecureDataDirPermissions(): void {
    try {
      if (fs.existsSync(this.dataDir)) {
        fs.chmodSync(this.dataDir, 0o700);
      }
      if (fs.existsSync(this.localFilePath)) {
        fs.chmodSync(this.localFilePath, 0o600);
      }
    } catch {
      // Ignore chmod errors on non-POSIX filesystems
    }
  }

  private createEmptyState(): LocalDatabaseState {
    return {
      users: {},
      products: {},
      orders: {},
      payments: {},
      balance_topups: {},
      digital_keys: {},
      payment_locks: {},
      transactions: {},
      admins: {},
      settings: {},
    };
  }

  /**
   * Enables strictly isolated in-memory test mode:
   * - Never touches production Cloud Firestore
   * - Never reads or writes .data/firestore-mirror.json
   */
  public enableIsolatedTestMode(seedDefaults = true): void {
    this.isolatedTestMode = true;
    this.adminReady = false;
    this.degradedMode = false;
    this.simulatedFailures = {};
    this.localState = this.createEmptyState();
    this.adminStatusMessage = 'Изолированный in-memory режим тестирования (без доступа к production Firestore)';

    if (seedDefaults) {
      const now = new Date().toISOString();
      const config = getEnvConfig();
      this.localState.settings.global = {
        key: 'global',
        storeName: config.storeName || 'QuizyStars (Test)',
        supportUsername: config.storeSupportUsername || 'quizystars_support',
        maintenanceMode: false,
        updatedAt: now,
      };
      for (const adminTelegramId of config.adminIds) {
        const adminDocId = `tg_${adminTelegramId}`;
        this.localState.admins[adminDocId] = {
          adminId: adminDocId,
          telegramId: adminTelegramId,
          role: 'superadmin',
          addedAt: now,
        };
      }
      for (const item of INITIAL_TEST_PRODUCTS) {
        this.localState.products[item.id] = {
          ...item,
          createdAt: now,
          updatedAt: now,
        };
      }
    }
  }

  public disableIsolatedTestMode(): void {
    this.isolatedTestMode = false;
    this.simulatedFailures = {};
  }

  /**
   * Connects FirestoreRepository strictly to the local Firebase Firestore Emulator.
   * Enforces ProductionGuard before initializing.
   */
  public async initWithEmulator(
    projectId = 'demo-stars-shop-audit',
  ): Promise<void> {
    const verified = assertEmulatorOnlyEnvironment(projectId);
    this.isolatedTestMode = false;
    this.degradedMode = false;
    this.simulatedFailures = {};

    const appName = `emulator-audit-${verified.projectId}`;
    const existing = getAdminApps().find((a) => a.name === appName);
    this.adminApp =
      existing ||
      initializeAdminApp(
        {
          projectId: verified.projectId,
        },
        appName,
      );

    this.adminDb = getAdminFirestore(this.adminApp);
    try {
      this.adminDb.settings({ ignoreUndefinedProperties: true });
    } catch {
      // settings() may already have been called on this instance
    }

    const probeRef = this.adminDb.collection('_emulator_probe').doc('ping');
    await probeRef.set({
      emulatorHost: verified.emulatorHost,
      projectId: verified.projectId,
      checkedAt: new Date().toISOString(),
    });
    const snap = await probeRef.get();
    if (!snap.exists) {
      throw new Error('Не удалось подтвердить запись в локальный Firestore Emulator.');
    }
    await probeRef.delete();

    this.adminReady = true;
    this.emulatorConnected = true;
    this.adminStatusMessage = `Подключён к локальному Firebase Firestore Emulator (${verified.emulatorHost}, projectId: ${verified.projectId})`;
  }

  public isEmulatorMode(): boolean {
    return this.emulatorConnected;
  }

  public getAdminDbInstance(): AdminFirestore | null {
    return this.adminDb;
  }

  public setSimulatedFailure(config: SimulatedFailureConfig): void {
    this.simulatedFailures = { ...config };
  }

  public isLocalFallbackAllowed(): boolean {
    if (this.isolatedTestMode) return true;
    const config = getEnvConfig();
    return config.allowLocalFallback;
  }

  public isProductionStorageHealthy(): boolean {
    if (this.simulatedFailures.unavailable) {
      return false;
    }
    if (this.isolatedTestMode) {
      return !this.degradedMode;
    }
    if (this.adminReady && this.adminDb && !this.degradedMode) {
      return true;
    }
    return this.isLocalFallbackAllowed() && !this.degradedMode;
  }

  /**
   * Fail-safe check before creating new orders or processing payments.
   * Prevents silent fallback to local file in production if Cloud Firestore is down.
   */
  public assertReadyForOrdersAndPayments(): void {
    if (this.simulatedFailures.unavailable) {
      throw new StorageUnavailableError(
        'Основное хранилище базы данных временно недоступно. Оформление заказов и обработка платежей приостановлены.',
      );
    }
    if (this.isolatedTestMode) {
      if (this.degradedMode) {
        throw new StorageUnavailableError(
          'Хранилище переведено в аварийный режим недоступности.',
        );
      }
      return;
    }
    if (!this.adminReady || !this.adminDb || this.degradedMode) {
      if (!this.isLocalFallbackAllowed()) {
        throw new StorageUnavailableError(
          'Production-хранилище Cloud Firestore недоступно. Оформление заказов и приём платежей временно заблокированы для сохранности данных.',
        );
      }
    }
  }

  private checkSimulatedFailures(op: OperationType, pathStr: string): void {
    if (this.simulatedFailures.unavailable) {
      throw new StorageUnavailableError(
        `Simulated storage unavailability on ${op} (${pathStr})`,
      );
    }
    if (
      (op === OperationType.GET || op === OperationType.LIST) &&
      this.simulatedFailures.readError
    ) {
      throw new Error(this.simulatedFailures.readError);
    }
    if (
      (op === OperationType.WRITE ||
        op === OperationType.CREATE ||
        op === OperationType.UPDATE ||
        op === OperationType.DELETE) &&
      this.simulatedFailures.writeError
    ) {
      throw new Error(this.simulatedFailures.writeError);
    }
  }

  private assertStorageAvailable(op: OperationType, pathStr: string): void {
    this.checkSimulatedFailures(op, pathStr);
    if (this.isolatedTestMode) {
      return;
    }
    if (this.adminReady && this.adminDb && !this.degradedMode) {
      return;
    }
    if (!this.isLocalFallbackAllowed()) {
      throw new StorageUnavailableError(
        `Операция ${op} (${pathStr}) отклонена: Cloud Firestore не подключён в production-режиме (локальное хранилище отключено).`,
      );
    }
  }

  private loadLocalState(): LocalDatabaseState {
    if (this.isolatedTestMode || !this.isLocalFallbackAllowed()) {
      return this.createEmptyState();
    }
    try {
      if (fs.existsSync(this.localFilePath)) {
        fs.chmodSync(this.localFilePath, 0o600);
        const raw = fs.readFileSync(this.localFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<LocalDatabaseState>;
        return {
          users: parsed.users || {},
          products: parsed.products || {},
          orders: parsed.orders || {},
          payments: parsed.payments || {},
          balance_topups: parsed.balance_topups || {},
          digital_keys: parsed.digital_keys || {},
          payment_locks: parsed.payment_locks || {},
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
   * Saves local fallback state ONLY when explicitly in local fallback mode (never in production or isolated test mode).
   * Never deletes or clobbers an existing backup without preserving a .bak copy first.
   */
  private saveLocalState(): void {
    if (this.adminReady || this.isolatedTestMode || !this.isLocalFallbackAllowed()) {
      return;
    }
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      }
      fs.chmodSync(this.dataDir, 0o700);

      if (fs.existsSync(this.localFilePath) && !this.backupPreservedThisSession) {
        const backupPath = `${this.localFilePath}.bak`;
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(this.localFilePath, backupPath);
          fs.chmodSync(backupPath, 0o600);
        }
        this.backupPreservedThisSession = true;
      }

      fs.writeFileSync(
        this.localFilePath,
        JSON.stringify(this.localState, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
      fs.chmodSync(this.localFilePath, 0o600);
    } catch (error) {
      console.error('[Firestore] Ошибка сохранения локального кэша:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  public async init(): Promise<void> {
    const config = getEnvConfig();
    if (config.nodeEnv === 'test' || this.isolatedTestMode) {
      this.enableIsolatedTestMode(true);
      return;
    }

    this.ensureSecureDataDirPermissions();
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
        this.degradedMode = false;
        this.adminStatusMessage = `Firebase Admin SDK активен (проект: ${config.firebaseProjectId}, БД: ${config.firebaseDatabaseId}, Read/Write/Delete проверены)`;
        console.log(`[Firestore] ${this.adminStatusMessage}`);
      } catch (error) {
        this.adminReady = false;
        const msg = error instanceof Error ? error.message : String(error);
        if (!this.isLocalFallbackAllowed()) {
          this.degradedMode = true;
          this.adminStatusMessage = `КРИТИЧЕСКАЯ ОШИБКА Firebase Admin SDK (${msg}). Магазин переведён в защитный режим недоступности БД (production fail-safe).`;
          console.error(`[Firestore] ❌ ${this.adminStatusMessage}`);
          return;
        }
        this.localState = this.loadLocalState();
        this.adminStatusMessage = `Ошибка Firebase Admin SDK (${msg}). Включён dev/test локальный режим (${config.firebaseProjectId}).`;
        console.warn(`[Firestore] ${this.adminStatusMessage}`);
      }
    } else {
      this.adminReady = false;
      if (!this.isLocalFallbackAllowed()) {
        this.degradedMode = true;
        this.adminStatusMessage = `Отсутствуют серверные ключи Firebase Admin SDK в production-режиме (${connCheck.details}). Оформление заказов и платежи заблокированы до настройки ключей.`;
        console.error(`[Firestore] ❌ ${this.adminStatusMessage}`);
        return;
      }
      this.localState = this.loadLocalState();
      this.adminStatusMessage = `${connCheck.details} (Активирован локальный dev/test режим).`;
      console.log(`[Firestore] ${this.adminStatusMessage}`);
    }

    await this.seedInitialData();
  }

  public getStatus(): {
    adminSdkConnected: boolean;
    degradedMode: boolean;
    localFallbackAllowed: boolean;
    projectId: string;
    databaseId: string;
    statusMessage: string;
  } {
    const config = getEnvConfig();
    return {
      adminSdkConnected: this.adminReady,
      degradedMode: this.degradedMode || Boolean(this.simulatedFailures.unavailable),
      localFallbackAllowed: this.isLocalFallbackAllowed(),
      projectId: config.firebaseProjectId,
      databaseId: config.firebaseDatabaseId,
      statusMessage: this.adminStatusMessage,
    };
  }

  private async seedInitialData(): Promise<void> {
    if (!this.isProductionStorageHealthy()) {
      return;
    }

    const config = getEnvConfig();
    const now = new Date().toISOString();

    // 1. Seed or sync global settings
    const existingSettings = await this.getDoc<StoreSettings>('settings', 'global');
    const resolvedStoreName =
      !existingSettings?.storeName ||
      existingSettings.storeName === 'Telegram Digital Store' ||
      existingSettings.storeName === 'Stars Shop'
        ? config.storeName || 'QuizyStars'
        : existingSettings.storeName;
    await this.setDoc<StoreSettings>('settings', 'global', {
      key: 'global',
      storeName: resolvedStoreName,
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
        `[Firestore] Загружено ${INITIAL_TEST_PRODUCTS.length} стартовых товаров в каталог.`,
      );
    }
  }

  /**
   * Logs and rethrows all Firestore errors without swallowing them.
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
    collectionName: StoreCollectionName,
    docId: string,
  ): Promise<T | null> {
    const safeId = sanitizeDocId(docId);
    const pathStr = `${collectionName}/${safeId}`;
    this.assertStorageAvailable(OperationType.GET, pathStr);

    if (!this.isolatedTestMode && this.adminReady && this.adminDb) {
      try {
        const snap = await this.adminDb.collection(collectionName).doc(safeId).get();
        if (!snap.exists) return null;
        return snap.data() as T;
      } catch (error) {
        this.handleOrRethrow(error, OperationType.GET, pathStr);
      }
    }

    const bucket = this.localState[collectionName] as Record<string, unknown>;
    const found = bucket[safeId];
    return found ? (JSON.parse(JSON.stringify(found)) as T) : null;
  }

  public async setDoc<T extends object>(
    collectionName: StoreCollectionName,
    docId: string,
    data: T,
  ): Promise<void> {
    const safeId = sanitizeDocId(docId);
    const pathStr = `${collectionName}/${safeId}`;
    this.assertStorageAvailable(OperationType.WRITE, pathStr);

    if (!this.isolatedTestMode && this.adminReady && this.adminDb) {
      try {
        await this.adminDb.collection(collectionName).doc(safeId).set(data);
        return;
      } catch (error) {
        this.handleOrRethrow(error, OperationType.WRITE, pathStr);
      }
    }

    const bucket = this.localState[collectionName] as Record<string, unknown>;
    bucket[safeId] = JSON.parse(JSON.stringify(data));
    this.saveLocalState();
  }

  public async updateDoc<T extends object>(
    collectionName: StoreCollectionName,
    docId: string,
    partial: Partial<T>,
  ): Promise<T | null> {
    const safeId = sanitizeDocId(docId);
    const pathStr = `${collectionName}/${safeId}`;
    this.assertStorageAvailable(OperationType.UPDATE, pathStr);

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
    collectionName: StoreCollectionName,
    docId: string,
  ): Promise<boolean> {
    const safeId = sanitizeDocId(docId);
    const pathStr = `${collectionName}/${safeId}`;
    this.assertStorageAvailable(OperationType.DELETE, pathStr);

    if (!this.isolatedTestMode && this.adminReady && this.adminDb) {
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
   * Server-side indexed Firestore queries with where, orderBy, startAfter cursor, and limit.
   */
  public async queryDocs<T>(
    collectionName: StoreCollectionName,
    options?: QueryOptions,
  ): Promise<T[]> {
    this.assertStorageAvailable(OperationType.LIST, collectionName);

    if (!this.isolatedTestMode && this.adminReady && this.adminDb) {
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
        if (options?.startAfter !== undefined && options.startAfter !== null) {
          let appliedSnapshotCursor = false;
          if (
            typeof options.startAfter === 'object' &&
            options.startAfter !== null &&
            'id' in options.startAfter &&
            typeof (options.startAfter as { id: unknown }).id === 'string'
          ) {
            const cursorId = sanitizeDocId((options.startAfter as { id: string }).id);
            const cursorSnap = await this.adminDb.collection(collectionName).doc(cursorId).get();
            if (cursorSnap.exists) {
              query = query.startAfter(cursorSnap);
              appliedSnapshotCursor = true;
            }
          } else if (
            typeof options.startAfter === 'string' &&
            VALID_ID_REGEX.test(options.startAfter)
          ) {
            const cursorSnap = await this.adminDb
              .collection(collectionName)
              .doc(sanitizeDocId(options.startAfter))
              .get();
            if (cursorSnap.exists) {
              query = query.startAfter(cursorSnap);
              appliedSnapshotCursor = true;
            }
          }

          if (!appliedSnapshotCursor) {
            const cursorVal =
              typeof options.startAfter === 'object' &&
              options.startAfter !== null &&
              'value' in options.startAfter
                ? (options.startAfter as { value: unknown }).value
                : options.startAfter;
            query = query.startAfter(cursorVal);
          }
        } else if (options?.offset && options.offset > 0) {
          query = query.offset(options.offset);
        }
        if (options?.limit && options.limit > 0) {
          query = query.limit(options.limit);
        }

        const snap = await query.get();
        return snap.docs.map((d) => d.data() as T);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
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
            return applyInMemorySortAndCursorPagination(docs, options);
          } catch (fallbackError) {
            this.handleOrRethrow(fallbackError, OperationType.LIST, collectionName);
          }
        }
        this.handleOrRethrow(error, OperationType.LIST, collectionName);
      }
    }

    const bucket = this.localState[collectionName] as Record<string, T>;
    let docs = Object.values(bucket).map(
      (item) => JSON.parse(JSON.stringify(item)) as T,
    );
    if (options?.where) {
      docs = docs.filter((item) =>
        options.where!.every((f) =>
          evaluateWhereFilter(item as Record<string, unknown>, f),
        ),
      );
    }
    return applyInMemorySortAndCursorPagination(docs, options);
  }

  /**
   * Cursor-based pagination (`startAfter`) with backward-compatible `nextOffset`.
   */
  public async queryDocsPaginated<T>(
    collectionName: StoreCollectionName,
    options?: QueryOptions,
  ): Promise<PaginatedResult<T>> {
    const limit = Math.max(1, options?.limit ?? 20);
    const offset = Math.max(0, options?.offset ?? 0);

    const fetched = await this.queryDocs<T>(collectionName, {
      ...options,
      limit: limit + 1,
    });

    const hasMore = fetched.length > limit;
    const items = hasMore ? fetched.slice(0, limit) : fetched;

    let nextCursor: unknown | null = null;
    if (hasMore && items.length > 0 && options?.orderBy?.field) {
      const lastItem = items[items.length - 1] as Record<string, unknown>;
      nextCursor = {
        value: lastItem[options.orderBy.field],
        id: getDocumentPrimaryKey(lastItem),
      };
    }

    return {
      items,
      hasMore,
      nextOffset: offset + items.length,
      nextCursor,
    };
  }

  public async listDocs<T>(
    collectionName: StoreCollectionName,
    limit = 200,
  ): Promise<T[]> {
    return this.queryDocs<T>(collectionName, { limit });
  }

  /**
   * Atomic Firestore Transaction runner.
   * Strictly enforces that all reads (`tx.get`) happen BEFORE any writes (`tx.set`).
   */
  public async runTransaction<R>(
    updateFn: (tx: RepoTransaction) => Promise<R>,
  ): Promise<R> {
    this.assertStorageAvailable(OperationType.WRITE, 'transaction');
    if (this.simulatedFailures.transactionError) {
      throw new Error(this.simulatedFailures.transactionError);
    }

    if (!this.isolatedTestMode && this.adminReady && this.adminDb) {
      const db = this.adminDb;
      try {
        return await db.runTransaction(async (firestoreTx) => {
          let hasWritten = false;
          const repoTx: RepoTransaction = {
            get: async <T>(
              collectionName: StoreCollectionName,
              docId: string,
            ): Promise<T | null> => {
              if (hasWritten) {
                throw new Error(
                  'Нарушение контракта транзакции Firestore: все операции чтения (tx.get) должны выполняться до операций записи (tx.set).',
                );
              }
              this.checkSimulatedFailures(
                OperationType.GET,
                `${collectionName}/${docId}`,
              );
              const safeId = sanitizeDocId(docId);
              const ref = db.collection(collectionName).doc(safeId);
              const snap = await firestoreTx.get(ref);
              if (!snap.exists) return null;
              return snap.data() as T;
            },
            set: <T extends object>(
              collectionName: StoreCollectionName,
              docId: string,
              data: T,
            ): void => {
              this.checkSimulatedFailures(
                OperationType.WRITE,
                `${collectionName}/${docId}`,
              );
              hasWritten = true;
              const safeId = sanitizeDocId(docId);
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

    // Serialized atomic transaction for isolated test / local fallback mode with full rollback on error
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
      let hasWritten = false;
      const stagedWrites = new Map<
        string,
        { collectionName: StoreCollectionName; docId: string; data: unknown }
      >();

      const repoTx: RepoTransaction = {
        get: async <T>(
          collectionName: StoreCollectionName,
          docId: string,
        ): Promise<T | null> => {
          if (hasWritten) {
            throw new Error(
              'Нарушение контракта транзакции Firestore: все операции чтения (tx.get) должны выполняться до операций записи (tx.set).',
            );
          }
          this.checkSimulatedFailures(
            OperationType.GET,
            `${collectionName}/${docId}`,
          );
          const safeId = sanitizeDocId(docId);
          const bucket = this.localState[collectionName] as Record<string, unknown>;
          const val = bucket[safeId];
          return val ? (JSON.parse(JSON.stringify(val)) as T) : null;
        },
        set: <T extends object>(
          collectionName: StoreCollectionName,
          docId: string,
          data: T,
        ): void => {
          this.checkSimulatedFailures(
            OperationType.WRITE,
            `${collectionName}/${docId}`,
          );
          hasWritten = true;
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
