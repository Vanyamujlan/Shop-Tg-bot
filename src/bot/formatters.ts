import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
  DigitalKeyRecord,
  Order,
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
  PAYMENT_PROVIDER_CATALOG,
  XROCKET_SUPPORTED_ASSETS,
  convertUsdToPaymentCurrency,
} from '../services/PaymentProviders.ts';
import { calculateTopUpCommission } from '../services/BalanceService.ts';
import { ProductKeyStockSummary } from '../services/DigitalKeyService.ts';
import { oe } from './outlineEmoji.ts';

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
    `${oe('brand')} <b>Stars Shop — добро пожаловать, ${escapeHtml(firstName)}!</b>`,
    '',
    'Здесь вы можете приобрести цифровые товары Telegram прямо внутри чата:',
    `• ${oe('stars')} <b>Telegram Stars</b> — пополнение баланса звёзд`,
    `• ${oe('premium')} <b>Telegram Premium</b> — подписка на 3, 6 и 12 месяцев`,
    `• ${oe('gifts')} <b>Telegram Gifts</b> — редкие и коллекционные подарки`,
    '',
    `${oe('lock')} <b>Официальная оплата:</b> покупки можно оплачивать через <b>Telegram Stars (XTR)</b> или с <b>внутреннего баланса магазина в USD ($)</b> (пополнение через CryptoBot и xRocket).`,
    isAdmin
      ? `\n${oe('admin')} <i>Вам доступен режим администратора магазина (/admin).</i>`
      : '',
    '',
    'Выберите нужный раздел в меню ниже:',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatCatalogOverviewMessage(): string {
  return [
    `${oe('catalog')} <b>Каталог цифровых товаров Stars Shop</b>`,
    '',
    'Выберите интересующую вас категорию:',
    `• ${oe('stars')} <b>Telegram Stars</b> — пакеты звёзд для сервисов и подарков`,
    `• ${oe('premium')} <b>Telegram Premium</b> — премиум-подписки`,
    `• ${oe('gifts')} <b>Telegram Gifts</b> — цифровые подарки для профиля`,
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
      'В данной категории сейчас нет активных товаров. Пожалуйста, загляните позже или выберите другую категорию.',
    ].join('\n');
  }

  const lines = products.map(
    (p, idx) =>
      `${idx + 1}. <b>${escapeHtml(p.name)}</b> — <code>${formatUsd(p.price)}</code> / <code>${p.price} ⭐ (XTR)</code>`,
  );

  return [
    `${oe('catalog')} <b>Категория: ${title}</b>`,
    '',
    ...lines,
    '',
    'Нажмите на товар ниже, чтобы посмотреть подробное описание и перейти к покупке:',
  ].join('\n');
}

export function formatProductCardMessage(product: Product): string {
  return [
    `${oe('catalog')} <b>${escapeHtml(product.name)}</b>`,
    `${oe('info')} Категория: <b>${CATEGORY_LABELS[product.category]}</b>`,
    '',
    `${oe('edit')} <b>Описание:</b>\n${escapeHtml(product.description)}`,
    '',
    `${oe('amount')} <b>Стоимость:</b> <code>${formatUsd(product.price)}</code> с внутреннего баланса или <code>${product.price} ⭐ (XTR)</code>`,
    `${oe('orders')} <b>Способ выдачи:</b> ${
      product.keyGeneratorAlgorithm
        ? 'Мгновенная автоматическая выдача цифрового ключа после оплаты'
        : product.fulfillmentType === 'manual'
          ? 'Проверенная выдача после оплаты'
          : 'Автоматический адаптер поставщика'
    }`,
    '',
    'Выберите удобный способ оплаты ниже:',
  ].join('\n');
}

