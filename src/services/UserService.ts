import { firestoreRepo } from '../db/firestore.ts';
import { isAdminTelegramId } from '../config/env.ts';
import { StoreUser, AdminRecord } from '../types.ts';

export class UserService {
  public static getUserId(telegramId: number): string {
    return `tg_${telegramId}`;
  }

  /**
   * Atomically creates or updates Telegram user profile fields inside a Firestore transaction.
   * Preserves concurrent updates to balanceUsdCents, totalOrders, totalSpentUsdCents, and isBlocked.
   */
  public static async upsertFromTelegram(from: {
    id: number;
    username?: string;
    first_name: string;
    last_name?: string;
    language_code?: string;
  }): Promise<StoreUser> {
    const userId = this.getUserId(from.id);

    return firestoreRepo.runTransaction<StoreUser>(async (tx) => {
      const existing = await tx.get<StoreUser>('users', userId);
      const now = new Date().toISOString();

      if (existing) {
        const nextUsername = (from.username ?? existing.username ?? '').slice(0, 64);
        const nextFirstName = (
          from.first_name ||
          existing.firstName ||
          'Пользователь'
        ).slice(0, 128);
        const nextLastName = (from.last_name ?? existing.lastName ?? '').slice(0, 128);
        const nextLanguageCode = (
          from.language_code ||
          existing.languageCode ||
          'ru'
        ).slice(0, 16);

        const balanceUsdCents =
          typeof existing.balanceUsdCents === 'number' &&
          Number.isInteger(existing.balanceUsdCents)
            ? existing.balanceUsdCents
            : Math.round((existing.balance ?? 0) * 100);

        const updated: StoreUser = {
          ...existing,
          username: nextUsername,
          firstName: nextFirstName,
          lastName: nextLastName,
          languageCode: nextLanguageCode,
          balanceUsdCents,
          balance: Number((balanceUsdCents / 100).toFixed(2)),
          totalSpentUsdCents: existing.totalSpentUsdCents ?? 0,
          totalOrders: existing.totalOrders ?? 0,
          totalSpentStars: existing.totalSpentStars ?? 0,
          isBlocked: Boolean(existing.isBlocked),
          updatedAt: now,
        };
        tx.set<StoreUser>('users', userId, updated);
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
        balanceUsdCents: 0,
        totalSpentUsdCents: 0,
        balance: 0,
        totalSpentStars: 0,
        createdAt: now,
        updatedAt: now,
      };

      tx.set<StoreUser>('users', userId, created);
      return created;
    });
  }

  public static async getUserByTelegramId(telegramId: number): Promise<StoreUser | null> {
    return firestoreRepo.getDoc<StoreUser>('users', this.getUserId(telegramId));
  }

  public static async getUserById(userId: string): Promise<StoreUser | null> {
    return firestoreRepo.getDoc<StoreUser>('users', userId);
  }

  public static async getAllUsers(
    limit = 100,
    startAfterCursor?: unknown,
  ): Promise<StoreUser[]> {
    const isLegacyOffset =
      typeof startAfterCursor === 'number' && startAfterCursor > 0;
    return firestoreRepo.queryDocs<StoreUser>('users', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      startAfter: isLegacyOffset ? undefined : startAfterCursor,
      offset: isLegacyOffset ? startAfterCursor : undefined,
      limit,
    });
  }

  public static async setUserBlocked(
    telegramId: number,
    isBlocked: boolean,
  ): Promise<StoreUser | null> {
    const userId = this.getUserId(telegramId);
    return firestoreRepo.runTransaction<StoreUser | null>(async (tx) => {
      const existing = await tx.get<StoreUser>('users', userId);
      if (!existing) return null;

      const updated: StoreUser = {
        ...existing,
        isBlocked,
        updatedAt: new Date().toISOString(),
      };
      tx.set<StoreUser>('users', userId, updated);
      return updated;
    });
  }

  public static async incrementUserUsdStats(
    userId: string,
    spentUsdCents: number,
  ): Promise<void> {
    const safeCents = Math.max(0, Math.round(spentUsdCents));
    await firestoreRepo.runTransaction(async (tx) => {
      const existing = await tx.get<StoreUser>('users', userId);
      if (!existing) return;

      tx.set<StoreUser>('users', userId, {
        ...existing,
        totalOrders: (existing.totalOrders || 0) + 1,
        totalSpentUsdCents: (existing.totalSpentUsdCents || 0) + safeCents,
        updatedAt: new Date().toISOString(),
      });
    });
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
