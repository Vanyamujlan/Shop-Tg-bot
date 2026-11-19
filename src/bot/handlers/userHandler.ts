import { Context, Markup, Telegraf } from 'telegraf';
import {
  BalanceTopUpProvider,
  Order,
  ProductCategory,
} from '../../types.ts';
import { StorageUnavailableError } from '../../db/firestore.ts';
import { UserService } from '../../services/UserService.ts';
import { ProductService } from '../../services/ProductService.ts';
import {
  OrderService,
  normalizeRecipientUsername,
} from '../../services/OrderService.ts';
import {
  balanceService,
  validateTopUpAmountUsd,
} from '../../services/BalanceService.ts';
import { formatUsd } from '../../config/env.ts';
import { formatUsdCents, usdInputToCents } from '../../services/Money.ts';
import { oe, oeBtn } from '../outlineEmoji.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  XROCKET_SUPPORTED_ASSETS,
  paymentProviderGateway,
} from '../../services/PaymentProviders.ts';
import {
  buildBackToMenuKeyboard,
  buildCatalogCategoriesKeyboard,
  buildCategoryProductsKeyboard,
  buildMainMenuKeyboard,
  buildOrderCheckoutChooserKeyboard,
  buildProductDetailKeyboard,
  buildPromptRecipientKeyboard,
  buildTopUpInvoiceKeyboard,
  buildTopUpStep1ProviderKeyboard,
  buildTopUpStep2AmountKeyboard,
  buildTopUpStep3XRocketCurrencyKeyboard,
  buildUserOrderDetailKeyboard,
  buildUserOrdersKeyboard,
  buildUserProfileKeyboard,
} from '../keyboards.ts';
import {
  LiveCurrencyPreviewItem,
  escapeHtml,
  formatCatalogOverviewMessage,
  formatCategoryListMessage,
  formatHelpMessage,
  formatOrderCheckoutChooserMessage,
  formatOrderDetailMessage,
  formatPaySupportMessage,
  formatProductCardMessage,
  formatPromptRecipientUsernameMessage,
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

export interface UserCheckoutSession {
  mode: 'custom_qty' | 'recipient_username';
  productId: string;
  quantity?: number;
  createdAt: number;
}

const userTopUpSessions = new Map<number, UserTopUpCustomSession>();
const userCheckoutSessions = new Map<number, UserCheckoutSession>();
const USER_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_USER_SESSIONS = 1000;

function pruneMapByTtl<T extends { createdAt: number }>(
  map: Map<number, T>,
): void {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (now - v.createdAt > USER_SESSION_TTL_MS) {
      map.delete(k);
    }
  }
  while (map.size >= MAX_USER_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function setUserTopUpSession(
  telegramId: number,
  session: UserTopUpCustomSession,
): void {
  userCheckoutSessions.delete(telegramId);
  pruneMapByTtl(userTopUpSessions);
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

export function setUserCheckoutSession(
  telegramId: number,
  session: UserCheckoutSession,
): void {
  userTopUpSessions.delete(telegramId);
  pruneMapByTtl(userCheckoutSessions);
  userCheckoutSessions.set(telegramId, session);
}

export function getUserCheckoutSession(
  telegramId: number,
): UserCheckoutSession | undefined {
  const s = userCheckoutSessions.get(telegramId);
  if (!s) return undefined;
  if (Date.now() - s.createdAt > USER_SESSION_TTL_MS) {
    userCheckoutSessions.delete(telegramId);
    return undefined;
  }
  return s;
}

export function clearUserCheckoutSession(telegramId: number): void {
  userCheckoutSessions.delete(telegramId);
}

export function clearAllUserInteractiveSessions(telegramId: number): void {
  userTopUpSessions.delete(telegramId);
  userCheckoutSessions.delete(telegramId);
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

export async function fetchLiveCurrencyPreviews(
  provider: BalanceTopUpProvider,
  amountUsdCents: number,
): Promise<LiveCurrencyPreviewItem[]> {
  let candidateList: Array<{ code: string; networks: string[] }> = [];

  try {
    const supported = await paymentProviderGateway.getSupportedCurrencies(provider);
    if (provider === 'xrocket') {
      const supportedMap = new Map(supported.map((s) => [s.code, s.networks]));
      candidateList = XROCKET_SUPPORTED_ASSETS.map((asset) => ({
        code: asset.code,
        networks:
          supportedMap.get(asset.code)?.length
            ? supportedMap.get(asset.code)!
            : asset.networks,
      }));
    } else {
      const preferredOrder = ['USDT', 'TON', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC'];
      const supportedMap = new Map(supported.map((s) => [s.code, s.networks]));
      candidateList = preferredOrder
        .filter((code) => supportedMap.has(code) || PAYMENT_PROVIDER_CATALOG[provider].supportedCurrencies.includes(code))
        .map((code) => ({
          code,
          networks: supportedMap.get(code) ?? [],
        }));
    }
  } catch {
    if (provider === 'xrocket') {
      candidateList = XROCKET_SUPPORTED_ASSETS.map((a) => ({
        code: a.code,
        networks: a.networks,
      }));
    } else {
      candidateList = ['USDT', 'TON', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC'].map((code) => ({
        code,
        networks: [],
      }));
    }
  }

  const settled = await Promise.allSettled(
    candidateList.map((item) =>
      paymentProviderGateway.getLiveUsdConversion({
        provider,
        amountUsdCents,
        targetCurrency: item.code,
        network: item.networks[0],
      }),
    ),
  );

  return candidateList.map((item, idx) => {
    const outcome = settled[idx];
    if (outcome.status === 'fulfilled') {
      return {
        code: item.code,
        networks: item.networks,
        conversion: outcome.value,
      };
    }
    const reason =
      outcome.reason instanceof Error
        ? outcome.reason.message
        : 'курс временно недоступен';
    return {
      code: item.code,
      networks: item.networks,
      error: reason,
    };
  });
}

export async function renderOrderCheckoutChooser(
  ctx: Context,
  order: Order,
): Promise<void> {
  if (!ctx.from) return;
  const currentBalanceUsdCents = await balanceService.getBalanceUsdCents(ctx.from.id);
  await safeRespondOrEdit(
    ctx,
    formatOrderCheckoutChooserMessage(order, currentBalanceUsdCents),
    buildOrderCheckoutChooserKeyboard(order, currentBalanceUsdCents),
  );
}

async function renderTopUpStep1(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  clearAllUserInteractiveSessions(ctx.from.id);
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
  clearAllUserInteractiveSessions(ctx.from.id);
  let livePreviews: LiveCurrencyPreviewItem[] = [];
  try {
    const amountCents = usdInputToCents(amountPaid);
    livePreviews = await fetchLiveCurrencyPreviews('xrocket', amountCents);
  } catch {
    livePreviews = [];
  }
  await safeRespondOrEdit(
    ctx,
    formatTopUpStep3XRocketCurrencyMessage(amountPaid, livePreviews),
    buildTopUpStep3XRocketCurrencyKeyboard(amountPaid, livePreviews),
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
              'Ваш доступ к QuizyStars ограничен.',
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
            '⚠️ <b>Магазин временно находится в защитном режиме (база данных недоступна).</b>\nОформление новых заказов приостановлено. Попробуйте позже или обратитесь в /paysupport.',
            { parse_mode: 'HTML' },
          );
        }
        return;
      }
      throw error;
    }
  });

  // /start — Главное меню QuizyStars
  bot.start(async (ctx) => {
    if (ctx.from) clearAllUserInteractiveSessions(ctx.from.id);
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
    if (ctx.from) clearAllUserInteractiveSessions(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatCatalogOverviewMessage(),
      buildCatalogCategoriesKeyboard(),
    );
  });

  // /orders — История заказов
  bot.command('orders', async (ctx) => {
    if (!ctx.from) return;
    clearAllUserInteractiveSessions(ctx.from.id);
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
    clearAllUserInteractiveSessions(ctx.from.id);
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
    clearAllUserInteractiveSessions(ctx.from.id);
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
    clearAllUserInteractiveSessions(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatCatalogOverviewMessage(),
      buildCatalogCategoriesKeyboard(),
    );
  });

  // Callback: Мои заказы
  bot.action('menu:orders', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:orders')) return;
    clearAllUserInteractiveSessions(ctx.from.id);
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
    clearAllUserInteractiveSessions(ctx.from.id);
    const user = await UserService.upsertFromTelegram(ctx.from);
    const isAdmin = await UserService.isAdmin(ctx.from.id);
    await safeRespondOrEdit(
      ctx,
      formatUserProfileMessage(user, isAdmin),
      buildUserProfileKeyboard(),
    );
  });

  // Callback: Пополнение баланса
  bot.action('menu:topup', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'menu:topup')) return;
    await renderTopUpStep1(ctx);
  });

  // Callback: Шаг 1/3 -> Шаг 2/3 Выбор провайдера пополнения
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

  // Callback: Выбор валюты пополнения
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

  // Callback: Пересчёт суммы на Шаге 2/3
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

  // Callback: Шаг 3/3 (для xRocket) — экран выбора монеты и сети с живыми курсами
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

  // Callback: Шаг 3/3 (для xRocket) — создание счёта по выбранной монете и сети
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
        clearAllUserInteractiveSessions(ctx.from.id);
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

  // Callback: Сброс и повторный свободный ввод суммы в USD
  bot.action(
    /^topup:custom:(cryptobot|xrocket):([A-Z0-9]+)$/,
    async (ctx) => {
      const provider = ctx.match[1] as BalanceTopUpProvider;
      const currency = ctx.match[2];
      if (!ctx.from) return;

      await renderTopUpStep2(ctx, provider, currency, undefined);
    },
  );

  // Callback: Создание счёта у провайдера
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
        clearAllUserInteractiveSessions(ctx.from.id);
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

  // Callback: Серверная проверка статуса счёта через API провайдера
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
      if (verifyRes.status === 'paid' || verifyRes.status === 'overpaid') {
        const creditedText = formatUsdCents(
          verifyRes.topUp.amountCreditedUsdCents ??
            Math.round(verifyRes.topUp.amountCredited * 100),
        );
        await safeAnswerCbQuery(
          ctx,
          verifyRes.duplicate
            ? 'Этот счёт уже был оплачен и зачислен ранее.'
            : `Оплата подтверждена! Зачислено +${creditedText}.`,
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

  // Callback: Отмена неоплаченного счёта пополнения
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

  // Callback: Справка по поддерживаемым криптовалютам
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

  // Callback: Выбор категории
  bot.action(/^cat:(stars|premium|gifts)$/, async (ctx) => {
    const category = ctx.match[1] as ProductCategory;
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `cat:${category}`)) {
      return;
    }
    clearAllUserInteractiveSessions(ctx.from.id);

    const products = await ProductService.getProductsByCategory(category, false);
    await safeRespondOrEdit(
      ctx,
      formatCategoryListMessage(category, products),
      buildCategoryProductsKeyboard(category, products),
    );
  });

  // Callback: Карточка товара
  bot.action(/^prod:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `prod:${productId}`)) {
      return;
    }
    clearAllUserInteractiveSessions(ctx.from.id);

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

  // Callback: Детали заказа покупателя
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

  // Callback: Отмена неоплаченного заказа покупателем
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
        const orderCents = updated.totalPriceUsdCents ?? updated.totalPrice;
        await OrderService.logTransaction({
          orderId: updated.orderId,
          userId: updated.userId,
          type: 'order_cancelled',
          amount: orderCents,
          amountUsdCents: orderCents,
          currency: 'USD',
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

  // Текстовый ввод для пользовательских сценариев: количество Stars, @username получателя, сумма пополнения USD
  bot.on('text', async (ctx, next) => {
    if (!ctx.from) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      clearAllUserInteractiveSessions(ctx.from.id);
      return next();
    }

    const checkoutSession = getUserCheckoutSession(ctx.from.id);
    if (checkoutSession) {
      try {
        const product = await ProductService.getProductById(checkoutSession.productId);
        if (!product || !product.isActive) {
          clearUserCheckoutSession(ctx.from.id);
          await ctx.reply('❌ Товар больше недоступен для покупки.', {
            parse_mode: 'HTML',
            ...buildBackToMenuKeyboard(),
          });
          return;
        }

        if (checkoutSession.mode === 'custom_qty') {
          const calc = ProductService.calculateOrderPriceUsdCents(product, text);
          setUserCheckoutSession(ctx.from.id, {
            mode: 'recipient_username',
            productId: product.id,
            quantity: calc.quantity,
            createdAt: Date.now(),
          });
          await ctx.reply(
            formatPromptRecipientUsernameMessage({
              productName: `${product.name} (${calc.quantity} ⭐)`,
              quantity: calc.quantity,
              totalPriceUsdCents: calc.totalPriceUsdCents,
            }),
            {
              parse_mode: 'HTML',
              ...buildPromptRecipientKeyboard(product.id, ctx.from.username),
            },
          );
          return;
        }

        if (checkoutSession.mode === 'recipient_username') {
          const normalized = normalizeRecipientUsername(text);
          if (!normalized) {
            throw new Error('Укажите @username получателя.');
          }
          const qty = checkoutSession.quantity ?? 1;
          const order = await OrderService.createOrder({
            telegramUser: ctx.from,
            productId: product.id,
            quantity: qty,
            recipientUsername: normalized,
          });
          clearUserCheckoutSession(ctx.from.id);
          const balCents = await balanceService.getBalanceUsdCents(ctx.from.id);
          await ctx.reply(
            formatOrderCheckoutChooserMessage(order, balCents),
            {
              parse_mode: 'HTML',
              ...buildOrderCheckoutChooserKeyboard(order, balCents),
            },
          );
          return;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await ctx.reply(`${oe('warning')} ${escapeHtml(msg)}`, {
          parse_mode: 'HTML',
        });
        return;
      }
    }

    const session = getUserTopUpSession(ctx.from.id);
    if (!session) return next();

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
