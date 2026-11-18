import { Markup } from 'telegraf';
import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
  Order,
  Product,
  ProductCategory,
  StoreUser,
} from '../types.ts';
import { CATEGORY_LABELS, ORDER_STATUS_LABELS } from '../constants.ts';
import { PAYMENT_PROVIDER_CATALOG } from '../services/PaymentProviders.ts';
import { calculateTopUpCommission } from '../services/BalanceService.ts';

export function buildMainMenuKeyboard(isAdmin = false) {
  const rows = [
    [Markup.button.callback('⭐ Купить Stars', 'cat:stars')],
    [Markup.button.callback('💎 Купить Premium', 'cat:premium')],
    [Markup.button.callback('🎁 Купить Gifts', 'cat:gifts')],
    [
      Markup.button.callback('📦 Мои заказы', 'menu:orders'),
      Markup.button.callback('👤 Мой профиль', 'menu:profile'),
    ],
    [
      Markup.button.callback('💳 Пополнить баланс', 'menu:topup'),
      Markup.button.callback('💬 Поддержка', 'menu:support'),
    ],
  ];

  if (isAdmin) {
    rows.push([Markup.button.callback('🛠 Админ-панель магазина', 'adm:home')]);
  }

  return Markup.inlineKeyboard(rows);
}

export function buildUserProfileKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 Пополнить баланс', 'menu:topup')],
    [Markup.button.callback('📜 История пополнений', 'topup:history')],
    [Markup.button.callback('🏠 Вернуться в главное меню', 'menu:home')],
  ]);
}

export function buildTopUpMenuKeyboard(
  selectedProvider: BalanceTopUpProvider = 'cryptobot',
  selectedCurrency?: string,
  selectedAmount = 500,
) {
  const meta = PAYMENT_PROVIDER_CATALOG[selectedProvider];
  const currency =
    selectedCurrency && meta.supportedCurrencies.includes(selectedCurrency)
      ? selectedCurrency
      : meta.defaultCurrency;
  const calc = calculateTopUpCommission(selectedAmount, selectedProvider);

  const providerRow = (['cryptobot', 'lolzteam', 'xrocket'] as const).map(
    (provId) => {
      const p = PAYMENT_PROVIDER_CATALOG[provId];
      const activePrefix = provId === selectedProvider ? '✅ ' : '';
      return Markup.button.callback(
        `${activePrefix}${p.shortTitle} (${p.feePercent}%)`,
        `topup:prov:${provId}`,
      );
    },
  );

  // Currency rows (up to 4 buttons per row)
  const currencyRows = [];
  const currencies = meta.supportedCurrencies;
  for (let i = 0; i < currencies.length; i += 4) {
    const slice = currencies.slice(i, i + 4);
    currencyRows.push(
      slice.map((curr) =>
        Markup.button.callback(
          `${curr === currency ? '🔹 ' : ''}${curr}`,
          `topup:curr:${selectedProvider}:${curr}`,
        ),
      ),
    );
  }

  // Preset amount rows (3 buttons per row)
  const amountRows = [];
  const amounts = meta.presetAmounts;
  for (let i = 0; i < amounts.length; i += 3) {
    const slice = amounts.slice(i, i + 3);
    amountRows.push(
      slice.map((amt) =>
        Markup.button.callback(
          `${amt === selectedAmount ? '🔘 ' : ''}${amt} ${currency}`,
          `topup:amt:${selectedProvider}:${currency}:${amt}`,
        ),
      ),
    );
  }

  return Markup.inlineKeyboard([
    providerRow,
    ...currencyRows,
    ...amountRows,
    [
      Markup.button.callback(
        '✏️ Ввести свою сумму',
        `topup:custom:${selectedProvider}:${currency}`,
      ),
    ],
    [
      Markup.button.callback(
        `💳 Оплатить ${calc.amountPaid} ${currency} (к зачислению ${calc.amountCredited})`,
        `topup:create:${selectedProvider}:${currency}:${calc.amountPaid}`,
      ),
    ],
    [
      Markup.button.callback('🪙 Доступные валюты и сети', 'topup:crypto_info'),
      Markup.button.callback('📜 История пополнений', 'topup:history'),
    ],
    [
      Markup.button.callback('👤 В профиль', 'menu:profile'),
      Markup.button.callback('🏠 Главное меню', 'menu:home'),
    ],
  ]);
}

