import { Markup } from 'telegraf';
import { Order, Product, ProductCategory, StoreUser } from '../types.ts';
import { CATEGORY_LABELS, ORDER_STATUS_LABELS } from '../constants.ts';

export function buildMainMenuKeyboard(isAdmin = false) {
  const rows = [
    [Markup.button.callback('⭐ Купить Stars', 'cat:stars')],
    [Markup.button.callback('💎 Купить Premium', 'cat:premium')],
    [Markup.button.callback('🎁 Купить Gifts', 'cat:gifts')],
    [
      Markup.button.callback('📦 Мои заказы', 'menu:orders'),
      Markup.button.callback('👤 Мой профиль', 'menu:profile'),
    ],
    [Markup.button.callback('💬 Поддержка', 'menu:support')],
  ];

  if (isAdmin) {
    rows.push([Markup.button.callback('🛠 Админ-панель магазина', 'adm:home')]);
  }

  return Markup.inlineKeyboard(rows);
}

export function buildCatalogCategoriesKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Купить Stars', 'cat:stars')],
    [Markup.button.callback('💎 Купить Premium', 'cat:premium')],
    [Markup.button.callback('🎁 Купить Gifts', 'cat:gifts')],
    [Markup.button.callback('⬅️ В главное меню', 'menu:home')],
  ]);
}

export function buildCategoryProductsKeyboard(
  category: ProductCategory,
  products: Product[],
) {
  const rows = products.map((product) => [
    Markup.button.callback(
      `${product.name} — ${product.price} ⭐`,
      `prod:${product.id}`,
    ),
  ]);

  rows.push([
    Markup.button.callback('📂 Все категории', 'menu:catalog'),
    Markup.button.callback('🏠 Главное меню', 'menu:home'),
  ]);

  return Markup.inlineKeyboard(rows);
}

export function buildProductDetailKeyboard(product: Product) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `💳 Купить за ${product.price} ⭐ (Telegram Stars)`,
        `buy:${product.id}`,
      ),
    ],
    [
      Markup.button.callback(
        `⬅️ Назад в ${CATEGORY_LABELS[product.category]}`,
        `cat:${product.category}`,
      ),
      Markup.button.callback('🏠 Меню', 'menu:home'),
    ],
  ]);
}

export function buildUserOrdersKeyboard(orders: Order[]) {
  const rows = orders.slice(0, 8).map((order) => [
    Markup.button.callback(
      `#${order.orderId.slice(-6)} • ${order.productName.slice(0, 22)} (${order.totalPrice} ⭐)`,
      `uord:${order.orderId}`,
    ),
  ]);

  rows.push([
    Markup.button.callback('🔄 Обновить список', 'menu:orders'),
    Markup.button.callback('🏠 Главное меню', 'menu:home'),
  ]);

  return Markup.inlineKeyboard(rows);
}

export function buildUserOrderDetailKeyboard(order: Order) {
  const rows = [];
  if (order.paymentStatus === 'pending') {
    rows.push([
      Markup.button.callback('❌ Отменить неоплаченный заказ', `ucancel:${order.orderId}`),
    ]);
  }
  rows.push([
    Markup.button.callback('⬅️ К моим заказам', 'menu:orders'),
    Markup.button.callback('🏠 Главное меню', 'menu:home'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function buildBackToMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Вернуться в главное меню', 'menu:home')],
  ]);
}

export function buildAdminMainKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Статистика магазина', 'adm:stats'),
      Markup.button.callback('📦 Управление заказами', 'adm:orders:all'),
    ],
    [
      Markup.button.callback('🛍 Управление товарами', 'adm:products'),
      Markup.button.callback('➕ Добавить товар', 'adm:prod_add_start'),
    ],
    [
      Markup.button.callback('👥 Пользователи и блокировки', 'adm:users'),
      Markup.button.callback('✉️ Написать пользователю', 'adm:msg_user_start'),
    ],
    [
      Markup.button.callback('🔌 Статус интеграций и логи', 'adm:integrations'),
    ],
    [Markup.button.callback('🏠 Выйти в меню покупателя', 'menu:home')],
  ]);
}

export function buildAdminProductsKeyboard(products: Product[]) {
  const rows = products.map((p) => [
    Markup.button.callback(
      `${p.isActive ? '🟢' : '🔴'} ${p.name} (${p.price} ⭐)`,
      `adm:prod:${p.id}`,
    ),
  ]);

  rows.push([
    Markup.button.callback('➕ Добавить новый товар', 'adm:prod_add_start'),
  ]);
  rows.push([Markup.button.callback('⬅️ В админ-панель', 'adm:home')]);
  return Markup.inlineKeyboard(rows);
}