export function formatUserProfileMessage(user: StoreUser, isAdmin: boolean): string {
  const currentBalance = Number((user.balance ?? 0).toFixed(2));
  return [
    `${oe('profile')} <b>Ваш профиль покупателя — Stars Shop</b>`,
    '',
    `${oe('id')} <b>Telegram ID:</b> <code>${user.telegramId}</code>`,
    `${oe('profile')} <b>Имя:</b> ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}`,
    user.username ? `🔗 <b>Username:</b> @${escapeHtml(user.username)}` : '',
    `${oe('wallet')} <b>Внутренний баланс:</b> <code>${formatUsd(currentBalance)}</code>`,
    `${oe('orders')} <b>Оплаченных заказов:</b> ${user.totalOrders}`,
    `${oe('stars')} <b>Сумма покупок в Stars:</b> ${user.totalSpentStars} XTR`,
    `📅 <b>Дата регистрации:</b> ${formatDateRu(user.createdAt)}`,
    `${oe('lock')} <b>Статус аккаунта:</b> ${
      user.isBlocked
        ? `${oe('error')} Ограничен`
        : isAdmin
          ? `${oe('owner')} Администратор`
          : `${oe('check')} Активен`
    }`,
    '',
    `${oe('info')} Нажмите <b>«Пополнить баланс»</b>, чтобы внести произвольную сумму в USD ($) через CryptoBot или xRocket.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Шаг 1/3: Минималистичный экран выбора способа оплаты в USD ($).
 */
export function formatTopUpStep1ProviderMessage(currentBalance: number): string {
  return [
    `${oe('wallet')} <b>ПОПОЛНЕНИЕ БАЛАНСА (USD)</b>`,
    '<i>Шаг 1/3 — Выбор способа оплаты</i>',
    '',
    `${oe('amount')} Текущий баланс: <code>${formatUsd(currentBalance)}</code>`,
    '',
    `${oe('topup')} <b>Выберите способ оплаты:</b>`,
    `• ${oe('cryptobot')} <b>CryptoBot</b> — комиссия <code>3%</code> ($100.00 → $97.00 к зачислению)`,
    `• ${oe('xrocket')} <b>xRocket</b> — комиссия <code>2%</code> ($100.00 → $98.00 к зачислению)`,
  ].join('\n');
}

/**
 * Шаг 2/3: Экран свободного ввода суммы в USD ($) по референсу https://ibb.co/KpxHvx5V
 * без фиксированных кнопок сумм, с мгновенным расчётом комиссии и суммы к зачислению.
 */
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
    `${oe('amount')} <b>ВВОД СУММЫ ПОПОЛНЕНИЯ (USD)</b>`,
    '<i>Шаг 2/3 — Свободный ввод суммы</i>',
    '',
    `${providerIcon} Способ оплаты: <b>${escapeHtml(meta.shortTitle)}</b> [комиссия <code>${meta.feePercent}%</code>]${
      params.providerConfigured ? '' : ` ${oe('warning')} <i>(API не настроен)</i>`
    }`,
    `• Допустимый диапазон: от <code>${formatUsd(MIN_TOPUP_AMOUNT_USD)}</code> до <code>${formatUsd(MAX_TOPUP_AMOUNT_USD)}</code>`,
    '',
  ];

  if (hasValidAmount) {
    const calc = calculateTopUpCommission(params.amountPaid!, params.provider);
    lines.push(
      '┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
      `   ${oe('amount')} Введённая сумма: <b><code>${formatUsd(calc.amountPaid)}</code></b>`,
      `   ${oe('fee')} Комиссия ${escapeHtml(meta.shortTitle)} (${calc.feePercent}%): <code>-${formatUsd(calc.feeAmount)}</code>`,
      `   ${oe('credited')} <b>К зачислению на баланс:</b> <b><code>+${formatUsd(calc.amountCredited)}</code></b>`,
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
      '',
      `${oe('edit')} <i>Вы можете отправить другую сумму в USD числом в чат (например: <code>10</code>, <code>19.99</code>, <code>100.00</code>) или переключить способ оплаты ниже.</i>`,
    );
  } else {
    const sample100 = calculateTopUpCommission(100, params.provider);
    lines.push(
      '┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
      `   ${oe('edit')} <b>Введите сумму пополнения в USD ($)</b>`,
      '   Отправьте любое число в чат:',
      '   например <code>10.00</code>, <code>19.99</code> или <code>100.00</code>',
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
      '',
      `${oe('stats')} <b>Формула расчёта (${escapeHtml(meta.shortTitle)} — ${meta.feePercent}%):</b>`,
      `• Комиссия удерживается из введённой суммы (<code>сумма × ${(1 - meta.feePercent / 100).toFixed(2)}</code>)`,
      `• Пример: при вводе <code>${formatUsd(100)}</code> → комиссия <code>-${formatUsd(sample100.feeAmount)}</code> → к зачислению <b><code>+${formatUsd(sample100.amountCredited)}</code></b>`,
    );
  }

  return lines.join('\n');
}

/**
 * Шаг 3/3 (для xRocket): Экран выбора криптовалюты и сети с прозрачной конвертацией из USD ($).
 */
export function formatTopUpStep3XRocketCurrencyMessage(amountUsd: number): string {
  const calc = calculateTopUpCommission(amountUsd, 'xrocket');
  const conversionLines = XROCKET_SUPPORTED_ASSETS.map((asset) => {
    const conv = convertUsdToPaymentCurrency(calc.amountPaid, asset.code);
    if (!conv.requiresConversionNotice) {
      return `• <b>${asset.code}</b>: <code>${conv.convertedAmount.toFixed(2)} ${asset.code}</code> (1 ${asset.code} = $1.00)`;
    }
    return `• <b>${asset.code}</b>: <code>~${conv.convertedAmount} ${asset.code}</code> (курс фиксации: 1 ${asset.code} = ${formatUsd(conv.exchangeRateUsd)})`;
  });

  return [
    `${oe('currency')} <b>ВЫБОР ВАЛЮТЫ И СЕТИ ОПЛАТЫ</b>`,
    '<i>Шаг 3/3 — xRocket Pay</i>',
    '',
    `${oe('amount')} Сумма пополнения (USD): <b><code>${formatUsd(calc.amountPaid)}</code></b>`,
    `${oe('fee')} Комиссия xRocket (${calc.feePercent}%): <code>-${formatUsd(calc.feeAmount)}</code>`,
    `${oe('credited')} <b>Фиксированная сумма зачисления:</b> <b><code>+${formatUsd(calc.amountCredited)}</code></b>`,
    '',
    `${oe('info')} <b>Доступные валюты и курсы конвертации:</b>`,
    ...conversionLines,
    '',
    '<i>Сумма зачисления в USD фиксируется при создании счёта и не меняется после оплаты.</i>',
  ].join('\n');
}

/**
 * Совместимый форматтер меню пополнения баланса в USD ($).
 */
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

/**
 * Шаг 3/3: Карточка созданного счёта в USD ($) с указанием исходной валюты оплаты и зафиксированного курса.
 */
export function formatTopUpInvoiceCardMessage(
  topUp: BalanceTopUpRecord,
  newBalance?: number,
): string {
  const meta = PAYMENT_PROVIDER_CATALOG[topUp.provider];
  const statusLabels: Record<string, string> = {
    pending: `${oe('pending')} Ожидает оплаты`,
    paid: `${oe('check')} Оплачен и зачислен на баланс`,
    cancelled: `${oe('error')} Отменён`,
    expired: `${oe('warning')} Срок действия истёк`,
    failed: `${oe('warning')} Ошибка проверки платежа`,
  };

  const baseUsd = topUp.amountUsd ?? topUp.amountPaid;
  const origCurr = topUp.originalCurrency || topUp.currency;
  const origAmt = topUp.originalAmountPaid ?? topUp.amountPaid;
  const currencyLabel = topUp.network
    ? `${origCurr} (${topUp.network})`
    : origCurr;

  const isConvertedCrypto =
    origCurr !== 'USD' &&
    origCurr !== 'USDT' &&
    origCurr !== 'USDC' &&
    topUp.exchangeRateUsd &&
    topUp.exchangeRateUsd !== 1;

  return [
    `${oe('orderDetail')} <b>СЧЁТ НА ПОПОЛНЕНИЕ СОЗДАН</b>`,
    '<i>Шаг 3/3 — Оплата счёта</i>',
    '',
    `${oe('id')} Счёт: <code>#${escapeHtml(topUp.paymentId)}</code>`,
    `${oe('topup')} Способ оплаты: <b>${escapeHtml(meta?.shortTitle || topUp.provider)}</b>`,
    `${oe('currency')} Валюта счёта: <code>${escapeHtml(currencyLabel)}</code>`,
    `${oe('amount')} Введённая сумма (USD): <b><code>${formatUsd(baseUsd)}</code></b>`,
    isConvertedCrypto
      ? `${oe('refresh')} Сумма к оплате по курсу (1 ${escapeHtml(origCurr)} = ${formatUsd(topUp.exchangeRateUsd!)}): <b><code>${origAmt} ${escapeHtml(origCurr)}</code></b>`
      : `${oe('amount')} К оплате: <code>${formatUsd(baseUsd)} (${origAmt.toFixed(2)} ${escapeHtml(origCurr)})</code>`,
    `${oe('fee')} Комиссия (${topUp.feePercent}%): <code>-${formatUsd(topUp.feeAmount)}</code>`,
    `${oe('credited')} <b>Итоговая сумма зачисления:</b> <b><code>+${formatUsd(topUp.amountCredited)}</code></b>`,
    `📌 Статус: ${statusLabels[topUp.paymentStatus] || topUp.paymentStatus}`,
    topUp.failureReason
      ? `${oe('warning')} Причина: ${escapeHtml(topUp.failureReason)}`
      : '',
    newBalance !== undefined
      ? `${oe('wallet')} Обновлённый баланс: <b><code>${formatUsd(newBalance)}</code></b>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatSupportedCryptoInfoMessage(): string {
  return [
    `${oe('currency')} <b>Оплата в USD ($) и криптовалюте через поддерживаемых провайдеров</b>`,
    '',
    `1️⃣ ${oe('xrocket')} <b>xRocket Pay (@xrocket) — комиссия 2%</b>`,
    `• <b>Валюты:</b> ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedCurrencies.join(', ')}`,
    `• <b>Сети:</b> ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedNetworks.join(', ')}`,
    '',
    `2️⃣ ${oe('cryptobot')} <b>CryptoBot (@CryptoBot) — комиссия 3%</b>`,
    `• <b>Валюты:</b> ${PAYMENT_PROVIDER_CATALOG.cryptobot.supportedCurrencies.join(', ')}`,
    `• <b>Сети:</b> ${PAYMENT_PROVIDER_CATALOG.cryptobot.supportedNetworks.join(', ')}`,
  ].join('\n');
}

export function formatUserTopUpHistoryMessage(
  topUps: BalanceTopUpRecord[],
  currentBalance: number,
): string {
  if (topUps.length === 0) {
    return [
      `${oe('history')} <b>История пополнений баланса</b>`,
      `${oe('wallet')} <b>Текущий баланс:</b> <code>${formatUsd(currentBalance)}</code>`,
      '',
      'У вас пока нет созданных счетов на пополнение баланса.',
    ].join('\n');
  }

  const lines = topUps.slice(0, 10).map((t, idx) => {
    const prov = PAYMENT_PROVIDER_CATALOG[t.provider]?.shortTitle || t.provider;
    const baseUsd = t.amountUsd ?? t.amountPaid;
    const origCurr = t.originalCurrency || t.currency;
    const origAmt = t.originalAmountPaid ?? t.amountPaid;
    const origTag =
      origCurr !== 'USD'
        ? ` [${origAmt} ${escapeHtml(origCurr)}]`
        : ' [USD]';
    return `${idx + 1}. <b>#${escapeHtml(t.paymentId.slice(-8))}</b> [${escapeHtml(prov)}] — внесено <code>${formatUsd(baseUsd)}</code>${origTag} (комиссия ${t.feePercent}%: <code>-${formatUsd(t.feeAmount)}</code>) → к зачислению <code>+${formatUsd(t.amountCredited)}</code> | Статус: <b>${t.paymentStatus}</b>`;
  });

  return [
    `${oe('history')} <b>История пополнений баланса (показано: ${Math.min(topUps.length, 10)})</b>`,
    `${oe('wallet')} <b>Текущий баланс:</b> <code>${formatUsd(currentBalance)}</code>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatAdminTopUpCard(topUp: BalanceTopUpRecord): string {
  const prov = PAYMENT_PROVIDER_CATALOG[topUp.provider]?.title || topUp.provider;
  const baseUsd = topUp.amountUsd ?? topUp.amountPaid;
  const origCurr = topUp.originalCurrency || topUp.currency;
  const origAmt = topUp.originalAmountPaid ?? topUp.amountPaid;

  return [
    `${oe('topup')} <b>Пополнение баланса #${escapeHtml(topUp.paymentId)}</b>`,
    `${oe('profile')} <b>Пользователь:</b> <code>${topUp.userTelegramId}</code> (${escapeHtml(topUp.userId)})${topUp.username ? ` @${escapeHtml(topUp.username)}` : ''}`,
    `🔌 <b>Провайдер:</b> ${escapeHtml(prov)}`,
    `${oe('id')} <b>External Invoice ID:</b> <code>${escapeHtml(topUp.externalInvoiceId)}</code>`,
    topUp.network ? `🌐 <b>Сеть:</b> <code>${escapeHtml(topUp.network)}</code>` : '',
    `${oe('amount')} <b>Сумма в USD:</b> <code>${formatUsd(baseUsd)}</code>`,
    `${oe('currency')} <b>Исходная валюта оплаты:</b> <code>${origAmt} ${escapeHtml(origCurr)}</code>${topUp.exchangeRateUsd ? ` (курс: ${formatUsd(topUp.exchangeRateUsd)})` : ''}`,
    `${oe('fee')} <b>Комиссия магазина (${topUp.feePercent}%):</b> <code>-${formatUsd(topUp.feeAmount)}</code>`,
    `${oe('credited')} <b>Фактическая сумма зачисления:</b> <code>+${formatUsd(topUp.amountCredited)}</code>`,
    `📌 <b>Статус:</b> <b>${escapeHtml(topUp.paymentStatus.toUpperCase())}</b>`,
    topUp.failureReason
      ? `${oe('warning')} <b>Ошибка / Причина:</b> ${escapeHtml(topUp.failureReason)}`
      : '',
    `🕒 <b>Создан:</b> ${formatDateRu(topUp.createdAt)}`,
    topUp.expiresAt ? `${oe('pending')} <b>Истекает:</b> ${formatDateRu(topUp.expiresAt)}` : '',
    topUp.paidAt ? `${oe('check')} <b>Оплачен:</b> ${formatDateRu(topUp.paidAt)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatUserOrdersListMessage(orders: Order[]): string {
  if (orders.length === 0) {
    return [
      `${oe('orders')} <b>Мои заказы</b>`,
      '',
      'У вас пока нет оформленных заказов. Перейдите в /catalog, чтобы выбрать цифровой товар!',
    ].join('\n');
  }

  const recent = orders.slice(0, 8).map(
    (o, i) =>
      `${i + 1}. <b>#${escapeHtml(o.orderId.slice(-8))}</b> — ${escapeHtml(
        o.productName,
      )} (<code>${o.paymentMethod === 'balance' ? formatUsd(o.totalPrice) : `${o.totalPrice} ⭐`}</code>)\n   Статус: ${
        ORDER_STATUS_LABELS[o.fulfillmentStatus]
      }`,
  );

  return [
    `${oe('orders')} <b>История ваших заказов (всего: ${orders.length})</b>`,
    '',
    ...recent,
    '',
    'Нажмите на заказ ниже для просмотра деталей:',
  ].join('\n');
}

export function formatOrderDetailMessage(order: Order): string {
  const paymentMethodLabel =
    order.paymentMethod === 'balance'
      ? `${oe('wallet')} Внутренний баланс магазина (USD)`
      : `${oe('stars')} Telegram Stars (XTR)`;

  const keyLines =
    order.deliveredKeyValues && order.deliveredKeyValues.length > 0
      ? [
          '',
          `${oe('key')} <b>Ваш цифровой ключ:</b>`,
          ...order.deliveredKeyValues.map((k) => `<code>${escapeHtml(k)}</code>`),
        ]
      : [];

  return [
    `${oe('orderDetail')} <b>Детали заказа #${escapeHtml(order.orderId)}</b>`,
    '',
    `${oe('catalog')} <b>Товар:</b> ${escapeHtml(order.productName)}`,
    `📂 <b>Категория:</b> ${CATEGORY_LABELS[order.category]}`,
    `🔢 <b>Количество:</b> ${order.quantity} шт.`,
    `${oe('topup')} <b>Способ оплаты:</b> ${paymentMethodLabel}`,
    `${oe('amount')} <b>Сумма:</b> <code>${order.paymentMethod === 'balance' ? `${formatUsd(order.totalPrice)} (USD)` : `${order.totalPrice} ⭐ (${order.currency})`}</code>`,
    `📌 <b>Статус оплаты:</b> ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 <b>Статус выдачи:</b> ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    ...keyLines,
    order.telegramPaymentChargeId
      ? `${oe('lock')} <b>ID платежа Telegram:</b> <code>${escapeHtml(
          order.telegramPaymentChargeId,
        )}</code>`
      : '',
    order.balancePaymentId
      ? `${oe('lock')} <b>ID списания баланса:</b> <code>${escapeHtml(order.balancePaymentId)}</code>`
      : '',
    order.fulfillmentNote
      ? `${oe('support')} <b>Комментарий:</b> ${escapeHtml(order.fulfillmentNote)}`
      : '',
    `🕒 <b>Создан:</b> ${formatDateRu(order.createdAt)}`,
    order.paidAt ? `${oe('check')} <b>Оплачен:</b> ${formatDateRu(order.paidAt)}` : '',
    order.completedAt
      ? `${oe('check')} <b>Выполнен:</b> ${formatDateRu(order.completedAt)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOrderCompletedUserNotice(order: Order): string {
  const keySection =
    order.deliveredKeyValues && order.deliveredKeyValues.length > 0
      ? [
          '',
          `${oe('key')} <b>Ваш цифровой ключ:</b>`,
          ...order.deliveredKeyValues.map((k) => `<code>${escapeHtml(k)}</code>`),
        ]
      : [];

  return [
    `${oe('check')} <b>Ваш заказ #${escapeHtml(order.orderId)} выполнен!</b>`,
    '',
    `${oe('catalog')} <b>Товар:</b> ${escapeHtml(order.productName)}`,
    `${oe('amount')} <b>Оплачено:</b> ${
      order.paymentMethod === 'balance'
        ? `${formatUsd(order.totalPrice)} с внутреннего баланса`
        : `${order.totalPrice} ⭐ (XTR)`
    }`,
    ...keySection,
    order.fulfillmentNote
      ? `📋 <b>Информация о выдаче:</b>\n${escapeHtml(order.fulfillmentNote)}`
      : '',
    '',
    'Спасибо за покупку в Stars Shop! Чтобы посмотреть историю заказов, используйте команду /orders.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatHelpMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    `${oe('help')} <b>Справка и навигация по Stars Shop</b>`,
    '',
    '<b>Доступные команды:</b>',
    '/start — Главное меню магазина',
    '/catalog — Каталог цифровых товаров',
    '/orders — История ваших заказов',
    '/profile — Ваш профиль, баланс в USD ($) и статистика покупок',
    '/topup — Пополнить внутренний баланс в USD (CryptoBot, xRocket)',
    '/terms — Правила пользования магазином',
    '/paysupport — Поддержка по платежам',
    '/help — Помощь и ответы на вопросы',
    '',
    '<b>Как происходит покупка:</b>',
    '1. Выберите товар в разделе Stars, Premium или Gifts.',
    '2. Оплатите товар напрямую через Telegram Stars (XTR) или с внутреннего баланса магазина в USD ($).',
    '3. Сразу после подтверждения оплаты заказ получает статус <b>Оплачен</b> и передаётся на выдачу.',
    '4. После выдачи товара вы получите уведомление в этом чате.',
    '',
    `${oe('support')} Контакт поддержки: @${escapeHtml(storeSupportUsername)}`,
  ].join('\n');
}

export function formatTermsMessage(): string {
  return [
    `${oe('terms')} <b>Правила цифрового магазина Stars Shop</b>`,
    '',
    '1. <b>Предмет магазина:</b> Магазин предоставляет цифровые товары экосистемы Telegram (Telegram Stars, Telegram Premium, Telegram Gifts) исключительно через интерфейс данного бота.',
    '2. <b>Оплата и пополнение баланса в USD ($):</b> Оплата принимается через официальный механизм Telegram Stars (XTR), а также с внутреннего баланса магазина в долларах США (пополнение через официальные API CryptoBot — комиссия 3%, xRocket — комиссия 2%, комиссия удерживается из введённой суммы). Магазин никогда не запрашивает пароли, коды входа, seed-фразы или приватные ключи.',
    '3. <b>Порядок выдачи:</b> Выдача товара осуществляется после серверной верификации платежа. При наличии цифрового ключа на складе выдача происходит автоматически и мгновенно.',
    '4. <b>Возврат средств:</b> Если заказ не может быть выдан по техническим причинам, выполняется полный возврат Telegram Stars (через <code>refundStarPayment</code>) либо возврат средств в USD ($) на внутренний баланс покупателя.',
  ].join('\n');
}

export function formatPaySupportMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    `${oe('topup')} <b>Поддержка по платежам (Payment Support)</b>`,
    '',
    'По всем вопросам, связанным с оплатой в Telegram Stars (XTR), пополнением внутреннего баланса в USD (CryptoBot / xRocket), статусом заказа или возвратом средств:',
    '',
    `• ${oe('support')} Служба поддержки: @${escapeHtml(storeSupportUsername)}`,
    '• При обращении укажите <b>ID заказа</b> (из раздела /orders) или <b>ID пополнения баланса</b>.',
    '• Если средства были списаны, но товар ещё не доставлен, проверьте статус в /orders — администратор получает уведомление автоматически.',
  ].join('\n');
}

