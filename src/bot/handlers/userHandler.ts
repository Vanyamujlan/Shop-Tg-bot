import { Context, Markup, Telegraf } from 'telegraf';
import { BalanceTopUpProvider, ProductCategory } from '../../types.ts';
import { StorageUnavailableError } from '../../db/firestore.ts';
import { UserService } from '../../services/UserService.ts';
import { ProductService } from '../../services/ProductService.ts';
import { OrderService } from '../../services/OrderService.ts';
import {
  balanceService,
  validateTopUpAmountUsd,
} from '../../services/BalanceService.ts';
import { formatUsd } from '../../config/env.ts';
import { oe, oeBtn } from '../outlineEmoji.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  paymentProviderGateway,
} from '../../services/PaymentProviders.ts';
import {
  buildBackToMenuKeyboard,
  buildCatalogCategoriesKeyboard,
  buildCategoryProductsKeyboard,
  buildMainMenuKeyboard,
  buildProductDetailKeyboard,
  buildTopUpInvoiceKeyboard,
  buildTopUpStep1ProviderKeyboard,
  buildTopUpStep2AmountKeyboard,
  buildTopUpStep3XRocketCurrencyKeyboard,
  buildUserOrderDetailKeyboard,
  buildUserOrdersKeyboard,
  buildUserProfileKeyboard,
} from '../keyboards.ts';
import {
  escapeHtml,
  formatCatalogOverviewMessage,
  formatCategoryListMessage,
  formatHelpMessage,
  formatOrderDetailMessage,
  formatPaySupportMessage,
  formatProductCardMessage,
  formatSupportedCryptoInfoMessage,
  formatTermsMessage,
  formatTopUpInvoiceCardMessage,
  formatTopUpStep1ProviderMessage,
  formatTopUpStep2AmountMessage,
  formatTopUpStep3XRocketCurrencyMessage,
  formatUserOrdersListMessage,
  formatUserProfileMessage,
  formatUserTopUpHistoryMessage,
  formatWelcomeMessage,
} from '../formatters.ts';

interface UserTopUpCustomSession {
  provider: BalanceTopUpProvider;
  currency: string;
  amountUsd?: number;
  createdAt: number;
}

const userTopUpSessions = new Map<number, UserTopUpCustomSession>();
const USER_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_USER_SESSIONS = 1000;

function setUserTopUpSession(
  telegramId: number,
  session: UserTopUpCustomSession,
): void {
  const now = Date.now();
  for (const [k, v] of userTopUpSessions.entries()) {
    if (now - v.createdAt > USER_SESSION_TTL_MS) {
      userTopUpSessions.delete(k);
    }
  }
  while (userTopUpSessions.size >= MAX_USER_SESSIONS) {
    const oldest = userTopUpSessions.keys().next().value;
    if (oldest === undefined) break;
    userTopUpSessions.delete(oldest);
  }
  userTopUpSessions.set(telegramId, session);
}

function getUserTopUpSession(
  telegramId: number,
): UserTopUpCustomSession | undefined {
  const s = userTopUpSessions.get(telegramId);
  if (!s) return undefined;
  if (Date.now() - s.createdAt > USER_SESSION_TTL_MS) {
    userTopUpSessions.delete(telegramId);
    return undefined;
  }
  return s;
}

export function clearUserTopUpSession(telegramId: number): void {
  userTopUpSessions.delete(telegramId);
}

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

async function renderTopUpStep1(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  clearUserTopUpSession(ctx.from.id);
  const currentBalance = await balanceService.getBalance(ctx.from.id);
  await safeRespondOrEdit(
    ctx,
    formatTopUpStep1ProviderMessage(currentBalance),
    buildTopUpStep1ProviderKeyboard(),
  );
}

