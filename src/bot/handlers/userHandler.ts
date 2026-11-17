import { Context, Telegraf } from 'telegraf';
import { ProductCategory } from '../../types.ts';
import { StorageUnavailableError } from '../../db/firestore.ts';
import { UserService } from '../../services/UserService.ts';
import { ProductService } from '../../services/ProductService.ts';
import { OrderService } from '../../services/OrderService.ts';
import {
  buildBackToMenuKeyboard,
  buildCatalogCategoriesKeyboard,
  buildCategoryProductsKeyboard,
  buildMainMenuKeyboard,
  buildProductDetailKeyboard,
  buildUserOrderDetailKeyboard,
  buildUserOrdersKeyboard,
} from '../keyboards.ts';
import {
  formatCatalogOverviewMessage,
  formatCategoryListMessage,
  formatHelpMessage,
  formatOrderDetailMessage,
  formatPaySupportMessage,
  formatProductCardMessage,
  formatTermsMessage,
  formatUserOrdersListMessage,
  formatUserProfileMessage,
  formatWelcomeMessage,
} from '../formatters.ts';

const callbackDebounceMap = new Map<string, number>();
const MAX_DEBOUNCE_ENTRIES = 2000;
const DEBOUNCE_TTL_MS = 60_000;

function pruneCallbackDebounceMap(now: number): void {
  if (callbackDebounceMap.size <= MAX_DEBOUNCE_ENTRIES) {
    return;
  }
  for (const [k, timestamp] of callbackDebounceMap.entries()) {
    if (now - timestamp > DEBOUNCE_TTL_MS) {
      callbackDebounceMap.delete(k);
    }
  }
  // If still above max size, evict oldest entries
  while (callbackDebounceMap.size > MAX_DEBOUNCE_ENTRIES) {
    const oldestKey = callbackDebounceMap.keys().next().value;
    if (!oldestKey) break;
    callbackDebounceMap.delete(oldestKey);
  }
}

export function isDuplicateCallbackClick(
  telegramUserId: number,
  actionKey: string,
  windowMs = 700,
): boolean {
  const key = `${telegramUserId}:${actionKey}`;
  const now = Date.now();
  const prev = callbackDebounceMap.get(key) || 0;
  if (now - prev < windowMs) {
    return true;
  }
  callbackDebounceMap.set(key, now);
  pruneCallbackDebounceMap(now);
  return false;
}

export function clearCallbackDebounceMap(): void {
  callbackDebounceMap.clear();
}

export function getCallbackDebounceMapSize(): number {
  return callbackDebounceMap.size;
}

export async function safeAnswerCbQuery(
  ctx: Context,
  text?: string,
  showAlert = false,
): Promise<void> {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCbQuery(text, { show_alert: showAlert });
  } catch {
    // Ignore expired or already answered callback query errors
  }
}

export async function safeRespondOrEdit(
  ctx: Context,
  htmlText: string,
  extra?: object,
): Promise<void> {
  if (ctx.callbackQuery) {
    await safeAnswerCbQuery(ctx);

    try {
      await ctx.editMessageText(htmlText, {
        parse_mode: 'HTML',
        ...extra,
      });
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('message is not modified')) {
        return;
      }
      // If previous message was a photo/invoice or cannot be edited, send a fresh message
    }
  }

  await ctx.reply(htmlText, {
    parse_mode: 'HTML',
    ...extra,
  });
}

