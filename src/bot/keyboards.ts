import { Markup } from 'telegraf';
import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
  DigitalKeyRecord,
  Order,
  PaymentRecord,
  Product,
  ProductCategory,
  StoreUser,
} from '../types.ts';
import { CATEGORY_LABELS, ORDER_STATUS_LABELS } from '../constants.ts';
import { formatUsd } from '../config/env.ts';
import { formatUsdCents } from '../services/Money.ts';
import {
  PAYMENT_PROVIDER_CATALOG,
  XROCKET_SUPPORTED_ASSETS,
} from '../services/PaymentProviders.ts';
import { calculateTopUpCommission } from '../services/BalanceService.ts';
import { ProductKeyStockSummary } from '../services/DigitalKeyService.ts';
import { ProductService } from '../services/ProductService.ts';
import { LiveCurrencyPreviewItem } from './formatters.ts';
import { oeBtn } from './outlineEmoji.ts';

function formatShortOrderPrice(order: Order): string {
  if (order.currency === 'XTR') return `${order.totalPrice}⭐`;
  return formatUsdCents(order.totalPriceUsdCents ?? order.totalPrice);
}

export function buildMainMenuKeyboard(isAdmin = false) {
  const rows = [
    [Markup.button.callback(`${oeBtn('stars')} Купить Stars`, 'cat:stars')],
    [Markup.button.callback(`${oeBtn('premium')} Купить Premium`, 'cat:premium')],
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
        `${oeBtn('admin')} Админ-панель QuizyStars`,
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
        `${oeBtn('home')} Главное меню`,
        'menu:home',
      ),
    ],
  ]);
}

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
            `${oeBtn('currency')} Выбрать монету (${formatUsdCents(calc.amountUsdCents)} → +${formatUsdCents(calc.amountCreditedUsdCents)})`,
            `topup:xr_curr:${calc.amountPaid}`,
          )
        : Markup.button.callback(
            `${oeBtn('topup')} Создать счёт ${formatUsdCents(calc.amountUsdCents)} (+${formatUsdCents(calc.amountCreditedUsdCents)})`,
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

export function buildTopUpStep3XRocketCurrencyKeyboard(
  amountUsd: number,
  livePreviews?: LiveCurrencyPreviewItem[],
) {
  const assetButtons: Array<ReturnType<typeof Markup.button.callback>> = [];
  const previewMap = new Map(
    (livePreviews ?? []).map((item) => [item.code, item]),
  );

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
    const preview = previewMap.get(asset.code);
    if (previewMap.size > 0 && preview && !preview.conversion) {
      // Skip coins whose live rate could not be fetched from xRocket
      continue;
    }
    const icon = coinIcons[asset.code] || '🪙';
    const suffix =
      preview?.conversion && preview.conversion.requiresConversionNotice
        ? ` • ${preview.conversion.convertedAmountStr}`
        : '';
    for (const net of asset.networks) {
      const netCode = encodeURIComponent(net);
      assetButtons.push(
        Markup.button.callback(
          `${icon} ${asset.code} (${net})${suffix}`,
          `topup:xr_pay:${asset.code}:${netCode}:${amountUsd}`,
        ),
      );
    }
  }

  const rows = [];
  for (let i = 0; i < assetButtons.length; i += 2) {
    rows.push(assetButtons.slice(i, i + 2));
  }

  if (rows.length === 0) {
    rows.push([
      Markup.button.callback('🔄 Повторить загрузку курсов', `topup:xr_curr:${amountUsd}`),
    ]);
  }

  rows.push([
    Markup.button.callback(
      `${oeBtn('back')} Назад`,
      `topup:amt:xrocket:USDT:${amountUsd}`,
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

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

export function buildTopUpInvoiceKeyboard(topUp: BalanceTopUpRecord) {
  const rows = [];
  if (topUp.payUrl && topUp.paymentStatus === 'pending') {
    const grossCents =
      typeof topUp.amountUsdCents === 'number'
        ? topUp.amountUsdCents
        : Math.round((topUp.amountUsd ?? topUp.amountPaid) * 100);
    rows.push([
      Markup.button.url(
        `${oeBtn('topup')} Оплатить (${formatUsdCents(grossCents)})`,
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
    [Markup.button.callback(`${oeBtn('stars')} Купить Stars`, 'cat:stars')],
    [Markup.button.callback(`${oeBtn('premium')} Купить Premium`, 'cat:premium')],
    [Markup.button.callback(`${oeBtn('home')} Главное меню`, 'menu:home')],
  ]);
}

export function buildPremiumTariffsKeyboard(products: Product[]) {
  const catalog = ProductService.resolveBuyerPremiumCatalog(products);
  const rows = catalog.availableProducts.map((p) => {
    const cents = p.priceUsdCents ?? p.price;
    const months = ProductService.resolvePremiumDurationMonths(p);
    const monthWord = months === 3 ? 'месяца' : 'месяцев';
    return [
      Markup.button.callback(
        `💎 ${months} ${monthWord} — ${formatUsdCents(cents)}`,
        `prem:select:${p.id}`,
      ),
    ];
  });

  rows.push([Markup.button.callback(`${oeBtn('back')} Назад`, 'menu:home')]);
  return Markup.inlineKeyboard(rows);
}

export function buildCategoryProductsKeyboard(
  category: ProductCategory,
  products: Product[],
) {
  if (category === 'premium') {
    return buildPremiumTariffsKeyboard(products);
  }

  const rows = products
    .filter((p) => p.category !== 'gifts')
    .map((product) => {
      const cents = product.priceUsdCents ?? product.price;
      const labelPrice =
        product.minQuantity && product.minQuantity > 1
          ? `${formatUsdCents(product.unitPriceUsdCents ?? cents)} / 1 ⭐`
          : formatUsdCents(cents);
      return [
        Markup.button.callback(
          `${product.name} — ${labelPrice}`,
          `prod:${product.id}`,
        ),
      ];
    });

  rows.push([
    Markup.button.callback('📂 Категории', 'menu:catalog'),
    Markup.button.callback('🏠 Меню', 'menu:home'),
  ]);

  return Markup.inlineKeyboard(rows);
}

export function buildProductDetailKeyboard(product: Product) {
  const cents = product.priceUsdCents ?? product.price;
  const rows = [];

  if (product.minQuantity && product.minQuantity > 1) {
    rows.push([
      Markup.button.callback(
        '✨ Выбрать количество Stars',
        'cat:stars',
      ),
    ]);
  } else if (product.category === 'premium') {
    rows.push([
      Markup.button.callback(
        `💳 Выбрать за ${formatUsdCents(cents)}`,
        `prem:select:${product.id}`,
      ),
    ]);
  }

  rows.push([
    Markup.button.callback('🏠 Главное меню', 'menu:home'),
  ]);

  return Markup.inlineKeyboard(rows);
}

export function buildPromptStarsQuantityKeyboard(canReturnToConfirm = false) {
  const rows = [];
  if (canReturnToConfirm) {
    rows.push([Markup.button.callback('⬅️ Назад', 'checkout:back_confirm')]);
  } else {
    rows.push([Markup.button.callback('⬅️ Назад', 'menu:home')]);
  }
  rows.push([Markup.button.callback('❌ Отменить', 'checkout:cancel')]);
  return Markup.inlineKeyboard(rows);
}

export function buildPromptRecipientKeyboard(
  category: ProductCategory | string,
  validSelfUsername?: string | null,
  canReturnToConfirm = false,
) {
  const rows = [];
  if (validSelfUsername) {
    const cleanSelf = validSelfUsername.replace(/^@/, '').toLowerCase();
    rows.push([
      Markup.button.callback(
        `👤 Купить себе (@${cleanSelf})`,
        'rcpt_self',
      ),
    ]);
  }
  const backCallback = canReturnToConfirm
    ? 'checkout:back_confirm'
    : category === 'stars' || category === 'stars_custom'
      ? 'stars:edit_qty'
      : 'cat:premium';
  rows.push([
    Markup.button.callback('⬅️ Назад', backCallback),
    Markup.button.callback('❌ Отменить', 'checkout:cancel'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function buildOrderConfirmationKeyboard(category: ProductCategory) {
  const editButton =
    category === 'stars'
      ? Markup.button.callback('✏️ Изменить количество', 'checkout:edit_qty')
      : Markup.button.callback('💎 Изменить тариф', 'cat:premium');

  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 Перейти к оплате', 'checkout:proceed')],
    [
      editButton,
      Markup.button.callback('👤 Изменить получателя', 'checkout:edit_recipient'),
    ],
    [Markup.button.callback('❌ Отменить заказ', 'checkout:cancel')],
  ]);
}

export function buildOrderCheckoutChooserKeyboard(
  order: Order,
  currentBalanceUsdCents: number,
) {
  const orderCents = order.totalPriceUsdCents ?? order.totalPrice;
  const canAfford = currentBalanceUsdCents >= orderCents;
  const balLabel = canAfford
    ? `💰 Внутренний USD-баланс (${formatUsdCents(currentBalanceUsdCents)})`
    : `💰 USD-баланс (${formatUsdCents(currentBalanceUsdCents)} — недостаточно)`;

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        balLabel,
        canAfford ? `pay_bal:${order.orderId}` : `pay_bal_insuff:${order.orderId}`,
      ),
    ],
    [
      Markup.button.callback(
        `${oeBtn('cryptobot')} CryptoBot`,
        `pay_ord_prov:cryptobot:${order.orderId}`,
      ),
      Markup.button.callback(
        `${oeBtn('xrocket')} xRocket`,
        `pay_ord_prov:xrocket:${order.orderId}`,
      ),
    ],
    [Markup.button.callback('❌ Отменить заказ', `ucancel:${order.orderId}`)],
  ]);
}

export function buildOrderCryptoCurrencyKeyboard(
  orderId: string,
  provider: BalanceTopUpProvider,
  currencies: LiveCurrencyPreviewItem[],
) {
  const buttons: Array<ReturnType<typeof Markup.button.callback>> = [];
  for (const item of currencies) {
    if (!item.conversion) continue;
    const nets = item.networks.length > 0 ? item.networks : ['NONE'];
    for (const net of nets) {
      const netEnc = encodeURIComponent(net);
      const label =
        net === 'NONE'
          ? `${item.code}${item.conversion.requiresConversionNotice ? ` (${item.conversion.convertedAmountStr})` : ''}`
          : `${item.code} (${net})`;
      buttons.push(
        Markup.button.callback(
          label,
          `pay_ord:${provider}:${item.code}:${netEnc}:${orderId}`,
        ),
      );
    }
  }

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  if (rows.length === 0) {
    rows.push([
      Markup.button.callback(
        '🔄 Повторить загрузку курсов',
        `pay_ord_prov:${provider}:${orderId}`,
      ),
    ]);
  }

  rows.push([
    Markup.button.callback('⬅️ Другой способ оплаты', `ordpay_menu:${orderId}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function buildOrderPaymentInvoiceKeyboard(
  order: Order,
  payment: PaymentRecord,
) {
  const rows = [];
  if (payment.payUrl && payment.status === 'pending') {
    rows.push([
      Markup.button.url(
        `💳 Оплатить ${payment.expectedAmountStr} ${payment.currency}`,
        payment.payUrl,
      ),
    ]);
    rows.push([
      Markup.button.callback(
        '🔄 Проверить оплату',
        `chk_ordpay:${payment.paymentId}`,
      ),
    ]);
  }

  if (order.paymentStatus === 'pending') {
    rows.push([
      Markup.button.callback('💳 Другой способ', `ordpay_menu:${order.orderId}`),
      Markup.button.callback('❌ Отменить', `ucancel:${order.orderId}`),
    ]);
  } else {
    rows.push([
      Markup.button.callback('📦 Мои заказы', 'menu:orders'),
      Markup.button.callback('🏠 Меню', 'menu:home'),
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

export function buildUserOrdersKeyboard(orders: Order[]) {
  const rows = orders.slice(0, 8).map((order) => [
    Markup.button.callback(
      `#${order.orderId.slice(-6)} • ${order.productName.slice(0, 20)} (${formatShortOrderPrice(order)})`,
      `uord:${order.orderId}`,
    ),
  ]);

  rows.push([
    Markup.button.callback('🔄 Обновить', 'menu:orders'),
    Markup.button.callback('🏠 Меню', 'menu:home'),
  ]);

  return Markup.inlineKeyboard(rows);
}

export function buildUserOrderDetailKeyboard(order: Order) {
  const rows = [];
  if (order.paymentStatus === 'pending') {
    rows.push([
      Markup.button.callback('💳 Перейти к оплате', `ordpay_menu:${order.orderId}`),
    ]);
    if (order.activePaymentId) {
      rows.push([
        Markup.button.callback('🔄 Проверить оплату', `chk_ordpay:${order.activePaymentId}`),
      ]);
    }
    rows.push([
      Markup.button.callback(
        '❌ Отменить заказ',
        `ucancel:${order.orderId}`,
      ),
    ]);
  }
  rows.push([
    Markup.button.callback('⬅️ К заказам', 'menu:orders'),
    Markup.button.callback('🏠 Меню', 'menu:home'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function buildBackToMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Главное меню', 'menu:home')],
  ]);
}

export function buildAdminMainKeyboard(isOwner = false) {
  const rows = [
    [
      Markup.button.callback('📊 Статистика', 'adm:stats'),
      Markup.button.callback('📦 Заказы', 'adm:orders:all'),
    ],
    [
      Markup.button.callback('💳 Пополнения', 'adm:topups:all'),
      Markup.button.callback('🛍 Товары', 'adm:products'),
    ],
    [
      Markup.button.callback('➕ Новый товар', 'adm:prod_add_start'),
      Markup.button.callback('👥 Пользователи', 'adm:users'),
    ],
    [
      Markup.button.callback('✉️ Написать юзеру', 'adm:msg_user_start'),
      Markup.button.callback('🔌 Интеграции и логи', 'adm:integrations'),
    ],
  ];

  if (isOwner) {
    rows.push([
      Markup.button.callback(
        '🔑 Склад ключей (Owner)',
        'own:keys:home',
      ),
    ]);
  }

  rows.push([Markup.button.callback('🏠 Меню покупателя', 'menu:home')]);
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
        `${algBadge} ${product.name} [${avail} / ${deliv}]`,
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
        '⚙️ +1 ключ',
        `own:keys:gen:${product.id}:1`,
      ),
      Markup.button.callback(
        '⚙️ +5 ключей',
        `own:keys:gen:${product.id}:5`,
      ),
    ]);
  }

  if (summary.available > 0) {
    rows.push([
      Markup.button.callback(
        `🚫 Доступные ключи (${summary.available})`,
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
    Markup.button.callback('⬅️ Склад', 'own:keys:home'),
    Markup.button.callback('🏠 Админ-панель', 'adm:home'),
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
    Markup.button.callback('⬅️ Назад', `own:keys:prod:${productId}`),
  ]);

  return Markup.inlineKeyboard(rows);
}

export function buildAdminTopUpsKeyboard(topUps: BalanceTopUpRecord[]) {
  const filterRow = [
    Markup.button.callback('Все', 'adm:topups:all'),
    Markup.button.callback('Оплачены', 'adm:topups:paid'),
    Markup.button.callback('Ожидают', 'adm:topups:pending'),
    Markup.button.callback('Ошибки', 'adm:topups:failed'),
  ];

  const rows = topUps.slice(0, 10).map((t) => {
    const prov = PAYMENT_PROVIDER_CATALOG[t.provider]?.shortTitle || t.provider;
    const grossCents =
      typeof t.amountUsdCents === 'number'
        ? t.amountUsdCents
        : Math.round((t.amountUsd ?? t.amountPaid) * 100);
    return [
      Markup.button.callback(
        `#${t.paymentId.slice(-6)} | ${prov} | ${formatUsdCents(grossCents)} | ${t.paymentStatus}`,
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
        '🔄 Проверить у провайдера',
        `adm:topup_check:${topUp.paymentId}`,
      ),
    ]);
  }
  rows.push([
    Markup.button.callback('⬅️ К пополнениям', 'adm:topups:all'),
    Markup.button.callback('🏠 Админ-панель', 'adm:home'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function buildAdminProductsKeyboard(products: Product[]) {
  const rows = products.map((p) => {
    const cents = p.priceUsdCents ?? p.price;
    const priceLabel = p.currency === 'XTR' ? `${p.price} ⭐` : formatUsdCents(cents);
    return [
      Markup.button.callback(
        `${p.isActive ? '🟢' : '🔴'} ${p.name} (${priceLabel})`,
        `adm:prod:${p.id}`,
      ),
    ];
  });

  rows.push([
    Markup.button.callback('➕ Добавить товар', 'adm:prod_add_start'),
  ]);
  rows.push([Markup.button.callback('⬅️ В админ-панель', 'adm:home')]);
  return Markup.inlineKeyboard(rows);
}

export function buildAdminProductManageKeyboard(product: Product) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('💰 Цена (USD)', `adm:pprice:${product.id}`),
      Markup.button.callback('✏️ Название', `adm:pname:${product.id}`),
    ],
    [
      Markup.button.callback('📝 Описание', `adm:pdesc:${product.id}`),
      Markup.button.callback(
        product.isActive ? '⏸ Отключить' : '▶️ Включить',
        `adm:ptoggle:${product.id}`,
      ),
    ],
    [Markup.button.callback('🗑 Удалить товар', `adm:pdel:${product.id}`)],
    [Markup.button.callback('⬅️ К товарам', 'adm:products')],
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
      `#${o.orderId.slice(-6)} | ${o.productName.slice(0, 16)} | ${formatShortOrderPrice(o)} | ${ORDER_STATUS_LABELS[o.fulfillmentStatus].split(' ')[0]}`,
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
          '🔄 В работу',
          `adm:ord_proc:${order.orderId}`,
        ),
      );
    }
    actionRow.push(
      Markup.button.callback(
        '✅ Выдать',
        `adm:ord_done:${order.orderId}`,
      ),
    );
    rows.push(actionRow);
    rows.push([
      Markup.button.callback(
        '📝 Выдать с кодом',
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

  if (
    (order.paymentMethod === 'balance' || order.paymentMethod === 'internal_balance') &&
    !order.balanceRefunded &&
    (order.paymentStatus === 'paid' ||
      order.paymentStatus === 'processing' ||
      order.paymentStatus === 'completed' ||
      order.paymentStatus === 'failed')
  ) {
    rows.push([
      Markup.button.callback(
        '↩️ Возврат на внутренний баланс (USD)',
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
  rows.push([Markup.button.callback('⬅️ К заказам', 'adm:orders:all')]);

  return Markup.inlineKeyboard(rows);
}

export function buildAdminOrderRefundConfirmKeyboard(order: Order) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '⬅️ Вернуться к заказу (XTR отключён)',
        `adm:ord:${order.orderId}`,
      ),
    ],
  ]);
}

export function buildAdminOrderBalanceRefundConfirmKeyboard(order: Order) {
  const cents = order.totalPriceUsdCents ?? order.totalPrice;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `✅ Да, вернуть ${formatUsdCents(cents)} на баланс`,
        `adm:ord_bal_refund_confirm:${order.orderId}`,
      ),
    ],
    [
      Markup.button.callback(
        '❌ Отмена',
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
          ? '✅ Разблокировать'
          : '🚫 Заблокировать',
        `adm:ublock:${user.telegramId}`,
      ),
    ],
    [
      Markup.button.callback(
        '✉️ Отправить сообщение',
        `adm:msg_to:${user.telegramId}`,
      ),
    ],
    [Markup.button.callback('⬅️ К пользователям', 'adm:users')],
  ]);
}
