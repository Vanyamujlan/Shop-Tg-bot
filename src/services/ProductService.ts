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
      const catalogDef = INITIAL_TEST_PRODUCTS.find((p) => p.id === product.id);
      const effectiveDuration =
        product.durationMonths ?? catalogDef?.durationMonths;
      if (
        effectiveDuration === undefined ||
        !this.ALLOWED_PREMIUM_DURATIONS.has(effectiveDuration)
      ) {
        throw new Error(
          'Недопустимый срок подписки Telegram Premium: доступны только 3, 6 или 12 месяцев.',
        );
      }
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
      this.BUYER_PREMIUM_IDS.has(product.id)
    );
  }

  public static async getBuyerStarsProduct(): Promise<Product | null> {
    const prod = await this.getProductById(this.BUYER_STARS_PRODUCT_ID);
    if (!prod || !prod.isActive) return null;
    return prod;
  }

  public static async getBuyerPremiumProducts(): Promise<Product[]> {
    const allPremium = await this.getProductsByCategory('premium', false, 20);
    return allPremium
      .filter((p) => this.BUYER_PREMIUM_IDS.has(p.id))
      .sort((a, b) => (a.durationMonths ?? 0) - (b.durationMonths ?? 0));
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

    if (
      input.category === 'premium' &&
      input.durationMonths !== undefined &&
      !this.ALLOWED_PREMIUM_DURATIONS.has(input.durationMonths)
    ) {
      throw new Error(
        'Недопустимый срок подписки Telegram Premium: доступны только 3, 6 или 12 месяцев.',
      );
    }

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
      ...(input.durationMonths !== undefined
        ? { durationMonths: input.durationMonths }
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