export function formatAdminOrderCard(order: Order): string {
  const methodLabel =
    order.paymentMethod === 'balance'
      ? `${oe('wallet')} Внутренний баланс (USD)`
      : `${oe('stars')} Telegram Stars (XTR)`;
  return [
    `${oe('orderDetail')} <b>Заказ #${escapeHtml(order.orderId)}</b>`,
    `${oe('profile')} <b>Покупатель:</b> <code>${order.userTelegramId}</code> ${
      order.username ? `(@${escapeHtml(order.username)})` : ''
    }`,
    `${oe('catalog')} <b>Товар:</b> ${escapeHtml(order.productName)} (x${order.quantity})`,
    `${oe('topup')} <b>Способ оплаты:</b> ${methodLabel}`,
    `${oe('amount')} <b>Сумма:</b> <code>${order.paymentMethod === 'balance' ? `${formatUsd(order.totalPrice)} (BAL)` : `${order.totalPrice} ⭐ (${order.currency})`}</code>`,
    `📌 <b>Статус оплаты:</b> ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 <b>Статус выдачи:</b> ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    order.awaitingKeyStock
      ? `${oe('warning')} <b>Ожидание склада ключей:</b> <code>Нет доступных цифровых ключей (заказ НЕ помечен как выполненный)</code>`
      : '',
    order.assignedKeyIds && order.assignedKeyIds.length > 0
      ? `${oe('key')} <b>Назначенные ID ключей:</b> <code>${escapeHtml(order.assignedKeyIds.join(', '))}</code>`
      : '',
    order.telegramPaymentChargeId
      ? `${oe('lock')} <b>Charge ID:</b> <code>${escapeHtml(order.telegramPaymentChargeId)}</code>`
      : '',
    order.balancePaymentId
      ? `${oe('lock')} <b>Balance Payment ID:</b> <code>${escapeHtml(order.balancePaymentId)}</code>`
      : '',
    order.fulfillmentNote
      ? `${oe('edit')} <b>Примечание:</b> ${escapeHtml(order.fulfillmentNote)}`
      : '',
    `🕒 <b>Создан:</b> ${formatDateRu(order.createdAt)}`,
    order.paidAt ? `${oe('check')} <b>Оплачен:</b> ${formatDateRu(order.paidAt)}` : '',
    order.completedAt
      ? `${oe('check')} <b>Завершён:</b> ${formatDateRu(order.completedAt)}`
      : '',
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
        ? `${oe('settings')} Алгоритм: <code>${escapeHtml(s.algorithm)}</code>`
        : `${oe('edit')} Ручная загрузка ключей`;
    return `${idx + 1}. <b>${escapeHtml(s.productName)}</b> (${algLabel})\n   🟢 Доступно: <b>${s.available}</b> | 📦 Выдано: <b>${s.delivered}</b> | 🚫 Отключено: <b>${s.disabled}</b>`;
  });

  return [
    `${oe('key')} <b>Генератор и склад цифровых ключей (Owner-Only)</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `🟢 Всего доступно на складе: <b>${totalAvail}</b>`,
    `📦 Всего выдано покупателям: <b>${totalDeliv}</b>`,
    `🚫 Отключено: <b>${totalDisabled}</b>`,
    '',
    ...lines,
    '',
    'Выберите товар ниже для добавления, генерации или управления ключами:',
  ].join('\n');
}