export function buildAdminProductManageKeyboard(product: Product) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('💰 Изменить цену (XTR)', `adm:pprice:${product.id}`),
      Markup.button.callback('✏️ Изменить название', `adm:pname:${product.id}`),
    ],
    [
      Markup.button.callback('📝 Изменить описание', `adm:pdesc:${product.id}`),
      Markup.button.callback(
        product.isActive ? '⏸ Отключить товар' : '▶️ Включить товар',
        `adm:ptoggle:${product.id}`,
      ),
    ],
    [
      Markup.button.callback('🗑 Удалить товар', `adm:pdel:${product.id}`),
    ],
    [Markup.button.callback('⬅️ К списку товаров', 'adm:products')],
  ]);
}

export function buildAdminCategoryPickKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Telegram Stars', 'adm:addcat:stars')],
    [Markup.button.callback('💎 Telegram Premium', 'adm:addcat:premium')],
    [Markup.button.callback('🎁 Telegram Gifts', 'adm:addcat:gifts')],
    [Markup.button.callback('❌ Отмена', 'adm:products')],
  ]);
}

export function buildAdminOrdersKeyboard(orders: Order[]) {
  const filterRow = [
    Markup.button.callback('Все', 'adm:orders:all'),
    Markup.button.callback('Оплачены', 'adm:orders:paid'),
    Markup.button.callback('В работе', 'adm:orders:processing'),
    Markup.button.callback('Выполнены', 'adm:orders:completed'),
  ];

  const orderRows = orders.slice(0, 10).map((o) => [
    Markup.button.callback(
      `#${o.orderId.slice(-6)} | ${o.productName.slice(0, 18)} | ${o.totalPrice}⭐ | ${ORDER_STATUS_LABELS[o.fulfillmentStatus].split(' ')[0]}`,
      `adm:ord:${o.orderId}`,
    ),
  ]);

  return Markup.inlineKeyboard([
    filterRow,
    ...orderRows,
    [Markup.button.callback('⬅️ В админ-панель', 'adm:home')],
  ]);
}

export function buildAdminOrderActionKeyboard(order: Order) {
  const rows = [];

  if (order.fulfillmentStatus !== 'completed' && order.paymentStatus !== 'refunded') {
    rows.push([
      Markup.button.callback(
        '🔄 Взять в обработку',
        `adm:ord_proc:${order.orderId}`,
      ),
      Markup.button.callback(
        '✅ Подтвердить выдачу',
        `adm:ord_done:${order.orderId}`,
      ),
    ]);
  }

  if (
    order.telegramPaymentChargeId &&
    order.paymentStatus !== 'refunded'
  ) {
    rows.push([
      Markup.button.callback(
        '↩️ Возврат Stars (refundStarPayment)',
        `adm:ord_refund:${order.orderId}`,
      ),
    ]);
  }

  if (order.paymentStatus === 'pending') {
    rows.push([
      Markup.button.callback('❌ Отменить заказ', `adm:ord_cancel:${order.orderId}`),
    ]);
  }

  rows.push([
    Markup.button.callback(
      '✉️ Написать покупателю',
      `adm:msg_to:${order.userTelegramId}`,
    ),
  ]);
  rows.push([Markup.button.callback('⬅️ К списку заказов', 'adm:orders:all')]);

  return Markup.inlineKeyboard(rows);
}

export function buildAdminUsersKeyboard(users: StoreUser[]) {
  const rows = users.slice(0, 10).map((u) => [
    Markup.button.callback(
      `${u.isBlocked ? '🚫' : '👤'} ${u.firstName} ${u.username ? `(@${u.username})` : ''} [${u.telegramId}]`,
      `adm:usr:${u.telegramId}`,
    ),
  ]);

  rows.push([Markup.button.callback('⬅️ В админ-панель', 'adm:home')]);
  return Markup.inlineKeyboard(rows);
}

export function buildAdminUserManageKeyboard(user: StoreUser) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        user.isBlocked ? '✅ Разблокировать пользователя' : '🚫 Заблокировать пользователя',
        `adm:ublock:${user.telegramId}`,
      ),
    ],
    [
      Markup.button.callback(
        '✉️ Отправить сообщение',
        `adm:msg_to:${user.telegramId}`,
      ),
    ],
    [Markup.button.callback('⬅️ К списку пользователей', 'adm:users')],
  ]);
}
