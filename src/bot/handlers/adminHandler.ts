import { Context, Markup, Telegraf } from 'telegraf';
import {
  AdminInteractiveSession,
  BotConnectionStatus,
  OrderStatus,
  ProductCategory,
} from '../../types.ts';
import { CATEGORY_LABELS } from '../../constants.ts';
import { UserService } from '../../services/UserService.ts';
import { ProductService } from '../../services/ProductService.ts';
import { OrderService } from '../../services/OrderService.ts';
import { PaymentService } from '../../services/PaymentService.ts';
import { FulfillmentService } from '../../services/FulfillmentService.ts';
import { firestoreRepo } from '../../db/firestore.ts';
import { getEnvConfig } from '../../config/env.ts';
import {
  buildAdminCategoryPickKeyboard,
  buildAdminMainKeyboard,
  buildAdminOrderActionKeyboard,
  buildAdminOrdersKeyboard,
  buildAdminProductManageKeyboard,
  buildAdminProductsKeyboard,
  buildAdminUserManageKeyboard,
  buildAdminUsersKeyboard,
} from '../keyboards.ts';
import {
  escapeHtml,
  formatAdminOrderCard,
  formatAdminStatsMessage,
  formatDateRu,
  formatProductCardMessage,
  formatUserProfileMessage,
} from '../formatters.ts';
import {
  isDuplicateCallbackClick,
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
  // Команда /admin
  bot.command('admin', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    clearAdminSession(ctx.from!.id);
    await safeRespondOrEdit(
      ctx,
      [
        '🛠 <b>Панель администратора цифрового магазина</b>',
        '',
        'Выберите раздел для управления каталогом, заказами, пользователями или просмотра статуса интеграций:',
      ].join('\n'),
      buildAdminMainKeyboard(),
    );
  });

  // Главная страница админ-панели
  bot.action('adm:home', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:home')) return;
    clearAdminSession(ctx.from!.id);
    await safeRespondOrEdit(
      ctx,
      [
        '🛠 <b>Панель администратора цифрового магазина</b>',
        '',
        'Выберите раздел для управления:',
      ].join('\n'),
      buildAdminMainKeyboard(),
    );
  });

  // 1. Статистика магазина
  bot.action('adm:stats', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:stats')) return;

    const [users, orders, products, payments, recentTransactions] =
      await Promise.all([
        UserService.getAllUsers(200),
        OrderService.getAllOrders(undefined, 200),
        ProductService.getAllProducts(true, 200),
        PaymentService.getAllPayments(200),
        OrderService.getRecentTransactions(6),
      ]);

    const paidRevenue = payments
      .filter((p) => p.status === 'paid')
      .reduce((acc, p) => acc + p.totalAmount, 0);

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
      totalStarsRevenue: paidRevenue,
      totalProducts: products.length,
      activeProducts: products.filter((p) => p.isActive).length,
      recentTransactions,
    });

    await safeRespondOrEdit(ctx, text, buildAdminMainKeyboard());
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
        : `📦 <b>Управление заказами (${filterRaw}, найдено: ${orders.length})</b>\n\nНажмите на заказ для просмотра деталей, ручной выдачи или возврата Stars:`;

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

  // Перевести заказ в статус processing («В обработке»)
  bot.action(/^adm:ord_proc:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_proc:${orderId}`, 1500)) {
      return;
    }

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

  // Выдача заказа с персональным сообщением, ссылкой или кодом активации
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

  // Официальный возврат Telegram Stars через refundStarPayment
  bot.action(/^adm:ord_refund:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_refund:${orderId}`, 2500)) {
      return;
    }

    const order = await OrderService.getOrderById(orderId);

    if (!order || !order.telegramPaymentChargeId) {
      await safeAnswerCbQuery(
        ctx,
        'У заказа отсутствует telegram_payment_charge_id для возврата.',
        true,
      );
      return;
    }

    if (order.paymentStatus === 'refunded') {
      await safeAnswerCbQuery(
        ctx,
        'По этому заказу уже выполнен возврат.',
        true,
      );
      return;
    }

    try {
      await (
        ctx.telegram as unknown as {
          callApi: (method: string, payload: Record<string, unknown>) => Promise<boolean>;
        }
      ).callApi('refundStarPayment', {
        user_id: order.userTelegramId,
        telegram_payment_charge_id: order.telegramPaymentChargeId,
      });

      const refundedOrder = await PaymentService.markPaymentRefunded(
        order.orderId,
        ctx.from!.id,
      );

      // Уведомляем покупателя о возврате
      try {
        await bot.telegram.sendMessage(
          order.userTelegramId,
          `↩️ <b>Возврат средств по заказу #${escapeHtml(order.orderId)}</b>\n\nНа ваш баланс возвращено <b>${order.totalPrice} ⭐ (Telegram Stars)</b>.`,
          { parse_mode: 'HTML' },
        );
      } catch {
        // Ignore if user blocked the bot
      }

      await safeAnswerCbQuery(
        ctx,
        'Возврат Telegram Stars успешно выполнен!',
        true,
      );

      if (refundedOrder) {
        await safeRespondOrEdit(
          ctx,
          formatAdminOrderCard(refundedOrder),
          buildAdminOrderActionKeyboard(refundedOrder),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[AdminHandler] Ошибка refundStarPayment:', msg);
      await safeAnswerCbQuery(
        ctx,
        `Ошибка API возврата: ${msg.slice(0, 150)}`,
        true,
      );
    }
  });

  // Отмена неоплаченного заказа админом
  bot.action(/^adm:ord_cancel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    if (isDuplicateCallbackClick(ctx.from!.id, `adm:ord_cancel:${orderId}`, 1500)) {
      return;
    }

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
      'Отменил заказ',
    );

    await safeRespondOrEdit(
      ctx,
      formatAdminOrderCard(updated),
      buildAdminOrderActionKeyboard(updated),
    );
  });

  // 3. Управление товарами
  bot.action('adm:products', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    if (isDuplicateCallbackClick(ctx.from!.id, 'adm:products')) return;
    clearAdminSession(ctx.from!.id);
    const products = await ProductService.getAllProducts(true);
    await safeRespondOrEdit(
      ctx,
      [
        `🛍 <b>Управление товарами (всего: ${products.length})</b>`,
        '',
        '🟢 — товар активен и виден покупателям',
        '🔴 — товар временно скрыт из каталога',
        '',
        'Выберите товар для изменения цены, описания или статуса:',
      ].join('\n'),
      buildAdminProductsKeyboard(products),
    );
  });

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

    await safeRespondOrEdit(
      ctx,
      [
        `⚙️ <b>Редактирование товара</b> (ID: <code>${escapeHtml(product.id)}</code>)`,
        `Статус: ${product.isActive ? '🟢 Активен' : '🔴 Отключён'}`,
        '',
        formatProductCardMessage(product),
      ].join('\n'),
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
    await safeRespondOrEdit(
      ctx,
      [
        `⚙️ <b>Редактирование товара</b> (ID: <code>${escapeHtml(updated.id)}</code>)`,
        `Статус: ${updated.isActive ? '🟢 Активен' : '🔴 Отключён'}`,
        '',
        formatProductCardMessage(updated),
      ].join('\n'),
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
    const products = await ProductService.getAllProducts(true);
    await safeRespondOrEdit(
      ctx,
      `🛍 <b>Управление товарами (всего: ${products.length})</b>\n\nТовар успешно удалён.`,
      buildAdminProductsKeyboard(products),
    );
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

    await safeRespondOrEdit(
      ctx,
      [
        `💰 <b>Изменение цены товара:</b> ${escapeHtml(product.name)}`,
        `Текущая цена: <code>${product.price} ⭐ (XTR)</code>`,
        '',
        'Отправьте в чат новое целое число (от 1 до 100000) для установки цены в Telegram Stars:',
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
      `👑 <b>Администраторов в ADMIN_IDS:</b> ${envConfig.adminIds.length}`,
      '',
      '⚠️ <b>Последние системные ошибки:</b>',
      ...errorLines,
    ].join('\n');

    await safeRespondOrEdit(ctx, text, buildAdminMainKeyboard());
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
        const price = Number(text);
        const updated = await ProductService.updateProductPrice(
          session.targetId,
          price,
        );
        clearAdminSession(ctx.from.id);
        if (!updated) {
          await ctx.reply('❌ Товар не найден.');
          return;
        }
        await logAdminAudit(
          ctx.from.id,
          updated.id,
          updated.price,
          `Изменил цену товара "${updated.name}" на ${updated.price} XTR`,
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
          '➕ <b>Шаг 4 из 4:</b> Отправьте <b>цену товара в Telegram Stars (XTR)</b> (целое число от 1 до 100000):',
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (session.action === 'add_product_price' && session.draftProduct) {
        const price = Number(text);
        const created = await ProductService.createProduct({
          category: session.draftProduct.category,
          name: session.draftProduct.name || 'Новый товар',
          description: session.draftProduct.description || 'Цифровой товар Telegram',
          price,
        });
        clearAdminSession(ctx.from.id);
        await logAdminAudit(
          ctx.from.id,
          created.id,
          created.price,
          `Создал новый товар "${created.name}" (${created.price} XTR)`,
        );
        await ctx.reply(
          `🎉 <b>Новый товар успешно добавлен в каталог!</b>\n\n${formatProductCardMessage(
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
            ...buildAdminMainKeyboard(),
          },
        );
        return;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`⚠️ <b>Ошибка:</b> ${escapeHtml(msg)}`, {
        parse_mode: 'HTML',
      });
    }
  });
}
