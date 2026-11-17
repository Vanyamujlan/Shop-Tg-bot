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

async function ensureAdmin(ctx: Context): Promise<boolean> {
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

export function registerAdminHandlers(
  bot: Telegraf,
  getBotStatus: () => BotConnectionStatus,
): void {
  // Команда /admin
  bot.command('admin', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    adminSessions.delete(ctx.from!.id);
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
    adminSessions.delete(ctx.from!.id);
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
        UserService.getAllUsers(),
        OrderService.getAllOrders(),
        ProductService.getAllProducts(true),
        PaymentService.getAllPayments(),
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
  bot.action(/^adm:orders:(all|paid|processing|completed)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const filterRaw = ctx.match[1];
    const filter =
      filterRaw === 'all' ? undefined : (filterRaw as OrderStatus);

    const orders = await OrderService.getAllOrders(filter);
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
    const order = await OrderService.getOrderById(orderId);
    if (!order) {
      await ctx.answerCbQuery('Заказ не найден.', { show_alert: true });
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
    const updated = await OrderService.updateOrderStatus({
      orderId,
      fulfillmentStatus: 'processing',
      fulfillmentNote: 'Администратор взял заказ в обработку.',
    });
    if (!updated) {
      await ctx.answerCbQuery('Заказ не найден.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('Статус изменён на «В обработке»');
    await safeRespondOrEdit(
      ctx,
      formatAdminOrderCard(updated),
      buildAdminOrderActionKeyboard(updated),
    );
  });

  // Подтвердить выдачу заказа (completed) + уведомить покупателя
  bot.action(/^adm:ord_done:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];

    try {
      const completed = await FulfillmentService.completeOrder({
        orderId,
        adminNote: 'Товар выдан администратором. Приятного пользования!',
        bot,
      });

      await ctx.answerCbQuery('Заказ отмечен как выполненный, покупатель уведомлён!');
      await safeRespondOrEdit(
        ctx,
        formatAdminOrderCard(completed),
        buildAdminOrderActionKeyboard(completed),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.answerCbQuery(msg.slice(0, 180), { show_alert: true });
    }
  });

  // Официальный возврат Telegram Stars через refundStarPayment
  bot.action(/^adm:ord_refund:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    const order = await OrderService.getOrderById(orderId);

    if (!order || !order.telegramPaymentChargeId) {
      await ctx.answerCbQuery(
        'У заказа отсутствует telegram_payment_charge_id для возврата.',
        { show_alert: true },
      );
      return;
    }

    if (order.paymentStatus === 'refunded') {
      await ctx.answerCbQuery('По этому заказу уже выполнен возврат.', {
        show_alert: true,
      });
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

      const refundedOrder = await PaymentService.markPaymentRefunded(order.orderId);

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

      await ctx.answerCbQuery('Возврат Telegram Stars успешно выполнен!', {
        show_alert: true,
      });

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
      await ctx.answerCbQuery(`Ошибка API возврата: ${msg.slice(0, 150)}`, {
        show_alert: true,
      });
    }
  });

  // Отмена неоплаченного заказа админом
  bot.action(/^adm:ord_cancel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const orderId = ctx.match[1];
    const updated = await OrderService.updateOrderStatus({
      orderId,
      paymentStatus: 'cancelled',
      fulfillmentStatus: 'cancelled',
      fulfillmentNote: 'Отменён администратором.',
    });
    if (!updated) return;

    await safeRespondOrEdit(
      ctx,
      formatAdminOrderCard(updated),
      buildAdminOrderActionKeyboard(updated),
    );
  });

  // 3. Управление товарами
  bot.action('adm:products', async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    adminSessions.delete(ctx.from!.id);
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
    const product = await ProductService.getProductById(productId);
    if (!product) {
      await ctx.answerCbQuery('Товар не найден.', { show_alert: true });
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
    const updated = await ProductService.toggleProductActive(productId);
    if (!updated) {
      await ctx.answerCbQuery('Товар не найден.', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery(
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
    await ProductService.deleteProduct(productId);
    await ctx.answerCbQuery('Товар удалён из каталога.');
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

    adminSessions.set(ctx.from!.id, {
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

    adminSessions.set(ctx.from!.id, {
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

    adminSessions.set(ctx.from!.id, {
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
    adminSessions.delete(ctx.from!.id);
    await safeRespondOrEdit(
      ctx,
      '➕ <b>Добавление нового товара</b>\n\nШаг 1 из 4: Выберите категорию товара:',
      buildAdminCategoryPickKeyboard(),
    );
  });

  bot.action(/^adm:addcat:(stars|premium|gifts)$/, async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const category = ctx.match[1] as ProductCategory;

    adminSessions.set(ctx.from!.id, {
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
    const users = await UserService.getAllUsers();
    await safeRespondOrEdit(
      ctx,
      [
        `👥 <b>Пользователи магазина (всего: ${users.length})</b>`,
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
      await ctx.answerCbQuery('Пользователь не найден.', { show_alert: true });
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
    if (targetTgId === ctx.from!.id) {
      await ctx.answerCbQuery('Нельзя заблокировать самого себя.', {
        show_alert: true,
      });
      return;
    }

    const existing = await UserService.getUserByTelegramId(targetTgId);
    if (!existing) return;

    const updated = await UserService.setUserBlocked(
      targetTgId,
      !existing.isBlocked,
    );
    if (!updated) return;

    await ctx.answerCbQuery(
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
    adminSessions.set(ctx.from!.id, {
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
    adminSessions.set(ctx.from!.id, {
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
    const botStatus = getBotStatus();
    const dbStatus = firestoreRepo.getStatus();
    const fulfillmentInfo = FulfillmentService.getAdapterInfo();
    const envConfig = getEnvConfig();
    const recentTx = await OrderService.getRecentTransactions(20);
    const errorTx = recentTx.filter((t) => t.type === 'error').slice(0, 5);

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
          : 'ℹ️ Резервный режим синхронизации (добавьте FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY для прямого Admin SDK)'
      }`,
      `🚚 <b>Модуль выдачи (FulfillmentService):</b> <code>${escapeHtml(
        fulfillmentInfo.name,
      )}</code>`,
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
    const session = adminSessions.get(ctx.from.id);
    if (!session) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      adminSessions.delete(ctx.from.id);
      return next();
    }

    if (!(await ensureAdmin(ctx))) {
      adminSessions.delete(ctx.from.id);
      return;
    }

    try {
      if (session.action === 'edit_price' && session.targetId) {
        const price = Number(text);
        const updated = await ProductService.updateProductPrice(
          session.targetId,
          price,
        );
        adminSessions.delete(ctx.from.id);
        if (!updated) {
          await ctx.reply('❌ Товар не найден.');
          return;
        }
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
        adminSessions.delete(ctx.from.id);
        if (!updated) return;
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
        adminSessions.delete(ctx.from.id);
        if (!updated) return;
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
        adminSessions.set(ctx.from.id, session);
        await ctx.reply(
          '➕ <b>Шаг 3 из 4:</b> Отправьте в чат <b>описание</b> нового товара:',
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (session.action === 'add_product_description' && session.draftProduct) {
        session.draftProduct.description = text.slice(0, 1000);
        session.action = 'add_product_price';
        adminSessions.set(ctx.from.id, session);
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
        adminSessions.delete(ctx.from.id);
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
        adminSessions.delete(ctx.from.id);
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
