import { Markup, Telegraf } from 'telegraf';
import { OrderService } from '../../services/OrderService.ts';
import { ProductService } from '../../services/ProductService.ts';
import { PaymentService } from '../../services/PaymentService.ts';
import { FulfillmentService } from '../../services/FulfillmentService.ts';
import { balanceService } from '../../services/BalanceService.ts';
import { isDuplicateCallbackClick, safeAnswerCbQuery } from './userHandler.ts';
import { escapeHtml, formatOrderDetailMessage } from '../formatters.ts';
import { buildBackToMenuKeyboard } from '../keyboards.ts';

export function registerPaymentHandlers(bot: Telegraf): void {
  // 1a. Покупка товара с внутреннего баланса магазина (buy_bal:<productId>)
  bot.action(/^buy_bal:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (
      !ctx.from ||
      isDuplicateCallbackClick(ctx.from.id, `buy_bal:${productId}`, 1500)
    ) {
      return;
    }

    try {
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
        `Оплачено с внутреннего баланса! Остаток: ${result.newBalance}`,
      );

      const orderInFulfillment = await FulfillmentService.initiateFulfillment(
        result.order,
        bot,
      );

      await ctx.reply(
        [
          '✅ <b>Заказ успешно оплачен с внутреннего баланса!</b>',
          `💰 <b>Остаток на внутреннем балансе:</b> <code>${result.newBalance}</code>`,
          '',
          formatOrderDetailMessage(orderInFulfillment),
          '',
          '🚚 <b>Что дальше:</b> ваш заказ передан на выдачу. Как только товар будет выдан, бот пришлёт вам уведомление в этот чат.',
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

  // 1b. Создание счёта Telegram Stars (XTR) при нажатии «Купить»
  bot.action(/^buy:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!ctx.from || isDuplicateCallbackClick(ctx.from.id, `buy:${productId}`, 1500)) {
      return;
    }

    try {
      const product = await ProductService.getProductById(productId);
      if (!product || !product.isActive) {
        await ctx.answerCbQuery('Этот товар сейчас недоступен для покупки.', {
          show_alert: true,
        });
        return;
      }

      // Цена всегда берётся строго из базы данных внутри OrderService.createOrder
      const order = await OrderService.createOrder({
        telegramUser: ctx.from,
        productId: product.id,
        quantity: 1,
      });

      await ctx.answerCbQuery('Счёт на оплату в Telegram Stars сформирован!');

      // Для Telegram Stars (XTR) provider_token обязан быть пустой строкой ""
      await ctx.replyWithInvoice({
        title: product.name.slice(0, 32),
        description: `${product.description.slice(0, 200)} (Заказ #${order.orderId.slice(-8)})`,
        payload: order.orderId,
        provider_token: '',
        currency: 'XTR',
        prices: [
          {
            label: product.name.slice(0, 32),
            amount: order.totalPrice,
          },
        ],
        ...Markup.inlineKeyboard([
          [Markup.button.pay(`⭐ Оплатить ${order.totalPrice} XTR`)],
          [Markup.button.callback('❌ Отменить заказ', `ucancel:${order.orderId}`)],
        ]),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[PaymentHandler] Ошибка создания invoice:', msg);
      await ctx.reply(
        `⚠️ <b>Не удалось создать счёт на оплату:</b>\n${escapeHtml(msg)}`,
        {
          parse_mode: 'HTML',
          ...buildBackToMenuKeyboard(),
        },
      );
    }
  });

  // 2. Обработка pre_checkout_query (ответ в пределах 10 секунд обязателен по требованиям Telegram)
  bot.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    try {
      const validation = await PaymentService.validatePreCheckout({
        invoicePayload: query.invoice_payload,
        telegramUserId: query.from.id,
        currency: query.currency,
        totalAmount: query.total_amount,
      });

      if (validation.ok) {
        await ctx.answerPreCheckoutQuery(true);
      } else {
        await ctx.answerPreCheckoutQuery(
          false,
          validation.errorMessage || 'Не удалось подтвердить заказ перед оплатой.',
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[PaymentHandler] Ошибка в pre_checkout_query:', msg);
      await ctx.answerPreCheckoutQuery(
        false,
        'Временная техническая ошибка при проверке заказа. Попробуйте снова.',
      );
    }
  });

  // 3. Обработка successful_payment — атомарная транзакция в Firestore, защита от дублей и восстановление после сбоя выдачи
  bot.on('message', async (ctx, next) => {
    const message = ctx.message as {
      successful_payment?: {
        currency: string;
        total_amount: number;
        invoice_payload: string;
        telegram_payment_charge_id: string;
        provider_payment_charge_id?: string;
      };
    };

    if (!message?.successful_payment || !ctx.from) {
      return next();
    }

    const paymentInfo = message.successful_payment;

    try {
      const result = await PaymentService.processSuccessfulPayment({
        telegramUserId: ctx.from.id,
        invoicePayload: paymentInfo.invoice_payload,
        currency: paymentInfo.currency,
        totalAmount: paymentInfo.total_amount,
        telegramPaymentChargeId: paymentInfo.telegram_payment_charge_id,
        providerPaymentChargeId: paymentInfo.provider_payment_charge_id,
      });

      if (result.alreadyProcessed) {
        // Если транзакция оплаты ранее зафиксировалась, но сбой произошёл до старта выдачи — восстанавливаем выдачу
        if (result.needsFulfillmentRecovery) {
          const recoveredOrder = await FulfillmentService.initiateFulfillment(
            result.order,
            bot,
          );
          await ctx.reply(
            [
              '✅ <b>Оплата в Telegram Stars подтверждена, заказ передан на выдачу!</b>',
              '',
              formatOrderDetailMessage(recoveredOrder),
              '',
              '🚚 <b>Что дальше:</b> ваш заказ передан на выдачу. Как только товар будет выдан, бот пришлёт вам уведомление в этот чат.',
            ].join('\n'),
            {
              parse_mode: 'HTML',
              ...buildBackToMenuKeyboard(),
            },
          );
          return;
        }

        await ctx.reply(
          [
            'ℹ️ <b>Этот платёж уже был успешно зарегистрирован ранее.</b>',
            '',
            formatOrderDetailMessage(result.order),
          ].join('\n'),
          {
            parse_mode: 'HTML',
            ...buildBackToMenuKeyboard(),
          },
        );
        return;
      }

      // Инициируем выдачу через FulfillmentService строго ПОСЛЕ успешной фиксации транзакции оплаты
      const orderInFulfillment = await FulfillmentService.initiateFulfillment(
        result.order,
        bot,
      );

      await ctx.reply(
        [
          '✅ <b>Оплата в Telegram Stars успешно получена!</b>',
          '',
          formatOrderDetailMessage(orderInFulfillment),
          '',
          '🚚 <b>Что дальше:</b> ваш заказ передан на выдачу. Как только товар будет выдан, бот пришлёт вам уведомление в этот чат.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          ...buildBackToMenuKeyboard(),
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[PaymentHandler] Ошибка обработки successful_payment:', msg);

      try {
        await OrderService.logTransaction({
          orderId: paymentInfo.invoice_payload || 'unknown_order',
          userId: `tg_${ctx.from.id}`,
          type: 'error',
          amount: paymentInfo.total_amount,
          details: `Ошибка обработки платежа ${paymentInfo.telegram_payment_charge_id}: ${msg}`,
        });
      } catch (logErr) {
        console.error(
          '[PaymentHandler] Не удалось записать лог ошибки транзакции:',
          logErr instanceof Error ? logErr.message : String(logErr),
        );
      }

      await ctx.reply(
        [
          '⚠️ <b>Платёж получен, но возникла задержка при обновлении заказа.</b>',
          `🔐 Сохраните ID платежа: <code>${escapeHtml(
            paymentInfo.telegram_payment_charge_id,
          )}</code>`,
          'Обратитесь в /paysupport — администратор проверит платёж вручную.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          ...buildBackToMenuKeyboard(),
        },
      );
    }
  });
}
