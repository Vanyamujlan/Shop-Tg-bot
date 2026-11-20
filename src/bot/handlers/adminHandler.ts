import { Context, Markup, Telegraf } from 'telegraf';
import {
  AdminInteractiveSession,
  BalanceTopUpStatus,
  BotConnectionStatus,
  OrderStatus,
  ProductCategory,
} from '../../types.ts';
import { CATEGORY_LABELS } from '../../constants.ts';
import { UserService } from '../../services/UserService.ts';
import { ProductService } from '../../services/ProductService.ts';
import { OrderService } from '../../services/OrderService.ts';
import { FulfillmentService } from '../../services/FulfillmentService.ts';
import { myStarsClient } from '../../services/MyStarsService.ts';
import { balanceService } from '../../services/BalanceService.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  paymentProviderGateway,
} from '../../services/PaymentProviders.ts';
import { firestoreRepo } from '../../db/firestore.ts';
import {
  formatUsd,
  getEnvConfig,
  isOwnerTelegramId,
} from '../../config/env.ts';
import {
  formatUsdCents,
  usdInputToCents,
} from '../../services/Money.ts';
import {
  DigitalKeyService,
  DuplicateDigitalKeyError,
  OwnerAccessDeniedError,
  UnsupportedKeyGeneratorError,
} from '../../services/DigitalKeyService.ts';
import {
  buildAdminCategoryPickKeyboard,
  buildAdminMainKeyboard,
  buildAdminOrderActionKeyboard,
  buildAdminOrderBalanceRefundConfirmKeyboard,
  buildAdminOrdersKeyboard,
  buildAdminPremiumDurationPickKeyboard,
  buildAdminProductManageKeyboard,
  buildAdminProductsKeyboard,
  buildAdminTopUpDetailKeyboard,
  buildAdminTopUpsKeyboard,
  buildAdminUserManageKeyboard,
  buildAdminUsersKeyboard,
  buildOwnerAvailableKeysKeyboard,
  buildOwnerKeysHomeKeyboard,
  buildOwnerProductKeysKeyboard,
} from '../keyboards.ts';
import {
  escapeHtml,
  formatAdminCatalogDiagnosticsSummary,
  formatAdminOrderCard,
  formatAdminStatsMessage,
  formatAdminTopUpCard,
  formatDateRu,
  formatOwnerAvailableKeysListMessage,
  formatOwnerDeliveredKeysListMessage,
  formatOwnerKeyDeliveryHistoryMessage,
  formatOwnerKeysOverviewMessage,
  formatOwnerProductKeysMessage,
  formatProductCardMessage,
  formatUserProfileMessage,
} from '../formatters.ts';
import {
  isDuplicateCallbackClick,
  registerSessionCleanupHook,
  safeAnswerCbQuery,
  safeRespondOrEdit,
} from './userHandler.ts';

const adminSessions = new Map<number, AdminInteractiveSession>();
const ADMIN_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ADMIN_SESSIONS = 200;

function pruneAdminSessions(now = Date.now()): void {
  for (const [adminId, session] of adminSessions.entries()) {
    if (now - session.createdAt > ADMIN_SESSION_TTL_MS) {
      adminSessions.delete(adminId);
    }
  }
  while (adminSessions.size > MAX_ADMIN_SESSIONS) {
    const oldestKey = adminSessions.keys().next().value;
    if (oldestKey === undefined) break;
    adminSessions.delete(oldestKey);
  }
}

export function setAdminSession(
  adminId: number,
  session: AdminInteractiveSession,
): void {
  pruneAdminSessions();
  adminSessions.set(adminId, session);
}

export function getAdminSession(
  adminId: number,
): AdminInteractiveSession | undefined {
  const session = adminSessions.get(adminId);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > ADMIN_SESSION_TTL_MS) {
    adminSessions.delete(adminId);
    return undefined;
  }
  return session;
}

export function clearAdminSession(adminId: number): void {
  adminSessions.delete(adminId);
}

export async function ensureAdmin(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  const isAdmin = await UserService.isAdmin(telegramId);
  if (!isAdmin) {
    if (ctx.callbackQuery) {
      await safeAnswerCbQuery(
        ctx,
        '⛔ Доступ разрешён только администраторам.',
        true,
      );
    } else {
      await ctx.reply('⛔ У вас нет прав доступа к панели администратора.');
    }
    return false;
  }
  return true;
}

export async function ensureOwner(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!isOwnerTelegramId(telegramId)) {
    if (ctx.callbackQuery) {
      await safeAnswerCbQuery(
        ctx,
        '⛔ Доступ к генератору и складу ключей разрешён исключительно владельцу бота (OWNER_TELEGRAM_ID).',
        true,
      );
    } else {
      await ctx.reply(
        '⛔ Доступ запрещён: управление цифровыми ключами доступно исключительно владельцу бота (OWNER_TELEGRAM_ID).',
      );
    }
    return false;
  }
  return true;
}