async function renderTopUpStep2(
  ctx: Context,
  provider: BalanceTopUpProvider,
  currency?: string,
  amountPaid?: number,
): Promise<void> {
  if (!ctx.from) return;
  const meta = PAYMENT_PROVIDER_CATALOG[provider];
  const resolvedCurrency =
    currency && meta.supportedCurrencies.includes(currency)
      ? currency
      : meta.defaultCurrency;
  const providerConfigured = paymentProviderGateway.isProviderConfigured(provider);

  // Allow user to type custom USD amount directly in chat on Step 2
  setUserTopUpSession(ctx.from.id, {
    provider,
    currency: resolvedCurrency,
    amountUsd: amountPaid,
    createdAt: Date.now(),
  });

  await safeRespondOrEdit(
    ctx,
    formatTopUpStep2AmountMessage({
      provider,
      amountPaid,
      currency: resolvedCurrency,
      providerConfigured,
    }),
    buildTopUpStep2AmountKeyboard(provider, amountPaid, resolvedCurrency),
  );
}

async function renderTopUpStep3XRocketCurrency(
  ctx: Context,
  amountPaid: number,
): Promise<void> {
  if (!ctx.from) return;
  clearUserTopUpSession(ctx.from.id);
  await safeRespondOrEdit(
    ctx,
    formatTopUpStep3XRocketCurrencyMessage(amountPaid),
    buildTopUpStep3XRocketCurrencyKeyboard(amountPaid),
  );
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

  // /profile — Профиль пользователя (с кнопкой «💳 Пополнить баланс»)
  bot.command('profile', async (ctx) => {
    if (!ctx.from) return;
    clearUserTopUpSession(ctx.from.id);
    const user = await UserService.upsertFromTelegram(ctx.from);
    const isAdmin = await UserService.isAdmin(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatUserProfileMessage(user, isAdmin),
      buildUserProfileKeyboard(),
    );
  });

  // /topup — Пополнение баланса (Шаг 1/3)
  bot.command('topup', async (ctx) => {
    await renderTopUpStep1(ctx);
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
    clearUserTopUpSession(ctx.from.id);
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
    clearUserTopUpSession(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatCatalogOverviewMessage(),
      buildCatalogCategoriesKeyboard(),
    );
  });

  // Callback: Мои заказы
  bot.action('menu:orders', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:orders')) return;
    clearUserTopUpSession(ctx.from.id);
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
    clearUserTopUpSession(ctx.from.id);
    const user = await UserService.upsertFromTelegram(ctx.from);
    const isAdmin = await UserService.isAdmin(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatUserProfileMessage(user, isAdmin),
      buildUserProfileKeyboard(),
    );
  });

  // Callback: Меню пополнения баланса («💳 Пополнить баланс» -> Шаг 1/3)
  bot.action('menu:topup', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:topup')) return;
    await renderTopUpStep1(ctx);
  });

  // Callback: Шаг 1/3 -> Шаг 2/3 Выбор способа пополнения (topup:prov:<provider>)
  bot.action(/^topup:prov:(cryptobot|xrocket)$/, async (ctx) => {
    const provider = ctx.match[1] as BalanceTopUpProvider;
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `topup:prov:${provider}`)) {
      return;
    }
    const existingSession = getUserTopUpSession(ctx.from.id);
    const meta = PAYMENT_PROVIDER_CATALOG[provider];
    await renderTopUpStep2(
      ctx,
      provider,
      meta.defaultCurrency,
      existingSession?.amountUsd,
    );
  });

  // Callback: Выбор валюты пополнения (topup:curr:<provider>:<currency>)
  bot.action(
    /^topup:curr:(cryptobot|xrocket):([A-Z0-9]+)$/,
    async (ctx) => {
      const provider = ctx.match[1] as BalanceTopUpProvider;
      const currency = ctx.match[2];
      if (
        !ctx.from ||
        isDuplicateCallbackClick(ctx.from.id, `topup:curr:${provider}:${currency}`)
      ) {
        return;
      }
      const existingSession = getUserTopUpSession(ctx.from.id);
      await renderTopUpStep2(
        ctx,
        provider,
        currency,
        existingSession?.amountUsd,
      );
    },
  );

  // Callback: Пересчёт введённой суммы пополнения при смене провайдера на Шаге 2/3 (topup:amt:<provider>:<currency>:<amount>)
  bot.action(
    /^topup:amt:(cryptobot|xrocket):([A-Z0-9]+):([0-9.]+)$/,
    async (ctx) => {
      const provider = ctx.match[1] as BalanceTopUpProvider;
      const currency = ctx.match[2];
      const amount = Number(ctx.match[3]);
      if (
        !ctx.from ||
        isDuplicateCallbackClick(
          ctx.from.id,
          `topup:amt:${provider}:${currency}:${amount}`,
        )
      ) {
        return;
      }
      await renderTopUpStep2(ctx, provider, currency, amount);
    },
  );

  // Callback: Шаг 3/3 (для xRocket) — экран выбора монеты и сети (topup:xr_curr:<amountUsd>)
  bot.action(/^topup:xr_curr:([0-9.]+)$/, async (ctx) => {
    const amountPaid = Number(ctx.match[1]);
    if (
      !ctx.from ||
      isDuplicateCallbackClick(ctx.from.id, `topup:xr_curr:${amountPaid}`)
    ) {
      return;
    }
    await renderTopUpStep3XRocketCurrency(ctx, amountPaid);
  });

  // Callback: Шаг 3/3 (для xRocket) — создание счёта по выбранной монете и сети (topup:xr_pay:<currency>:<network>:<amountUsd>)
  bot.action(
    /^topup:xr_pay:([A-Z0-9]+):([^:]+):([0-9.]+)$/,
    async (ctx) => {
      const currency = ctx.match[1];
      const network = decodeURIComponent(ctx.match[2]);
      const amountUsd = Number(ctx.match[3]);
      if (
        !ctx.from ||
        isDuplicateCallbackClick(
          ctx.from.id,
          `topup:xr_pay:${currency}:${network}:${amountUsd}`,
          1500,
        )
      ) {
        return;
      }

      try {
        clearUserTopUpSession(ctx.from.id);
        const topUp = await balanceService.createTopUp({
          telegramId: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          provider: 'xrocket',
          amountPaid: amountUsd,
          currency,
          network,
          convertFromUsd: true,
        });

        await safeAnswerCbQuery(ctx, 'Счёт xRocket создан!');
        await safeRespondOrEdit(
          ctx,
          formatTopUpInvoiceCardMessage(topUp),
          buildTopUpInvoiceKeyboard(topUp),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
      }
    },
  );

  // Callback: Сброс и повторный свободный ввод суммы в USD (topup:custom:<provider>:<currency>)
  bot.action(
    /^topup:custom:(cryptobot|xrocket):([A-Z0-9]+)$/,
    async (ctx) => {
      const provider = ctx.match[1] as BalanceTopUpProvider;
      const currency = ctx.match[2];
      if (!ctx.from) return;

      await renderTopUpStep2(ctx, provider, currency, undefined);
    },
  );

  // Callback: Создание счёта у провайдера (topup:create:<provider>:<currency>:<amountUsd>)
  bot.action(
    /^topup:create:(cryptobot|xrocket):([A-Z0-9]+):([0-9.]+)$/,
    async (ctx) => {
      const provider = ctx.match[1] as BalanceTopUpProvider;
      const currency = ctx.match[2];
      const amountPaid = Number(ctx.match[3]);
      if (
        !ctx.from ||
        isDuplicateCallbackClick(
          ctx.from.id,
          `topup:create:${provider}:${currency}:${amountPaid}`,
          1500,
        )
      ) {
        return;
      }

      try {
        clearUserTopUpSession(ctx.from.id);
        const topUp = await balanceService.createTopUp({
          telegramId: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          provider,
          amountPaid,
          currency,
          convertFromUsd: true,
        });

        await safeAnswerCbQuery(ctx, 'Счёт на пополнение успешно создан!');
        await safeRespondOrEdit(
          ctx,
          formatTopUpInvoiceCardMessage(topUp),
          buildTopUpInvoiceKeyboard(topUp),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
      }
    },
  );

  // Callback: Серверная проверка статуса счёта через API провайдера (topup:check:<paymentId>)
  bot.action(/^topup:check:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const paymentId = ctx.match[1];
    if (
      !ctx.from ||
      isDuplicateCallbackClick(ctx.from.id, `topup:check:${paymentId}`, 1500)
    ) {
      return;
    }

    try {
      const existing = await balanceService.getTopUpById(paymentId);
      if (!existing || existing.userTelegramId !== ctx.from.id) {
        await safeAnswerCbQuery(ctx, 'Счёт не найден.', true);
        return;
      }

      const verifyRes = await balanceService.verifyAndProcessTopUp(paymentId);
      if (verifyRes.status === 'paid') {
        await safeAnswerCbQuery(
          ctx,
          verifyRes.duplicate
            ? 'Этот счёт уже был оплачен и зачислен ранее.'
            : `Оплата подтверждена! На баланс зачислено +${formatUsd(verifyRes.topUp.amountCredited)}.`,
          true,
        );
      } else if (verifyRes.status === 'pending') {
        await safeAnswerCbQuery(
          ctx,
          'Оплата ещё не поступила. Завершите платёж по ссылке и повторите проверку.',
          true,
        );
      } else {
        await safeAnswerCbQuery(
          ctx,
          `Статус счёта: ${verifyRes.status} (${verifyRes.reason || 'не оплачен'})`,
          true,
        );
      }

      await safeRespondOrEdit(
        ctx,
        formatTopUpInvoiceCardMessage(verifyRes.topUp, verifyRes.newBalance),
        buildTopUpInvoiceKeyboard(verifyRes.topUp),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Callback: Отмена неоплаченного счёта пополнения (topup:cancel:<paymentId>)
  bot.action(/^topup:cancel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const paymentId = ctx.match[1];
    if (
      !ctx.from ||
      isDuplicateCallbackClick(ctx.from.id, `topup:cancel:${paymentId}`, 1200)
    ) {
      return;
    }

    try {
      const cancelled = await balanceService.cancelPendingTopUp(
        paymentId,
        ctx.from.id,
      );
      await safeAnswerCbQuery(ctx, 'Счёт на пополнение отменён.');
      await safeRespondOrEdit(
        ctx,
        formatTopUpInvoiceCardMessage(cancelled),
        buildTopUpInvoiceKeyboard(cancelled),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Callback: Справка по поддерживаемым криптовалютам и сетям
  bot.action('topup:crypto_info', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'topup:crypto_info')) {
      return;
    }
    await safeRespondOrEdit(
      ctx,
      formatSupportedCryptoInfoMessage(),
      Markup.inlineKeyboard([
        [Markup.button.callback(`${oeBtn('back')} Назад`, 'menu:topup')],
      ]),
    );
  });

  // Callback: История пополнений пользователя
  bot.action('topup:history', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'topup:history')) {
      return;
    }
    const [topUps, currentBalance] = await Promise.all([
      balanceService.getUserTopUps(ctx.from.id, 10),
      balanceService.getBalance(ctx.from.id),
    ]);
    await safeRespondOrEdit(
      ctx,
      formatUserTopUpHistoryMessage(topUps, currentBalance),
      Markup.inlineKeyboard([
        [Markup.button.callback(`${oeBtn('card')} Пополнить баланс`, 'menu:topup')],
        [Markup.button.callback(`${oeBtn('back')} Назад`, 'menu:profile')],
      ]),
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

    if (
      order.paymentStatus !== 'pending' ||
      order.fulfillmentStatus !== 'pending'
    ) {
      await safeAnswerCbQuery(
        ctx,
        'Оплаченный заказ нельзя отменить самостоятельно.',
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatOrderDetailMessage(order),
        buildUserOrderDetailKeyboard(order),
      );
      return;
    }

    try {
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Обработка свободного текстового ввода пользовательской суммы пополнения в USD ($) на Шаге 2/3
  bot.on('text', async (ctx, next) => {
    if (!ctx.from) return next();
    const session = getUserTopUpSession(ctx.from.id);
    if (!session) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      clearUserTopUpSession(ctx.from.id);
      return next();
    }

    try {
      const validatedAmountUsd = validateTopUpAmountUsd(text);
      await renderTopUpStep2(
        ctx,
        session.provider,
        session.currency,
        validatedAmountUsd,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`${oe('warning')} ${escapeHtml(msg)}`, {
        parse_mode: 'HTML',
      });
    }
  });
}