export function buildTopUpInvoiceKeyboard(topUp: BalanceTopUpRecord) {
  const rows = [];
  if (topUp.payUrl && topUp.paymentStatus === 'pending') {
    rows.push([Markup.button.url('🔗 Перейти к оплате счёта', topUp.payUrl)]);
  }
  if (topUp.paymentStatus === 'pending') {
    rows.push([
      Markup.button.callback(
        '🔄 Проверить статус оплаты',
        `topup:check:${topUp.paymentId}`,
      ),
    ]);
    rows.push([
      Markup.button.callback(
        '❌ Отменить счёт',
        `topup:cancel:${topUp.paymentId}`,
      ),
    ]);
  }
  rows.push([
    Markup.button.callback('⬅️ К выбору пополнения', 'menu:topup'),
    Markup.button.callback('👤 В профиль', 'menu:profile'),
  ]);
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
        `💰 Оплатить с внутреннего баланса (${product.price})`,
        `buy_bal:${product.id}`,
      ),
    ],
    [
      Markup.button.callback('💳 Пополнить баланс', 'menu:topup'),
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
      `#${order.orderId.slice(-6)} • ${order.productName.slice(0, 22)} (${order.totalPrice} ${order.paymentMethod === 'balance' ? 'BAL' : '⭐'})`,
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
      Markup.button.callback('💳 Пополнения баланса', 'adm:topups:all'),
      Markup.button.callback('🛍 Управление товарами', 'adm:products'),
    ],
    [
      Markup.button.callback('➕ Добавить товар', 'adm:prod_add_start'),
      Markup.button.callback('👥 Пользователи и блокировки', 'adm:users'),
    ],
    [
      Markup.button.callback('✉️ Написать пользователю', 'adm:msg_user_start'),
      Markup.button.callback('🔌 Статус интеграций и логи', 'adm:integrations'),
    ],
    [Markup.button.callback('🏠 Выйти в меню покупателя', 'menu:home')],
  ]);
}

export function buildAdminTopUpsKeyboard(topUps: BalanceTopUpRecord[]) {
  const filterRow = [
    Markup.button.callback('Все', 'adm:topups:all'),
    Markup.button.callback('Оплачены', 'adm:topups:paid'),
    Markup.button.callback('Ожидают', 'adm:topups:pending'),
    Markup.button.callback('Ошибки/Истекли', 'adm:topups:failed'),
  ];

  const rows = topUps.slice(0, 10).map((t) => {
    const prov = PAYMENT_PROVIDER_CATALOG[t.provider]?.shortTitle || t.provider;
    return [
      Markup.button.callback(
        `#${t.paymentId.slice(-6)} | ${prov} | +${t.amountCredited}/${t.amountPaid} ${t.currency} | ${t.paymentStatus}`,
        `adm:topup:${t.paymentId}`,
      ),
    ];
  });

  return Markup.inlineKeyboard([
    filterRow,
    ...rows,
    [Markup.button.callback('⬅️ В админ-панель', 'adm:home')],
  ]);
}

