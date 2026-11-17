import { firestoreRepo } from '../db/firestore.ts';
import { isAdminTelegramId } from '../config/env.ts';
import { StoreUser, AdminRecord } from '../types.ts';

export class UserService {
  public static getUserId(telegramId: number): string {
    return `tg_${telegramId}`;
  }

  public static async upsertFromTelegram(from: {
    id: number;
    username?: string;
    first_name: string;
    last_name?: string;
    language_code?: string;
  }): Promise<StoreUser> {
    const userId = this.getUserId(from.id);
    const existing = await firestoreRepo.getDoc<StoreUser>('users', userId);
    const now = new Date().toISOString();

    if (existing) {
      const updated: StoreUser = {
        ...existing,
        username: (from.username || existing.username || '').slice(0, 64),
        firstName: (from.first_name || existing.firstName || 'Пользователь').slice(0, 128),
        lastName: (from.last_name || existing.lastName || '').slice(0, 128),
        languageCode: (from.language_code || existing.languageCode || 'ru').slice(0, 16),
        updatedAt: now,
      };
      await firestoreRepo.setDoc<StoreUser>('users', userId, updated);
      return updated;
    }

    const created: StoreUser = {
      userId,
      telegramId: from.id,
      username: (from.username || '').slice(0, 64),
      firstName: (from.first_name || 'Пользователь').slice(0, 128),
      lastName: (from.last_name || '').slice(0, 128),
      languageCode: (from.language_code || 'ru').slice(0, 16),
      isBlocked: false,
      totalOrders: 0,
      totalSpentStars: 0,
      createdAt: now,
      updatedAt: now,
    };

    await firestoreRepo.setDoc<StoreUser>('users', userId, created);
    return created;
  }

  public static async getUserByTelegramId(telegramId: number): Promise<StoreUser | null> {
    return firestoreRepo.getDoc<StoreUser>('users', this.getUserId(telegramId));
  }

  public static async getUserById(userId: string): Promise<StoreUser | null> {
    return firestoreRepo.getDoc<StoreUser>('users', userId);
  }

  /**
   * Server-side ordered and paginated users query (HIGH-02).
   */
  public static async getAllUsers(
    limit = 100,
    offset = 0,
  ): Promise<StoreUser[]> {
    return firestoreRepo.queryDocs<StoreUser>('users', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      offset,
    });
  }

  public static async setUserBlocked(
    telegramId: number,
    isBlocked: boolean,
  ): Promise<StoreUser | null> {
    const userId = this.getUserId(telegramId);
    const existing = await firestoreRepo.getDoc<StoreUser>('users', userId);
    if (!existing) return null;

    const updated: StoreUser = {
      ...existing,
      isBlocked,
      updatedAt: new Date().toISOString(),
    };
    await firestoreRepo.setDoc<StoreUser>('users', userId, updated);
    return updated;
  }

  public static async incrementUserPurchaseStats(
    userId: string,
    starsSpent: number,
  ): Promise<void> {
    await firestoreRepo.runTransaction(async (tx) => {
      const existing = await tx.get<StoreUser>('users', userId);
      if (!existing) return;

      tx.set<StoreUser>('users', userId, {
        ...existing,
        totalOrders: existing.totalOrders + 1,
        totalSpentStars: existing.totalSpentStars + starsSpent,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  public static async isAdmin(telegramId: number | undefined): Promise<boolean> {
    if (!telegramId) return false;
    if (isAdminTelegramId(telegramId)) return true;

    const adminRecord = await firestoreRepo.getDoc<AdminRecord>(
      'admins',
      `tg_${telegramId}`,
    );
    return Boolean(adminRecord);
  }
}
