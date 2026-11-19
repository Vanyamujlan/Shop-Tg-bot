import { INITIAL_TEST_PRODUCTS } from '../constants.ts';
import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  FulfillmentType,
  KeyGeneratorAlgorithm,
  Product,
  ProductCategory,
} from '../types.ts';
import { assertValidUsdCents } from './Money.ts';

export class ProductService {
  public static readonly BUYER_STARS_PRODUCT_ID = 'stars_custom';
  public static readonly BUYER_PREMIUM_IDS = new Set([
    'premium_3m',
    'premium_6m',
    'premium_12m',
  ]);
  public static readonly ALLOWED_PREMIUM_DURATIONS = new Set<number>([3, 6, 12]);
  public static readonly REQUIRED_PREMIUM_TARIFFS = [
    { id: 'premium_3m', durationMonths: 3 as const, priceUsdCents: 1390 },
    { id: 'premium_6m', durationMonths: 6 as const, priceUsdCents: 1990 },
    { id: 'premium_12m', durationMonths: 12 as const, priceUsdCents: 3490 },
  ] as const;

  public static assertValidPremiumDuration(duration: unknown): 3 | 6 | 12 {
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      !Number.isInteger(duration) ||
      !this.ALLOWED_PREMIUM_DURATIONS.has(duration)
    ) {
      throw new Error(
        'Недопустимый срок подписки Telegram Premium: обязательно укажите 3, 6 или 12 (допустимы только 3, 6 или 12 месяцев).',
      );
    }
    return duration as 3 | 6 | 12;
  }

  public static resolvePremiumDurationMonths(product: Product): 3 | 6 | 12 {
    const tariffSpec = this.REQUIRED_PREMIUM_TARIFFS.find(
      (t) => t.id === product.id,
    );

    if (product.durationMonths !== undefined) {
      const validDuration = this.assertValidPremiumDuration(product.durationMonths);
      if (tariffSpec && validDuration !== tariffSpec.durationMonths) {
        throw new Error(
          `Некорректный срок подписки у тарифа "${product.id}": ожидалось ${tariffSpec.durationMonths} мес., получено ${validDuration}.`,
        );
      }
      return validDuration;
    }

    if (tariffSpec) {
      return tariffSpec.durationMonths;
    }

    throw new Error(
      `У товара Telegram Premium "${product.id}" не указан обязательный срок подписки (3, 6 или 12 месяцев).`,
    );
  }

  public static isValidBuyerPremiumProduct(
    product: Product | null | undefined,
  ): product is Product {
    if (!product || !product.isActive || product.category !== 'premium') {
      return false;
    }

    const tariffSpec = this.REQUIRED_PREMIUM_TARIFFS.find(
      (t) => t.id === product.id,
    );
    if (!tariffSpec) return false;

    try {
      const resolvedDuration = this.resolvePremiumDurationMonths(product);
      if (resolvedDuration !== tariffSpec.durationMonths) {
        return false;
      }
    } catch {
      return false;
    }

    const cents = product.priceUsdCents ?? product.price;
    if (
      typeof cents !== 'number' ||
      !Number.isSafeInteger(cents) ||
      cents !== tariffSpec.priceUsdCents
    ) {
      return false;
    }

    if (
      product.priceUsdCents !== undefined &&
      product.priceUsdCents !== tariffSpec.priceUsdCents
    ) {
      return false;
    }

    return true;
  }

  public static resolveBuyerPremiumCatalog(products: Product[]): {
    allAvailable: boolean;
    availableProducts: Product[];
    validProducts: Product[];
    missingOrInvalidIds: string[];
  } {
    const byId = new Map<string, Product>();
    for (const p of products) {
      if (this.isValidBuyerPremiumProduct(p) && !byId.has(p.id)) {
        byId.set(p.id, p);
      }
    }

    const validProducts: Product[] = [];
    const missingOrInvalidIds: string[] = [];

    for (const spec of this.REQUIRED_PREMIUM_TARIFFS) {
      const found = byId.get(spec.id);
      if (found) {
        validProducts.push(found);
      } else {
        missingOrInvalidIds.push(spec.id);
      }
    }

    const allAvailable =
      missingOrInvalidIds.length === 0 &&
      validProducts.length === this.REQUIRED_PREMIUM_TARIFFS.length;

    return {
      allAvailable,
      availableProducts: allAvailable ? validProducts : [],
      validProducts,
      missingOrInvalidIds,
    };
  }

  /**
   * Resolves effective [minQuantity, maxQuantity] bounds for a product,
   * cross-checking against the canonical catalog definition if present.
   */
  public static getCatalogQuantityBounds(product: Product): {
    minQuantity: number;
    maxQuantity: number;
  } {
    const catalogDef = INITIAL_TEST_PRODUCTS.find((p) => p.id === product.id);
    const rawMin = product.minQuantity ?? catalogDef?.minQuantity ?? 1;
    const rawMax = product.maxQuantity ?? catalogDef?.maxQuantity ?? 100;

    if (
      !Number.isSafeInteger(rawMin) ||
      !Number.isSafeInteger(rawMax) ||
      rawMin < 1 ||
      rawMax < rawMin
    ) {
      throw new Error(
        `Некорректные ограничения количества в каталоге для "${product.name}".`,
      );
    }

    const effectiveMin =
      catalogDef?.minQuantity !== undefined
        ? Math.max(rawMin, catalogDef.minQuantity)
        : rawMin;
    const effectiveMax =
      catalogDef?.maxQuantity !== undefined
        ? Math.min(rawMax, catalogDef.maxQuantity)
        : rawMax;

    if (effectiveMax < effectiveMin) {
      throw new Error(
        `Некорректные ограничения количества в каталоге для "${product.name}".`,
      );
    }

    return {
      minQuantity: effectiveMin,
      maxQuantity: effectiveMax,
    };
  }

  /**
   * Strictly validates order/Stars quantity as a positive safe integer within catalog bounds.
   * Also guarantees Premium duration is strictly 3, 6, or 12 months with quantity === 1.
   * NEVER rounds fractional numbers (e.g., via Math.round, Math.floor, Math.ceil).
   */
  public static validateOrderQuantity(
    product: Product,
    rawQuantity: number | string = 1,
  ): number {
    if (product.category === 'premium') {
      this.resolvePremiumDurationMonths(product);
    }

    const { minQuantity: minQ, maxQuantity: maxQ } =
      this.getCatalogQuantityBounds(product);

    let qty: number;
    if (typeof rawQuantity === 'number') {
      if (
        !Number.isFinite(rawQuantity) ||
        !Number.isInteger(rawQuantity) ||
        !Number.isSafeInteger(rawQuantity)
      ) {
        throw new Error(
          `Некорректное количество для "${product.name}": укажите целое положительное число от ${minQ} до ${maxQ}.`,
        );
      }
      qty = rawQuantity;
    } else if (typeof rawQuantity === 'string') {
      const trimmed = rawQuantity.trim();
      if (!trimmed || !/^\d+$/.test(trimmed)) {
        throw new Error(
          `Некорректное количество для "${product.name}": укажите целое положительное число от ${minQ} до ${maxQ}.`,
        );
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed)) {
        throw new Error(
          `Некорректное количество для "${product.name}": число превышает допустимый предел (от ${minQ} до ${maxQ}).`,
        );
      }
      qty = parsed;
    } else {
      throw new Error(
        `Некорректное количество для "${product.name}": укажите целое положительное число от ${minQ} до ${maxQ}.`,
      );
    }

    if (product.category === 'premium' && qty !== 1) {
      throw new Error('Для подписки Telegram Premium количество всегда равно 1.');
    }

    if (qty <= 0 || qty < minQ || qty > maxQ) {
      throw new Error(
        `Некорректное количество для "${product.name}": допустимо от ${minQ} до ${maxQ}.`,
      );
    }

    return qty;
  }

  /**
   * Computes canonical integer USD cents unit and total price for a product + quantity,
   * respecting custom Stars quantity ranges and pack pricing without rounding quantity.
   */
  public static calculateOrderPriceUsdCents(
    product: Product,
    rawQuantity: number | string = 1,
  ): {
    quantity: number;
    unitPriceUsdCents: number;
    totalPriceUsdCents: number;
  } {
    const qty = this.validateOrderQuantity(product, rawQuantity);

    const baseCents =
      typeof product.unitPriceUsdCents === 'number' &&
      Number.isInteger(product.unitPriceUsdCents) &&
      product.unitPriceUsdCents > 0
        ? product.unitPriceUsdCents
        : typeof product.priceUsdCents === 'number' &&
            Number.isInteger(product.priceUsdCents) &&
            product.priceUsdCents > 0
          ? product.priceUsdCents
          : product.price;

    const safeUnit = assertValidUsdCents(baseCents, 'priceUsdCents');
    const total = safeUnit * qty;
    if (!Number.isSafeInteger(total) || total <= 0) {
      throw new Error(
        `Итоговая стоимость для "${product.name}" превышает допустимый предел.`,
      );
    }

    return {
      quantity: qty,
      unitPriceUsdCents: safeUnit,
      totalPriceUsdCents: total,
    };
  }

  public static isBuyerVisibleProduct(product: Product): boolean {
    if (!product.isActive) return false;
    return (
      product.id === this.BUYER_STARS_PRODUCT_ID ||
      this.isValidBuyerPremiumProduct(product)
    );
  }

  public static async getBuyerStarsProduct(): Promise<Product | null> {
    const raw = await this.getProductById(this.BUYER_STARS_PRODUCT_ID);
    if (!raw) return null;
    const prod: Product = { ...raw, id: raw.id || this.BUYER_STARS_PRODUCT_ID };
    if (!prod.isActive || prod.category !== 'stars') return null;
    return prod;
  }

  public static async getValidatedBuyerPremiumCatalog(): Promise<{
    allAvailable: boolean;
    availableProducts: Product[];
    validProducts: Product[];
    missingOrInvalidIds: string[];
  }> {
    const fetched = await Promise.all(
      this.REQUIRED_PREMIUM_TARIFFS.map(async (spec) => {
        const doc = await this.getProductById(spec.id);
        return doc ? ({ ...doc, id: doc.id || spec.id } as Product) : null;
      }),
    );
    const foundProducts = fetched.filter((p): p is Product => Boolean(p));
    return this.resolveBuyerPremiumCatalog(foundProducts);
  }

  public static async diagnoseBuyerCatalog(): Promise<{
    allHealthy: boolean;
    hasMissing: boolean;
    items: Array<{
      id: string;
      status: 'ok' | 'missing' | 'inactive' | 'invalid';
      reason?: string;
    }>;
  }> {
    const targetIds = [
      this.BUYER_STARS_PRODUCT_ID,
      ...this.REQUIRED_PREMIUM_TARIFFS.map((t) => t.id),
    ];
    const fetched = await Promise.all(
      targetIds.map(async (id) => {
        const doc = await this.getProductById(id);
        return doc ? ({ ...doc, id: doc.id || id } as Product) : null;
      }),
    );
    const items: Array<{
      id: string;
      status: 'ok' | 'missing' | 'inactive' | 'invalid';
      reason?: string;
    }> = [];

    for (let i = 0; i < targetIds.length; i += 1) {
      const id = targetIds[i];
      const doc = fetched[i];
      if (!doc) {
        items.push({ id, status: 'missing', reason: 'документ отсутствует в Firestore' });
        continue;
      }
      if (!doc.isActive) {
        items.push({ id, status: 'inactive', reason: 'товар отключён (isActive = false)' });
        continue;
      }
      if (id === this.BUYER_STARS_PRODUCT_ID) {
        if (doc.category !== 'stars') {
          items.push({ id, status: 'invalid', reason: `неверная категория "${doc.category}"` });
        } else {
          items.push({ id, status: 'ok' });
        }
        continue;
      }

      const rawProduct: Product = doc;
      if (this.isValidBuyerPremiumProduct(doc)) {
        items.push({ id, status: 'ok' });
      } else {
        const spec = this.REQUIRED_PREMIUM_TARIFFS.find((t) => t.id === id);
        const cents = rawProduct.priceUsdCents ?? rawProduct.price;
        items.push({
          id,
          status: 'invalid',
          reason: `некорректная категория (${rawProduct.category}), срок (${String(rawProduct.durationMonths)} вместо ${spec?.durationMonths}) или цена (${cents} вместо ${spec?.priceUsdCents} центов)`,
        });
      }
    }

    return {
      allHealthy: items.every((i) => i.status === 'ok'),
      hasMissing: items.some((i) => i.status === 'missing'),
      items,
    };
  }

  public static async ensureMissingCanonicalBuyerProducts(): Promise<{
    createdIds: string[];
    existingProblems: Array<{ id: string; reason: string }>;
  }> {
    return firestoreRepo.ensureMissingCanonicalCatalogProducts();
  }

  public static async getBuyerPremiumProducts(): Promise<Product[]> {
    const state = await this.getValidatedBuyerPremiumCatalog();
    return state.availableProducts;
  }

  public static async getBuyerCatalogProducts(): Promise<Product[]> {
    const all = await this.getAllProducts(false, 100);
    return all.filter((p) => this.isBuyerVisibleProduct(p));
  }

  public static async getAllProducts(
    includeInactive = false,
    limit = 100,
    startAfterCursor?: unknown,
  ): Promise<Product[]> {
    const isLegacyOffset =
      typeof startAfterCursor === 'number' && startAfterCursor > 0;
    return firestoreRepo.queryDocs<Product>('products', {
      where: includeInactive
        ? []
        : [{ field: 'isActive', op: '==', value: true }],
      orderBy: { field: 'price', direction: 'asc' },
      startAfter: isLegacyOffset ? undefined : startAfterCursor,
      offset: isLegacyOffset ? startAfterCursor : undefined,
      limit,
    });
  }

  public static async getProductsByCategory(
    category: ProductCategory,
    includeInactive = false,
    limit = 50,
    startAfterCursor?: unknown,
  ): Promise<Product[]> {
    const isLegacyOffset =
      typeof startAfterCursor === 'number' && startAfterCursor > 0;
    return firestoreRepo.queryDocs<Product>('products', {
      where: includeInactive
        ? [{ field: 'category', op: '==', value: category }]
        : [
            { field: 'category', op: '==', value: category },
            { field: 'isActive', op: '==', value: true },
          ],
      orderBy: { field: 'price', direction: 'asc' },
      startAfter: isLegacyOffset ? undefined : startAfterCursor,
      offset: isLegacyOffset ? startAfterCursor : undefined,
      limit,
    });
  }

  public static async getProductById(productId: string): Promise<Product | null> {
    return firestoreRepo.getDoc<Product>('products', productId);
  }

  public static async createProduct(input: {
    name: string;
    category: ProductCategory;
    description: string;
    priceUsdCents?: number;
    price?: number;
    unitPriceUsdCents?: number;
    minQuantity?: number;
    maxQuantity?: number;
    durationMonths?: 3 | 6 | 12;
    imageUrl?: string;
    fulfillmentType?: FulfillmentType;
    keyGeneratorAlgorithm?: KeyGeneratorAlgorithm;
  }): Promise<Product> {
    const rawCents = input.priceUsdCents ?? input.price ?? 0;
    const cleanPriceCents = Math.round(Number(rawCents));
    if (
      !Number.isInteger(cleanPriceCents) ||
      cleanPriceCents < 1 ||
      cleanPriceCents > 10_000_000
    ) {
      throw new Error(
        'Цена должна быть целым числом в центах USD от 1 ($0.01) до 10 000 000 ($100 000.00).',
      );
    }

    const now = new Date().toISOString();
    const id = sanitizeDocId(`${input.category}_${Date.now()}`);

    const minQuantity = input.minQuantity;
    const maxQuantity = input.maxQuantity;
    if (
      minQuantity !== undefined &&
      (!Number.isSafeInteger(minQuantity) || minQuantity < 1)
    ) {
      throw new Error('minQuantity должен быть целым положительным числом.');
    }
    if (
      maxQuantity !== undefined &&
      (!Number.isSafeInteger(maxQuantity) ||
        maxQuantity < (minQuantity ?? 1))
    ) {
      throw new Error(
        'maxQuantity должен быть целым числом не меньше minQuantity.',
      );
    }

    const validatedDuration =
      input.category === 'premium'
        ? this.assertValidPremiumDuration(input.durationMonths)
        : undefined;

    const product: Product = {
      id,
      name: input.name.trim().slice(0, 120),
      category: input.category,
      description: input.description.trim().slice(0, 1000),
      priceUsdCents: cleanPriceCents,
      ...(input.unitPriceUsdCents !== undefined
        ? { unitPriceUsdCents: assertValidUsdCents(input.unitPriceUsdCents, 'unitPriceUsdCents') }
        : {}),
      price: cleanPriceCents,
      currency: 'USD',
      ...(minQuantity !== undefined ? { minQuantity } : {}),
      ...(maxQuantity !== undefined ? { maxQuantity } : {}),
      ...(validatedDuration !== undefined
        ? { durationMonths: validatedDuration }
        : {}),
      imageUrl: (input.imageUrl || '').trim().slice(0, 500),
      isActive: true,
      fulfillmentType: input.fulfillmentType || 'manual',
      ...(input.keyGeneratorAlgorithm
        ? { keyGeneratorAlgorithm: input.keyGeneratorAlgorithm }
        : {}),
      createdAt: now,
      updatedAt: now,
    };

    await firestoreRepo.setDoc<Product>('products', product.id, product);
    return product;
  }

  public static async updateProductPriceUsdCents(
    productId: string,
    newPriceUsdCents: number,
  ): Promise<Product | null> {
    const cleanCents = Math.round(Number(newPriceUsdCents));
    if (!Number.isInteger(cleanCents) || cleanCents < 1 || cleanCents > 10_000_000) {
      throw new Error(
        'Цена должна быть в диапазоне от $0.01 (1 цент) до $100 000.00.',
      );
    }

    return firestoreRepo.updateDoc<Product>('products', productId, {
      priceUsdCents: cleanCents,
      price: cleanCents,
      currency: 'USD',
      updatedAt: new Date().toISOString(),
    });
  }

  public static async updateProductPrice(
    productId: string,
    newPriceCents: number,
  ): Promise<Product | null> {
    return this.updateProductPriceUsdCents(productId, newPriceCents);
  }

  public static async updateProductDetails(
    productId: string,
    updates: Partial<Pick<Product, 'name' | 'description' | 'imageUrl' | 'isActive'>>,
  ): Promise<Product | null> {
    const sanitizedUpdates: Partial<Product> = {
      updatedAt: new Date().toISOString(),
    };

    if (typeof updates.name === 'string' && updates.name.trim()) {
      sanitizedUpdates.name = updates.name.trim().slice(0, 120);
    }
    if (typeof updates.description === 'string' && updates.description.trim()) {
      sanitizedUpdates.description = updates.description.trim().slice(0, 1000);
    }
    if (typeof updates.imageUrl === 'string') {
      sanitizedUpdates.imageUrl = updates.imageUrl.trim().slice(0, 500);
    }
    if (typeof updates.isActive === 'boolean') {
      sanitizedUpdates.isActive = updates.isActive;
    }

    return firestoreRepo.updateDoc<Product>('products', productId, sanitizedUpdates);
  }

  public static async toggleProductActive(productId: string): Promise<Product | null> {
    const existing = await this.getProductById(productId);
    if (!existing) return null;

    return firestoreRepo.updateDoc<Product>('products', productId, {
      isActive: !existing.isActive,
      updatedAt: new Date().toISOString(),
    });
  }

  public static async deleteProduct(productId: string): Promise<boolean> {
    return firestoreRepo.deleteDoc('products', productId);
  }
}