export function buildAdminTopUpDetailKeyboard(topUp: BalanceTopUpRecord) {
  const rows = [];
  if (topUp.paymentStatus === 'pending') {
    rows.push([
      Markup.button.callback(
        '🔄 Проверить статус через API провайдера',
        `adm:topup_check:${topUp.paymentId}`,
      ),
    ]);
  }
  rows.push([
    Markup.button.callback('⬅️ К списку пополнений', 'adm:topups:all'),
    Markup.button.callback('🏠 В админ-панель', 'adm:home'),
  ]);
  return Markup.inlineKeyboard(rows);
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
      `#${o.orderId.slice(-6)} | ${o.productName.slice(0, 18)} | ${o.totalPrice}${o.paymentMethod === 'balance' ? ' BAL' : '⭐'} | ${ORDER_STATUS_LABELS[o.fulfillmentStatus].split(' ')[0]}`,
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

  // AUD-005: Кнопки обработки и выдачи доступны ТОЛЬКО для оплаченных заказов
  const isPaidForFulfillment =
    order.paymentStatus === 'paid' || order.paymentStatus === 'processing';

  if (
    isPaidForFulfillment &&
    order.fulfillmentStatus !== 'completed' &&
    order.fulfillmentStatus !== 'refunded' &&
    order.fulfillmentStatus !== 'cancelled'
  ) {
    const actionRow = [];
    if (order.fulfillmentStatus !== 'processing') {
      actionRow.push(
        Markup.button.callback(
          '🔄 Взять в обработку',
          `adm:ord_proc:${order.orderId}`,
        ),
      );
    }
    actionRow.push(
      Markup.button.callback(
        '✅ Подтвердить выдачу',
        `adm:ord_done:${order.orderId}`,
      ),
    );
    rows.push(actionRow);
    rows.push([
      Markup.button.callback(
        '📝 Выдать с кодом / сообщением',
        `adm:ord_note:${order.orderId}`,
      ),
    ]);
  }

  if (
    order.paymentStatus === 'paid' ||
    order.paymentStatus === 'processing' ||
    order.paymentStatus === 'completed'
  ) {
    rows.push([
      Markup.button.callback(
        '🔔 Повторить уведомление',
        `adm:ord_notify:${order.orderId}`,
      ),
    ]);
  }

  // AUD-004: Возврат Telegram Stars доступен только для реально оплаченных заказов с charge_id
  if (
    order.paymentMethod !== 'balance' &&
    order.telegramPaymentChargeId &&
    (order.paymentStatus === 'paid' ||
      order.paymentStatus === 'processing' ||
      order.paymentStatus === 'completed')
  ) {
    rows.push([
      Markup.button.callback(
        '↩️ Возврат Stars (refundStarPayment)',
        `adm:ord_refund:${order.orderId}`,
      ),
    ]);
  }

  // Возврат на внутренний баланс для заказов, оплаченных с внутреннего баланса
  if (
    order.paymentMethod === 'balance' &&
    !order.balanceRefunded &&
    (order.paymentStatus === 'paid' ||
      order.paymentStatus === 'processing' ||
      order.paymentStatus === 'completed' ||
      order.paymentStatus === 'failed')
  ) {
    rows.push([
      Markup.button.callback(
        '↩️ Возврат средств на внутренний баланс',
        `adm:ord_bal_refund:${order.orderId}`,
      ),
    ]);
  }

  if (
    order.paymentStatus === 'pending' &&
    order.fulfillmentStatus === 'pending'
  ) {
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

export function buildAdminOrderRefundConfirmKeyboard(order: Order) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `✅ Да, вернуть ${order.totalPrice} ⭐ покупателю`,
        `adm:ord_refund_confirm:${order.orderId}`,
      ),
    ],
    [
      Markup.button.callback(
        '❌ Отмена (вернуться к заказу)',
        `adm:ord:${order.orderId}`,
      ),
    ],
  ]);
}

export function buildAdminOrderBalanceRefundConfirmKeyboard(order: Order) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `✅ Да, вернуть ${order.totalPrice} на внутренний баланс`,
        `adm:ord_bal_refund_confirm:${order.orderId}`,
      ),
    ],
    [
      Markup.button.callback(
        '❌ Отмена (вернуться к заказу)',
        `adm:ord:${order.orderId}`,
      ),
    ],
  ]);
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

