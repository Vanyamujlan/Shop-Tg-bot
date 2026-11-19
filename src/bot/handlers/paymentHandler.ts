import { Markup, Telegraf } from 'telegraf';
import { firestoreRepo } from '../../db/firestore.ts';
import {
  OrderService,
  canUseTelegramUsernameAsRecipient,
} from '../../services/OrderService.ts';
import { ProductService } from '../../services/ProductService.ts';
import { PaymentService } from '../../services/PaymentService.ts';
import { FulfillmentService } from '../../services/FulfillmentService.ts';
import { balanceService } from '../../services/BalanceService.ts';
import { formatUsd } from '../../config/env.ts';
import { formatUsdCents } from '../../services/Money.ts';
import { oe, oeBtn } from '../outlineEmoji.ts';
import {
  UserCheckoutSession,
  clearAllUserInteractiveSessions,
  clearUserCheckoutSession,
  fetchLiveCurrencyPreviews,
  getUserCheckoutSession,
  isDuplicateCallbackClick,
  renderCheckoutConfirmationCard,
  renderCheckoutRecipientPrompt,
  renderCheckoutStarsQuantityPrompt,
  renderMainMenu,
  renderOrderCheckoutChooser,
  safeAnswerCbQuery,
  safeRespondOrEdit,
  setUserCheckoutSession,
} from './userHandler.ts';
import {
  escapeHtml,
  formatOrderCryptoCurrencyMessage,
  formatOrderDetailMessage,
  formatOrderPaymentInvoiceMessage,
  formatPremiumTariffsMessage,
} from '../formatters.ts';
import {
  buildBackToMenuKeyboard,
  buildOrderCryptoCurrencyKeyboard,
  buildOrderPaymentInvoiceKeyboard,
  buildPremiumTariffsKeyboard,
} from '../keyboards.ts';
import { BalanceTopUpProvider, PaymentRecord } from '../../types.ts';

const activeProceedLocks = new Set<number>();

