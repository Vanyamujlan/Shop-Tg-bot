import {
  Order,
  Product,
  ProductCategory,
  StoreTransaction,
  StoreUser,
} from '../types.ts';
import { CATEGORY_LABELS, ORDER_STATUS_LABELS } from '../constants.ts';
import { getEnvConfig } from '../config/env.ts';

export function escapeHtml(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatDateRu(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function formatWelcomeMessage(firstName: string, isAdmin: boolean): string {
  return [
    `👋 <b>Добро пожаловать в цифровой магазин, ${escapeHtml(firstName)}!</b>`,
    '',
    'Здесь вы можете приобрести цифровые товары Telegram прямо внутри чата:',
    '• ⭐ <b>Telegram Stars</b> — пополнение баланса звёзд',
    '• 💎 <b>Telegram Premium</b> — подписка на 3, 6 и 12 месяцев',
    '• 🎁 <b>Telegram Gifts</b> — редкие и коллекционные подарки',
    '',
    '🔒 <b>Официальная оплата:</b> все покупки оплачиваются через защищённую систему <b>Telegram Stars (XTR)</b> с мгновенной фиксацией заказа.',
    isAdmin ? '\n🛠 <i>Вам доступен режим администратора магазина (/admin).</i>' : '',
    '',
    'Выберите нужный раздел в меню ниже 👇',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatCatalogOverviewMessage(): string {
  return [
    '🛍 <b>Каталог цифровых товаров Telegram</b>',
    '',
    'Выберите интересующую вас категорию:',
    '• ⭐ <b>Telegram Stars</b> — пакеты звёзд для сервисов и подарков',
    '• 💎 <b>Telegram Premium</b> — премиум-подписки',
    '• 🎁 <b>Telegram Gifts</b> — цифровые подарки для профиля',
  ].join('\n');
}

export function formatCategoryListMessage(
  category: ProductCategory,
  products: Product[],
): string {
  const title = CATEGORY_LABELS[category];
  if (products.length === 0) {
    return [
      `📂 <b>${title}</b>`,
      '',
      'В данной категории сейчас нет активных товаров. Пожалуйста, загляните позже или выберите другую категорию.',
    ].join('\n');
  }

  const lines = products.map(
    (p, idx) =>
      `${idx + 1}. <b>${escapeHtml(p.name)}</b> — <code>${p.price} ⭐ (XTR)</code>`,
  );

  return [
    `📂 <b>Категория: ${title}</b>`,
    '',
    ...lines,
    '',
    'Нажмите на товар ниже, чтобы посмотреть подробное описание и перейти к покупке 👇',
  ].join('\n');
}

export function formatProductCardMessage(product: Product): string {
  return [
    `🏷 <b>${escapeHtml(product.name)}</b>`,
    `📂 Категория: <b>${CATEGORY_LABELS[product.category]}</b>`,
    '',
    `📝 <b>Описание:</b>\n${escapeHtml(product.description)}`,
    '',
    `💰 <b>Стоимость:</b> <code>${product.price} ⭐ (XTR)</code>`,
    `📦 <b>Способ выдачи:</b> ${
      product.fulfillmentType === 'manual'
        ? 'Проверенная выдача администратором после оплаты'
        : 'Автоматический адаптер поставщика'
    }`,
    '',
    'Нажмите кнопку <b>«Купить»</b> ниже — бот сформирует официальный счёт Telegram Stars 👇',
  ].join('\n');
}

export function formatUserProfileMessage(user: StoreUser, isAdmin: boolean): string {
  return [
    '👤 <b>Ваш профиль покупателя</b>',
    '',
    `🆔 <b>Telegram ID:</b> <code>${user.telegramId}</code>`,
    `👤 <b>Имя:</b> ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}`,
    user.username ? `🔗 <b>Username:</b> @${escapeHtml(user.username)}` : '',
    `📦 <b>Оплаченных заказов:</b> ${user.totalOrders}`,
    `⭐ <b>Сумма покупок:</b> ${user.totalSpentStars} XTR`,
    `📅 <b>Дата регистрации:</b> ${formatDateRu(user.createdAt)}`,
    `🛡 <b>Статус аккаунта:</b> ${
      user.isBlocked ? '🚫 Ограничен' : isAdmin ? '👑 Администратор' : '✅ Активен'
    }`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatUserOrdersListMessage(orders: Order[]): string {
  if (orders.length === 0) {
    return [
      '📦 <b>Мои заказы</b>',
      '',
      'У вас пока нет оформленных заказов. Перейдите в /catalog, чтобы выбрать цифровой товар!',
    ].join('\n');
  }

  const recent = orders.slice(0, 8).map(
    (o, i) =>
      `${i + 1}. <b>#${escapeHtml(o.orderId.slice(-8))}</b> — ${escapeHtml(
        o.productName,
      )} (<code>${o.totalPrice} ⭐</code>)\n   Статус: ${
        ORDER_STATUS_LABELS[o.fulfillmentStatus]
      }`,
  );

  return [
    `📦 <b>История ваших заказов (всего: ${orders.length})</b>`,
    '',
    ...recent,
    '',
    'Нажмите на заказ ниже для просмотра деталей 👇',
  ].join('\n');
}

export function formatOrderDetailMessage(order: Order): string {
  return [
    `🧾 <b>Детали заказа #${escapeHtml(order.orderId)}</b>`,
    '',
    `🛍 <b>Товар:</b> ${escapeHtml(order.productName)}`,
    `📂 <b>Категория:</b> ${CATEGORY_LABELS[order.category]}`,
    `🔢 <b>Количество:</b> ${order.quantity} шт.`,
    `💳 <b>Сумма:</b> <code>${order.totalPrice} ⭐ (${order.currency})</code>`,
    `📌 <b>Статус оплаты:</b> ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 <b>Статус выдачи:</b> ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    order.telegramPaymentChargeId
      ? `🔐 <b>ID платежа Telegram:</b> <code>${escapeHtml(
          order.telegramPaymentChargeId,
        )}</code>`
      : '',
    order.fulfillmentNote
      ? `💬 <b>Комментарий:</b> ${escapeHtml(order.fulfillmentNote)}`
      : '',
    `🕒 <b>Создан:</b> ${formatDateRu(order.createdAt)}`,
    order.paidAt ? `✅ <b>Оплачен:</b> ${formatDateRu(order.paidAt)}` : '',
    order.completedAt
      ? `🎉 <b>Выполнен:</b> ${formatDateRu(order.completedAt)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOrderCompletedUserNotice(order: Order): string {
  return [
    `🎉 <b>Ваш заказ #${escapeHtml(order.orderId)} выполнен!</b>`,
    '',
    `🛍 <b>Товар:</b> ${escapeHtml(order.productName)}`,
    `💰 <b>Оплачено:</b> ${order.totalPrice} ⭐ (XTR)`,
    order.fulfillmentNote
      ? `📋 <b>Информация о выдаче:</b>\n${escapeHtml(order.fulfillmentNote)}`
      : '',
    '',
    'Спасибо за покупку в нашем магазине! Чтобы посмотреть историю заказов, используйте команду /orders.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatHelpMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    'ℹ️ <b>Справка и навигация по магазину</b>',
    '',
    '<b>Доступные команды:</b>',
    '/start — Главное меню магазина',
    '/catalog — Каталог цифровых товаров',
    '/orders — История ваших заказов',
    '/profile — Ваш профиль и статистика покупок',
    '/terms — Правила пользования магазином',
    '/paysupport — Поддержка по платежам Telegram Stars',
    '/help — Помощь и ответы на вопросы',
    '',
    '<b>Как происходит покупка:</b>',
    '1. Выберите товар в разделе Stars, Premium или Gifts.',
    '2. Нажмите кнопку «Купить» и оплатите официальный счёт в Telegram Stars (XTR).',
    '3. Сразу после подтверждения оплаты (`successful_payment`) заказ получает статус <b>Оплачен</b> и передаётся на выдачу.',
    '4. После выдачи товара вы получите уведомление в этом чате.',
    '',
    `💬 Контакт поддержки: @${escapeHtml(storeSupportUsername)}`,
  ].join('\n');
}

export function formatTermsMessage(): string {
  return [
    '📜 <b>Правила цифрового магазина</b>',
    '',
    '1. <b>Предмет магазина:</b> Магазин предоставляет цифровые товары экосистемы Telegram (Telegram Stars, Telegram Premium, Telegram Gifts) исключительно через интерфейс данного бота.',
    '2. <b>Оплата:</b> Оплата принимается только через официальный платёжный механизм Telegram Stars (валюта XTR). Магазин никогда не запрашивает пароли, коды входа, seed-фразы или приватные ключи.',
    '3. <b>Порядок выдачи:</b> Выдача товара осуществляется после верификации платежа Telegram (`successful_payment`). Срок стандартной ручной выдачи администратором — от 5 минут до 24 часов.',
    '4. <b>Возврат средств:</b> Если заказ не может быть выдан по техническим причинам, администратор выполняет полный возврат Telegram Stars через официальный метод <code>refundStarPayment</code>.',
  ].join('\n');
}

export function formatPaySupportMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    '💳 <b>Поддержка по платежам (Payment Support)</b>',
    '',
    'По всем вопросам, связанным с оплатой в Telegram Stars (XTR), статусом заказа или возвратом средств:',
    '',
    `• Служба поддержки: @${escapeHtml(storeSupportUsername)}`,
    '• При обращении укажите <b>ID заказа</b> (из раздела /orders) или <b>ID платежа Telegram</b> (`telegram_payment_charge_id`).',
    '• Если средства были списаны, но товар ещё не доставлен, проверьте статус в /orders — администратор получает уведомление автоматически.',
  ].join('\n');
}

export function formatAdminOrderCard(order: Order): string {
  return [
    `🧾 <b>Заказ #${escapeHtml(order.orderId)}</b>`,
    `👤 <b>Покупатель:</b> <code>${order.userTelegramId}</code> ${
      order.username ? `(@${escapeHtml(order.username)})` : ''
    }`,
    `🛍 <b>Товар:</b> ${escapeHtml(order.productName)} (x${order.quantity})`,
    `💰 <b>Сумма:</b> <code>${order.totalPrice} ⭐ (${order.currency})</code>`,
    `📌 <b>Статус оплаты:</b> ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 <b>Статус выдачи:</b> ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    order.telegramPaymentChargeId
      ? `🔐 <b>Charge ID:</b> <code>${escapeHtml(order.telegramPaymentChargeId)}</code>`
      : '',
    order.fulfillmentNote
      ? `📝 <b>Примечание:</b> ${escapeHtml(order.fulfillmentNote)}`
      : '',
    `🕒 <b>Создан:</b> ${formatDateRu(order.createdAt)}`,
    order.paidAt ? `✅ <b>Оплачен:</b> ${formatDateRu(order.paidAt)}` : '',
    order.completedAt
      ? `🎉 <b>Завершён:</b> ${formatDateRu(order.completedAt)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatAdminStatsMessage(params: {
  totalUsers: number;
  blockedUsers: number;
  totalOrders: number;
  paidOrdersCount: number;
  completedOrdersCount: number;
  pendingOrdersCount: number;
  refundedOrdersCount: number;
  totalStarsRevenue: number;
  totalProducts: number;
  activeProducts: number;
  recentTransactions: StoreTransaction[];
}): string {
  const txLines =
    params.recentTransactions.length > 0
      ? params.recentTransactions
          .slice(0, 5)
          .map(
            (t) =>
              `• <code>${formatDateRu(t.createdAt)}</code> [${escapeHtml(
                t.type,
              )}] — ${escapeHtml(t.details)}`,
          )
      : ['• Транзакций пока нет'];

  return [
    '📊 <b>Статистика цифрового магазина</b>',
    '',
    `👥 <b>Пользователей всего:</b> ${params.totalUsers} (заблокировано: ${params.blockedUsers})`,
    `🛍 <b>Товаров в каталоге:</b> ${params.totalProducts} (активных: ${params.activeProducts})`,
    '',
    `📦 <b>Заказов всего:</b> ${params.totalOrders}`,
    `• ⏳ Ожидают оплаты: ${params.pendingOrdersCount}`,
    `• ✅ Оплачены / в обработке: ${params.paidOrdersCount}`,
    `• 🎉 Выполнены (выданы): ${params.completedOrdersCount}`,
    `• ↩️ Возвраты (Refund): ${params.refundedOrdersCount}`,
    '',
    `⭐ <b>Сумма успешных платежей:</b> <code>${params.totalStarsRevenue} XTR</code>`,
    '',
    '📋 <b>Последние события:</b>',
    ...txLines,
  ].join('\n');
}
