import { Markup } from 'telegraf';
import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
  DigitalKeyRecord,
  Order,
  Product,
  ProductCategory,
  StoreUser,
} from '../types.ts';
import { CATEGORY_LABELS, ORDER_STATUS_LABELS } from '../constants.ts';
import { formatUsd } from '../config/env.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  XROCKET_SUPPORTED_ASSETS,
  convertUsdToPaymentCurrency,
} from '../services/PaymentProviders.ts';
import { calculateTopUpCommission } from '../services/BalanceService.ts';
import { ProductKeyStockSummary } from '../services/DigitalKeyService.ts';
import { oeBtn } from './outlineEmoji.ts';

export function buildMainMenuKeyboard(isAdmin = false) {
  const rows = [
    [Markup.button.callback(`${oeBtn('stars')} Купить Stars`, 'cat:stars')],
    [Markup.button.callback(`${oeBtn('premium')} Купить Premium`, 'cat:premium')],
    [Markup.button.callback(`${oeBtn('gifts')} Купить Gifts`, 'cat:gifts')],
    [
      Markup.button.callback(`${oeBtn('orders')} Мои заказы`, 'menu:orders'),
      Markup.button.callback(`${oeBtn('profile')} Мой профиль`, 'menu:profile'),
    ],
    [
      Markup.button.callback(`${oeBtn('topup')} Пополнить баланс`, 'menu:topup'),
      Markup.button.callback(`${oeBtn('support')} Поддержка`, 'menu:support'),
    ],
  ];

  if (isAdmin) {
    rows.push([
      Markup.button.callback(
        `${oeBtn('admin')} Админ-панель магазина`,
        'adm:home',
      ),
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

export function buildUserProfileKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${oeBtn('topup')} Пополнить баланс`, 'menu:topup')],
    [
      Markup.button.callback(
        `${oeBtn('history')} История пополнений`,
        'topup:history',
      ),
    ],
    [
      Markup.button.callback(
        `${oeBtn('home')} Вернуться в главное меню`,
        'menu:home',
      ),
    ],
  ]);
}

/**
 * Шаг 1/3: Минималистичный выбор способа оплаты (CryptoBot [3%] или xRocket [2%]).
 */
export function buildTopUpStep1ProviderKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${oeBtn('cryptobot')} CryptoBot [3%]`,
        'topup:prov:cryptobot',
      ),
      Markup.button.callback(
        `${oeBtn('xrocket')} xRocket [2%]`,
        'topup:prov:xrocket',
      ),
    ],
    [
      Markup.button.callback(
        `${oeBtn('history')} История пополнений`,
        'topup:history',
      ),
    ],
    [Markup.button.callback(`${oeBtn('back')} Назад`, 'menu:profile')],
  ]);
}

/**
 * Шаг 2/3: Свободный ввод суммы пополнения в USD ($) без фиксированных кнопок сумм.
 * Позволяет переключать способ оплаты с мгновенным пересчётом комиссии.
 */
