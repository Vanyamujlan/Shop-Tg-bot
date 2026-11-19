import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
  DigitalKeyRecord,
  Order,
  PaymentRecord,
  Product,
  ProductCategory,
  StoreTransaction,
  StoreUser,
} from '../types.ts';
import { CATEGORY_LABELS, ORDER_STATUS_LABELS } from '../constants.ts';
import {
  MAX_TOPUP_AMOUNT_USD,
  MIN_TOPUP_AMOUNT_USD,
  formatUsd,
  getEnvConfig,
} from '../config/env.ts';
import {
  formatUsdCents,
  usdInputToCents,
} from '../services/Money.ts';
import {
  LiveUsdConversionResult,
  PAYMENT_PROVIDER_CATALOG,
  XROCKET_SUPPORTED_ASSETS,
} from '../services/PaymentProviders.ts';
import { calculateTopUpCommission } from '../services/BalanceService.ts';
import { ProductKeyStockSummary } from '../services/DigitalKeyService.ts';
import { oe } from './outlineEmoji.ts';

export interface LiveCurrencyPreviewItem {
  code: string;
  networks: string[];
  conversion?: LiveUsdConversionResult;
  error?: string;
}

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

export function formatProductPriceLabel(product: Product): string {
  const cents = product.priceUsdCents ?? product.price;
  if (product.currency === 'XTR') {
    return `${product.price} ⭐ (XTR)`;
  }
  if (product.minQuantity && product.minQuantity > 1) {
    return `${formatUsdCents(product.unitPriceUsdCents ?? cents)} / шт. (от ${product.minQuantity})`;
  }
  return formatUsdCents(cents);
}

export function formatOrderAmountLabel(order: Order): string {
  if (order.currency === 'XTR') {
    return `${order.totalPrice} ⭐ (XTR)`;
  }
  return formatUsdCents(order.totalPriceUsdCents ?? order.totalPrice);
}

export function formatOrderPaymentMethodLabel(order: Order): string {
  switch (order.paymentMethod) {
    case 'balance':
    case 'internal_balance':
      return `${oe('wallet')} Баланс QuizyStars (USD)`;
    case 'cryptobot':
      return `${oe('cryptobot')} CryptoBot`;
    case 'xrocket':
      return `${oe('xrocket')} xRocket`;
    case 'stars':
    case 'telegram_stars':
      return `${oe('stars')} Telegram Stars (архив)`;
    default:
      return `${oe('topup')} Ожидает выбора способа оплаты`;
  }
}

