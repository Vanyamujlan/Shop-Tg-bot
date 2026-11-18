import {
  BalanceTopUpProvider,
  BalanceTopUpRecord,
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
    '🔒 <b>Официальная оплата:</b> покупки можно оплачивать через <b>Telegram Stars (XTR)</b> или с <b>внутреннего баланса магазина</b> (пополнение через CryptoBot, Lolzteam, xRocket).',
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
      product.fulfillmentType === 'manual'
        ? 'Проверенная выдача администратором после оплаты'
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
    '💡 Нажмите <b>«💳 Пополнить баланс»</b>, чтобы пополнить внутренний баланс через CryptoBot, Lolzteam или xRocket.',
  ]
    .filter(Boolean)
    .join('\n');
}

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
    '💳 <b>Пополнение внутреннего баланса Stars Shop</b>',
    '',
    `💰 <b>Ваш текущий баланс:</b> <code>${Number(params.currentBalance.toFixed(2))}</code>`,
    '',
    '📊 <b>Доступные провайдеры и комиссии магазина:</b>',
    `• <b>CryptoBot (@CryptoBot):</b> комиссия <code>3%</code> (100 → 97 зачислено)`,
    `• <b>Lolzteam Market (LZT):</b> комиссия <code>5%</code> (100 → 95 зачислено)`,
    `• <b>xRocket Pay (@xrocket):</b> комиссия <code>2%</code> (100 → 98 зачислено)`,
    '',
    '🧾 <b>Предварительный расчёт перед оплатой:</b>',
    `• Выбранный провайдер: <b>${escapeHtml(meta.title)}</b>${
      params.providerConfigured ? '' : ' ⚠️ <i>(API-ключ не задан в .env)</i>'
    }`,
    `• Валюта платежа: <code>${escapeHtml(currency)}</code>`,
    `• Сумма платежа: <code>${calc.amountPaid} ${escapeHtml(currency)}</code>`,
    `• Комиссия магазина (${calc.feePercent}%): <code>-${calc.feeAmount} ${escapeHtml(currency)}</code>`,
    `• ✅ <b>Итоговая сумма к зачислению:</b> <code>${calc.amountCredited}</code>`,
    '',
    `🪙 <b>Поддерживаемые валюты ${escapeHtml(meta.shortTitle)}:</b> ${meta.supportedCurrencies.join(', ')}`,
    `🌐 <b>Сети:</b> ${meta.supportedNetworks.join(' • ')}`,
    '',
    'Выберите провайдера, валюту и сумму (или нажмите «Ввести свою сумму»), затем нажмите <b>«💳 Оплатить»</b> 👇',
  ].join('\n');
}

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

  return [
    `🧾 <b>Счёт на пополнение баланса #${escapeHtml(topUp.paymentId)}</b>`,
    '',
    `🔌 <b>Провайдер:</b> ${escapeHtml(meta?.title || topUp.provider)}`,
    `🆔 <b>ID счёта у провайдера:</b> <code>${escapeHtml(topUp.externalInvoiceId)}</code>`,
    `💱 <b>Валюта платежа:</b> <code>${escapeHtml(topUp.currency)}</code>`,
    `💵 <b>Сумма к оплате:</b> <code>${topUp.amountPaid} ${escapeHtml(topUp.currency)}</code>`,
    `📉 <b>Комиссия (${topUp.feePercent}%):</b> <code>-${topUp.feeAmount} ${escapeHtml(topUp.currency)}</code>`,
    `💰 <b>Сумма к зачислению на баланс:</b> <code>+${topUp.amountCredited}</code>`,
    `📌 <b>Статус платежа:</b> ${statusLabels[topUp.paymentStatus] || topUp.paymentStatus}`,
    topUp.failureReason
      ? `⚠️ <b>Причина отказа:</b> ${escapeHtml(topUp.failureReason)}`
      : '',
    newBalance !== undefined
      ? `🏦 <b>Ваш обновлённый баланс:</b> <code>${Number(newBalance.toFixed(2))}</code>`
      : '',
    `🕒 <b>Создан:</b> ${formatDateRu(topUp.createdAt)}`,
    topUp.expiresAt && topUp.paymentStatus === 'pending'
      ? `⏳ <b>Действителен до:</b> ${formatDateRu(topUp.expiresAt)}`
      : '',
    topUp.paidAt ? `✅ <b>Зачислен:</b> ${formatDateRu(topUp.paidAt)}` : '',
    '',
    topUp.paymentStatus === 'pending'
      ? 'Нажмите <b>«🔗 Перейти к оплате счёта»</b>, завершите оплату у провайдера и нажмите <b>«🔄 Проверить статус оплаты»</b> (или дождитесь автоматического зачисления по вебхуку).'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatSupportedCryptoInfoMessage(): string {
  return [
    '🪙 <b>Оплата криптовалютой через поддерживаемых провайдеров</b>',
    '',
    'Прямое пополнение криптовалютой полностью интегрировано через официальные API <b>CryptoBot</b> и <b>xRocket Pay</b> (без дублирующих посредников):',
    '',
    '1️⃣ <b>xRocket Pay (@xrocket) — комиссия 2%</b>',
    `• <b>Валюты:</b> ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedCurrencies.join(', ')}`,
    `• <b>Сети:</b> ${PAYMENT_PROVIDER_CATALOG.xrocket.supportedNetworks.join(', ')}`,
    '',
    '2️⃣ <b>CryptoBot (@CryptoBot) — комиссия 3%</b>',
    `• <b>Валюты:</b> ${PAYMENT_PROVIDER_CATALOG.cryptobot.supportedCurrencies.join(', ')}`,
    `• <b>Сети:</b> ${PAYMENT_PROVIDER_CATALOG.cryptobot.supportedNetworks.join(', ')}`,
    '• <i>При выборе RUB в CryptoBot сумма автоматически конвертируется по биржевому курсу в любую выбранную вами криптовалюту (USDT, TON, BTC, ETH, TRX, BNB, USDC, LTC).</i>',
    '',
    '3️⃣ <b>Lolzteam Market (LZT) — комиссия 5%</b>',
    `• <b>Валюты:</b> ${PAYMENT_PROVIDER_CATALOG.lolzteam.supportedCurrencies.join(', ')}`,
    `• <b>Способы:</b> ${PAYMENT_PROVIDER_CATALOG.lolzteam.supportedNetworks.join(', ')}`,
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
    topUp.recipientMerchantId
      ? `🏪 <b>Merchant ID:</b> <code>${escapeHtml(topUp.recipientMerchantId)}</code>`
      : '',
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
  return [
    `🎉 <b>Ваш заказ #${escapeHtml(order.orderId)} выполнен!</b>`,
    '',
    `🛍 <b>Товар:</b> ${escapeHtml(order.productName)}`,
    `💰 <b>Оплачено:</b> ${order.totalPrice} ${
      order.paymentMethod === 'balance' ? 'с внутреннего баланса' : '⭐ (XTR)'
    }`,
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
    '/topup — Пополнить внутренний баланс (CryptoBot, Lolzteam, xRocket)',
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
    '2. <b>Оплата и пополнение баланса:</b> Оплата принимается через официальный механизм Telegram Stars (XTR), а также с внутреннего баланса магазина (пополнение через официальные API CryptoBot — комиссия 3%, Lolzteam — 5%, xRocket — 2%). Магазин никогда не запрашивает пароли, коды входа, seed-фразы или приватные ключи.',
    '3. <b>Порядок выдачи:</b> Выдача товара осуществляется после серверной верификации платежа. Срок стандартной ручной выдачи администратором — от 5 минут до 24 часов.',
    '4. <b>Возврат средств:</b> Если заказ не может быть выдан по техническим причинам, выполняется полный возврат Telegram Stars (через <code>refundStarPayment</code>) либо возврат средств на внутренний баланс покупателя.',
  ].join('\n');
}

export function formatPaySupportMessage(): string {
  const { storeSupportUsername } = getEnvConfig();
  return [
    '💳 <b>Поддержка по платежам (Payment Support)</b>',
    '',
    'По всем вопросам, связанным с оплатой в Telegram Stars (XTR), пополнением внутреннего баланса (CryptoBot / Lolzteam / xRocket), статусом заказа или возвратом средств:',
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