export function buildTopUpStep2AmountKeyboard(
  provider: BalanceTopUpProvider,
  selectedAmount?: number,
  selectedCurrency?: string,
) {
  const meta = PAYMENT_PROVIDER_CATALOG[provider];
  const currency =
    selectedCurrency && meta.supportedCurrencies.includes(selectedCurrency)
      ? selectedCurrency
      : meta.defaultCurrency;

  const hasValidAmount =
    typeof selectedAmount === 'number' &&
    Number.isFinite(selectedAmount) &&
    selectedAmount >= meta.minAmount &&
    selectedAmount <= meta.maxAmount;

  const amountForSwitch = hasValidAmount ? selectedAmount : 0;

  const providerSwitchRow = (['cryptobot', 'xrocket'] as const).map((provId) => {
    const p = PAYMENT_PROVIDER_CATALOG[provId];
    const isCurrent = provId === provider;
    const icon = provId === 'cryptobot' ? oeBtn('cryptobot') : oeBtn('xrocket');
    const targetCallback =
      amountForSwitch > 0
        ? `topup:amt:${provId}:${p.defaultCurrency}:${amountForSwitch}`
        : `topup:prov:${provId}`;
    return Markup.button.callback(
      `${isCurrent ? '● ' : ''}${icon} ${p.shortTitle} [${p.feePercent}%]`,
      targetCallback,
    );
  });

  const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [
    providerSwitchRow,
  ];

  if (hasValidAmount) {
    const calc = calculateTopUpCommission(selectedAmount, provider);
    const actionButton =
      provider === 'xrocket'
        ? Markup.button.callback(
            `${oeBtn('currency')} Выбрать монету и сеть (${formatUsd(calc.amountPaid)} → +${formatUsd(calc.amountCredited)})`,
            `topup:xr_curr:${calc.amountPaid}`,
          )
        : Markup.button.callback(
            `${oeBtn('topup')} Создать счёт ${formatUsd(calc.amountPaid)} (к зачислению +${formatUsd(calc.amountCredited)})`,
            `topup:create:cryptobot:${currency}:${calc.amountPaid}`,
          );

    rows.push([actionButton]);
    rows.push([
      Markup.button.callback(
        `${oeBtn('edit')} Изменить сумму ($)`,
        `topup:custom:${provider}:${currency}`,
      ),
    ]);
  } else {
    rows.push([
      Markup.button.callback(
        `${oeBtn('edit')} Ввести сумму в USD ($)`,
        `topup:custom:${provider}:${currency}`,
      ),
    ]);
  }

  rows.push([Markup.button.callback(`${oeBtn('back')} Назад`, 'menu:topup')]);

  return Markup.inlineKeyboard(rows);
}

/**
 * Шаг 3/3 (для xRocket): Выбор монеты и сети оплаты перед созданием счёта.
 * Показывает конвертацию из USD, если монета отличается от USDT/USDC.
 */