export function formatWelcomeMessage(firstName: string, isAdmin: boolean): string {
  return [
    `${oe('brand')} <b>QuizyStars — привет, ${escapeHtml(firstName)}!</b>`,
    '',
    'Покупка <b>Telegram Stars</b> и <b>Telegram Premium</b>:',
    `• ${oe('stars')} <b>Telegram Stars</b> — от 50 до 100 000 ⭐ ($0.02 за 1 ⭐)`,
    `• ${oe('premium')} <b>Telegram Premium</b> — 3, 6 или 12 месяцев`,
    '',
    `${oe('lock')} <b>Оплата:</b> внутренний баланс (USD), CryptoBot, xRocket.`,
    isAdmin
      ? `\n${oe('admin')} <i>Панель администратора: /admin</i>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatCatalogOverviewMessage(): string {
  return [
    `${oe('catalog')} <b>Каталог QuizyStars</b>`,
    '',
    'Выберите товар:',
    `• ${oe('stars')} <b>Telegram Stars</b> — любое количество (50–100 000 ⭐), $0.02 за 1 ⭐`,
    `• ${oe('premium')} <b>Telegram Premium</b> — 3 мес. ($13.90), 6 мес. ($19.90), 12 мес. ($34.90)`,
  ].join('\n');
}

export function formatCategoryListMessage(
  category: ProductCategory,
  products: Product[],
): string {
  const title = CATEGORY_LABELS[category];
  if (products.length === 0) {
    return [
      `${oe('catalog')} <b>${title}</b>`,
      '',
      'В этой категории пока нет активных товаров.',
    ].join('\n');
  }

  const lines = products.map(
    (p, idx) =>
      `${idx + 1}. <b>${escapeHtml(p.name)}</b> — <code>${formatProductPriceLabel(p)}</code>`,
  );

  return [
    `${oe('catalog')} <b>${title}</b>`,
    '',
    ...lines,
    '',
    'Выберите тариф ниже:',
  ].join('\n');
}

export function formatPremiumTariffsMessage(products: Product[]): string {
  const tariffLines = products.map((p) => {
    const cents = p.priceUsdCents ?? p.price;
    const months = p.durationMonths ?? '';
    return `• <b>${months} месяцев</b> — <code>${formatUsdCents(cents)}</code>`;
  });

  return [
    `${oe('premium')} <b>Купить Telegram Premium</b>`,
    '',
    'Доступные тарифы:',
    ...(tariffLines.length > 0
      ? tariffLines
      : [
          '• <b>3 месяца</b> — <code>$13.90</code>',
          '• <b>6 месяцев</b> — <code>$19.90</code>',
          '• <b>12 месяцев</b> — <code>$34.90</code>',
        ]),
    '',
    'Выберите подходящий срок подписки:',
  ].join('\n');
}

export function formatProductCardMessage(product: Product): string {
  const recipientHint =
    product.category === 'stars' || product.category === 'premium'
      ? `\n${oe('profile')} <b>Получатель:</b> указывается Telegram <code>@username</code> при оформлении.`
      : '';

  return [
    `${oe('catalog')} <b>${escapeHtml(product.name)}</b>`,
    `${oe('info')} Категория: <b>${CATEGORY_LABELS[product.category]}</b>`,
    '',
    `${escapeHtml(product.description)}`,
    '',
    `${oe('amount')} <b>Цена:</b> <code>${formatProductPriceLabel(product)}</code>${recipientHint}`,
  ].join('\n');
}

export function formatPromptCustomQuantityMessage(product: Product): string {
  const minQ = product.minQuantity ?? 50;
  const maxQ = product.maxQuantity ?? 100000;
  const unitCents = product.unitPriceUsdCents ?? product.priceUsdCents ?? product.price;
  return [
    `${oe('stars')} <b>Купить Telegram Stars</b>`,
    '',
    `Введите количество Stars от <b>${minQ}</b> до <b>${maxQ.toLocaleString('en-US').replace(/,/g, ' ')}</b>.`,
    `Цена: <code>${formatUsdCents(unitCents)}</code> за 1 ⭐ (например: <code>100</code> = <code>${formatUsdCents(unitCents * 100)}</code>).`,
  ].join('\n');
}

export function formatPromptRecipientUsernameMessage(params: {
  productName: string;
  quantity: number;
  totalPriceUsdCents: number;
  category?: ProductCategory;
  durationMonths?: 3 | 6 | 12;
}): string {
  const itemLine =
    params.category === 'stars'
      ? `${oe('stars')} Товар: <b>Telegram Stars</b> — <b>${params.quantity} ⭐</b>`
      : params.category === 'premium' && params.durationMonths
        ? `${oe('premium')} Тариф: <b>Telegram Premium — ${params.durationMonths} мес.</b>`
        : `${oe('catalog')} Товар: <b>${escapeHtml(params.productName)}</b> (x${params.quantity})`;

  return [
    `${oe('profile')} <b>Получатель заказа</b>`,
    '',
    itemLine,
    `${oe('amount')} Итого: <b><code>${formatUsdCents(params.totalPriceUsdCents)}</code></b>`,
    '',
    'Отправьте Telegram <code>@username</code> получателя или нажмите кнопку ниже:',
  ].join('\n');
}

export function formatOrderConfirmationCardMessage(params: {
  product: Product;
  quantity: number;
  unitPriceUsdCents: number;
  totalPriceUsdCents: number;
  recipientUsername: string;
}): string {
  const cleanRecipient = params.recipientUsername.replace(/^@/, '').toLowerCase();
  const isStars = params.product.category === 'stars';
  const isPremium = params.product.category === 'premium';

  return [
    `${oe('orderDetail')} <b>Подтверждение заказа</b>`,
    '',
    isStars
      ? `${oe('stars')} Товар: <b>Telegram Stars</b>`
      : isPremium
        ? `${oe('premium')} Товар: <b>Telegram Premium</b>`
        : `${oe('catalog')} Товар: <b>${escapeHtml(params.product.name)}</b>`,
    isStars
      ? `🔢 Количество: <b>${params.quantity} ⭐</b>`
      : isPremium && params.product.durationMonths
        ? `⏳ Срок подписки: <b>${params.product.durationMonths} мес.</b>`
        : `🔢 Количество: <b>${params.quantity}</b>`,
    `${oe('profile')} Получатель: <b>@${escapeHtml(cleanRecipient)}</b>`,
    `${oe('amount')} Итого: <b><code>${formatUsdCents(params.totalPriceUsdCents)}</code></b>`,
    '',
    'Проверьте данные перед переходом к оплате:',
  ].join('\n');
}

export function formatOrderCheckoutChooserMessage(
  order: Order,
  currentBalanceUsdCents: number,
): string {
  const orderCents = order.totalPriceUsdCents ?? order.totalPrice;
  const canAfford = currentBalanceUsdCents >= orderCents;
  const itemSummary =
    order.category === 'stars'
      ? `${oe('stars')} Товар: <b>Telegram Stars</b> (${order.quantity} ⭐)`
      : order.category === 'premium' && order.durationMonths
        ? `${oe('premium')} Тариф: <b>Telegram Premium — ${order.durationMonths} мес.</b>`
        : `${oe('catalog')} Товар: <b>${escapeHtml(order.productName)}</b> (x${order.quantity})`;

  return [
    `${oe('orderDetail')} <b>Оплата заказа #${escapeHtml(order.orderId)}</b>`,
    '',
    itemSummary,
    order.recipientUsername
      ? `${oe('profile')} Получатель: <b>@${escapeHtml(order.recipientUsername)}</b>`
      : '',
    `${oe('amount')} К оплате: <b><code>${formatUsdCents(orderCents)}</code></b>`,
    `${oe('wallet')} Ваш USD-баланс: <code>${formatUsdCents(currentBalanceUsdCents)}</code>${canAfford ? '' : ' <i>(недостаточно средств)</i>'}`,
    '',
    'Выберите способ оплаты:',
    '1. Внутренний USD-баланс',
    '2. CryptoBot',
    '3. xRocket',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOrderCryptoCurrencyMessage(
  order: Order,
  provider: BalanceTopUpProvider,
  currencies: LiveCurrencyPreviewItem[],
): string {
  const meta = PAYMENT_PROVIDER_CATALOG[provider];
  const orderCents = order.totalPriceUsdCents ?? order.totalPrice;
  const rateLines = currencies.map((item) => {
    if (!item.conversion) {
      return `• <b>${escapeHtml(item.code)}</b>: <i>${escapeHtml(item.error || 'курс временно недоступен')}</i>`;
    }
    if (!item.conversion.requiresConversionNotice) {
      return `• <b>${escapeHtml(item.code)}</b>: <code>${item.conversion.convertedAmountStr} ${escapeHtml(item.code)}</code> (1:1 USD)`;
    }
    return `• <b>${escapeHtml(item.code)}</b>: <code>${item.conversion.convertedAmountStr} ${escapeHtml(item.code)}</code> (1 ${escapeHtml(item.code)} = $${escapeHtml(item.conversion.exchangeRateUsdStr)})`;
  });

  return [
    `${oe('currency')} <b>Оплата заказа #${escapeHtml(order.orderId)} — ${escapeHtml(meta.shortTitle)}</b>`,
    `${oe('amount')} Сумма: <b><code>${formatUsdCents(orderCents)}</code></b>`,
    order.recipientUsername
      ? `${oe('profile')} Получатель: <b>@${escapeHtml(order.recipientUsername)}</b>`
      : '',
    '',
    `${oe('info')} <b>Актуальные курсы провайдера:</b>`,
    ...(rateLines.length > 0
      ? rateLines
      : ['• Не удалось загрузить курсы валют провайдера.']),
    '',
    'Выберите валюту оплаты ниже:',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOrderPaymentInvoiceMessage(
  order: Order,
  payment: PaymentRecord,
): string {
  const providerTitle =
    payment.provider === 'cryptobot' || payment.provider === 'xrocket'
      ? PAYMENT_PROVIDER_CATALOG[payment.provider].shortTitle
      : payment.provider;
  const currencyLabel = payment.network
    ? `${payment.currency} (${payment.network})`
    : payment.currency;

  const statusLabels: Record<string, string> = {
    pending: `${oe('pending')} Ожидает оплаты`,
    paid: `${oe('check')} Оплачен`,
    overpaid: `${oe('check')} Оплачен (переплата зафиксирована)`,
    underpaid: `${oe('warning')} Недоплата — заказ не активирован`,
    expired: `${oe('warning')} Срок действия истёк`,
    cancelled: `${oe('error')} Отменён`,
    failed: `${oe('error')} Ошибка оплаты`,
  };

  return [
    `${oe('orderDetail')} <b>Счёт на оплату заказа #${escapeHtml(order.orderId)}</b>`,
    '',
    `${oe('catalog')} Товар: <b>${escapeHtml(order.productName)}</b> (x${order.quantity})`,
    order.recipientUsername
      ? `${oe('profile')} Получатель: <b>@${escapeHtml(order.recipientUsername)}</b>`
      : '',
    `${oe('topup')} Провайдер: <b>${escapeHtml(providerTitle)}</b>`,
    `${oe('amount')} Сумма заказа: <code>${formatUsdCents(payment.expectedUsdCents)}</code>`,
    `${oe('currency')} К оплате: <b><code>${escapeHtml(payment.expectedAmountStr)} ${escapeHtml(currencyLabel)}</code></b>`,
    payment.exchangeRateUsdStr && payment.currency !== 'USD'
      ? `${oe('refresh')} Зафиксированный курс: <code>1 ${escapeHtml(payment.currency)} = $${escapeHtml(payment.exchangeRateUsdStr)}</code>`
      : '',
    `📌 Статус счёта: ${statusLabels[payment.status] || escapeHtml(payment.status)}`,
    payment.statusReason
      ? `${oe('warning')} Примечание: ${escapeHtml(payment.statusReason)}`
      : '',
    payment.expiresAt && payment.status === 'pending'
      ? `⏳ Действителен до: ${formatDateRu(payment.expiresAt)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatUserProfileMessage(user: StoreUser, isAdmin: boolean): string {
  const balanceCents =
    typeof user.balanceUsdCents === 'number' && Number.isInteger(user.balanceUsdCents)
      ? user.balanceUsdCents
      : Math.round((user.balance ?? 0) * 100);
  const spentCents =
    typeof user.totalSpentUsdCents === 'number' && Number.isInteger(user.totalSpentUsdCents)
      ? user.totalSpentUsdCents
      : 0;

  return [
    `${oe('profile')} <b>Профиль — QuizyStars</b>`,
    '',
    `${oe('id')} Telegram ID: <code>${user.telegramId}</code>`,
    `${oe('profile')} Имя: ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}`,
    user.username ? `🔗 Username: @${escapeHtml(user.username)}` : '',
    `${oe('wallet')} Внутренний баланс: <b><code>${formatUsdCents(balanceCents)}</code></b>`,
    `${oe('orders')} Оплаченных заказов: ${user.totalOrders}`,
    `${oe('amount')} Потрачено: <code>${formatUsdCents(spentCents)}</code>`,
    `📅 Регистрация: ${formatDateRu(user.createdAt)}`,
    `${oe('lock')} Статус: ${
      user.isBlocked
        ? `${oe('error')} Ограничен`
        : isAdmin
          ? `${oe('owner')} Администратор`
          : `${oe('check')} Активен`
    }`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatTopUpStep1ProviderMessage(currentBalanceUsdOrCents: number): string {
  const balUsd = currentBalanceUsdOrCents;
  return [
    `${oe('wallet')} <b>Пополнение баланса (USD)</b>`,
    '<i>Шаг 1/3 — Выбор провайдера</i>',
    '',
    `${oe('amount')} Текущий баланс: <code>${formatUsd(balUsd)}</code>`,
    '',
    `• ${oe('cryptobot')} <b>CryptoBot</b> — комиссия <code>3%</code> ($100.00 → +$97.00)`,
    `• ${oe('xrocket')} <b>xRocket</b> — комиссия <code>2%</code> ($100.00 → +$98.00)`,
  ].join('\n');
}

export function formatTopUpStep2AmountMessage(params: {
  provider: BalanceTopUpProvider;
  amountPaid?: number;
  currency?: string;
  providerConfigured: boolean;
}): string {
  const meta = PAYMENT_PROVIDER_CATALOG[params.provider];
  const providerIcon =
    params.provider === 'cryptobot' ? oe('cryptobot') : oe('xrocket');

  const hasValidAmount =
    typeof params.amountPaid === 'number' &&
    Number.isFinite(params.amountPaid) &&
    params.amountPaid >= meta.minAmount &&
    params.amountPaid <= meta.maxAmount;

  const lines: string[] = [
    `${oe('amount')} <b>Ввод суммы пополнения (USD)</b>`,
    '<i>Шаг 2/3</i>',
    '',
    `${providerIcon} Способ: <b>${escapeHtml(meta.shortTitle)}</b> (комиссия <code>${meta.feePercent}%</code>)${
      params.providerConfigured ? '' : ` ${oe('warning')} <i>(API не настроен)</i>`
    }`,
    `• Диапазон: от <code>${formatUsd(MIN_TOPUP_AMOUNT_USD)}</code> до <code>${formatUsd(MAX_TOPUP_AMOUNT_USD)}</code>`,
    '',
  ];

  if (hasValidAmount) {
    const calc = calculateTopUpCommission(params.amountPaid!, params.provider);
    lines.push(
      `${oe('amount')} Внесено: <b><code>${formatUsdCents(calc.amountUsdCents)}</code></b>`,
      `${oe('fee')} Комиссия (${calc.feePercent}%): <code>−${formatUsdCents(calc.feeUsdCents)}</code>`,
      `${oe('credited')} К зачислению: <b><code>+${formatUsdCents(calc.amountCreditedUsdCents)}</code></b>`,
      '',
      `${oe('edit')} <i>Отправьте другую сумму в чат (например: <code>10.00</code>, <code>19.99</code>) или продолжите ниже.</i>`,
    );
  } else {
    const sample = calculateTopUpCommission(100, params.provider);
    lines.push(
      `${oe('edit')} Отправьте в чат сумму в USD (например: <code>10</code>, <code>19.99</code>, <code>100.00</code>).`,
      `${oe('stats')} Пример (${escapeHtml(meta.shortTitle)}): <code>$100.00</code> → комиссия <code>−${formatUsdCents(sample.feeUsdCents)}</code> → <b><code>+${formatUsdCents(sample.amountCreditedUsdCents)}</code></b>`,
    );
  }

  return lines.join('\n');
}

export function formatTopUpStep3XRocketCurrencyMessage(
  amountUsd: number,
  livePreviews?: LiveCurrencyPreviewItem[],
): string {
  const calc = calculateTopUpCommission(amountUsd, 'xrocket');
  const conversionLines =
    livePreviews && livePreviews.length > 0
      ? livePreviews.map((item) => {
          if (!item.conversion) {
            return `• <b>${escapeHtml(item.code)}</b>: <i>${escapeHtml(item.error || 'курс временно недоступен')}</i>`;
          }
          if (!item.conversion.requiresConversionNotice) {
            return `• <b>${escapeHtml(item.code)}</b>: <code>${item.conversion.convertedAmountStr} ${escapeHtml(item.code)}</code>`;
          }
          return `• <b>${escapeHtml(item.code)}</b>: <code>~${item.conversion.convertedAmountStr} ${escapeHtml(item.code)}</code> (1 ${escapeHtml(item.code)} = $${escapeHtml(item.conversion.exchangeRateUsdStr)})`;
        })
      : XROCKET_SUPPORTED_ASSETS.map(
          (asset) => `• <b>${asset.code}</b>: расчёт по живому курсу при создании счёта`,
        );

  return [
    `${oe('currency')} <b>Выбор монеты и сети</b>`,
    '<i>Шаг 3/3 — xRocket Pay</i>',
    '',
    `${oe('amount')} Сумма: <b><code>${formatUsdCents(calc.amountUsdCents)}</code></b>`,
    `${oe('fee')} Комиссия xRocket (${calc.feePercent}%): <code>−${formatUsdCents(calc.feeUsdCents)}</code>`,
    `${oe('credited')} К зачислению: <b><code>+${formatUsdCents(calc.amountCreditedUsdCents)}</code></b>`,
    '',
    `${oe('info')} <b>Валюты и актуальные курсы:</b>`,
    ...conversionLines,
  ].join('\n');
}

export function formatTopUpMenuMessage(params: {
  currentBalance: number;
  provider: BalanceTopUpProvider;
  currency?: string;
  amountPaid?: number;
  providerConfigured: boolean;
}): string {
  return formatTopUpStep2AmountMessage({
    provider: params.provider,
    amountPaid: params.amountPaid,
    currency: params.currency,
    providerConfigured: params.providerConfigured,
  });
}

export function formatTopUpInvoiceCardMessage(
  topUp: BalanceTopUpRecord,
  newBalance?: number,
): string {
  const meta = PAYMENT_PROVIDER_CATALOG[topUp.provider];
  const statusLabels: Record<string, string> = {
    pending: `${oe('pending')} Ожидает оплаты`,
    paid: `${oe('check')} Оплачен и зачислен`,
    overpaid: `${oe('check')} Оплачен (переплата зафиксирована)`,
    underpaid: `${oe('warning')} Недоплата — баланс НЕ зачислен`,
    cancelled: `${oe('error')} Отменён`,
    expired: `${oe('warning')} Срок действия истёк`,
    failed: `${oe('warning')} Ошибка проверки платежа`,
  };

  const grossCents =
    typeof topUp.amountUsdCents === 'number'
      ? topUp.amountUsdCents
      : usdInputToCents(topUp.amountUsd ?? topUp.amountPaid);
  const feeCents =
    typeof topUp.feeUsdCents === 'number'
      ? topUp.feeUsdCents
      : Math.round(topUp.feeAmount * 100);
  const creditedCents =
    typeof topUp.amountCreditedUsdCents === 'number'
      ? topUp.amountCreditedUsdCents
      : Math.round(topUp.amountCredited * 100);

  const origCurr = topUp.originalCurrency || topUp.currency;
  const origAmtStr =
    topUp.expectedAmountStr || String(topUp.originalAmountPaid ?? topUp.amountPaid);
  const currencyLabel = topUp.network ? `${origCurr} (${topUp.network})` : origCurr;

  return [
    `${oe('orderDetail')} <b>Счёт на пополнение #${escapeHtml(topUp.paymentId)}</b>`,
    '',
    `${oe('topup')} Провайдер: <b>${escapeHtml(meta?.shortTitle || topUp.provider)}</b>`,
    `${oe('currency')} Валюта: <code>${escapeHtml(currencyLabel)}</code>`,
    `${oe('amount')} Сумма пополнения: <b><code>${formatUsdCents(grossCents)}</code></b>`,
    origCurr !== 'USD'
      ? `${oe('refresh')} К оплате: <b><code>${escapeHtml(origAmtStr)} ${escapeHtml(origCurr)}</code></b>${
          topUp.exchangeRateUsdStr
            ? ` (1 ${escapeHtml(origCurr)} = $${escapeHtml(topUp.exchangeRateUsdStr)})`
            : ''
        }`
      : '',
    `${oe('fee')} Комиссия (${topUp.feePercent}%): <code>−${formatUsdCents(feeCents)}</code>`,
    `${oe('credited')} К зачислению: <b><code>+${formatUsdCents(creditedCents)}</code></b>`,
    `📌 Статус: ${statusLabels[topUp.paymentStatus] || topUp.paymentStatus}`,
    topUp.failureReason || topUp.statusReason
      ? `${oe('warning')} Детали: ${escapeHtml(topUp.failureReason || topUp.statusReason)}`
      : '',
    newBalance !== undefined
      ? `${oe('wallet')} Баланс: <b><code>${formatUsd(newBalance)}</code></b>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatSupportedCryptoInfoMessage(): string {
  return [
    `${oe('currency')} <b>Поддерживаемые платёжные провайдеры (USD / Crypto)</b>`,
    '',
    `1️⃣ ${oe('cryptobot')} <b>CryptoBot — комиссия 3%</b> (пополнение баланса)`,
    `• Валюты: ${PAYMENT_PROVIDER_CATALOG.cryptobot.supportedCurrencies.join(', ')}`,
    '',
    `2️⃣ ${oe('xrocket')} <b>xRocket Pay — комиссия 2%</b> (пополнение баланса)`,
    `• Валюты: ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedCurrencies.join(', ')}`,
    `• Сети: ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedNetworks.join(', ')}`,
  ].join('\n');
}

export function formatUserTopUpHistoryMessage(
  topUps: BalanceTopUpRecord[],
  currentBalance: number,
): string {
  if (topUps.length === 0) {
    return [
      `${oe('history')} <b>История пополнений</b>`,
      `${oe('wallet')} Баланс: <code>${formatUsd(currentBalance)}</code>`,
      '',
      'У вас пока нет счетов на пополнение.',
    ].join('\n');
  }

  const lines = topUps.slice(0, 10).map((t, idx) => {
    const prov = PAYMENT_PROVIDER_CATALOG[t.provider]?.shortTitle || t.provider;
    const grossCents =
      typeof t.amountUsdCents === 'number'
        ? t.amountUsdCents
        : usdInputToCents(t.amountUsd ?? t.amountPaid);
    const creditedCents =
      typeof t.amountCreditedUsdCents === 'number'
        ? t.amountCreditedUsdCents
        : Math.round(t.amountCredited * 100);
    const origCurr = t.originalCurrency || t.currency || 'USD';
    const cryptoAmtStr =
      t.expectedAmountStr ||
      (t.originalAmountPaid !== undefined ? String(t.originalAmountPaid) : '');
    const cryptoNote =
      origCurr !== 'USD'
        ? cryptoAmtStr
          ? ` (${escapeHtml(cryptoAmtStr)} ${escapeHtml(origCurr)})`
          : ` (${escapeHtml(origCurr)})`
        : '';
    return `${idx + 1}. <b>#${escapeHtml(t.paymentId.slice(-8))}</b> [${escapeHtml(prov)}] — ${formatUsdCents(grossCents)}${cryptoNote} → <code>+${formatUsdCents(creditedCents)}</code> | <b>${t.paymentStatus}</b>`;
  });

  return [
    `${oe('history')} <b>История пополнений (показано: ${Math.min(topUps.length, 10)})</b>`,
    `${oe('wallet')} Баланс: <code>${formatUsd(currentBalance)}</code>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatAdminTopUpCard(topUp: BalanceTopUpRecord): string {
  const prov = PAYMENT_PROVIDER_CATALOG[topUp.provider]?.title || topUp.provider;
  const grossCents =
    typeof topUp.amountUsdCents === 'number'
      ? topUp.amountUsdCents
      : usdInputToCents(topUp.amountUsd ?? topUp.amountPaid);
  const feeCents =
    typeof topUp.feeUsdCents === 'number'
      ? topUp.feeUsdCents
      : Math.round(topUp.feeAmount * 100);
  const creditedCents =
    typeof topUp.amountCreditedUsdCents === 'number'
      ? topUp.amountCreditedUsdCents
      : Math.round(topUp.amountCredited * 100);

  return [
    `${oe('topup')} <b>Пополнение #${escapeHtml(topUp.paymentId)}</b>`,
    `${oe('profile')} Пользователь: <code>${topUp.userTelegramId}</code>${topUp.username ? ` (@${escapeHtml(topUp.username)})` : ''}`,
    `🔌 Провайдер: ${escapeHtml(prov)}`,
    `${oe('id')} External ID: <code>${escapeHtml(topUp.externalInvoiceId)}</code>`,
    topUp.network ? `🌐 Сеть: <code>${escapeHtml(topUp.network)}</code>` : '',
    `${oe('amount')} Сумма USD: <code>${formatUsdCents(grossCents)}</code>`,
    `${oe('currency')} Счёт: <code>${escapeHtml(topUp.expectedAmountStr || String(topUp.amountPaid))} ${escapeHtml(topUp.currency)}</code>${
      topUp.exchangeRateUsdStr ? ` (курс $${escapeHtml(topUp.exchangeRateUsdStr)})` : ''
    }`,
    topUp.actualAmountStr
      ? `📥 Получено: <code>${escapeHtml(topUp.actualAmountStr)} ${escapeHtml(topUp.currency)}</code>`
      : '',
    `${oe('fee')} Комиссия (${topUp.feePercent}%): <code>−${formatUsdCents(feeCents)}</code>`,
    `${oe('credited')} К зачислению: <code>+${formatUsdCents(creditedCents)}</code>`,
    `📌 Статус: <b>${escapeHtml(topUp.paymentStatus.toUpperCase())}</b>`,
    topUp.failureReason || topUp.statusReason
      ? `${oe('warning')} Причина: ${escapeHtml(topUp.failureReason || topUp.statusReason)}`
      : '',
    `🕒 Создан: ${formatDateRu(topUp.createdAt)}`,
    topUp.paidAt ? `${oe('check')} Оплачен: ${formatDateRu(topUp.paidAt)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatUserOrdersListMessage(orders: Order[]): string {
  if (orders.length === 0) {
    return [
      `${oe('orders')} <b>Мои заказы</b>`,
      '',
      'Заказов пока нет. Откройте /catalog.',
    ].join('\n');
  }

  const recent = orders.slice(0, 8).map(
    (o, i) =>
      `${i + 1}. <b>#${escapeHtml(o.orderId.slice(-8))}</b> — ${escapeHtml(o.productName)} (<code>${formatOrderAmountLabel(o)}</code>)\n   ${ORDER_STATUS_LABELS[o.fulfillmentStatus]}`,
  );

  return [
    `${oe('orders')} <b>Мои заказы (всего: ${orders.length})</b>`,
    '',
    ...recent,
  ].join('\n');
}

