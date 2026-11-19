import { Markup, Telegraf } from 'telegraf';
import { firestoreRepo } from '../../db/firestore.ts';
import { OrderService } from '../../services/OrderService.ts';
import { ProductService } from '../../services/ProductService.ts';
import { PaymentService } from '../../services/PaymentService.ts';
import { FulfillmentService } from '../../services/FulfillmentService.ts';
import { balanceService } from '../../services/BalanceService.ts';
import { formatUsd } from '../../config/env.ts';
import { oe } from '../outlineEmoji.ts';
import {
  clearUserCheckoutSession,
  fetchLiveCurrencyPreviews,
  isDuplicateCallbackClick,
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
  formatPromptCustomQuantityMessage,
  formatPromptRecipientUsernameMessage,
} from '../formatters.ts';
import {
  buildBackToMenuKeyboard,
  buildOrderCryptoCurrencyKeyboard,
  buildOrderPaymentInvoiceKeyboard,
  buildPromptRecipientKeyboard,
} from '../keyboards.ts';
import { BalanceTopUpProvider, PaymentRecord } from '../../types.ts';

export function registerPaymentHandlers(bot: Telegraf): void {
  // 1a. Быстрая покупка с внутреннего баланса магазина (buy_bal:<productId>)
  bot.action(/^buy_bal:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (
      !ctx.from ||
      isDuplicateCallbackClick(ctx.from.id, `buy_bal:${productId}`, 1500)
    ) {
      return;
    }

    try {
      clearUserCheckoutSession(ctx.from.id);
      const result = await balanceService.purchaseWithInternalBalance({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        productId,
        quantity: 1,
      });

      if (result.duplicate) {
        await safeAnswerCbQuery(ctx, 'Этот заказ уже был оплачен с баланса.', true);
        return;
      }

      await safeAnswerCbQuery(
        ctx,
        `Оплачено с внутреннего баланса! Остаток: ${formatUsd(result.newBalance)}`,
      );

      const orderInFulfillment = await FulfillmentService.initiateFulfillment(
        result.order,
        bot,
      );

      await ctx.reply(
        [
          `${oe('check')} <b>Заказ успешно оплачен с внутреннего баланса QuizyStars!</b>`,
          `${oe('money')} <b>Остаток на балансе:</b> <code>${formatUsd(result.newBalance)}</code>`,
          '',
          formatOrderDetailMessage(orderInFulfillment),
          '',
          `${oe('rocket')} Заказ передан на выдачу. Уведомление придёт в этот чат.`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          ...buildBackToMenuKeyboard(),
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1b. Начало покупки Stars (свободное количество): запрос количества (buy_custom:<productId>)
  bot.action(/^buy_custom:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `buy_custom:${productId}`)) {
      return;
    }

    const product = await ProductService.getProductById(productId);
    if (!product || !product.isActive) {
      await safeAnswerCbQuery(ctx, 'Этот товар сейчас недоступен.', true);
      return;
    }

    setUserCheckoutSession(ctx.from.id, {
      mode: 'custom_qty',
      productId: product.id,
      createdAt: Date.now(),
    });

    await safeRespondOrEdit(
      ctx,
      formatPromptCustomQuantityMessage(product),
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', `prod:${product.id}`)],
      ]),
    );
  });

  // 1c. Начало оформления заказа (buy_start:<productId>)
  bot.action(/^buy_start:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `buy_start:${productId}`, 1200)) {
      return;
    }

    try {
      const product = await ProductService.getProductById(productId);
      if (!product || !product.isActive) {
        await safeAnswerCbQuery(ctx, 'Этот товар сейчас недоступен.', true);
        return;
      }

      if (product.category === 'stars' || product.category === 'premium') {
        const calc = ProductService.calculateOrderPriceUsdCents(product, 1);
        setUserCheckoutSession(ctx.from.id, {
          mode: 'recipient_username',
          productId: product.id,
          quantity: calc.quantity,
          createdAt: Date.now(),
        });
        await safeRespondOrEdit(
          ctx,
          formatPromptRecipientUsernameMessage({
            productName: product.name,
            quantity: calc.quantity,
            totalPriceUsdCents: calc.totalPriceUsdCents,
          }),
          buildPromptRecipientKeyboard(product.id, ctx.from.username),
        );
        return;
      }

      clearUserCheckoutSession(ctx.from.id);
      const order = await OrderService.createOrder({
        telegramUser: ctx.from,
        productId: product.id,
        quantity: 1,
      });
      await renderOrderCheckoutChooser(ctx, order);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1d. Быстрый выбор себя как получателя (rcpt_self:<productId>)
  bot.action(/^rcpt_self:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `rcpt_self:${productId}`, 1200)) {
      return;
    }
    if (!ctx.from.username) {
      await safeAnswerCbQuery(
        ctx,
        'У вашего Telegram-профиля не установлен @username. Отправьте @username получателя текстом.',
        true,
      );
      return;
    }

    try {
      const prevSession = ctx.from.id;
      void prevSession;
      const product = await ProductService.getProductById(productId);
      if (!product || !product.isActive) {
        await safeAnswerCbQuery(ctx, 'Этот товар сейчас недоступен.', true);
        return;
      }

      const { getUserCheckoutSession } = await import('./userHandler.ts');
      const session = getUserCheckoutSession(ctx.from.id);
      const qty =
        session && session.productId === productId && session.quantity
          ? session.quantity
          : 1;

      const order = await OrderService.createOrder({
        telegramUser: ctx.from,
        productId: product.id,
        quantity: qty,
        recipientUsername: ctx.from.username,
      });
      clearUserCheckoutSession(ctx.from.id);
      await renderOrderCheckoutChooser(ctx, order);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await safeAnswerCbQuery(ctx, msg.slice(0, 180), true);
    }
  });

  // 1e. Экран выбора способа оплаты заказа (ordpay_menu:<orderId>)
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
    if (order.paymentStatus !== 'pending') {
      await safeAnswerCbQuery(ctx, 'Заказ уже оплачен или отменён.', true);
      return;
    }
    await renderOrderCheckoutChooser(ctx, order);
  });

  // 1f. Оплата существующего заказа с внутреннего баланса USD (pay_bal:<orderId>)
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

      const result = await balanceService.purchaseWithInternalBalance({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        productId: order.productId,
        quantity: order.quantity,
        orderId: order.orderId,
        recipientUsername: order.recipientUsername,
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

  // 1g. Выбор валюты и живой курс для оплаты заказа через CryptoBot / xRocket (pay_ord_prov:<provider>:<orderId>)
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
      if (order.paymentStatus !== 'pending') {
        await safeAnswerCbQuery(ctx, 'Этот заказ уже не ожидает оплаты.', true);
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

  // 1h. Создание / переиспользование счёта CryptoBot или xRocket на оплату заказа
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

  // 1i. Проверка оплаты заказа по кнопке (chk_ordpay:<paymentId>)
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

  // 1j. Старый callback buy:<productId> — оплата через Telegram Stars (XTR) полностью отключена
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