async function logAdminAudit(
  adminTelegramId: number,
  orderId: string,
  amount: number,
  details: string,
): Promise<void> {
  try {
    await OrderService.logTransaction({
      orderId,
      userId: `tg_${adminTelegramId}`,
      type: 'admin_action',
      amount,
      details: `[Админ ${adminTelegramId}] ${details}`,
    });
  } catch (error) {
    console.warn(
      '[AdminHandler] Не удалось записать аудит действия админа:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function registerAdminHandlers(
  bot: Telegraf,
  getBotStatus: () => BotConnectionStatus,
): void {
  registerSessionCleanupHook(clearAdminSession);

  // Команда /admin
  bot.command('admin', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    clearAdminSession(ctx.from!.id);
    const isOwner = isOwnerTelegramId(ctx.from!.id);
    await safeRespondOrEdit(
      ctx,
      [
        '🛠 <b>Панель администратора QuizyStars</b>',
        '',
        'Выберите раздел для управления каталогом, заказами, пользователями или просмотра статуса интеграций:',
      ].join('\n'),
      buildAdminMainKeyboard(isOwner),
    );
  });

  // Главная страница админ-панели
  bot.action('adm:home', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:home')) return;
    clearAdminSession(ctx.from!.id);
    const isOwner = isOwnerTelegramId(ctx.from!.id);
    await safeRespondOrEdit(
      ctx,
      [
        '🛠 <b>Панель администратора QuizyStars</b>',
        '',
        'Выберите раздел для управления:',
      ].join('\n'),
      buildAdminMainKeyboard(isOwner),
    );
  });

  // 1. Статистика магазина
  bot.action('adm:stats', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:stats')) return;

    const [users, orders, products, recentTransactions, topUps] =
      await Promise.all([
        UserService.getAllUsers(200),
        OrderService.getAllOrders(undefined, 200),
        ProductService.getAllProducts(true, 200),
        OrderService.getRecentTransactions(6),
        balanceService.getAllTopUps(undefined, 200),
      ]);

    const totalUsdRevenueCents = orders
      .filter(
        (o) =>
          o.currency !== 'XTR' &&
          (o.paymentStatus === 'paid' ||
            o.paymentStatus === 'processing' ||
            o.paymentStatus === 'completed'),
      )
      .reduce(
        (acc, o) =>
          acc + (o.grossRevenueUsdCents ?? o.totalPriceUsdCents ?? o.totalPrice),
        0,
      );

    const paidTopUps = topUps.filter(
      (t) => t.paymentStatus === 'paid' || t.paymentStatus === 'overpaid',
    );
    const totalTopUpCreditedCents = paidTopUps.reduce(
      (acc, t) =>
        acc +
        (typeof t.amountCreditedUsdCents === 'number'
          ? t.amountCreditedUsdCents
          : Math.round(t.amountCredited * 100)),
      0,
    );
    const totalTopUpFeesCents = paidTopUps.reduce(
      (acc, t) =>
        acc +
        (typeof t.feeUsdCents === 'number'
          ? t.feeUsdCents
          : Math.round(t.feeAmount * 100)),
      0,
    );

    const text = formatAdminStatsMessage({
      totalUsers: users.length,
      blockedUsers: users.filter((u) => u.isBlocked).length,
      totalOrders: orders.length,
      pendingOrdersCount: orders.filter((o) => o.paymentStatus === 'pending').length,
      paidOrdersCount: orders.filter(
        (o) =>
          o.fulfillmentStatus === 'paid' || o.fulfillmentStatus === 'processing',
      ).length,
      completedOrdersCount: orders.filter(
        (o) => o.fulfillmentStatus === 'completed',
      ).length,
      refundedOrdersCount: orders.filter((o) => o.paymentStatus === 'refunded')
        .length,
      totalUsdRevenueCents,
      totalProducts: products.length,
      activeProducts: products.filter((p) => p.isActive).length,
      recentTransactions,
      totalTopUpsCount: topUps.length,
      paidTopUpsCount: paidTopUps.length,
      totalTopUpCreditedCents,
      totalTopUpFeesCents,
    });

    await safeRespondOrEdit(
      ctx,
      text,
      buildAdminMainKeyboard(isOwnerTelegramId(ctx.from!.id)),
    );
  });

  // 1b. Просмотр и фильтрация пополнений баланса в админ-панели
  bot.action(/^adm:topups:(all|paid|pending|failed)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const filterRaw = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:topups:${filterRaw}`)) return;

    const allTopUps = await balanceService.getAllTopUps(undefined, 60);
    const filtered =
      filterRaw === 'all'
        ? allTopUps
        : filterRaw === 'failed'
          ? allTopUps.filter(
              (t) =>
                t.paymentStatus === 'failed' ||
                t.paymentStatus === 'underpaid' ||
                t.paymentStatus === 'expired' ||
                t.paymentStatus === 'cancelled',
            )
          : allTopUps.filter(
              (t) => t.paymentStatus === (filterRaw as BalanceTopUpStatus),
            );

    const paidList = allTopUps.filter(
      (t) => t.paymentStatus === 'paid' || t.paymentStatus === 'overpaid',
    );
    const totalPaidInCents = paidList.reduce(
      (acc, t) =>
        acc +
        (typeof t.amountUsdCents === 'number'
          ? t.amountUsdCents
          : usdInputToCents(t.amountUsd ?? t.amountPaid)),
      0,
    );
    const totalCreditedCents = paidList.reduce(
      (acc, t) =>
        acc +
        (typeof t.amountCreditedUsdCents === 'number'
          ? t.amountCreditedUsdCents
          : Math.round(t.amountCredited * 100)),
      0,
    );
    const totalFeeCents = paidList.reduce(
      (acc, t) =>
        acc +
        (typeof t.feeUsdCents === 'number'
          ? t.feeUsdCents
          : Math.round(t.feeAmount * 100)),
      0,
    );

    const summaryLines = [
      `💳 <b>Пополнения баланса USD (фильтр: ${filterRaw}, найдено: ${filtered.length})</b>`,
      `• Успешных пополнений: <b>${paidList.length}</b>`,
      `• Внесено покупателями: <code>${formatUsdCents(totalPaidInCents)}</code>`,
      `• Удержано комиссии магазином: <code>${formatUsdCents(totalFeeCents)}</code>`,
      `• Зачислено на балансы: <code>${formatUsdCents(totalCreditedCents)}</code>`,
      '',
      filtered.length === 0
        ? 'Записей о пополнениях по выбранному фильтру пока нет.'
        : 'Нажмите на пополнение для просмотра деталей:',
    ].join('\n');

    await safeRespondOrEdit(
      ctx,
      summaryLines,
      buildAdminTopUpsKeyboard(filtered),
    );
  });

  // Детали конкретного пополнения баланса для админа
  bot.action(/^adm:topup:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const paymentId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:topup:${paymentId}`)) return;

    const topUp = await balanceService.getTopUpById(paymentId);
    if (!topUp) {
      await safeAnswerCbQuery(ctx, 'Запись о пополнении не найдена.', true);
      return;
    }

    await safeRespondOrEdit(
      ctx,
      formatAdminTopUpCard(topUp),
      buildAdminTopUpDetailKeyboard(topUp),
    );
  });

  // Принудительная проверка статуса пополнения через API провайдера из админки
  bot.action(/^adm:topup_check:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const paymentId = ctx.match[1];
    if (
      isDuplicateCallbackClick(ctx.from!.id, `adm:topup_check:${paymentId}`, 1500)
    ) {
      return;
    }

    try {
      const res = await balanceService.verifyAndProcessTopUp(paymentId);
      await logAdminAudit(
        ctx.from!.id,
        paymentId,
        res.topUp.amountPaid,
        `Проверил статус пополнения через API (${res.topUp.provider}): status=${res.status}`,
      );
      await safeAnswerCbQuery(
        ctx,
        `Статус у провайдера: ${res.status}${res.reason ? ` (${res.reason})` : ''}`,
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminTopUpCard(res.topUp),
        buildAdminTopUpDetailKeyboard(res.topUp),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 2. Список заказов (с фильтрацией)
  bot.action(/^adm:orders:(all|paid|processing|completed|failed)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const filterRaw = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:orders:${filterRaw}`)) return;

    const filter =
      filterRaw === 'all' ? undefined : (filterRaw as OrderStatus);

    const orders = await OrderService.getAllOrders(filter, 50);
    const header =
      orders.length === 0
        ? `📦 <b>Управление заказами (${filterRaw})</b>\n\nЗаказов по выбранному фильтру пока нет.`
        : `📦 <b>Управление заказами (${filterRaw}, найдено: ${orders.length})</b>\n\nНажмите на заказ для просмотра деталей или ручной выдачи:`;

    await safeRespondOrEdit(ctx, header, buildAdminOrdersKeyboard(orders));
  });

  // Карточка заказа для админа
  bot.action(/^adm:ord:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord:${orderId}`)) return;

    const order = await OrderService.getOrderById(orderId);
    if (!order) {
      await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
      return;
    }

    await safeRespondOrEdit(
      ctx,
      formatAdminOrderCard(order),
      buildAdminOrderActionKeyboard(order),
    );
  });

  // Перевести заказ в статус processing («В обработке») — AUD-005: только для оплаченных заказов
  bot.action(/^adm:ord_proc:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_proc:${orderId}`, 1500)) {
      return;
    }

    const existing = await OrderService.getOrderById(orderId);
    if (!existing) {
      await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
      return;
    }

    if (
      existing.paymentStatus !== 'paid' &&
      existing.paymentStatus !== 'processing'
    ) {
      await safeAnswerCbQuery(
        ctx,
        `Невозможно взять заказ в обработку: статус оплаты «${existing.paymentStatus}» (требуется оплата).`,
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(existing),
        buildAdminOrderActionKeyboard(existing),
      );
      return;
    }

    if (
      existing.fulfillmentStatus === 'completed' ||
      existing.fulfillmentStatus === 'refunded' ||
      existing.fulfillmentStatus === 'cancelled'
    ) {
      await safeAnswerCbQuery(
        ctx,
        `Заказ уже находится в финальном статусе «${existing.fulfillmentStatus}».`,
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(existing),
        buildAdminOrderActionKeyboard(existing),
      );
      return;
    }

    try {
      const updated = await OrderService.updateOrderStatus({
        orderId,
        fulfillmentStatus: 'processing',
        fulfillmentNote: 'Администратор взял заказ в обработку.',
      });
      if (!updated) {
        await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
        return;
      }

      await logAdminAudit(
        ctx.from!.id,
        orderId,
        updated.totalPrice,
        'Взял заказ в обработку (processing)',
      );
      await safeAnswerCbQuery(ctx, 'Статус изменён на «В обработке»');
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(updated),
        buildAdminOrderActionKeyboard(updated),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Быстрое подтверждение выдачи заказа (completed) + уведомление покупателя
  bot.action(/^adm:ord_done:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_done:${orderId}`, 2000)) {
      return;
    }

    try {
      const completed = await FulfillmentService.completeOrder({
        orderId,
        adminNote: 'Товар выдан администратором. Приятного пользования!',
        adminTelegramId: ctx.from!.id,
        bot,
      });

      await safeAnswerCbQuery(
        ctx,
        'Заказ отмечен как выполненный, покупатель уведомлён!',
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(completed),
        buildAdminOrderActionKeyboard(completed),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Выдача заказа с персональным сообщением, ссылкой или кодом активации (AUD-005: только для оплаченных)
  bot.action(/^adm:ord_note:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_note:${orderId}`)) {
      return;
    }

    const order = await OrderService.getOrderById(orderId);
    if (!order) {
      await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
      return;
    }

    if (
      order.paymentStatus !== 'paid' &&
      order.paymentStatus !== 'processing'
    ) {
      await safeAnswerCbQuery(
        ctx,
        `Невозможно выдать заказ без оплаты (текущий статус: «${order.paymentStatus}»).`,
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(order),
        buildAdminOrderActionKeyboard(order),
      );
      return;
    }

    if (
      order.fulfillmentStatus === 'completed' ||
      order.fulfillmentStatus === 'refunded' ||
      order.fulfillmentStatus === 'cancelled'
    ) {
      await safeAnswerCbQuery(
        ctx,
        `Заказ уже имеет финальный статус «${order.fulfillmentStatus}».`,
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(order),
        buildAdminOrderActionKeyboard(order),
      );
      return;
    }

    setAdminSession(ctx.from!.id, {
      action: 'complete_order_note',
      targetId: orderId,
      createdAt: Date.now(),
    });

    await safeRespondOrEdit(
      ctx,
      [
        `📝 <b>Выдача заказа #${escapeHtml(order.orderId)} с кодом или сообщением</b>`,
        `Товар: <b>${escapeHtml(order.productName)}</b>`,
        `Покупатель: <code>${order.userTelegramId}</code>`,
        '',
        'Отправьте в чат текст, ссылку или код активации — он будет сохранён в заказе и сразу отправлен покупателю вместе с уведомлением о выполнении заказа:',
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', `adm:ord:${order.orderId}`)],
      ]),
    );
  });

  // Повторная отправка уведомлений по заказу (админу и покупателю)
  bot.action(/^adm:ord_notify:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_notify:${orderId}`, 1500)) {
      return;
    }

    try {
      const res = await FulfillmentService.retryOrderNotifications(orderId, bot);
      await logAdminAudit(
        ctx.from!.id,
        orderId,
        res.order.totalPrice,
        'Повторная отправка уведомлений по заказу',
      );
      await safeAnswerCbQuery(
        ctx,
        `Уведомления отправлены (админ: ${res.adminNotified ? 'да' : 'нет'}, покупатель: ${res.buyerNotified ? 'да' : 'нет'})`,
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(res.order),
        buildAdminOrderActionKeyboard(res.order),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Возврат Telegram Stars (XTR) отключён вместе с XTR checkout
  bot.action(/^adm:ord_refund:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    await safeAnswerCbQuery(
      ctx,
      'Оплата и возвраты через Telegram Stars (XTR) отключены в QuizyStars.',
      true,
    );
  });

  bot.action(/^adm:ord_refund_confirm:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    await safeAnswerCbQuery(
      ctx,
      'Оплата и возвраты через Telegram Stars (XTR) отключены в QuizyStars.',
      true,
    );
  });

  // Возврат заказа, оплаченного с внутреннего баланса, обратно на внутренний баланс (Шаг 1 из 2)
  bot.action(/^adm:ord_bal_refund:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (
      isDuplicateCallbackClick(ctx.from!.id, `adm:ord_bal_refund:${orderId}`, 1500)
    ) {
      return;
    }

    const order = await OrderService.getOrderById(orderId);
    if (!order || order.paymentMethod !== 'balance') {
      await safeAnswerCbQuery(
        ctx,
        'Заказ не найден или не был оплачен с внутреннего баланса.',
        true,
      );
      return;
    }

    if (order.paymentStatus === 'refunded' || order.balanceRefunded) {
      await safeAnswerCbQuery(
        ctx,
        'По этому заказу уже выполнен возврат на внутренний баланс.',
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(order),
        buildAdminOrderActionKeyboard(order),
      );
      return;
    }

    const refundCents = order.totalPriceUsdCents ?? order.totalPrice;
    const confirmText = [
      '⚠️ <b>Подтверждение возврата средств на внутренний баланс (Шаг 2 из 2)</b>',
      '',
      `Заказ: <code>#${escapeHtml(order.orderId)}</code>`,
      `Товар: <b>${escapeHtml(order.productName)}</b> (x${order.quantity})`,
      `Покупатель: <code>${order.userTelegramId}</code>${order.username ? ` (@${escapeHtml(order.username)})` : ''}`,
      `Сумма к возврату на внутренний баланс: <b>+${formatUsdCents(refundCents)}</b>`,
      order.fulfillmentStatus === 'completed'
        ? '\n🚨 <b>ВНИМАНИЕ: Заказ уже ВЫПОЛНЕН!</b> При подтверждении средства вернутся на баланс покупателя.'
        : '',
      '',
      'Подтвердите возврат средств на внутренний баланс покупателя:',
    ]
      .filter(Boolean)
      .join('\n');

    await safeRespondOrEdit(
      ctx,
      confirmText,
      buildAdminOrderBalanceRefundConfirmKeyboard(order),
    );
  });

  // Возврат заказа на внутренний баланс (Шаг 2 из 2 — атомарное выполнение)
  bot.action(/^adm:ord_bal_refund_confirm:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (
      isDuplicateCallbackClick(
        ctx.from!.id,
        `adm:ord_bal_refund_confirm:${orderId}`,
        2000,
      )
    ) {
      return;
    }

    try {
      const res = await balanceService.refundOrderToInternalBalance({
        orderId,
        reason: `Возврат на внутренний баланс выполнен администратором (ID: ${ctx.from!.id}).`,
        adminTelegramId: ctx.from!.id,
      });

      if (res.alreadyRefunded) {
        await safeAnswerCbQuery(
          ctx,
          'По этому заказу возврат на баланс уже был выполнен.',
          true,
        );
        await safeRespondOrEdit(
          ctx,
          formatAdminOrderCard(res.order),
          buildAdminOrderActionKeyboard(res.order),
        );
        return;
      }

      const refundCents = res.order.totalPriceUsdCents ?? res.order.totalPrice;
      await logAdminAudit(
        ctx.from!.id,
        orderId,
        refundCents,
        `Выполнил возврат +${formatUsdCents(refundCents)} на внутренний баланс покупателя ${res.order.userTelegramId} (новый баланс: ${formatUsd(res.newBalance)})`,
      );

      try {
        await bot.telegram.sendMessage(
          res.order.userTelegramId,
          `↩️ <b>Возврат средств по заказу #${escapeHtml(res.order.orderId)}</b>\n\nНа ваш внутренний баланс QuizyStars возвращено <b>+${formatUsdCents(refundCents)}</b>. Текущий баланс: <code>${formatUsd(res.newBalance)}</code>.`,
          { parse_mode: 'HTML' },
        );
      } catch {
        // Ignore if user blocked the bot
      }

      await safeAnswerCbQuery(
        ctx,
        'Средства успешно возвращены на внутренний баланс покупателя!',
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(res.order),
        buildAdminOrderActionKeyboard(res.order),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, `Ошибка возврата: ${msg.slice(0, 150)}`, true);
    }
  });

  // Отмена неоплаченного заказа админом (AUD-004: запрет отмены уже оплаченных заказов)
  bot.action(/^adm:ord_cancel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_cancel:${orderId}`, 1500)) {
      return;
    }

    const existing = await OrderService.getOrderById(orderId);
    if (!existing) {
      await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
      return;
    }

    if (
      existing.paymentStatus !== 'pending' ||
      existing.fulfillmentStatus !== 'pending'
    ) {
      await safeAnswerCbQuery(
        ctx,
        `Невозможно отменить заказ: статус оплаты уже «${existing.paymentStatus}» (выдача: «${existing.fulfillmentStatus}»).`,
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(existing),
        buildAdminOrderActionKeyboard(existing),
      );
      return;
    }

    try {
      const updated = await OrderService.updateOrderStatus({
        orderId,
        paymentStatus: 'cancelled',
        fulfillmentStatus: 'cancelled',
        fulfillmentNote: `Отменён администратором (ID: ${ctx.from!.id}).`,
      });
      if (!updated) return;

      await logAdminAudit(
        ctx.from!.id,
        orderId,
        updated.totalPrice,
        'Отменил неоплаченный заказ',
      );

      await safeAnswerCbQuery(ctx, 'Неоплаченный заказ отменён.');
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(updated),
        buildAdminOrderActionKeyboard(updated),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 3. Управление товарами
  const renderAdminProductsScreen = async (ctx: Context, notice?: string) => {
    const [products, diag] = await Promise.all([
      ProductService.getAllProducts(true),
      ProductService.diagnoseBuyerCatalog(),
    ]);

    await safeRespondOrEdit(
      ctx,
      [
        `🛍 <b>Управление товарами (всего: ${products.length})</b>`,
        notice ? `\n${notice}` : '',
        '',
        '🟢 — товар активен и виден покупателям',
        '🔴 — товар временно скрыт из каталога',
        '',
        formatAdminCatalogDiagnosticsSummary(diag),
        '',
        'Выберите товар для изменения цены, описания или статуса:',
      ]
        .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
        .join('\n'),
      buildAdminProductsKeyboard(products, diag.hasMissing),
    );
  };

  bot.action('adm:products', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:products')) return;
    clearAdminSession(ctx.from!.id);
    await renderAdminProductsScreen(ctx);
  });

  // Безопасное создание только отсутствующих канонических тарифов Stars/Premium
  bot.action('adm:restore_canonical', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:restore_canonical', 1500)) {
      return;
    }

    const res = await ProductService.ensureMissingCanonicalBuyerProducts();
    if (res.createdIds.length > 0) {
      await logAdminAudit(
        ctx.from!.id,
        'canonical_catalog',
        0,
        `Создал недостающие обязательные тарифы: ${res.createdIds.join(', ')}`,
      );
      await safeAnswerCbQuery(
        ctx,
        `Создано недостающих тарифов: ${res.createdIds.length}`,
        true,
      );
    } else {
      await safeAnswerCbQuery(
        ctx,
        'Все обязательные документы уже присутствуют в БД (перезапись не выполнялась).',
        true,
      );
    }

    const notice =
      res.createdIds.length > 0
        ? `✅ Созданы недостающие тарифы: <code>${escapeHtml(res.createdIds.join(', '))}</code> (существующие товары и цены не изменены).`
        : 'ℹ️ Отсутствующих документов Stars/Premium не найдено; существующие товары не перезаписывались.';

    await renderAdminProductsScreen(ctx, notice);
  });

  const formatCanonicalProductWarning = async (productId: string): Promise<string> => {
    const diag = await ProductService.diagnoseBuyerCatalog();
    const entry = diag.items.find((i) => i.id === productId);
    if (!entry || entry.status === 'ok') return '';
    return `⚠️ <b>Предупреждение каталога:</b> ${escapeHtml(entry.reason || entry.status)}`;
  };

  // Карточка управления конкретным товаром
  bot.action(/^adm:prod:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const productId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:prod:${productId}`)) return;

    const product = await ProductService.getProductById(productId);
    if (!product) {
      await safeAnswerCbQuery(ctx, 'Товар не найден.', true);
      return;
    }

    const warning = await formatCanonicalProductWarning(product.id);
    await safeRespondOrEdit(
      ctx,
      [
        `⚙️ <b>Редактирование товара</b> (ID: <code>${escapeHtml(product.id)}</code>)`,
        `Статус: ${product.isActive ? '🟢 Активен' : '🔴 Отключён'}`,
        warning,
        '',
        formatProductCardMessage(product),
      ]
        .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === '') && (idx === 3 || line !== ''))
        .join('\n'),
      buildAdminProductManageKeyboard(product),
    );
  });

  // Переключение активности товара
  bot.action(/^adm:ptoggle:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const productId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ptoggle:${productId}`, 1200)) {
      return;
    }

    const updated = await ProductService.toggleProductActive(productId);
    if (!updated) {
      await safeAnswerCbQuery(ctx, 'Товар не найден.', true);
      return;
    }

    await logAdminAudit(
      ctx.from!.id,
      productId,
      updated.price,
      `${updated.isActive ? 'Включил' : 'Отключил'} товар "${updated.name}"`,
    );

    await safeAnswerCbQuery(
      ctx,
      updated.isActive ? 'Товар включён в каталоге!' : 'Товар скрыт из каталога.',
    );
    const warning = await formatCanonicalProductWarning(updated.id);
    await safeRespondOrEdit(
      ctx,
      [
        `⚙️ <b>Редактирование товара</b> (ID: <code>${escapeHtml(updated.id)}</code>)`,
        `Статус: ${updated.isActive ? '🟢 Активен' : '🔴 Отключён'}`,
        warning,
        '',
        formatProductCardMessage(updated),
      ]
        .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === '') && (idx === 3 || line !== ''))
        .join('\n'),
      buildAdminProductManageKeyboard(updated),
    );
  });

  // Удаление товара
  bot.action(/^adm:pdel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const productId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:pdel:${productId}`, 2000)) {
      return;
    }

    await ProductService.deleteProduct(productId);
    await logAdminAudit(ctx.from!.id, productId, 0, `Удалил товар ${productId}`);
    await safeAnswerCbQuery(ctx, 'Товар удалён из каталога.');
    await renderAdminProductsScreen(ctx, '🗑 Товар успешно удалён.');
  });

  // Запрос ввода новой цены товара
  bot.action(/^adm:pprice:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const productId = ctx.match[1];
    const product = await ProductService.getProductById(productId);
    if (!product) return;

    setAdminSession(ctx.from!.id, {
      action: 'edit_price',
      targetId: productId,
      createdAt: Date.now(),
    });

    const currentCents = product.priceUsdCents ?? product.price;
    await safeRespondOrEdit(
      ctx,
      [
        `💰 <b>Изменение цены товара:</b> ${escapeHtml(product.name)}`,
        `Текущая цена: <code>${formatUsdCents(currentCents)}</code>`,
        '',
        'Отправьте в чат новую цену в USD (например: <code>13.90</code> или <code>0.90</code>):',
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', `adm:prod:${productId}`)],
      ]),
    );
  });

  // Запрос ввода нового названия товара
  bot.action(/^adm:pname:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const productId = ctx.match[1];
    const product = await ProductService.getProductById(productId);
    if (!product) return;

    setAdminSession(ctx.from!.id, {
      action: 'edit_name',
      targetId: productId,
      createdAt: Date.now(),
    });

    await safeRespondOrEdit(
      ctx,
      `✏️ <b>Введите новое название для товара</b> «${escapeHtml(product.name)}»:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', `adm:prod:${productId}`)],
      ]),
    );
  });

  // Запрос ввода нового описания товара
  bot.action(/^adm:pdesc:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const productId = ctx.match[1];
    const product = await ProductService.getProductById(productId);
    if (!product) return;

    setAdminSession(ctx.from!.id, {
      action: 'edit_description',
      targetId: productId,
      createdAt: Date.now(),
    });

    await safeRespondOrEdit(
      ctx,
      `📝 <b>Введите новое описание для товара</b> «${escapeHtml(product.name)}»:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', `adm:prod:${productId}`)],
      ]),
    );
  });

  // Добавление нового товара — шаг 1 (выбор категории)
  bot.action('adm:prod_add_start', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    clearAdminSession(ctx.from!.id);
    await safeRespondOrEdit(
      ctx,
      '➕ <b>Добавление нового товара</b>\n\nШаг 1 из 4: Выберите категорию товара:',
      buildAdminCategoryPickKeyboard(),
    );
  });

  bot.action(/^adm:addcat:(stars|premium|gifts)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const category = ctx.match[1] as ProductCategory;

    if (category === 'premium') {
      clearAdminSession(ctx.from!.id);
      await safeRespondOrEdit(
        ctx,
        [
          `➕ <b>Добавление товара в категорию ${CATEGORY_LABELS.premium}</b>`,
          '',
          'Шаг 2: Выберите фиксированный срок подписки (допустимы только 3, 6 или 12 месяцев):',
        ].join('\n'),
        buildAdminPremiumDurationPickKeyboard(),
      );
      return;
    }

    setAdminSession(ctx.from!.id, {
      action: 'add_product_name',
      draftProduct: { category },
      createdAt: Date.now(),
    });

    await safeRespondOrEdit(
      ctx,
      [
        `➕ <b>Добавление товара в категорию ${CATEGORY_LABELS[category]}</b>`,
        '',
        'Шаг 2 из 4: Отправьте в чат <b>название</b> нового товара:',
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'adm:products')],
      ]),
    );
  });

  bot.action(/^adm:addprem_dur:(3|6|12)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const durationMonths = Number(ctx.match[1]) as 3 | 6 | 12;

    setAdminSession(ctx.from!.id, {
      action: 'add_product_name',
      draftProduct: {
        category: 'premium',
        durationMonths,
      },
      createdAt: Date.now(),
    });

    await safeRespondOrEdit(
      ctx,
      [
        `➕ <b>Добавление товара: ${CATEGORY_LABELS.premium} (${durationMonths} мес.)</b>`,
        '',
        'Отправьте в чат <b>название</b> нового товара:',
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'adm:products')],
      ]),
    );
  });

  // 4. Управление пользователями и блокировками
  bot.action('adm:users', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:users')) return;
    const users = await UserService.getAllUsers(50);
    await safeRespondOrEdit(
      ctx,
      [
        `👥 <b>Пользователи магазина (показано: ${users.length})</b>`,
        '',
        'Нажмите на пользователя для просмотра профиля, отправки сообщения или блокировки:',
      ].join('\n'),
      buildAdminUsersKeyboard(users),
    );
  });

  bot.action(/^adm:usr:(\d+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const targetTgId = Number(ctx.match[1]);
    const user = await UserService.getUserByTelegramId(targetTgId);
    if (!user) {
      await safeAnswerCbQuery(ctx, 'Пользователь не найден.', true);
      return;
    }
    const isTargetAdmin = await UserService.isAdmin(targetTgId);
    await safeRespondOrEdit(
      ctx,
      formatUserProfileMessage(user, isTargetAdmin),
      buildAdminUserManageKeyboard(user),
    );
  });

  bot.action(/^adm:ublock:(\d+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const targetTgId = Number(ctx.match[1]);
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ublock:${targetTgId}`, 1500)) {
      return;
    }

    if (targetTgId === ctx.from!.id) {
      await safeAnswerCbQuery(ctx, 'Нельзя заблокировать самого себя.', true);
      return;
    }

    const existing = await UserService.getUserByTelegramId(targetTgId);
    if (!existing) return;

    const updated = await UserService.setUserBlocked(
      targetTgId,
      !existing.isBlocked,
    );
    if (!updated) return;

    await logAdminAudit(
      ctx.from!.id,
      `user_${targetTgId}`,
      0,
      `${updated.isBlocked ? 'Заблокировал' : 'Разблокировал'} пользователя ${targetTgId}`,
    );

    await safeAnswerCbQuery(
      ctx,
      updated.isBlocked
        ? 'Пользователь заблокирован.'
        : 'Пользователь разблокирован.',
    );

    const isTargetAdmin = await UserService.isAdmin(targetTgId);
    await safeRespondOrEdit(
      ctx,
      formatUserProfileMessage(updated, isTargetAdmin),
      buildAdminUserManageKeyboard(updated),
    );
  });

  // 5. Отправка сообщения пользователю
  bot.action('adm:msg_user_start', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    setAdminSession(ctx.from!.id, {
      action: 'message_user',
      createdAt: Date.now(),
    });
    await safeRespondOrEdit(
      ctx,
      [
        '✉️ <b>Отправка сообщения пользователю от имени бота</b>',
        '',
        'Отправьте сообщение в формате:',
        '<code>TELEGRAM_ID Текст вашего сообщения</code>',
        '',
        'Пример: <code>123456789 Ваш заказ готов к выдаче!</code>',
      ].join('\n'),
      Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm:home')]]),
    );
  });

  bot.action(/^adm:msg_to:(\d+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const targetTgId = ctx.match[1];
    setAdminSession(ctx.from!.id, {
      action: 'message_user',
      targetId: targetTgId,
      createdAt: Date.now(),
    });
    await safeRespondOrEdit(
      ctx,
      `✉️ <b>Отправка сообщения покупателю ID <code>${targetTgId}</code></b>\n\nВведите текст сообщения для отправки:`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm:home')]]),
    );
  });

  // 6. Статус интеграций и просмотр ошибок
  bot.action('adm:integrations', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:integrations')) return;
    const botStatus = getBotStatus();
    const dbStatus = firestoreRepo.getStatus();
    const fulfillmentInfo = FulfillmentService.getAdapterInfo();
    const envConfig = getEnvConfig();
    const recentTx = await OrderService.getRecentTransactions(20);
    const errorTx = recentTx
      .filter((t) => t.type === 'error' || t.type === 'fulfillment_failed')
      .slice(0, 5);

    const errorLines =
      errorTx.length > 0
        ? errorTx.map(
            (e) =>
              `• <code>${formatDateRu(e.createdAt)}</code>: ${escapeHtml(e.details)}`,
          )
        : ['• Ошибок платежей или выдачи не зафиксировано ✅'];

    const mystarsDiag = myStarsClient.getStatusSummary();

    const text = [
      '🔌 <b>Статус интеграций и системный монитор</b>',
      '',
      `🤖 <b>Telegram Bot API:</b> ${
        botStatus.connected
          ? `✅ Подключён (@${escapeHtml(botStatus.botUsername)})`
          : '❌ Не подключён'
      }`,
      `📡 <b>Режим работы бота:</b> <code>${botStatus.mode}</code> (polling активен: ${
        botStatus.pollingActive ? 'Да' : 'Нет'
      })`,
      `🗄 <b>База данных Firestore:</b> проект <code>${escapeHtml(
        dbStatus.projectId,
      )}</code>`,
      `🔐 <b>Firebase Admin SDK:</b> ${
        dbStatus.adminSdkConnected
          ? '✅ Прямое подключение активно'
          : dbStatus.degradedMode
            ? '🚨 Защитный режим недоступности БД (заказы приостановлены)'
            : 'ℹ️ Локальный dev/test режим'
      }`,
      `🚚 <b>Модуль выдачи (FulfillmentService):</b> <code>${escapeHtml(
        fulfillmentInfo.name,
      )}</code> (recovery worker: ${
        FulfillmentService.isRecoveryWorkerActive() ? 'активен' : 'остановлен'
      })`,
      `⭐ <b>Поставщик MyStars FaaS v1:</b> ${
        mystarsDiag.configured
          ? `✅ Настроен (ключ: <code>${escapeHtml(mystarsDiag.maskedApiKey)}</code>, webhook: ${
              mystarsDiag.webhookConfigured
                ? `✅ <code>${escapeHtml(mystarsDiag.maskedWebhookSecret)}</code>`
                : '⚠️ не задан'
            }, валюта: <code>${escapeHtml(mystarsDiag.paymentCurrency)}</code>)`
          : '⚠️ Не настроен (MYSTARS_API_KEY не задан — активен режим ручной выдачи)'
      }`,
      `👑 <b>Администраторов в ADMIN_IDS:</b> ${envConfig.adminIds.length}`,
      '',
      '💳 <b>Платёжные провайдеры (заказы и пополнение баланса):</b>',
      ...(['cryptobot', 'xrocket'] as const).map((p) => {
        const meta = PAYMENT_PROVIDER_CATALOG[p];
        const st = paymentProviderGateway.getProviderStatusSummary()[p];
        return `• <b>${escapeHtml(meta.shortTitle)} (${meta.feePercent}%):</b> ${
          st.configured
            ? `✅ Настроен (ключ: <code>${escapeHtml(st.maskedKey)}</code>)`
            : '⚠️ Не настроен (токен не задан в .env)'
        }`;
      }),
      '',
      '⚠️ <b>Последние системные ошибки:</b>',
      ...errorLines,
    ].join('\n');

    await safeRespondOrEdit(
      ctx,
      text,
      buildAdminMainKeyboard(isOwnerTelegramId(ctx.from!.id)),
    );
  });

  // =========================================================================
  // 7. ГЕНЕРАТОР И СКЛАД ЦИФРОВЫХ КЛЮЧЕЙ (OWNER-ONLY — STAGE 3.3)
  // =========================================================================

  const renderOwnerKeysOverview = async (ctx: Context) => {
    if (!(await ensureOwner(ctx))) return;
    clearAdminSession(ctx.from!.id);
    const [products, summaries] = await Promise.all([
      ProductService.getAllProducts(true),
      DigitalKeyService.getAllProductsStockSummary(ctx.from!.id),
    ]);
    await safeRespondOrEdit(
      ctx,
      formatOwnerKeysOverviewMessage(summaries),
      buildOwnerKeysHomeKeyboard(products, summaries),
    );
  };

  bot.command('keys', async (ctx) => {
    await renderOwnerKeysOverview(ctx);
  });

  bot.action('own:keys:home', async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'own:keys:home')) return;
    await renderOwnerKeysOverview(ctx);
  });

  bot.action(/^own:keys:prod:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    const productId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `own:keys:prod:${productId}`)) {
      return;
    }
    clearAdminSession(ctx.from!.id);

    const product = await ProductService.getProductById(productId);
    if (!product) {
      await safeAnswerCbQuery(ctx, 'Товар не найден.', true);
      return;
    }

    const summary = await DigitalKeyService.getProductStockSummary({
      actorTelegramId: ctx.from!.id,
      productId,
    });

    await safeRespondOrEdit(
      ctx,
      formatOwnerProductKeysMessage(product, summary),
      buildOwnerProductKeysKeyboard(product, summary),
    );
  });

  // Ручное добавление ключей (одиночное или пакетное)
  bot.action(/^own:keys:add:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    const productId = ctx.match[1];
    const product = await ProductService.getProductById(productId);
    if (!product) {
      await safeAnswerCbQuery(ctx, 'Товар не найден.', true);
      return;
    }

    setAdminSession(ctx.from!.id, {
      action: 'owner_add_keys',
      targetId: productId,
      createdAt: Date.now(),
    });

    await safeRespondOrEdit(
      ctx,
      [
        `➕ <b>Добавление цифровых ключей: ${escapeHtml(product.name)}</b>`,
        `🆔 Товар: <code>${escapeHtml(product.id)}</code>`,
        '',
        'Отправьте в чат один ключ или список ключей (каждый ключ — с новой строки).',
        '🔒 Перед сохранением каждый ключ проверяется на уникальность.',
      ].join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            '❌ Отмена',
            `own:keys:prod:${product.id}`,
          ),
        ],
      ]),
    );
  });

  // Автогенерация ключей по внутреннему алгоритму товара
  bot.action(/^own:keys:gen:([a-zA-Z0-9_-]+):(\d+)$/, async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    const productId = ctx.match[1];
    const count = Number(ctx.match[2]);
    if (
      isDuplicateCallbackClick(
        ctx.from!.id,
        `own:keys:gen:${productId}:${count}`,
        1500,
      )
    ) {
      return;
    }

    try {
      const created = await DigitalKeyService.generateKeys({
        actorTelegramId: ctx.from!.id,
        productId,
        count,
      });

      const product = await ProductService.getProductById(productId);
      const summary = await DigitalKeyService.getProductStockSummary({
        actorTelegramId: ctx.from!.id,
        productId,
      });

      await safeAnswerCbQuery(
        ctx,
        `Сгенерировано ключей: ${created.length} шт.`,
        true,
      );

      if (product) {
        const previewList = created
          .map((k, idx) => `${idx + 1}. <code>${escapeHtml(k.keyValue)}</code>`)
          .join('\n');
        await safeRespondOrEdit(
          ctx,
          [
            `✅ <b>Сгенерировано ${created.length} новых ключей!</b>`,
            previewList,
            '',
            formatOwnerProductKeysMessage(product, summary),
          ].join('\n'),
          buildOwnerProductKeysKeyboard(product, summary),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Список доступных ключей (с возможностью отключения)
  bot.action(/^own:keys:avail:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    const productId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `own:keys:avail:${productId}`)) {
      return;
    }

    const product = await ProductService.getProductById(productId);
    if (!product) {
      await safeAnswerCbQuery(ctx, 'Товар не найден.', true);
      return;
    }

    const availKeys = await DigitalKeyService.listKeysForProduct({
      actorTelegramId: ctx.from!.id,
      productId,
      status: 'available',
      limit: 20,
    });

    await safeRespondOrEdit(
      ctx,
      formatOwnerAvailableKeysListMessage(product, availKeys),
      buildOwnerAvailableKeysKeyboard(productId, availKeys),
    );
  });

  // Отключение неиспользованного ключа
  bot.action(/^own:keys:disable:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    const keyId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `own:keys:disable:${keyId}`, 1500)) {
      return;
    }

    try {
      const disabled = await DigitalKeyService.disableKey({
        actorTelegramId: ctx.from!.id,
        keyId,
      });

      await safeAnswerCbQuery(
        ctx,
        `Ключ ${disabled.maskedPreview} отключён (disabled).`,
        true,
      );

      const product = await ProductService.getProductById(disabled.productId);
      if (product) {
        const availKeys = await DigitalKeyService.listKeysForProduct({
          actorTelegramId: ctx.from!.id,
          productId: disabled.productId,
          status: 'available',
          limit: 20,
        });
        await safeRespondOrEdit(
          ctx,
          formatOwnerAvailableKeysListMessage(product, availKeys),
          buildOwnerAvailableKeysKeyboard(disabled.productId, availKeys),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // Список выданных ключей по товару
  bot.action(/^own:keys:deliv:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    const productId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `own:keys:deliv:${productId}`)) {
      return;
    }

    const product = await ProductService.getProductById(productId);
    if (!product) {
      await safeAnswerCbQuery(ctx, 'Товар не найден.', true);
      return;
    }

    const deliveredKeys = await DigitalKeyService.listKeysForProduct({
      actorTelegramId: ctx.from!.id,
      productId,
      status: 'delivered',
      limit: 20,
    });

    await safeRespondOrEdit(
      ctx,
      formatOwnerDeliveredKeysListMessage(product, deliveredKeys),
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            '⬅️ Назад к товару',
            `own:keys:prod:${productId}`,
          ),
        ],
      ]),
    );
  });

  // Общая история выдачи ключей
  bot.action('own:keys:history', async (ctx) => {
    if (!(await ensureOwner(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'own:keys:history')) return;

    const history = await DigitalKeyService.getKeyDeliveryHistory({
      actorTelegramId: ctx.from!.id,
      limit: 25,
    });

    await safeRespondOrEdit(
      ctx,
      formatOwnerKeyDeliveryHistoryMessage(history),
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ К складу ключей', 'own:keys:home')],
      ]),
    );
  });

  // Обработка текстового ввода для активных админ-сессий
  bot.on('text', async (ctx, next) => {
    if (!ctx.from) return next();
    const session = getAdminSession(ctx.from.id);
    if (!session) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      clearAdminSession(ctx.from.id);
      return next();
    }

    if (!(await ensureAdmin(ctx))) {
      clearAdminSession(ctx.from.id);
      return;
    }

    try {
      if (session.action === 'complete_order_note' && session.targetId) {
        const orderId = session.targetId;
        clearAdminSession(ctx.from.id);
        const completed = await FulfillmentService.completeOrder({
          orderId,
          adminNote: text,
          adminTelegramId: ctx.from.id,
          bot,
        });
        await ctx.reply(
          `✅ <b>Заказ #${escapeHtml(completed.orderId)} выполнен, сообщение отправлено покупателю!</b>\n\n${formatAdminOrderCard(completed)}`,
          {
            parse_mode: 'HTML',
            ...buildAdminOrderActionKeyboard(completed),
          },
        );
        return;
      }

      if (session.action === 'edit_price' && session.targetId) {
        const priceCents = usdInputToCents(text);
        const updated = await ProductService.updateProductPriceUsdCents(
          session.targetId,
          priceCents,
        );
        clearAdminSession(ctx.from.id);
        if (!updated) {
          await ctx.reply('❌ Товар не найден.');
          return;
        }
        await logAdminAudit(
          ctx.from.id,
          updated.id,
          priceCents,
          `Изменил цену товара "${updated.name}" на ${formatUsdCents(priceCents)}`,
        );
        await ctx.reply(
          `✅ <b>Цена товара обновлена!</b>\n\n${formatProductCardMessage(updated)}`,
          {
            parse_mode: 'HTML',
            ...buildAdminProductManageKeyboard(updated),
          },
        );
        return;
      }

      if (session.action === 'edit_name' && session.targetId) {
        const updated = await ProductService.updateProductDetails(
          session.targetId,
          { name: text },
        );
        clearAdminSession(ctx.from.id);
        if (!updated) return;
        await logAdminAudit(
          ctx.from.id,
          updated.id,
          updated.price,
          `Изменил название товара на "${updated.name}"`,
        );
        await ctx.reply(
          `✅ <b>Название товара обновлено!</b>\n\n${formatProductCardMessage(updated)}`,
          {
            parse_mode: 'HTML',
            ...buildAdminProductManageKeyboard(updated),
          },
        );
        return;
      }

      if (session.action === 'edit_description' && session.targetId) {
        const updated = await ProductService.updateProductDetails(
          session.targetId,
          { description: text },
        );
        clearAdminSession(ctx.from.id);
        if (!updated) return;
        await logAdminAudit(
          ctx.from.id,
          updated.id,
          updated.price,
          `Изменил описание товара "${updated.name}"`,
        );
        await ctx.reply(
          `✅ <b>Описание товара обновлено!</b>\n\n${formatProductCardMessage(updated)}`,
          {
            parse_mode: 'HTML',
            ...buildAdminProductManageKeyboard(updated),
          },
        );
        return;
      }

      if (session.action === 'add_product_name' && session.draftProduct) {
        session.draftProduct.name = text.slice(0, 120);
        session.action = 'add_product_description';
        setAdminSession(ctx.from.id, session);
        await ctx.reply(
          '➕ <b>Шаг 3 из 4:</b> Отправьте в чат <b>описание</b> нового товара:',
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (session.action === 'add_product_description' && session.draftProduct) {
        session.draftProduct.description = text.slice(0, 1000);
        session.action = 'add_product_price';
        setAdminSession(ctx.from.id, session);
        await ctx.reply(
          '➕ <b>Шаг 4 из 4:</b> Отправьте <b>цену товара в USD</b> (например: <code>13.90</code> или <code>4.99</code>):',
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (session.action === 'add_product_price' && session.draftProduct) {
        const priceUsdCents = usdInputToCents(text);
        const created = await ProductService.createProduct({
          category: session.draftProduct.category,
          ...(session.draftProduct.durationMonths !== undefined
            ? { durationMonths: session.draftProduct.durationMonths }
            : {}),
          name: session.draftProduct.name || 'Новый товар',
          description: session.draftProduct.description || 'Цифровой товар Telegram',
          priceUsdCents,
        });
        clearAdminSession(ctx.from.id);
        await logAdminAudit(
          ctx.from.id,
          created.id,
          priceUsdCents,
          `Создал новый товар "${created.name}" (${formatUsdCents(priceUsdCents)})`,
        );
        await ctx.reply(
          `🎉 <b>Новый товар успешно добавлен в каталог QuizyStars!</b>\n\n${formatProductCardMessage(
            created,
          )}`,
          {
            parse_mode: 'HTML',
            ...buildAdminProductManageKeyboard(created),
          },
        );
        return;
      }

      if (session.action === 'message_user') {
        let targetTgId: number;
        let msgBody: string;

        if (session.targetId) {
          targetTgId = Number(session.targetId);
          msgBody = text;
        } else {
          const firstSpace = text.indexOf(' ');
          if (firstSpace === -1) {
            await ctx.reply(
              '⚠️ Укажите ID пользователя и текст через пробел. Пример: <code>123456789 Здравствуйте!</code>',
              { parse_mode: 'HTML' },
            );
            return;
          }
          targetTgId = Number(text.slice(0, firstSpace).trim());
          msgBody = text.slice(firstSpace + 1).trim();
        }

        if (!Number.isInteger(targetTgId) || targetTgId <= 0 || !msgBody) {
          await ctx.reply('⚠️ Некорректный Telegram ID или пустое сообщение.');
          return;
        }

        await bot.telegram.sendMessage(
          targetTgId,
          `📩 <b>Сообщение от администрации магазина:</b>\n\n${escapeHtml(msgBody)}`,
          { parse_mode: 'HTML' },
        );
        clearAdminSession(ctx.from.id);
        await logAdminAudit(
          ctx.from.id,
          `msg_${targetTgId}`,
          0,
          `Отправил сообщение покупателю ${targetTgId}`,
        );
        await ctx.reply(
          `✅ Сообщение успешно доставлено пользователю <code>${targetTgId}</code>.`,
          {
            parse_mode: 'HTML',
            ...buildAdminMainKeyboard(isOwnerTelegramId(ctx.from.id)),
          },
        );
        return;
      }

      if (session.action === 'owner_add_keys' && session.targetId) {
        if (!(await ensureOwner(ctx))) {
          clearAdminSession(ctx.from.id);
          return;
        }
        const productId = session.targetId;
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

        const added = await DigitalKeyService.addKeys({
          actorTelegramId: ctx.from.id,
          productId,
          keys: lines,
        });
        clearAdminSession(ctx.from.id);

        const product = await ProductService.getProductById(productId);
        const summary = await DigitalKeyService.getProductStockSummary({
          actorTelegramId: ctx.from.id,
          productId,
        });

        await ctx.reply(
          [
            `✅ <b>Успешно добавлено ключей на склад: ${added.length} шт.</b>`,
            product ? formatOwnerProductKeysMessage(product, summary) : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          {
            parse_mode: 'HTML',
            ...(product
              ? buildOwnerProductKeysKeyboard(product, summary)
              : buildAdminMainKeyboard(true)),
          },
        );
        return;
      }
    } catch (error) {
      if (
        error instanceof OwnerAccessDeniedError ||
        error instanceof DuplicateDigitalKeyError ||
        error instanceof UnsupportedKeyGeneratorError
      ) {
        await ctx.reply(`⚠️ <b>Ошибка:</b> ${escapeHtml(error.message)}`, {
          parse_mode: 'HTML',
        });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`⚠️ <b>Ошибка:</b> ${escapeHtml(msg)}`, {
        parse_mode: 'HTML',
      });
    }
  });
}
