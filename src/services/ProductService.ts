import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import {
  FulfillmentType,
  KeyGeneratorAlgorithm,
  Product,
  ProductCategory,
} from '../types.ts';
import { assertValidUsdCents } from './Money.ts';

export class ProductService {
  /**
   * Computes canonical integer USD cents unit and total price for a product + quantity,
   * respecting custom Stars quantity ranges and pack pricing.
   */
  public static calculateOrderPriceUsdCents(
    product: Product,
    rawQuantity = 1,
  ): {
    quantity: number;
    unitPriceUsdCents: number;
    totalPriceUsdCents: number;
  } {
    const minQ = product.minQuantity ?? 1;
    const maxQ = product.maxQuantity ?? 100;
    const qty = Math.round(rawQuantity);
    if (!Number.isInteger(qty) || qty < minQ || qty > maxQ) {
      throw new Error(
        `Некорректное количество для "${product.name}": допустимо от ${minQ} до ${maxQ}.`,
      );
    }

    const baseCents =
      typeof product.unitPriceUsdCents === 'number' &&
      Number.isInteger(product.unitPriceUsdCents) &&
      product.unitPriceUsdCents > 0
        ? product.unitPriceUsdCents
        : typeof product.priceUsdCents === 'number' &&
            Number.isInteger(product.priceUsdCents) &&
            product.priceUsdCents > 0
          ? product.priceUsdCents
          : Math.round(product.price);

    const safeUnit = assertValidUsdCents(baseCents, 'priceUsdCents');
    const total = safeUnit * qty;

    return {
      quantity: qty,
      unitPriceUsdCents: safeUnit,
      totalPriceUsdCents: total,
    };
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
      ...(input.minQuantity !== undefined ? { minQuantity: input.minQuantity } : {}),
      ...(input.maxQuantity !== undefined ? { maxQuantity: input.maxQuantity } : {}),
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
