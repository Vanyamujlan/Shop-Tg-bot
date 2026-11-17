import { firestoreRepo, sanitizeDocId } from '../db/firestore.ts';
import { Product, ProductCategory, FulfillmentType } from '../types.ts';

export class ProductService {
  /**
   * Server-side filtered and cursor-paginated products query.
   */
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

  /**
   * Server-side filtered and cursor-paginated category products query.
   */
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
    price: number;
    imageUrl?: string;
    fulfillmentType?: FulfillmentType;
  }): Promise<Product> {
    const cleanPrice = Math.round(Number(input.price));
    if (!Number.isFinite(cleanPrice) || cleanPrice < 1 || cleanPrice > 100000) {
      throw new Error('Цена должна быть целым числом от 1 до 100 000 XTR (Telegram Stars).');
    }

    const now = new Date().toISOString();
    const id = sanitizeDocId(`${input.category}_${Date.now()}`);

    const product: Product = {
      id,
      name: input.name.trim().slice(0, 120),
      category: input.category,
      description: input.description.trim().slice(0, 1000),
      price: cleanPrice,
      currency: 'XTR',
      imageUrl: (input.imageUrl || '').trim().slice(0, 500),
      isActive: true,
      fulfillmentType: input.fulfillmentType || 'manual',
      createdAt: now,
      updatedAt: now,
    };

    await firestoreRepo.setDoc<Product>('products', product.id, product);
    return product;
  }

  public static async updateProductPrice(
    productId: string,
    newPrice: number,
  ): Promise<Product | null> {
    const cleanPrice = Math.round(Number(newPrice));
    if (!Number.isFinite(cleanPrice) || cleanPrice < 1 || cleanPrice > 100000) {
      throw new Error('Цена должна быть целым числом от 1 до 100 000 XTR (Telegram Stars).');
    }

    return firestoreRepo.updateDoc<Product>('products', productId, {
      price: cleanPrice,
      updatedAt: new Date().toISOString(),
    });
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