export function formatOrderDetailMessage(order: Order): string {
  const keyLines =
    order.deliveredKeyValues && order.deliveredKeyValues.length > 0
      ? [
          '',
          `${oe('key')} <b>Цифровой ключ:</b>`,
          ...order.deliveredKeyValues.map((k) => `<code>${escapeHtml(k)}</code>`),
        ]
      : [];

  return [
    `${oe('orderDetail')} <b>Заказ #${escapeHtml(order.orderId)}</b>`,
    '',
    `${oe('catalog')} Товар: ${escapeHtml(order.productName)} (x${order.quantity})`,
    order.recipientUsername
      ? `${oe('profile')} Получатель: <b>@${escapeHtml(order.recipientUsername)}</b>`
      : '',
    `${oe('topup')} Оплата: ${formatOrderPaymentMethodLabel(order)}`,
    `${oe('amount')} Сумма: <code>${formatOrderAmountLabel(order)}</code>`,
    `📌 Статус оплаты: ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 Статус выдачи: ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    ...keyLines,
    order.activePaymentId
      ? `${oe('lock')} ID платежа: <code>${escapeHtml(order.activePaymentId)}</code>`
      : '',
    order.fulfillmentNote
      ? `${oe('support')} Примечание: ${escapeHtml(order.fulfillmentNote)}`
      : '',
    `🕒 Создан: ${formatDateRu(order.createdAt)}`,
    order.paidAt ? `${oe('check')} Оплачен: ${formatDateRu(order.paidAt)}` : '',
    order.completedAt ? `${oe('check')} Выполнен: ${formatDateRu(order.completedAt)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOrderCompletedUserNotice(order: Order): string {
  const keySection =
    order.deliveredKeyValues && order.deliveredKeyValues.length > 0
      ? [
          '',
          `${oe('key')} <b>Цифровой ключ:</b>`,
          ...order.deliveredKeyValues.map((k) => `<code>${escapeHtml(k)}</code>`),
        ]
      : [];

  return [
    `${oe('check')} <b>Заказ #${escapeHtml(order.orderId)} выполнен!</b>`,
    '',
    `${oe('catalog')} Товар: ${escapeHtml(order.productName)} (x${order.quantity})`,
    order.recipientUsername
      ? `${oe('profile')} Получатель: <b>@${escapeHtml(order.recipientUsername)}</b>`
      : '',
    `${oe('amount')} Оплачено: <code>${formatOrderAmountLabel(order)}</code>`,
    ...keySection,
    order.fulfillmentNote
      ? `📋 ${escapeHtml(order.fulfillmentNote)}`
      : '',
    '',
    'Спасибо за покупку в QuizyStars! История заказов: /orders.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatHelpMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    `${oe('help')} <b>Справка QuizyStars</b>`,
    '',
    '/start — Главное меню',
    '/catalog — Каталог (Stars и Premium)',
    '/orders — Мои заказы',
    '/profile — Профиль и баланс (USD)',
    '/topup — Пополнить баланс (CryptoBot / xRocket)',
    '/terms — Правила',
    '/paysupport — Поддержка по платежам',
    '',
    `${oe('support')} Поддержка: @${escapeHtml(storeSupportUsername)}`,
  ].join('\n');
}

export function formatTermsMessage(): string {
  return [
    `${oe('terms')} <b>Правила QuizyStars</b>`,
    '',
    '1. Магазин поставляет Telegram Stars и Telegram Premium для указанного @username после серверной верификации оплаты.',
    '2. Оплата принимается через внутренний баланс USD, CryptoBot и xRocket. Оплата через Telegram Stars (XTR) отключена.',
    '3. Комиссия на пополнение баланса: CryptoBot — 3%, xRocket — 2% (удерживается из введённой суммы в USD).',
    '4. При отмене или невозможности выдачи заказа средства возвращаются в USD на внутренний баланс либо рассматриваются поддержкой.',
  ].join('\n');
}

export function formatPaySupportMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    `${oe('topup')} <b>Поддержка по платежам QuizyStars</b>`,
    '',
    `• Служба поддержки: @${escapeHtml(storeSupportUsername)}`,
    '• Укажите ID заказа (/orders) или ID счёта пополнения.',
    '• Криптоплатежи проверяются автоматически по webhook или кнопкой «Проверить оплату».',
  ].join('\n');
}

export function formatAdminOrderCard(order: Order): string {
  return [
    `${oe('orderDetail')} <b>Заказ #${escapeHtml(order.orderId)}</b>`,
    `${oe('profile')} Покупатель: <code>${order.userTelegramId}</code>${
      order.username ? ` (@${escapeHtml(order.username)})` : ''
    }`,
    order.recipientUsername
      ? `🎯 Получатель: <b>@${escapeHtml(order.recipientUsername)}</b>`
      : '',
    `${oe('catalog')} Товар: ${escapeHtml(order.productName)} (x${order.quantity})`,
    `${oe('topup')} Оплата: ${formatOrderPaymentMethodLabel(order)}`,
    `${oe('amount')} Сумма: <code>${formatOrderAmountLabel(order)}</code>`,
    `📌 Оплата: ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 Выдача: ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    order.mystarsCurrency
      ? `📊 Учёт MyStars: <code>${escapeHtml(order.mystarsCurrency)}</code> | Выручка: <code>${formatUsdCents(order.grossRevenueUsdCents ?? order.totalPriceUsdCents ?? order.totalPrice)}</code>${
          order.netProfitUsdCents !== undefined
            ? ` | Прибыль: <code>${formatUsdCents(order.netProfitUsdCents)}</code>`
            : ''
        }`
      : '',
    order.awaitingKeyStock
      ? `${oe('warning')} Ожидание ключей на складе`
      : '',
    order.activePaymentId
      ? `${oe('lock')} Payment ID: <code>${escapeHtml(order.activePaymentId)}</code>`
      : '',
    order.externalInvoiceId
      ? `${oe('lock')} External Invoice: <code>${escapeHtml(order.externalInvoiceId)}</code>`
      : '',
    order.fulfillmentNote
      ? `${oe('edit')} Примечание: ${escapeHtml(order.fulfillmentNote)}`
      : '',
    `🕒 Создан: ${formatDateRu(order.createdAt)}`,
    order.paidAt ? `${oe('check')} Оплачен: ${formatDateRu(order.paidAt)}` : '',
    order.completedAt ? `${oe('check')} Завершён: ${formatDateRu(order.completedAt)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOwnerKeysOverviewMessage(
  summaries: ProductKeyStockSummary[],
): string {
  const totalAvail = summaries.reduce((acc, s) => acc + s.available, 0);
  const totalDeliv = summaries.reduce((acc, s) => acc + s.delivered, 0);
  const totalDisabled = summaries.reduce((acc, s) => acc + s.disabled, 0);

  const lines = summaries.map((s, idx) => {
    const algLabel =
      s.algorithm && s.algorithm !== 'none'
        ? `${oe('settings')} <code>${escapeHtml(s.algorithm)}</code>`
        : `${oe('edit')} Ручная загрузка`;
    return `${idx + 1}. <b>${escapeHtml(s.productName)}</b> (${algLabel})\n   🟢 ${s.available} | 📦 ${s.delivered} | 🚫 ${s.disabled}`;
  });

  return [
    `${oe('key')} <b>Склад цифровых ключей (Owner-Only)</b>`,
    `🟢 Доступно: <b>${totalAvail}</b> | 📦 Выдано: <b>${totalDeliv}</b> | 🚫 Откл.: <b>${totalDisabled}</b>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatOwnerProductKeysMessage(
  product: Product,
  summary: ProductKeyStockSummary,
): string {
  return [
    `${oe('key')} <b>Ключи: ${escapeHtml(product.name)}</b>`,
    `${oe('id')} <code>${escapeHtml(product.id)}</code> | ${CATEGORY_LABELS[product.category]}`,
    `${oe('settings')} Алгоритм: ${
      product.keyGeneratorAlgorithm && product.keyGeneratorAlgorithm !== 'none'
        ? `<code>${escapeHtml(product.keyGeneratorAlgorithm)}</code>`
        : '<i>Ручная загрузка</i>'
    }`,
    '',
    `🟢 Доступно: <b>${summary.available}</b> | ⏳ Резерв: <b>${summary.reserved}</b> | 📦 Выдано: <b>${summary.delivered}</b> | 🚫 Откл.: <b>${summary.disabled}</b>`,
  ].join('\n');
}

export function formatOwnerAvailableKeysListMessage(
  product: Product,
  keys: DigitalKeyRecord[],
): string {
  if (keys.length === 0) {
    return `🟢 Для товара <b>${escapeHtml(product.name)}</b> нет доступных ключей.`;
  }

  const lines = keys.slice(0, 15).map(
    (k, idx) =>
      `${idx + 1}. <code>${escapeHtml(k.maskedPreview)}</code> [<code>${escapeHtml(k.keyId)}</code>]`,
  );

  return [
    `🟢 <b>Доступные ключи: ${escapeHtml(product.name)} (${keys.length})</b>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatOwnerDeliveredKeysListMessage(
  product: Product,
  keys: DigitalKeyRecord[],
): string {
  if (keys.length === 0) {
    return `📦 По товару <b>${escapeHtml(product.name)}</b> нет выданных ключей.`;
  }

  const lines = keys.slice(0, 15).map(
    (k, idx) =>
      `${idx + 1}. <code>${escapeHtml(k.keyValue)}</code> — заказ #<code>${escapeHtml(k.deliveredOrderId || '—')}</code>`,
  );

  return [
    `📦 <b>Выданные ключи: ${escapeHtml(product.name)} (${keys.length})</b>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatOwnerKeyDeliveryHistoryMessage(
  keys: DigitalKeyRecord[],
): string {
  if (keys.length === 0) {
    return `${oe('history')} <b>История выдачи ключей</b>\n\nПока пусто.`;
  }

  const lines = keys.slice(0, 20).map(
    (k, idx) =>
      `${idx + 1}. <b>${escapeHtml(k.productId)}</b> — <code>${escapeHtml(k.maskedPreview)}</code> (#<code>${escapeHtml(k.deliveredOrderId || '—')}</code>)`,
  );

  return [
    `${oe('history')} <b>История выдачи ключей (${Math.min(keys.length, 20)})</b>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatAdminStatsMessage(params: {
  totalUsers: number;
  blockedUsers: number;
  totalOrders: number;
  paidOrdersCount: number;
  completedOrdersCount: number;
  pendingOrdersCount: number;
  refundedOrdersCount: number;
  totalUsdRevenueCents?: number;
  totalStarsRevenue?: number;
  totalProducts: number;
  activeProducts: number;
  recentTransactions: StoreTransaction[];
  totalTopUpsCount?: number;
  paidTopUpsCount?: number;
  totalTopUpCredited?: number;
  totalTopUpFees?: number;
  totalTopUpCreditedCents?: number;
  totalTopUpFeesCents?: number;
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
      : ['• Событий пока нет'];

  const usdRevCents = params.totalUsdRevenueCents ?? 0;
  const creditedText =
    params.totalTopUpCreditedCents !== undefined
      ? formatUsdCents(params.totalTopUpCreditedCents)
      : formatUsd(params.totalTopUpCredited ?? 0);
  const feesText =
    params.totalTopUpFeesCents !== undefined
      ? formatUsdCents(params.totalTopUpFeesCents)
      : formatUsd(params.totalTopUpFees ?? 0);

  return [
    `${oe('stats')} <b>Статистика QuizyStars</b>`,
    '',
    `${oe('users')} Пользователей: ${params.totalUsers} (блок: ${params.blockedUsers})`,
    `${oe('catalog')} Товаров: ${params.totalProducts} (активны: ${params.activeProducts})`,
    `${oe('orders')} Заказов: ${params.totalOrders} (ожидают: ${params.pendingOrdersCount}, оплачены: ${params.paidOrdersCount}, выполнены: ${params.completedOrdersCount}, возвраты: ${params.refundedOrdersCount})`,
    `${oe('amount')} Выручка заказов (USD): <code>${formatUsdCents(usdRevCents)}</code>`,
    params.totalTopUpsCount !== undefined
      ? `${oe('topup')} Пополнения (USD): ${params.totalTopUpsCount} (оплачено: ${params.paidTopUpsCount ?? 0}, зачислено: <code>${creditedText}</code>, комиссии: <code>${feesText}</code>)`
      : '',
    '',
    '📋 <b>Последние события:</b>',
    ...txLines,
  ]
    .filter(Boolean)
    .join('\n');
}