export function registerUserHandlers(bot: Telegraf): void {
  // Middleware: register/update user, handle storage unavailability gracefully, and block banned users
  bot.use(async (ctx, next) => {
    try {
      if (ctx.from) {
        const isAdmin = await UserService.isAdmin(ctx.from.id);
        const user = await UserService.upsertFromTelegram(ctx.from);
        if (user.isBlocked && !isAdmin) {
          if (ctx.callbackQuery) {
            await safeAnswerCbQuery(
              ctx,
              'Ваш доступ к магазину ограничен.',
              true,
            );
          } else if (ctx.message) {
            await ctx.reply(
              '🚫 <b>Доступ к магазину ограничен.</b>\nЕсли вы считаете, что произошла ошибка, обратитесь в поддержку (/paysupport).',
              { parse_mode: 'HTML' },
            );
          }
          return;
        }
      }
      return await next();
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        if (ctx.callbackQuery) {
          await safeAnswerCbQuery(
            ctx,
            '⚠️ База данных магазина временно недоступна. Попробуйте чуть позже.',
            true,
          );
        } else if (ctx.message) {
          await ctx.reply(
            '⚠️ <b>Магазин временно находится в защитном режиме (база данных недоступна).</b>\nОформление новых заказов приостановлено для сохранности ваших средств. Попробуйте позже или обратитесь в /paysupport.',
            { parse_mode: 'HTML' },
          );
        }
        return;
      }
      throw error;
    }
  });

  // /start — Главное меню
  bot.start(async (ctx) => {
    const firstName = ctx.from?.first_name || 'Покупатель';
    const isAdmin = await UserService.isAdmin(ctx.from?.id);
    await safeRespondOrEdit(
      ctx,
      formatWelcomeMessage(firstName, isAdmin),
      buildMainMenuKeyboard(isAdmin),
    );
  });

  // /catalog — Каталог товаров
  bot.command('catalog', async (ctx) => {
    await safeRespondOrEdit(
      ctx,
      formatCatalogOverviewMessage(),
      buildCatalogCategoriesKeyboard(),
    );
  });

  // /orders — История заказов
  bot.command('orders', async (ctx) => {
    if (!ctx.from) return;
    const orders = await OrderService.getUserOrders(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatUserOrdersListMessage(orders),
      buildUserOrdersKeyboard(orders),
    );
  });

  // /profile — Профиль пользователя
  bot.command('profile', async (ctx) => {
    if (!ctx.from) return;
    const user = await UserService.upsertFromTelegram(ctx.from);
    const isAdmin = await UserService.isAdmin(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatUserProfileMessage(user, isAdmin),
      buildBackToMenuKeyboard(),
    );
  });

  // /help — Помощь
  bot.command('help', async (ctx) => {
    await safeRespondOrEdit(ctx, formatHelpMessage(), buildBackToMenuKeyboard());
  });

  // /terms — Правила магазина
  bot.command('terms', async (ctx) => {
    await safeRespondOrEdit(ctx, formatTermsMessage(), buildBackToMenuKeyboard());
  });

  // /paysupport — Поддержка по платежам
  bot.command('paysupport', async (ctx) => {
    await safeRespondOrEdit(
      ctx,
      formatPaySupportMessage(),
      buildBackToMenuKeyboard(),
    );
  });

  // Callback: Главное меню
  bot.action('menu:home', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:home')) return;
    const isAdmin = await UserService.isAdmin(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatWelcomeMessage(ctx.from.first_name || 'Покупатель', isAdmin),
      buildMainMenuKeyboard(isAdmin),
    );
  });

  // Callback: Каталог
  bot.action('menu:catalog', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:catalog')) return;
    await safeRespondOrEdit(
      ctx,
      formatCatalogOverviewMessage(),
      buildCatalogCategoriesKeyboard(),
    );
  });

  // Callback: Мои заказы
  bot.action('menu:orders', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:orders')) return;
    const orders = await OrderService.getUserOrders(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatUserOrdersListMessage(orders),
      buildUserOrdersKeyboard(orders),
    );
  });

  // Callback: Профиль
  bot.action('menu:profile', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:profile')) return;
    const user = await UserService.upsertFromTelegram(ctx.from);
    const isAdmin = await UserService.isAdmin(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatUserProfileMessage(user, isAdmin),
      buildBackToMenuKeyboard(),
    );
  });

  // Callback: Поддержка
  bot.action('menu:support', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:support')) return;
    await safeRespondOrEdit(ctx, formatHelpMessage(), buildBackToMenuKeyboard());
  });

  // Callback: Выбор категории (cat:stars, cat:premium, cat:gifts)
  bot.action(/^cat:(stars|premium|gifts)$/, async (ctx) => {
    const category = ctx.match[1] as ProductCategory;
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `cat:${category}`)) {
      return;
    }

    const products = await ProductService.getProductsByCategory(category, false);
    await safeRespondOrEdit(
      ctx,
      formatCategoryListMessage(category, products),
      buildCategoryProductsKeyboard(category, products),
    );
  });

  // Callback: Карточка товара (prod:<id>)
  bot.action(/^prod:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `prod:${productId}`)) {
      return;
    }

    const product = await ProductService.getProductById(productId);
    if (!product || !product.isActive) {
      await safeAnswerCbQuery(ctx, 'Товар не найден или временно отключён.', true);
      await safeRespondOrEdit(
        ctx,
        formatCatalogOverviewMessage(),
        buildCatalogCategoriesKeyboard(),
      );
      return;
    }

    const caption = formatProductCardMessage(product);
    const keyboard = buildProductDetailKeyboard(product);

    if (product.imageUrl && product.imageUrl.startsWith('http')) {
      try {
        await safeAnswerCbQuery(ctx);
        await ctx.replyWithPhoto(product.imageUrl, {
          caption,
          parse_mode: 'HTML',
          ...keyboard,
        });
        return;
      } catch {
        // Fallback to standard text card if photo URL is unreachable
      }
    }

    await safeRespondOrEdit(ctx, caption, keyboard);
  });

  // Callback: Детали заказа покупателя (uord:<orderId>)
  bot.action(/^uord:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `uord:${orderId}`)) {
      return;
    }

    const order = await OrderService.getOrderById(orderId);
    if (!order || order.userTelegramId !== ctx.from.id) {
      await safeAnswerCbQuery(
        ctx,
        'Заказ не найден или принадлежит другому пользователю.',
        true,
      );
      return;
    }

    await safeRespondOrEdit(
      ctx,
      formatOrderDetailMessage(order),
      buildUserOrderDetailKeyboard(order),
    );
  });

  // Callback: Отмена неоплаченного заказа покупателем (ucancel:<orderId>)
  bot.action(/^ucancel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `ucancel:${orderId}`)) {
      return;
    }

    const order = await OrderService.getOrderById(orderId);
    if (!order || order.userTelegramId !== ctx.from.id) {
      await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
      return;
    }

    if (order.paymentStatus !== 'pending') {
      await safeAnswerCbQuery(
        ctx,
        'Оплаченный заказ нельзя отменить самостоятельно.',
        true,
      );
      return;
    }

    const updated = await OrderService.updateOrderStatus({
      orderId: order.orderId,
      paymentStatus: 'cancelled',
      fulfillmentStatus: 'cancelled',
      fulfillmentNote: 'Отменён покупателем до оплаты.',
    });

    if (updated) {
      await OrderService.logTransaction({
        orderId: updated.orderId,
        userId: updated.userId,
        type: 'order_cancelled',
        amount: updated.totalPrice,
        details: 'Заказ отменён пользователем до оплаты.',
      });
      await safeRespondOrEdit(
        ctx,
        formatOrderDetailMessage(updated),
        buildUserOrderDetailKeyboard(updated),
      );
    }
  });
}
