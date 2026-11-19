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
import { getEnvConfig } from '../config/env.ts';
import { PAYMENT_PROVIDER_CATALOG } from '../services/PaymentProviders.ts';
import { calculateTopUpCommission } from '../services/BalanceService.ts';
import { ProductKeyStockSummary } from '../services/DigitalKeyService.ts';

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
    '🔒 <b>Официальная оплата:</b> покупки можно оплачивать через <b>Telegram Stars (XTR)</b> или с <b>внутреннего баланса магазина</b> (пополнение через CryptoBot и xRocket).',
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
    `💰 <b>Стоимость:</b> <code>${product.price} ⭐ (XTR)</code> или <code>${product.price} ед.</code> с внутреннего баланса`,
    `📦 <b>Способ выдачи:</b> ${
      product.keyGeneratorAlgorithm
        ? 'Мгновенная автоматическая выдача цифрового ключа после оплаты'
        : product.fulfillmentType === 'manual'
          ? 'Проверенная выдача после оплаты'
          : 'Автоматический адаптер поставщика'
    }`,
    '',
    'Выберите удобный способ оплаты ниже 👇',
  ].join('\n');
}

export function formatUserProfileMessage(user: StoreUser, isAdmin: boolean): string {
  const currentBalance = Number((user.balance ?? 0).toFixed(2));
  return [
    '👤 <b>Ваш профиль покупателя</b>',
    '',
    `🆔 <b>Telegram ID:</b> <code>${user.telegramId}</code>`,
    `👤 <b>Имя:</b> ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}`,
    user.username ? `🔗 <b>Username:</b> @${escapeHtml(user.username)}` : '',
    `💰 <b>Внутренний баланс:</b> <code>${currentBalance}</code>`,
    `📦 <b>Оплаченных заказов:</b> ${user.totalOrders}`,
    `⭐ <b>Сумма покупок в Stars:</b> ${user.totalSpentStars} XTR`,
    `📅 <b>Дата регистрации:</b> ${formatDateRu(user.createdAt)}`,
    `🛡 <b>Статус аккаунта:</b> ${
      user.isBlocked ? '🚫 Ограничен' : isAdmin ? '👑 Администратор' : '✅ Активен'
    }`,
    '',
    '💡 Нажмите <b>«💳 Пополнить баланс»</b>, чтобы пополнить внутренний баланс через CryptoBot или xRocket.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Шаг 1/3: Минималистичный экран выбора способа оплаты.
 */
export function formatTopUpStep1ProviderMessage(currentBalance: number): string {
  return [
    '💰 <b>ПОПОЛНЕНИЕ БАЛАНСА</b>',
    '<i>Шаг 1/3</i>',
    '',
    `💼 Текущий баланс: <code>${Number(currentBalance.toFixed(2))}</code>`,
    '',
    '💳 <b>Выберите способ оплаты:</b>',
    '• 💎 <b>CryptoBot</b> — комиссия <code>3%</code>',
    '• 🚀 <b>xRocket</b> — комиссия <code>2%</code>',
  ].join('\n');
}

/**
 * Шаг 2/3: Минималистичный экран выбора / ввода суммы с расчётом комиссии.
 */
export function formatTopUpStep2AmountMessage(params: {
  provider: BalanceTopUpProvider;
  amountPaid: number;
  currency?: string;
  providerConfigured: boolean;
}): string {
  const meta = PAYMENT_PROVIDER_CATALOG[params.provider];
  const currency =
    params.currency && meta.supportedCurrencies.includes(params.currency)
      ? params.currency
      : meta.defaultCurrency;
  const calc = calculateTopUpCommission(params.amountPaid, params.provider);

  return [
    '💵 <b>СУММА ПОПОЛНЕНИЯ</b>',
    '<i>Шаг 2/3</i>',
    '',
    `🏦 Способ оплаты: <b>${escapeHtml(meta.shortTitle)}</b> [${meta.feePercent}%]${
      params.providerConfigured ? '' : ' ⚠️ <i>(API не настроен)</i>'
    }`,
    '',
    `📝 <b>Введите сумму в ${escapeHtml(currency)} (минимум ${meta.minAmount} ${escapeHtml(currency)}):</b>`,
    '',
    '📊 <b>Расчёт перед оплатой:</b>',
    `• Сумма пополнения: <code>${calc.amountPaid} ${escapeHtml(currency)}</code>`,
    `• Комиссия (${calc.feePercent}%): <code>-${calc.feeAmount} ${escapeHtml(currency)}</code>`,
    `• ✅ <b>Итоговая сумма зачисления:</b> <code>${calc.amountCredited}</code>`,
  ].join('\n');
}

/**
 * Шаг 3/3 (для xRocket): Экран выбора криптовалюты и сети.
 */
export function formatTopUpStep3XRocketCurrencyMessage(amountPaid: number): string {
  const calc = calculateTopUpCommission(amountPaid, 'xrocket');
  return [
    '🪙 <b>ВАЛЮТА ОПЛАТЫ</b>',
    '<i>Шаг 3/3</i>',
    '',
    `👇 <b>Выберите монету и сеть для оплаты ${calc.amountPaid}:</b>`,
    '',
    `• Сумма пополнения: <code>${calc.amountPaid}</code>`,
    `• Комиссия xRocket (${calc.feePercent}%): <code>-${calc.feeAmount}</code>`,
    `• ✅ <b>Итоговая сумма зачисления:</b> <code>${calc.amountCredited}</code>`,
  ].join('\n');
}

/**
 * Совместимый форматтер меню пополнения баланса.
 */
export function formatTopUpMenuMessage(params: {
  currentBalance: number;
  provider: BalanceTopUpProvider;
  currency?: string;
  amountPaid: number;
  providerConfigured: boolean;
}): string {
  const meta = PAYMENT_PROVIDER_CATALOG[params.provider];
  const currency =
    params.currency && meta.supportedCurrencies.includes(params.currency)
      ? params.currency
      : meta.defaultCurrency;
  const calc = calculateTopUpCommission(params.amountPaid, params.provider);

  return [
    '💰 <b>ПОПОЛНЕНИЕ БАЛАНСА</b>',
    `💼 Ваш текущий баланс: <code>${Number(params.currentBalance.toFixed(2))}</code>`,
    '',
    '💳 <b>Доступные способы оплаты:</b>',
    '• 💎 <b>CryptoBot:</b> комиссия <code>3%</code> (100 → 97 зачислено)',
    '• 🚀 <b>xRocket:</b> комиссия <code>2%</code> (100 → 98 зачислено)',
    '',
    '📊 <b>Расчёт выбранного пополнения:</b>',
    `• Способ оплаты: <b>${escapeHtml(meta.shortTitle)}</b>${
      params.providerConfigured ? '' : ' ⚠️ <i>(API-ключ не задан в .env)</i>'
    }`,
    `• Сумма пополнения: <code>${calc.amountPaid} ${escapeHtml(currency)}</code>`,
    `• Комиссия (${calc.feePercent}%): <code>-${calc.feeAmount} ${escapeHtml(currency)}</code>`,
    `• ✅ <b>Итоговая сумма зачисления:</b> <code>${calc.amountCredited}</code>`,
  ].join('\n');
}

/**
 * Шаг 3/3: Карточка созданного счёта (минималистичный формат по референсу).
 */
export function formatTopUpInvoiceCardMessage(
  topUp: BalanceTopUpRecord,
  newBalance?: number,
): string {
  const meta = PAYMENT_PROVIDER_CATALOG[topUp.provider];
  const statusLabels: Record<string, string> = {
    pending: '⏳ Ожидает оплаты',
    paid: '✅ Оплачен и зачислен на баланс',
    cancelled: '❌ Отменён',
    expired: '⌛ Срок действия истёк',
    failed: '⚠️ Ошибка проверки платежа',
  };

  const currencyLabel = topUp.network
    ? `${topUp.currency} (${topUp.network})`
    : topUp.currency;

  return [
    '📄 <b>СЧЁТ СОЗДАН</b>',
    '<i>Шаг 3/3</i>',
    '',
    `🆔 Счёт: <code>#${escapeHtml(topUp.paymentId)}</code>`,
    `💳 Способ оплаты: <b>${escapeHtml(meta?.shortTitle || topUp.provider)}</b>`,
    `🪙 Валюта: <code>${escapeHtml(currencyLabel)}</code>`,
    `💵 Сумма пополнения: <code>${topUp.amountPaid} ${escapeHtml(topUp.currency)}</code>`,
    `📉 Комиссия (${topUp.feePercent}%): <code>-${topUp.feeAmount} ${escapeHtml(topUp.currency)}</code>`,
    `✅ <b>Итоговая сумма зачисления:</b> <code>+${topUp.amountCredited}</code>`,
    `📌 Статус: ${statusLabels[topUp.paymentStatus] || topUp.paymentStatus}`,
    topUp.failureReason
      ? `⚠️ Причина: ${escapeHtml(topUp.failureReason)}`
      : '',
    newBalance !== undefined
      ? `💼 Обновлённый баланс: <code>${Number(newBalance.toFixed(2))}</code>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatSupportedCryptoInfoMessage(): string {
  return [
    '🪙 <b>Оплата криптовалютой через поддерживаемых провайдеров</b>',
    '',
    '1️⃣ <b>xRocket Pay (@xrocket) — комиссия 2%</b>',
    `• <b>Валюты:</b> ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedCurrencies.join(', ')}`,
    `• <b>Сети:</b> ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedNetworks.join(', ')}`,
    '',
    '2️⃣ <b>CryptoBot (@CryptoBot) — комиссия 3%</b>',
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
      '📜 <b>История пополнений баланса</b>',
      `💰 <b>Текущий баланс:</b> <code>${Number(currentBalance.toFixed(2))}</code>`,
      '',
      'У вас пока нет созданных счетов на пополнение баланса.',
    ].join('\n');
  }

  const lines = topUps.slice(0, 10).map((t, idx) => {
    const prov = PAYMENT_PROVIDER_CATALOG[t.provider]?.shortTitle || t.provider;
    return `${idx + 1}. <b>#${escapeHtml(t.paymentId.slice(-8))}</b> [${escapeHtml(prov)}] — внесено <code>${t.amountPaid} ${escapeHtml(t.currency)}</code> (комиссия ${t.feePercent}%: -${t.feeAmount}) → к зачислению <code>+${t.amountCredited}</code> | Статус: <b>${t.paymentStatus}</b>`;
  });

  return [
    `📜 <b>История пополнений баланса (показано: ${Math.min(topUps.length, 10)})</b>`,
    `💰 <b>Текущий баланс:</b> <code>${Number(currentBalance.toFixed(2))}</code>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatAdminTopUpCard(topUp: BalanceTopUpRecord): string {
  const prov = PAYMENT_PROVIDER_CATALOG[topUp.provider]?.title || topUp.provider;
  return [
    `💳 <b>Пополнение баланса #${escapeHtml(topUp.paymentId)}</b>`,
    `👤 <b>Пользователь:</b> <code>${topUp.userTelegramId}</code> (${escapeHtml(topUp.userId)})${topUp.username ? ` @${escapeHtml(topUp.username)}` : ''}`,
    `🔌 <b>Провайдер:</b> ${escapeHtml(prov)}`,
    `🆔 <b>External Invoice ID:</b> <code>${escapeHtml(topUp.externalInvoiceId)}</code>`,
    topUp.network ? `🌐 <b>Сеть:</b> <code>${escapeHtml(topUp.network)}</code>` : '',
    `💵 <b>Сумма платежа:</b> <code>${topUp.amountPaid} ${escapeHtml(topUp.currency)}</code>`,
    `📉 <b>Комиссия магазина (${topUp.feePercent}%):</b> <code>${topUp.feeAmount} ${escapeHtml(topUp.currency)}</code>`,
    `💰 <b>Фактическая сумма зачисления:</b> <code>${topUp.amountCredited}</code>`,
    `📌 <b>Статус:</b> <b>${escapeHtml(topUp.paymentStatus.toUpperCase())}</b>`,
    topUp.failureReason
      ? `⚠️ <b>Ошибка / Причина:</b> ${escapeHtml(topUp.failureReason)}`
      : '',
    `🕒 <b>Создан:</b> ${formatDateRu(topUp.createdAt)}`,
    topUp.expiresAt ? `⏳ <b>Истекает:</b> ${formatDateRu(topUp.expiresAt)}` : '',
    topUp.paidAt ? `✅ <b>Оплачен:</b> ${formatDateRu(topUp.paidAt)}` : '',
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
      )} (<code>${o.totalPrice} ${o.paymentMethod === 'balance' ? 'BAL' : '⭐'}</code>)\n   Статус: ${
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
  const paymentMethodLabel =
    order.paymentMethod === 'balance'
      ? '💰 Внутренний баланс магазина'
      : '⭐ Telegram Stars (XTR)';

  const keyLines =
    order.deliveredKeyValues && order.deliveredKeyValues.length > 0
      ? [
          '',
          '🔑 <b>Ваш цифровой ключ:</b>',
          ...order.deliveredKeyValues.map((k) => `<code>${escapeHtml(k)}</code>`),
        ]
      : [];

  return [
    `🧾 <b>Детали заказа #${escapeHtml(order.orderId)}</b>`,
    '',
    `🛍 <b>Товар:</b> ${escapeHtml(order.productName)}`,
    `📂 <b>Категория:</b> ${CATEGORY_LABELS[order.category]}`,
    `🔢 <b>Количество:</b> ${order.quantity} шт.`,
    `💳 <b>Способ оплаты:</b> ${paymentMethodLabel}`,
    `💰 <b>Сумма:</b> <code>${order.totalPrice} ${order.paymentMethod === 'balance' ? 'ед. баланса' : `⭐ (${order.currency})`}</code>`,
    `📌 <b>Статус оплаты:</b> ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 <b>Статус выдачи:</b> ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    ...keyLines,
    order.telegramPaymentChargeId
      ? `🔐 <b>ID платежа Telegram:</b> <code>${escapeHtml(
          order.telegramPaymentChargeId,
        )}</code>`
      : '',
    order.balancePaymentId
      ? `🔐 <b>ID списания баланса:</b> <code>${escapeHtml(order.balancePaymentId)}</code>`
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
  const keySection =
    order.deliveredKeyValues && order.deliveredKeyValues.length > 0
      ? [
          '',
          '🔑 <b>Ваш цифровой ключ:</b>',
          ...order.deliveredKeyValues.map((k) => `<code>${escapeHtml(k)}</code>`),
        ]
      : [];

  return [
    `🎉 <b>Ваш заказ #${escapeHtml(order.orderId)} выполнен!</b>`,
    '',
    `🛍 <b>Товар:</b> ${escapeHtml(order.productName)}`,
    `💰 <b>Оплачено:</b> ${order.totalPrice} ${
      order.paymentMethod === 'balance' ? 'с внутреннего баланса' : '⭐ (XTR)'
    }`,
    ...keySection,
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
    '/profile — Ваш профиль, баланс и статистика покупок',
    '/topup — Пополнить внутренний баланс (CryptoBot, xRocket)',
    '/terms — Правила пользования магазином',
    '/paysupport — Поддержка по платежам',
    '/help — Помощь и ответы на вопросы',
    '',
    '<b>Как происходит покупка:</b>',
    '1. Выберите товар в разделе Stars, Premium или Gifts.',
    '2. Оплатите товар напрямую через Telegram Stars (XTR) или с внутреннего баланса магазина.',
    '3. Сразу после подтверждения оплаты заказ получает статус <b>Оплачен</b> и передаётся на выдачу.',
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
    '2. <b>Оплата и пополнение баланса:</b> Оплата принимается через официальный механизм Telegram Stars (XTR), а также с внутреннего баланса магазина (пополнение через официальные API CryptoBot — комиссия 3%, xRocket — 2%). Магазин никогда не запрашивает пароли, коды входа, seed-фразы или приватные ключи.',
    '3. <b>Порядок выдачи:</b> Выдача товара осуществляется после серверной верификации платежа. При наличии цифрового ключа на складе выдача происходит автоматически и мгновенно.',
    '4. <b>Возврат средств:</b> Если заказ не может быть выдан по техническим причинам, выполняется полный возврат Telegram Stars (через <code>refundStarPayment</code>) либо возврат средств на внутренний баланс покупателя.',
  ].join('\n');
}