export function formatOwnerProductKeysMessage(
  product: Product,
  summary: ProductKeyStockSummary,
): string {
  return [
    `${oe('key')} <b>Склад ключей: ${escapeHtml(product.name)}</b>`,
    `${oe('id')} ID товара: <code>${escapeHtml(product.id)}</code>`,
    `📂 Категория: <b>${CATEGORY_LABELS[product.category]}</b>`,
    `${oe('settings')} Алгоритм генерации: ${
      product.keyGeneratorAlgorithm && product.keyGeneratorAlgorithm !== 'none'
        ? `<code>${escapeHtml(product.keyGeneratorAlgorithm)}</code> (поддерживает автогенерацию)`
        : '<i>Не задан (только ручная загрузка реальных ключей поставщика)</i>'
    }`,
    '',
    `${oe('stats')} <b>Остатки и статусы ключей:</b>`,
    `• 🟢 Доступно к выдаче (available): <b>${summary.available}</b>`,
    `• ⏳ Зарезервировано (reserved): <b>${summary.reserved}</b>`,
    `• 📦 Выдано покупателям (delivered): <b>${summary.delivered}</b>`,
    `• 🚫 Отключено (disabled): <b>${summary.disabled}</b>`,
  ].join('\n');
}

export function formatOwnerAvailableKeysListMessage(
  product: Product,
  keys: DigitalKeyRecord[],
): string {
  if (keys.length === 0) {
    return `🟢 Для товара <b>${escapeHtml(product.name)}</b> сейчас нет доступных ключей.`;
  }

  const lines = keys.slice(0, 15).map(
    (k, idx) =>
      `${idx + 1}. <code>${escapeHtml(k.maskedPreview)}</code> [ID: <code>${escapeHtml(k.keyId)}</code>] (${k.source === 'generated' ? 'сгенерирован' : 'вручную'})`,
  );

  return [
    `🟢 <b>Доступные ключи: ${escapeHtml(product.name)} (всего: ${keys.length})</b>`,
    '',
    ...lines,
    '',
    'Нажмите на ключ ниже, чтобы отключить его (статус <code>disabled</code>):',
  ].join('\n');
}