export function registerPaymentHandlers(bot: Telegraf): void {
  // 1a. Устаревшая быстрая покупка Gifts/каталога с баланса отключена в Stage 4.2.2
  bot.action(/^buy_bal:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!ctx.from) return;
    clearAllUserInteractiveSessions(ctx.from.id);
    await safeAnswerCbQuery(
      ctx,
      'Быстрая покупка отключена. Выберите Stars или Premium в главном меню.',
      true,
    );
    await renderMainMenu(ctx);
  });

  // 1b. Переход к вводу количества Stars (buy_custom:<productId> и stars:edit_qty)
  bot.action(/^buy_custom:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `buy_custom:${productId}`)) {
      return;
    }
    clearAllUserInteractiveSessions(ctx.from.id);
    await renderCheckoutStarsQuantityPrompt(ctx, false);
  });

  bot.action('stars:edit_qty', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'stars:edit_qty')) {
      return;
    }
    const existing = getUserCheckoutSession(ctx.from.id);
    await renderCheckoutStarsQuantityPrompt(
      ctx,
      Boolean(existing?.returnToConfirm && existing?.recipientUsername),
    );
  });

  // Быстрый выбор фиксированного количества Stars кнопкой (с автоматическим расчётом цены)
  bot.action(/^stars:qty:(\d+)$/, async (ctx) => {
    const rawQty = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `stars:qty:${rawQty}`)) {
      return;
    }

    try {
      const starsProduct = await ProductService.getBuyerStarsProduct();
      if (!starsProduct) {
        clearUserCheckoutSession(ctx.from.id);
        await safeAnswerCbQuery(ctx, 'Покупка Telegram Stars временно недоступна.', true);
        await renderMainMenu(ctx);
        return;
      }

      const calc = ProductService.calculateOrderPriceUsdCents(starsProduct, rawQty);
      const existing = getUserCheckoutSession(ctx.from.id);
      if (existing?.returnToConfirm && existing?.recipientUsername) {
        const nextSession: UserCheckoutSession = {
          mode: 'confirm_order',
          productId: starsProduct.id,
          quantity: calc.quantity,
          recipientUsername: existing.recipientUsername,
          createdAt: Date.now(),
        };
        setUserCheckoutSession(ctx.from.id, nextSession);
        await renderCheckoutConfirmationCard(ctx, nextSession);
        return;
      }

      const nextSession: UserCheckoutSession = {
        mode: 'recipient_username',
        productId: starsProduct.id,
        quantity: calc.quantity,
        createdAt: Date.now(),
      };
      setUserCheckoutSession(ctx.from.id, nextSession);
      await renderCheckoutRecipientPrompt(ctx, nextSession);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1c. Устаревший callback buy_start:<productId> (Gifts заблокированы, Stars/Premium перенаправлены)
  bot.action(/^buy_start:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `buy_start:${productId}`, 1200)) {
      return;
    }

    try {
      const product = await ProductService.getProductById(productId);
      if (!product || !product.isActive || product.category === 'gifts') {
        clearAllUserInteractiveSessions(ctx.from.id);
        await safeAnswerCbQuery(ctx, 'Этот товар больше не доступен.', true);
        await renderMainMenu(ctx);
        return;
      }

      if (product.category === 'stars') {
        clearAllUserInteractiveSessions(ctx.from.id);
        await renderCheckoutStarsQuantityPrompt(ctx, false);
        return;
      }

      if (
        product.category === 'premium' &&
        ProductService.isValidBuyerPremiumProduct(product)
      ) {
        const catalogState =
          await ProductService.getValidatedBuyerPremiumCatalog();
        if (!catalogState.allAvailable) {
          clearAllUserInteractiveSessions(ctx.from.id);
          await safeAnswerCbQuery(
            ctx,
            'Раздел Telegram Premium временно недоступен.',
            true,
          );
          await renderMainMenu(ctx);
          return;
        }
        const nextSession: UserCheckoutSession = {
          mode: 'recipient_username',
          productId: product.id,
          quantity: 1,
          createdAt: Date.now(),
        };
        setUserCheckoutSession(ctx.from.id, nextSession);
        await renderCheckoutRecipientPrompt(ctx, nextSession);
        return;
      }

      clearAllUserInteractiveSessions(ctx.from.id);
      await renderMainMenu(ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1d. Выбор фиксированного тарифа Telegram Premium (3 / 6 / 12 месяцев)
  bot.action(/^prem:select:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `prem:select:${productId}`)) {
      return;
    }

    const [product, catalogState] = await Promise.all([
      ProductService.getProductById(productId),
      ProductService.getValidatedBuyerPremiumCatalog(),
    ]);
    if (
      !catalogState.allAvailable ||
      !ProductService.isValidBuyerPremiumProduct(product)
    ) {
      clearUserCheckoutSession(ctx.from.id);
      await safeAnswerCbQuery(
        ctx,
        'Выбранный тариф или раздел Telegram Premium временно недоступен.',
        true,
      );
      await safeRespondOrEdit(
        ctx,
        formatPremiumTariffsMessage(catalogState.availableProducts),
        buildPremiumTariffsKeyboard(catalogState.availableProducts),
      );
      return;
    }

    const nextSession: UserCheckoutSession = {
      mode: 'recipient_username',
      productId: product.id,
      quantity: 1,
      createdAt: Date.now(),
    };
    setUserCheckoutSession(ctx.from.id, nextSession);
    await renderCheckoutRecipientPrompt(ctx, nextSession);
  });

  // 1e. Кнопка «Купить себе (@username)» -> перевод на карточку подтверждения (без создания заказа в БД)
  bot.action(/^rcpt_self(?::([a-zA-Z0-9_-]+))?$/, async (ctx) => {
    const legacyProductId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'rcpt_self')) {
      return;
    }

    const selfUsername = canUseTelegramUsernameAsRecipient(ctx.from.username);
    if (!selfUsername) {
      await safeAnswerCbQuery(
        ctx,
        'У вашего Telegram-профиля не задан корректный @username (5–32 символа: латинские буквы, цифры и "_"). Введите @username получателя вручную.',
        true,
      );
      return;
    }

    try {
      const session = getUserCheckoutSession(ctx.from.id);
      const targetProductId = session?.productId || legacyProductId;
      if (!targetProductId) {
        clearUserCheckoutSession(ctx.from.id);
        await safeAnswerCbQuery(
          ctx,
          'Сессия оформления истекла. Начните оформление заново.',
          true,
        );
        await renderMainMenu(ctx);
        return;
      }

      const product = await ProductService.getProductById(targetProductId);
      if (
        !product ||
        !product.isActive ||
        product.category === 'gifts' ||
        (product.category === 'premium' &&
          !ProductService.isValidBuyerPremiumProduct(product))
      ) {
        clearUserCheckoutSession(ctx.from.id);
        await safeAnswerCbQuery(ctx, 'Этот товар сейчас недоступен.', true);
        await renderMainMenu(ctx);
        return;
      }

      if (product.category === 'stars' && !session?.quantity) {
        await safeAnswerCbQuery(
          ctx,
          'Сначала укажите количество Stars.',
          true,
        );
        await renderCheckoutStarsQuantityPrompt(ctx, false);
        return;
      }

      const qty = product.category === 'premium' ? 1 : (session?.quantity ?? 1);
      ProductService.calculateOrderPriceUsdCents(product, qty);

      const nextSession: UserCheckoutSession = {
        mode: 'confirm_order',
        productId: product.id,
        quantity: qty,
        recipientUsername: selfUsername,
        createdAt: Date.now(),
      };
      setUserCheckoutSession(ctx.from.id, nextSession);
      await renderCheckoutConfirmationCard(ctx, nextSession);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1f. Редактирование параметров на карточке подтверждения заказа
  bot.action('checkout:edit_qty', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'checkout:edit_qty')) {
      return;
    }
    const session = getUserCheckoutSession(ctx.from.id);
    if (!session) {
      await safeAnswerCbQuery(ctx, 'Сессия заказа истекла.', true);
      await renderMainMenu(ctx);
      return;
    }

    const product = await ProductService.getProductById(session.productId);
    if (!product || !product.isActive || product.category !== 'stars') {
      await safeAnswerCbQuery(
        ctx,
        'Количество можно изменить только при покупке Telegram Stars.',
        true,
      );
      return;
    }

    await renderCheckoutStarsQuantityPrompt(ctx, Boolean(session.recipientUsername));
  });

  bot.action('checkout:edit_recipient', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'checkout:edit_recipient')) {
      return;
    }
    const session = getUserCheckoutSession(ctx.from.id);
    if (!session) {
      await safeAnswerCbQuery(ctx, 'Сессия заказа истекла.', true);
      await renderMainMenu(ctx);
      return;
    }

    const nextSession: UserCheckoutSession = {
      ...session,
      mode: 'recipient_username',
      returnToConfirm: Boolean(session.recipientUsername),
      createdAt: Date.now(),
    };
    setUserCheckoutSession(ctx.from.id, nextSession);
    await renderCheckoutRecipientPrompt(ctx, nextSession);
  });

  bot.action('checkout:back_confirm', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'checkout:back_confirm')) {
      return;
    }
    const session = getUserCheckoutSession(ctx.from.id);
    if (!session || !session.quantity || !session.recipientUsername) {
      await safeAnswerCbQuery(ctx, 'Сессия заказа истекла.', true);
      await renderMainMenu(ctx);
      return;
    }

    const nextSession: UserCheckoutSession = {
      ...session,
      mode: 'confirm_order',
      returnToConfirm: false,
      createdAt: Date.now(),
    };
    setUserCheckoutSession(ctx.from.id, nextSession);
    await renderCheckoutConfirmationCard(ctx, nextSession);
  });

  bot.action('checkout:cancel', async (ctx) => {
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, 'checkout:cancel')) {
      return;
    }
    clearUserCheckoutSession(ctx.from.id);
    await safeAnswerCbQuery(ctx, 'Оформление заказа отменено.');
    await renderMainMenu(ctx);
  });

  // 1g. Подтверждение заказа и создание записи Order в БД (строго при нажатии «💳 Перейти к оплате»)
  bot.action('checkout:proceed', async (ctx) => {
    if (!ctx.from) return;
    if (
      activeProceedLocks.has(ctx.from.id) ||
      isDuplicateCallbackClick(ctx.from.id, 'checkout:proceed', 1500)
    ) {
      await safeAnswerCbQuery(ctx, 'Заказ уже создаётся, подождите…');
      return;
    }

    const session = getUserCheckoutSession(ctx.from.id);
    if (
      !session ||
      session.mode !== 'confirm_order' ||
      !session.productId ||
      !session.quantity ||
      !session.recipientUsername
    ) {
      clearUserCheckoutSession(ctx.from.id);
      await safeAnswerCbQuery(
        ctx,
        'Данные заказа не найдены или устарели. Оформите заказ заново.',
        true,
      );
      await renderMainMenu(ctx);
      return;
    }

    activeProceedLocks.add(ctx.from.id);
    // Сбрасываем сессию немедленно до асинхронного создания заказа для исключения дублирования
    clearUserCheckoutSession(ctx.from.id);
    try {
      const product = await ProductService.getProductById(session.productId);
      if (
        !product ||
        !product.isActive ||
        product.category === 'gifts' ||
        (product.category === 'premium' &&
          !ProductService.isValidBuyerPremiumProduct(product))
      ) {
        throw new Error('Выбранный тариф или товар больше недоступен.');
      }

      const order = await OrderService.createOrder({
        telegramUser: ctx.from,
        productId: session.productId,
        quantity: product.category === 'premium' ? 1 : session.quantity,
        recipientUsername: session.recipientUsername,
        requireRecipient: true,
      });
      await renderOrderCheckoutChooser(ctx, order);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    } finally {
      activeProceedLocks.delete(ctx.from.id);
    }
  });

  // 1h. Экран единого выбора способа оплаты заказа (ordpay_menu:<orderId>)
  bot.action(/^ordpay_menu:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `ordpay_menu:${orderId}`)) {
      return;
    }

    const order = await OrderService.getOrderById(orderId);
    if (!order || order.userTelegramId !== ctx.from.id) {
      await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
      return;
    }
    if (order.paymentStatus !== 'pending' || order.fulfillmentStatus !== 'pending') {
      await safeAnswerCbQuery(ctx, 'Заказ уже оплачен или отменён.', true);
      return;
    }
    if (
      (order.category === 'stars' || order.category === 'premium') &&
      !order.recipientUsername
    ) {
      await safeAnswerCbQuery(
        ctx,
        'В заказе отсутствует @username получателя. Отмените и создайте заказ заново.',
        true,
      );
      return;
    }
    await renderOrderCheckoutChooser(ctx, order);
  });

  // 1i. Обработка нажатия на внутренний баланс при недостатке средств (pay_bal_insuff:<orderId>)
  bot.action(/^pay_bal_insuff:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    if (
      !ctx.from ||
      isDuplicateCallbackClick(ctx.from.id, `pay_bal_insuff:${orderId}`)
    ) {
      return;
    }

    const order = await OrderService.getOrderById(orderId);
    if (!order || order.userTelegramId !== ctx.from.id) {
      await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
      return;
    }
    if (order.paymentStatus !== 'pending' || order.fulfillmentStatus !== 'pending') {
      await safeAnswerCbQuery(ctx, 'Заказ уже оплачен или отменён.', true);
      return;
    }

    const currentBalanceCents = await balanceService.getBalanceUsdCents(ctx.from.id);
    const orderCents = order.totalPriceUsdCents ?? order.totalPrice;
    const shortageCents = Math.max(0, orderCents - currentBalanceCents);

    await safeAnswerCbQuery(
      ctx,
      `Недостаточно средств на балансе. Не хватает ${formatUsdCents(shortageCents)}.`,
      true,
    );

    await safeRespondOrEdit(
      ctx,
      [
        `${oe('warning')} <b>Недостаточно средств на внутреннем балансе</b>`,
        '',
        `• Заказ: <code>#${escapeHtml(order.orderId)}</code>`,
        `• К оплате: <b><code>${formatUsdCents(orderCents)}</code></b>`,
        `• Ваш баланс: <code>${formatUsdCents(currentBalanceCents)}</code>`,
        `• Не хватает: <b><code>${formatUsdCents(shortageCents)}</code></b>`,
        '',
        'Пополните баланс или выберите оплату через CryptoBot / xRocket:',
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback(`${oeBtn('topup')} Пополнить баланс`, 'menu:topup')],
        [
          Markup.button.callback(
            `${oeBtn('back')} Выбрать способ оплаты`,
            `ordpay_menu:${order.orderId}`,
          ),
        ],
        [Markup.button.callback('❌ Отменить заказ', `ucancel:${order.orderId}`)],
      ]),
    );
  });

  // 1j. Оплата существующего заказа с внутреннего баланса USD (pay_bal:<orderId>)
  bot.action(/^pay_bal:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `pay_bal:${orderId}`, 1500)) {
      return;
    }

    try {
      const order = await OrderService.getOrderById(orderId);
      if (!order || order.userTelegramId !== ctx.from.id) {
        await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
        return;
      }
      if (order.paymentStatus !== 'pending' || order.fulfillmentStatus !== 'pending') {
        await safeAnswerCbQuery(ctx, 'Заказ уже оплачен или отменён.', true);
        return;
      }

      const result = await balanceService.purchaseWithInternalBalance({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        productId: order.productId,
        quantity: order.quantity,
        orderId: order.orderId,
        recipientUsername: order.recipientUsername,
        requireRecipient: order.category === 'stars' || order.category === 'premium',
      });

      if (result.duplicate) {
        await safeAnswerCbQuery(ctx, 'Этот заказ уже оплачен.', true);
        return;
      }

      await safeAnswerCbQuery(
        ctx,
        `Оплачено с баланса! Остаток: ${formatUsd(result.newBalance)}`,
      );

      const orderInFulfillment = await FulfillmentService.initiateFulfillment(
        result.order,
        bot,
      );

      await safeRespondOrEdit(
        ctx,
        [
          `${oe('check')} <b>Заказ #${escapeHtml(orderInFulfillment.orderId)} оплачен с баланса!</b>`,
          `${oe('money')} <b>Остаток:</b> <code>${formatUsd(result.newBalance)}</code>`,
          '',
          formatOrderDetailMessage(orderInFulfillment),
        ].join('\n'),
        buildBackToMenuKeyboard(),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1k. Выбор валюты и живой курс для оплаты заказа через CryptoBot / xRocket (pay_ord_prov:<provider>:<orderId>)
  bot.action(
    /^pay_ord_prov:(cryptobot|xrocket):([a-zA-Z0-9_-]+)$/,
    async (ctx) => {
      const provider = ctx.match[1] as BalanceTopUpProvider;
      const orderId = ctx.match[2];
      if (
        !ctx.from ||
        isDuplicateCallbackClick(ctx.from.id, `pay_ord_prov:${provider}:${orderId}`)
      ) {
        return;
      }

      const order = await OrderService.getOrderById(orderId);
      if (!order || order.userTelegramId !== ctx.from.id) {
        await safeAnswerCbQuery(ctx, 'Заказ не найден.', true);
        return;
      }
      if (order.paymentStatus !== 'pending' || order.fulfillmentStatus !== 'pending') {
        await safeAnswerCbQuery(ctx, 'Этот заказ уже не ожидает оплаты.', true);
        return;
      }
      if (
        (order.category === 'stars' || order.category === 'premium') &&
        !order.recipientUsername
      ) {
        await safeAnswerCbQuery(
          ctx,
          'Нельзя оплатить заказ без указанного @username получателя.',
          true,
        );
        return;
      }

      const orderCents = order.totalPriceUsdCents ?? order.totalPrice;
      const previews = await fetchLiveCurrencyPreviews(provider, orderCents);
      await safeRespondOrEdit(
        ctx,
        formatOrderCryptoCurrencyMessage(order, provider, previews),
        buildOrderCryptoCurrencyKeyboard(order.orderId, provider, previews),
      );
    },
  );

  // 1l. Создание / переиспользование счёта CryptoBot или xRocket на оплату заказа
  // (pay_ord:<provider>:<currency>:<networkEnc>:<orderId>)
  bot.action(
    /^pay_ord:(cryptobot|xrocket):([A-Z0-9]+):([^:]+):([a-zA-Z0-9_-]+)$/,
    async (ctx) => {
      const provider = ctx.match[1] as BalanceTopUpProvider;
      const currency = ctx.match[2];
      const rawNet = decodeURIComponent(ctx.match[3]);
      const network = rawNet === 'NONE' ? undefined : rawNet;
      const orderId = ctx.match[4];

      if (
        !ctx.from ||
        isDuplicateCallbackClick(
          ctx.from.id,
          `pay_ord:${provider}:${currency}:${rawNet}:${orderId}`,
          1500,
        )
      ) {
        return;
      }

      try {
        const res = await PaymentService.createOrReuseOrderPayment({
          orderId,
          callerTelegramId: ctx.from.id,
          provider,
          currency,
          network,
          requireRecipient: true,
        });

        await safeAnswerCbQuery(
          ctx,
          res.reused ? 'Открыт активный счёт.' : 'Счёт на оплату создан!',
        );

        await safeRespondOrEdit(
          ctx,
          formatOrderPaymentInvoiceMessage(res.order, res.payment),
          buildOrderPaymentInvoiceKeyboard(res.order, res.payment),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
      }
    },
  );

  // 1m. Проверка оплаты заказа по кнопке (chk_ordpay:<paymentId>)
  bot.action(/^chk_ordpay:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const paymentId = ctx.match[1];
    if (
      !ctx.from ||
      isDuplicateCallbackClick(ctx.from.id, `chk_ordpay:${paymentId}`, 1500)
    ) {
      return;
    }

    try {
      const paymentDoc = await firestoreRepo.getDoc<PaymentRecord>('payments', paymentId);
      if (!paymentDoc || paymentDoc.userTelegramId !== ctx.from.id) {
        await safeAnswerCbQuery(ctx, 'Счёт не найден.', true);
        return;
      }

      const verifyRes = await PaymentService.verifyAndProcessOrderPayment(paymentId);

      if (verifyRes.ok && verifyRes.order) {
        if (!verifyRes.duplicate || verifyRes.needsFulfillmentRecovery) {
          const orderInFulfillment = await FulfillmentService.initiateFulfillment(
            verifyRes.order,
            bot,
          );
          await safeAnswerCbQuery(ctx, 'Оплата подтверждена! Заказ передан в выдачу.', true);
          await safeRespondOrEdit(
            ctx,
            formatOrderDetailMessage(orderInFulfillment),
            buildBackToMenuKeyboard(),
          );
          return;
        }

        await safeAnswerCbQuery(ctx, 'Этот заказ уже оплачен ранее.', true);
        await safeRespondOrEdit(
          ctx,
          formatOrderDetailMessage(verifyRes.order),
          buildBackToMenuKeyboard(),
        );
        return;
      }

      if (verifyRes.status === 'pending') {
        await safeAnswerCbQuery(
          ctx,
          'Оплата ещё не поступила. Завершите платёж и повторите проверку.',
          true,
        );
      } else {
        await safeAnswerCbQuery(
          ctx,
          `Статус оплаты: ${verifyRes.status} (${verifyRes.reason || 'проверьте детали'})`,
          true,
        );
      }

      if (verifyRes.order && verifyRes.payment) {
        await safeRespondOrEdit(
          ctx,
          formatOrderPaymentInvoiceMessage(verifyRes.order, verifyRes.payment),
          buildOrderPaymentInvoiceKeyboard(verifyRes.order, verifyRes.payment),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1n. Старый callback buy:<productId> — оплата через Telegram Stars (XTR) полностью отключена
  bot.action(/^buy:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await safeAnswerCbQuery(
      ctx,
      'Оплата через Telegram Stars (XTR) отключена в QuizyStars. Используйте CryptoBot, xRocket или внутренний баланс USD.',
      true,
    );
  });

  // 2. Обработка pre_checkout_query — XTR полностью отключён
  bot.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    try {
      const validation = await PaymentService.validatePreCheckout({
        invoicePayload: query.invoice_payload,
        telegramUserId: query.from.id,
        currency: query.currency,
        totalAmount: query.total_amount,
      });
      await ctx.answerPreCheckoutQuery(
        false,
        validation.errorMessage ||
          'Оплата через Telegram Stars (XTR) отключена в QuizyStars.',
      );
    } catch {
      await ctx.answerPreCheckoutQuery(
        false,
        'Оплата через Telegram Stars (XTR) отключена в QuizyStars.',
      );
    }
  });

  // 3. Обработка successful_payment — XTR отключён, заказы не активируются
  bot.on('message', async (ctx, next) => {
    const message = ctx.message as {
      successful_payment?: {
        currency: string;
        total_amount: number;
        invoice_payload: string;
        telegram_payment_charge_id: string;
      };
    };

    if (!message?.successful_payment || !ctx.from) {
      return next();
    }

    const paymentInfo = message.successful_payment;
    try {
      await OrderService.logTransaction({
        orderId: paymentInfo.invoice_payload || 'xtr_disabled',
        userId: `tg_${ctx.from.id}`,
        type: 'error',
        amount: paymentInfo.total_amount,
        currency: paymentInfo.currency || 'XTR',
        details: `Получен отклонённый XTR successful_payment (charge=${paymentInfo.telegram_payment_charge_id}): оплата через XTR отключена в QuizyStars.`,
      });
    } catch {
      // Ignore audit log errors
    }

    await ctx.reply(
      '⚠️ Оплата через Telegram Stars (XTR) отключена в QuizyStars. Пожалуйста, используйте CryptoBot, xRocket или внутренний баланс USD.',
      {
        parse_mode: 'HTML',
        ...buildBackToMenuKeyboard(),
      },
    );
  });
}