export function buildTopUpStep3XRocketCurrencyKeyboard(amountUsd: number) {
  const assetButtons: Array<ReturnType<typeof Markup.button.callback>> = [];

  const coinIcons: Record<string, string> = {
    USDT: '💎',
    TON: '💠',
    BTC: '₿',
    ETH: 'Ξ',
    TRX: '🔺',
    BNB: '🟠',
    USDC: '🔵',
  };

  for (const asset of XROCKET_SUPPORTED_ASSETS) {
    const icon = coinIcons[asset.code] || '🪙';
    const conv = convertUsdToPaymentCurrency(amountUsd, asset.code);
    const amountSuffix = conv.requiresConversionNotice
      ? ` • ~${conv.convertedAmount} ${asset.code}`
      : '';
    for (const net of asset.networks) {
      const netCode = encodeURIComponent(net);
      assetButtons.push(
        Markup.button.callback(
          `${icon} ${asset.code} (${net})${amountSuffix}`,
          `topup:xr_pay:${asset.code}:${netCode}:${amountUsd}`,
        ),
      );
    }
  }

  const rows = [];
  for (let i = 0; i < assetButtons.length; i += 2) {
    rows.push(assetButtons.slice(i, i + 2));
  }

  rows.push([
    Markup.button.callback(
      `${oeBtn('back')} Назад`,
      `topup:amt:xrocket:USDT:${amountUsd}`,
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

/**
 * Клавиатура меню пополнения баланса со свободным вводом суммы в USD (без фиксированных кнопок сумм).
 */
export function buildTopUpMenuKeyboard(
  selectedProvider: BalanceTopUpProvider = 'cryptobot',
  selectedCurrency?: string,
  selectedAmount?: number,
) {
  return buildTopUpStep2AmountKeyboard(
    selectedProvider,
    selectedAmount,
    selectedCurrency,
  );
}

/**
 * Клавиатура созданного счёта (Шаг 3/3):
 * 1. «💳 Оплатить»
 * 2. «🔄 Проверить оплату»
 * 3. «« Назад»
 */
export function buildTopUpInvoiceKeyboard(topUp: BalanceTopUpRecord) {
  const rows = [];
  if (topUp.payUrl && topUp.paymentStatus === 'pending') {
    rows.push([
      Markup.button.url(
        `${oeBtn('topup')} Оплатить (${formatUsd(topUp.amountUsd ?? topUp.amountPaid)})`,
        topUp.payUrl,
      ),
    ]);
  }
  if (topUp.paymentStatus === 'pending') {
    rows.push([
      Markup.button.callback(
        `${oeBtn('refresh')} Проверить оплату`,
        `topup:check:${topUp.paymentId}`,
      ),
    ]);
  }
  rows.push([Markup.button.callback(`${oeBtn('back')} Назад`, 'menu:topup')]);
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
    [Markup.button.callback('💳 Пополнить баланс', 'menu:topup')],
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
      Markup.button.callback(
        '❌ Отменить неоплаченный заказ',
        `ucancel:${order.orderId}`,
      ),
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

export function buildAdminMainKeyboard(isOwner = false) {
  const rows = [
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
  ];

  if (isOwner) {
    rows.push([
      Markup.button.callback(
        '🔑 Генератор и склад ключей (Owner)',
        'own:keys:home',
      ),
    ]);
  }

  rows.push([Markup.button.callback('🏠 Выйти в меню покупателя', 'menu:home')]);
  return Markup.inlineKeyboard(rows);
}

export function buildOwnerKeysHomeKeyboard(
  products: Product[],
  summaries: ProductKeyStockSummary[],
) {
  const summaryMap = new Map(summaries.map((s) => [s.productId, s]));
  const rows = products.map((product) => {
    const s = summaryMap.get(product.id);
    const avail = s?.available ?? 0;
    const deliv = s?.delivered ?? 0;
    const algBadge = product.keyGeneratorAlgorithm ? '⚙️' : '📝';
    return [
      Markup.button.callback(
        `${algBadge} ${product.name} [Доступно: ${avail} | Выдано: ${deliv}]`,
        `own:keys:prod:${product.id}`,
      ),
    ];
  });

  rows.push([
    Markup.button.callback('📜 История выдачи ключей', 'own:keys:history'),
  ]);
  rows.push([Markup.button.callback('⬅️ В админ-панель', 'adm:home')]);
  return Markup.inlineKeyboard(rows);
}

export function buildOwnerProductKeysKeyboard(
  product: Product,
  summary: ProductKeyStockSummary,
) {
  const rows = [
    [
      Markup.button.callback(
        '➕ Добавить ключи вручную',
        `own:keys:add:${product.id}`,
      ),
    ],
  ];

  if (product.keyGeneratorAlgorithm) {
    rows.push([
      Markup.button.callback(
        '⚙️ Сгенерировать +1 ключ',
        `own:keys:gen:${product.id}:1`,
      ),
      Markup.button.callback(
        '⚙️ Сгенерировать +5 ключей',
        `own:keys:gen:${product.id}:5`,
      ),
    ]);
  }

  if (summary.available > 0) {
    rows.push([
      Markup.button.callback(
        `🚫 Управление доступными ключами (${summary.available})`,
        `own:keys:avail:${product.id}`,
      ),
    ]);
  }

  if (summary.delivered > 0) {
    rows.push([
      Markup.button.callback(
        `📦 Выданные ключи (${summary.delivered})`,
        `own:keys:deliv:${product.id}`,
      ),
    ]);
  }

  rows.push([
    Markup.button.callback('⬅️ К складу ключей', 'own:keys:home'),
    Markup.button.callback('🏠 В админ-панель', 'adm:home'),
  ]);

  return Markup.inlineKeyboard(rows);
}

export function buildOwnerAvailableKeysKeyboard(
  productId: string,
  keys: DigitalKeyRecord[],
) {
  const rows = keys.slice(0, 10).map((k) => [
    Markup.button.callback(
      `🚫 Отключить ${k.maskedPreview} (${k.keyId.slice(-6)})`,
      `own:keys:disable:${k.keyId}`,
    ),
  ]);

  rows.push([
    Markup.button.callback(
      '⬅️ Назад к товару',
      `own:keys:prod:${productId}`,
    ),
  ]);

  return Markup.inlineKeyboard(rows);
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
    [Markup.button.callback('🗑 Удалить товар', `adm:pdel:${product.id}`)],
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
        user.isBlocked
          ? '✅ Разблокировать пользователя'
          : '🚫 Заблокировать пользователя',
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