export function formatOwnerDeliveredKeysListMessage(
  product: Product,
  keys: DigitalKeyRecord[],
): string {
  if (keys.length === 0) {
    return `📦 По товару <b>${escapeHtml(product.name)}</b> ещё нет выданных ключей.`;
  }

  const lines = keys.slice(0, 15).map(
    (k, idx) =>
      `${idx + 1}. Ключ: <code>${escapeHtml(k.keyValue)}</code>\n   🧾 Заказ: <code>${escapeHtml(k.deliveredOrderId || '—')}</code> | 👤 Покупатель: <code>${k.deliveredUserTelegramId ?? '—'}</code> | 🕒 ${formatDateRu(k.deliveredAt)}`,
  );

  return [
    `📦 <b>Выданные ключи: ${escapeHtml(product.name)} (показано: ${Math.min(keys.length, 15)} из ${keys.length})</b>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatOwnerKeyDeliveryHistoryMessage(
  keys: DigitalKeyRecord[],
): string {
  if (keys.length === 0) {
    return [
      `${oe('history')} <b>История выдачи цифровых ключей</b>`,
      '',
      'Пока не выдано ни одного цифрового ключа.',
    ].join('\n');
  }

  const lines = keys.slice(0, 20).map(
    (k, idx) =>
      `${idx + 1}. <b>${escapeHtml(k.productId)}</b> — <code>${escapeHtml(k.maskedPreview)}</code>\n   🧾 Заказ: <code>${escapeHtml(k.deliveredOrderId || '—')}</code> | 👤 TG ID: <code>${k.deliveredUserTelegramId ?? '—'}</code> | 🕒 ${formatDateRu(k.deliveredAt)}`,
  );

  return [
    `${oe('history')} <b>История выдачи цифровых ключей (последние ${Math.min(keys.length, 20)})</b>`,
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
  totalStarsRevenue: number;
  totalProducts: number;
  activeProducts: number;
  recentTransactions: StoreTransaction[];
  totalTopUpsCount?: number;
  paidTopUpsCount?: number;
  totalTopUpCredited?: number;
  totalTopUpFees?: number;
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
    `${oe('stats')} <b>Статистика цифрового магазина Stars Shop</b>`,
    '',
    `${oe('users')} <b>Пользователей всего:</b> ${params.totalUsers} (заблокировано: ${params.blockedUsers})`,
    `${oe('catalog')} <b>Товаров в каталоге:</b> ${params.totalProducts} (активных: ${params.activeProducts})`,
    '',
    `${oe('orders')} <b>Заказов всего:</b> ${params.totalOrders}`,
    `• ${oe('pending')} Ожидают оплаты: ${params.pendingOrdersCount}`,
    `• ${oe('check')} Оплачены / в обработке: ${params.paidOrdersCount}`,
    `• 🎉 Выполнены (выданы): ${params.completedOrdersCount}`,
    `• ↩️ Возвраты (Refund): ${params.refundedOrdersCount}`,
    '',
    `${oe('stars')} <b>Выручка в Telegram Stars:</b> <code>${params.totalStarsRevenue} XTR</code>`,
    params.totalTopUpsCount !== undefined
      ? `${oe('topup')} <b>Пополнений баланса (USD):</b> ${params.totalTopUpsCount} (оплачено: ${params.paidTopUpsCount ?? 0}, зачислено: <code>${formatUsd(params.totalTopUpCredited ?? 0)}</code>, комиссия магазина: <code>${formatUsd(params.totalTopUpFees ?? 0)}</code>)`
      : '',
    '',
    '📋 <b>Последние события:</b>',
    ...txLines,
  ]
    .filter(Boolean)
    .join('\n');
}