export function formatPaySupportMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    '💳 <b>Поддержка по платежам (Payment Support)</b>',
    '',
    'По всем вопросам, связанным с оплатой в Telegram Stars (XTR), пополнением внутреннего баланса (CryptoBot / xRocket), статусом заказа или возвратом средств:',
    '',
    `• Служба поддержки: @${escapeHtml(storeSupportUsername)}`,
    '• При обращении укажите <b>ID заказа</b> (из раздела /orders) или <b>ID пополнения баланса</b>.',
    '• Если средства были списаны, но товар ещё не доставлен, проверьте статус в /orders — администратор получает уведомление автоматически.',
  ].join('\n');
}

export function formatAdminOrderCard(order: Order): string {
  const methodLabel =
    order.paymentMethod === 'balance'
      ? '💰 Внутренний баланс'
      : '⭐ Telegram Stars (XTR)';
  return [
    `🧾 <b>Заказ #${escapeHtml(order.orderId)}</b>`,
    `👤 <b>Покупатель:</b> <code>${order.userTelegramId}</code> ${
      order.username ? `(@${escapeHtml(order.username)})` : ''
    }`,
    `🛍 <b>Товар:</b> ${escapeHtml(order.productName)} (x${order.quantity})`,
    `💳 <b>Способ оплаты:</b> ${methodLabel}`,
    `💰 <b>Сумма:</b> <code>${order.totalPrice} ${order.paymentMethod === 'balance' ? 'BAL' : `⭐ (${order.currency})`}</code>`,
    `📌 <b>Статус оплаты:</b> ${ORDER_STATUS_LABELS[order.paymentStatus]}`,
    `🚚 <b>Статус выдачи:</b> ${ORDER_STATUS_LABELS[order.fulfillmentStatus]}`,
    order.awaitingKeyStock
      ? '⚠️ <b>Ожидание склада ключей:</b> <code>Нет доступных цифровых ключей (заказ НЕ помечен как выполненный)</code>'
      : '',
    order.assignedKeyIds && order.assignedKeyIds.length > 0
      ? `🔑 <b>Назначенные ID ключей:</b> <code>${escapeHtml(order.assignedKeyIds.join(', '))}</code>`
      : '',
    order.telegramPaymentChargeId
      ? `🔐 <b>Charge ID:</b> <code>${escapeHtml(order.telegramPaymentChargeId)}</code>`
      : '',
    order.balancePaymentId
      ? `🔐 <b>Balance Payment ID:</b> <code>${escapeHtml(order.balancePaymentId)}</code>`
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

export function formatOwnerKeysOverviewMessage(
  summaries: ProductKeyStockSummary[],
): string {
  const totalAvail = summaries.reduce((acc, s) => acc + s.available, 0);
  const totalDeliv = summaries.reduce((acc, s) => acc + s.delivered, 0);
  const totalDisabled = summaries.reduce((acc, s) => acc + s.disabled, 0);

  const lines = summaries.map((s, idx) => {
    const algLabel =
      s.algorithm && s.algorithm !== 'none'
        ? `⚙️ Алгоритм: <code>${escapeHtml(s.algorithm)}</code>`
        : '📝 Ручная загрузка ключей';
    return `${idx + 1}. <b>${escapeHtml(s.productName)}</b> (${algLabel})\n   🟢 Доступно: <b>${s.available}</b> | 📦 Выдано: <b>${s.delivered}</b> | 🚫 Отключено: <b>${s.disabled}</b>`;
  });

  return [
    '🔑 <b>Генератор и склад цифровых ключей (Owner-Only)</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `🟢 Всего доступно на складе: <b>${totalAvail}</b>`,
    `📦 Всего выдано покупателям: <b>${totalDeliv}</b>`,
    `🚫 Отключено: <b>${totalDisabled}</b>`,
    '',
    ...lines,
    '',
    'Выберите товар ниже для добавления, генерации или управления ключами 👇',
  ].join('\n');
}

export function formatOwnerProductKeysMessage(
  product: Product,
  summary: ProductKeyStockSummary,
): string {
  return [
    `🔑 <b>Склад ключей: ${escapeHtml(product.name)}</b>`,
    `🆔 ID товара: <code>${escapeHtml(product.id)}</code>`,
    `📂 Категория: <b>${CATEGORY_LABELS[product.category]}</b>`,
    `⚙️ Алгоритм генерации: ${
      product.keyGeneratorAlgorithm && product.keyGeneratorAlgorithm !== 'none'
        ? `<code>${escapeHtml(product.keyGeneratorAlgorithm)}</code> (поддерживает автогенерацию)`
        : '<i>Не задан (только ручная загрузка реальных ключей поставщика)</i>'
    }`,
    '',
    '📊 <b>Остатки и статусы ключей:</b>',
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
    'Нажмите на ключ ниже, чтобы отключить его (статус <code>disabled</code>) 👇',
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
      '📜 <b>История выдачи цифровых ключей</b>',
      '',
      'Пока не выдано ни одного цифрового ключа.',
    ].join('\n');
  }

  const lines = keys.slice(0, 20).map(
    (k, idx) =>
      `${idx + 1}. <b>${escapeHtml(k.productId)}</b> — <code>${escapeHtml(k.maskedPreview)}</code>\n   🧾 Заказ: <code>${escapeHtml(k.deliveredOrderId || '—')}</code> | 👤 TG ID: <code>${k.deliveredUserTelegramId ?? '—'}</code> | 🕒 ${formatDateRu(k.deliveredAt)}`,
  );

  return [
    `📜 <b>История выдачи цифровых ключей (последние ${Math.min(keys.length, 20)})</b>`,
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
    `⭐ <b>Выручка в Telegram Stars:</b> <code>${params.totalStarsRevenue} XTR</code>`,
    params.totalTopUpsCount !== undefined
      ? `💳 <b>Пополнений баланса:</b> ${params.totalTopUpsCount} (оплачено: ${params.paidTopUpsCount ?? 0}, зачислено: <code>${Number((params.totalTopUpCredited ?? 0).toFixed(2))}</code>, комиссия магазина: <code>${Number((params.totalTopUpFees ?? 0).toFixed(2))}</code>)`
      : '',
    '',
    '📋 <b>Последние события:</b>',
    ...txLines,
  ]
    .filter(Boolean)
    .join('\n');
}
