import fs from 'node:fs';
import path from 'node:path';
import express, { Express, Request, Response } from 'express';
import { formatUsd, getEnvConfig } from './src/config/env.ts';
import { firestoreRepo } from './src/db/firestore.ts';
import { botManager, maskSecretsInText } from './src/bot/bot.ts';
import { oe } from './src/bot/outlineEmoji.ts';
import { formatUsdCents } from './src/services/Money.ts';
import { FulfillmentService } from './src/services/FulfillmentService.ts';
import {
  BalanceService,
  balanceService as defaultBalanceService,
  calculateTopUpCommissionCents,
  validateTopUpAmountUsdCents,
} from './src/services/BalanceService.ts';
import { PaymentService } from './src/services/PaymentService.ts';
import {
  ExchangeRateUnavailableError,
  PAYMENT_PROVIDER_CATALOG,
  PaymentProviderGateway,
  paymentProviderGateway as defaultGateway,
} from './src/services/PaymentProviders.ts';
import { BalanceTopUpProvider } from './src/types.ts';

export interface RawBodyRequest extends Request {
  rawBody?: string;
}

export interface ServerDependencies {
  balanceSvc?: BalanceService;
  paymentSvc?: PaymentService;
  gateway?: PaymentProviderGateway;
}

let isShuttingDown = false;

export async function handleProviderWebhookRequest(
  provider: BalanceTopUpProvider,
  req: RawBodyRequest,
  res: Response,
  deps?: ServerDependencies,
): Promise<void> {
  const activeBalanceService = deps?.balanceSvc ?? defaultBalanceService;
  const rawBody =
    typeof req.rawBody === 'string'
      ? req.rawBody
      : JSON.stringify(req.body ?? {});
  const headers = req.headers as Record<string, string | string[] | undefined>;

  try {
    const result = await activeBalanceService.processWebhook({
      provider,
      rawBody,
      headers,
      parsedBody: req.body,
    });

    if (!result.ok && result.reason === 'INVALID_WEBHOOK_SIGNATURE') {
      res.status(401).json({
        ok: false,
        error: 'Unauthorized: invalid webhook signature',
      });
      return;
    }

    // If not a balance top-up invoice, route to direct Order payment processing
    if (!result.ok && result.reason === 'TOPUP_NOT_FOUND') {
      const orderResult = deps?.paymentSvc
        ? await deps.paymentSvc.processOrderWebhook({
            provider,
            rawBody,
            headers,
            parsedBody: req.body,
          })
        : await PaymentService.processOrderWebhook({
            provider,
            rawBody,
            headers,
            parsedBody: req.body,
          });

      if (!orderResult.ok && orderResult.reason === 'INVALID_WEBHOOK_SIGNATURE') {
        res.status(401).json({
          ok: false,
          error: 'Unauthorized: invalid webhook signature',
        });
        return;
      }

      if (
        orderResult.ok &&
        (orderResult.status === 'paid' || orderResult.status === 'overpaid') &&
        orderResult.order
      ) {
        const botInstance = botManager.getBotInstance();
        if (!orderResult.duplicate || orderResult.needsFulfillmentRecovery) {
          FulfillmentService.initiateFulfillment(orderResult.order, botInstance).catch(
            () => {
              // Recovery worker retries if transport/fulfillment fails temporarily
            },
          );
        }
        if (!orderResult.duplicate && botInstance) {
          const order = orderResult.order;
          const providerTitle = PAYMENT_PROVIDER_CATALOG[provider].shortTitle;
          const orderCents = order.totalPriceUsdCents ?? order.totalPrice;
          botInstance.telegram
            .sendMessage(
              order.userTelegramId,
              [
                `${oe('check')} <b>Заказ #${order.orderId} оплачен!</b>`,
                '',
                `${oe('catalog')} Товар: <b>${order.productName}</b> (x${order.quantity})`,
                order.recipientUsername
                  ? `${oe('profile')} Получатель: <b>@${order.recipientUsername}</b>`
                  : '',
                `${oe('provider')} Провайдер: <b>${providerTitle}</b>`,
                `${oe('amount')} Сумма: <code>${formatUsdCents(orderCents)}</code>`,
                '',
                `${oe('rocket')} Заказ передан на выдачу.`,
              ]
                .filter(Boolean)
                .join('\n'),
              { parse_mode: 'HTML' },
            )
            .catch(() => {
              // Ignore Telegram notification failures
            });
        }
      }

      res.status(200).json({
        ok: orderResult.ok,
        kind: 'order',
        status: orderResult.status,
        duplicate: orderResult.duplicate,
        reason: orderResult.reason,
      });
      return;
    }

    // Notify buyer in Telegram if balance was newly credited via webhook
    if (
      result.ok &&
      !result.duplicate &&
      (result.status === 'paid' || result.status === 'overpaid') &&
      result.topUp
    ) {
      const botInstance = botManager.getBotInstance();
      if (botInstance) {
        const topUp = result.topUp;
        const providerTitle = PAYMENT_PROVIDER_CATALOG[topUp.provider].shortTitle;
        const grossCents =
          typeof topUp.amountUsdCents === 'number'
            ? topUp.amountUsdCents
            : Math.round((topUp.amountUsd ?? topUp.amountPaid) * 100);
        const feeCents =
          typeof topUp.feeUsdCents === 'number'
            ? topUp.feeUsdCents
            : Math.round(topUp.feeAmount * 100);
        const creditedCents =
          typeof topUp.amountCreditedUsdCents === 'number'
            ? topUp.amountCreditedUsdCents
            : Math.round(topUp.amountCredited * 100);
        const isConverted = topUp.currency !== 'USD';

        botInstance.telegram
          .sendMessage(
            topUp.userTelegramId,
            [
              `${oe('check')} <b>Баланс QuizyStars пополнен!</b>`,
              '',
              `${oe('id')} Счёт: <code>${topUp.paymentId}</code>`,
              `${oe('provider')} Провайдер: <b>${providerTitle}</b>`,
              `${oe('usd')} Внесено: <code>${formatUsdCents(grossCents)}</code>`,
              isConverted
                ? `${oe('coin')} Счёт оплачен: <code>${topUp.expectedAmountStr || topUp.amountPaid} ${topUp.currency}</code>`
                : '',
              `${oe('percent')} Комиссия (${topUp.feePercent}%): <code>−${formatUsdCents(feeCents)}</code>`,
              `${oe('money')} Зачислено: <b><code>+${formatUsdCents(creditedCents)}</code></b>`,
              result.newBalance !== undefined
                ? `${oe('wallet')} Баланс: <code>${formatUsd(result.newBalance)}</code>`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
            { parse_mode: 'HTML' },
          )
          .catch(() => {
            // Ignore notification transport error; credit is already committed
          });
      }
    }

    res.status(200).json({
      ok: result.ok,
      kind: 'topup',
      status: result.status,
      duplicate: result.duplicate,
      reason: result.reason,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const latest = getEnvConfig();
    console.error(
      `[Webhook:${provider}] Ошибка обработки webhook:`,
      maskSecretsInText(raw, [
        latest.cryptobotApiToken,
        latest.xrocketApiKey,
        latest.mystarsApiKey,
      ]),
    );
    res.status(500).json({ ok: false });
  }
}

export async function handleTopUpCalculateRequest(
  req: Request,
  res: Response,
  deps?: ServerDependencies,
): Promise<void> {
  const gateway = deps?.gateway ?? defaultGateway;
  try {
    const rawProvider = String(req.body?.provider || 'cryptobot').toLowerCase();
    const provider: BalanceTopUpProvider =
      rawProvider === 'xrocket' ? 'xrocket' : 'cryptobot';
    const meta = PAYMENT_PROVIDER_CATALOG[provider];
    const requestedCurrency = String(
      req.body?.currency || meta.defaultCurrency,
    ).toUpperCase();
    const requestedNetwork =
      typeof req.body?.network === 'string' ? req.body.network : undefined;

    const amountUsdCents = validateTopUpAmountUsdCents(req.body?.amountUsd);
    const calc = calculateTopUpCommissionCents(amountUsdCents, provider);

    const validatedCurr = await gateway.validateCurrencyAndNetwork(
      provider,
      requestedCurrency,
      requestedNetwork,
    );
    const conversion = await gateway.getLiveUsdConversion({
      provider,
      amountUsdCents: calc.amountUsdCents,
      targetCurrency: validatedCurr.currency,
      network: validatedCurr.network,
    });

    res.status(200).json({
      ok: true,
      provider,
      providerTitle: meta.shortTitle,
      currency: conversion.targetCurrency,
      ...(conversion.network ? { network: conversion.network } : {}),
      amountUsdCents: calc.amountUsdCents,
      amountUsd: calc.amountPaid,
      amountUsdFormatted: formatUsdCents(calc.amountUsdCents),
      feeBps: calc.feeBps,
      feePercent: calc.feePercent,
      feeUsdCents: calc.feeUsdCents,
      feeAmount: calc.feeAmount,
      feeAmountFormatted: formatUsdCents(calc.feeUsdCents),
      amountCreditedUsdCents: calc.amountCreditedUsdCents,
      amountCredited: calc.amountCredited,
      amountCreditedFormatted: formatUsdCents(calc.amountCreditedUsdCents),
      amountToPayInCurrencyStr: conversion.convertedAmountStr,
      amountToPayInCurrency: conversion.convertedAmount,
      exchangeRateUsdStr: conversion.exchangeRateUsdStr,
      exchangeRateUsd: Number(conversion.exchangeRateUsdStr),
      requiresConversionNotice: conversion.requiresConversionNotice,
    });
  } catch (error) {
    if (error instanceof ExchangeRateUnavailableError) {
      res.status(503).json({
        ok: false,
        code: error.code,
        error: error.message,
      });
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      ok: false,
      error: msg,
    });
  }
}

export function renderPlainTextStatus(): string {
  const botStatus = botManager.getStatus();
  const dbStatus = firestoreRepo.getStatus();
  const config = getEnvConfig();
  return [
    '=== QUIZYSTARS STORE SERVER ===',
    'QuizyStars — Магазин Telegram Stars, Telegram Premium и Gifts. Оплата: CryptoBot (3%), xRocket (2%), внутренний баланс (USD). XTR checkout отключён.',
    '',
    `Статус Telegram Bot API: ${
      botStatus.connected
        ? `ПОДКЛЮЧЁН (@${botStatus.botUsername} — ${botStatus.botFirstName})`
        : `ОЖИДАНИЕ ТОКЕНА (${botStatus.error || 'TELEGRAM_BOT_TOKEN не задан'})`
    }`,
    `Режим работы бота: ${botStatus.mode} (Polling активен: ${
      botStatus.pollingActive ? 'Да' : 'Нет'
    })`,
    `База данных Firestore: проект ${dbStatus.projectId} (${dbStatus.databaseId})`,
    `Статус хранилища: ${dbStatus.degradedMode ? 'АВАРИЙНЫЙ РЕЖИМ (НЕДОСТУПНО)' : 'АКТИВНО'}`,
    `Валюта расчётов MyStars: ${config.mystarsPaymentCurrency}`,
    `Проверка здоровья (JSON): /health`,
    `Расчёт пополнения (JSON): POST /api/topup/calculate`,
    `Webhook endpoints: POST /webhook/telegram, /webhook/cryptobot, /webhook/xrocket`,
  ].join('\n');
}

export function createApp(deps?: ServerDependencies): Express {
  const app = express();

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString('utf8');
      },
    }),
  );

  // Telegram Webhook endpoint
  app.post('/webhook/telegram', async (req, res) => {
    await botManager.handleWebhookRequest(req, res);
  });

  // Payment Provider Webhook endpoints (CryptoBot, xRocket)
  app.post('/webhook/cryptobot', async (req: RawBodyRequest, res: Response) => {
    await handleProviderWebhookRequest('cryptobot', req, res, deps);
  });

  app.post('/webhook/xrocket', async (req: RawBodyRequest, res: Response) => {
    await handleProviderWebhookRequest('xrocket', req, res, deps);
  });

  // Live server-side validation, fee, and live exchange rate calculation endpoint
  app.post('/api/topup/calculate', async (req: Request, res: Response) => {
    await handleTopUpCalculateRequest(req, res, deps);
  });

  // Healthcheck endpoint for Cloud Run & status verification
  app.get('/health', (_req, res) => {
    const config = getEnvConfig();
    const botStatus = botManager.getStatus();
    const dbStatus = firestoreRepo.getStatus();
    const fulfillment = FulfillmentService.getAdapterInfo();
    const gateway = deps?.gateway ?? defaultGateway;
    const providerDiag = gateway.getProviderStatusSummary();

    const httpStatus = dbStatus.degradedMode ? 503 : 200;
    res.status(httpStatus).json({
      service: 'quizystars-store-bot',
      storeName: config.storeName,
      interfaceType: 'telegram-bot-and-usd-topup-preview',
      xtrCheckoutEnabled: false,
      mystarsPaymentCurrency: config.mystarsPaymentCurrency,
      bot: botStatus,
      database: dbStatus,
      fulfillment: {
        ...fulfillment,
        recoveryWorkerActive: FulfillmentService.isRecoveryWorkerActive(),
      },
      paymentProviders: {
        cryptobot: {
          configured: providerDiag.cryptobot.configured,
          feePercent: providerDiag.cryptobot.feePercent,
        },
        xrocket: {
          configured: providerDiag.xrocket.configured,
          feePercent: providerDiag.xrocket.feePercent,
        },
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/status', (_req, res) => {
    res.status(200).type('text/plain; charset=utf-8').send(renderPlainTextStatus());
  });

  app.get('/', (req, res) => {
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) {
      const htmlPath = path.resolve(process.cwd(), 'index.html');
      if (fs.existsSync(htmlPath)) {
        res.status(200).type('text/html; charset=utf-8').send(fs.readFileSync(htmlPath, 'utf-8'));
        return;
      }
    }
    res.status(200).type('text/plain; charset=utf-8').send(renderPlainTextStatus());
  });

  return app;
}

async function bootstrap(): Promise<void> {
  const config = getEnvConfig();
  const app = createApp();

  process.on('unhandledRejection', (reason) => {
    const raw = reason instanceof Error ? reason.stack || reason.message : String(reason);
    const latest = getEnvConfig();
    console.error(
      '[Process] Unhandled Rejection:',
      maskSecretsInText(raw, [
        latest.telegramBotToken,
        latest.webhookSecret,
        latest.firebasePrivateKey,
        latest.cryptobotApiToken,
        latest.xrocketApiKey,
        latest.mystarsApiKey,
      ]),
    );
  });

  process.on('uncaughtException', (error) => {
    const raw = error instanceof Error ? error.stack || error.message : String(error);
    const latest = getEnvConfig();
    console.error(
      '[Process] Uncaught Exception:',
      maskSecretsInText(raw, [
        latest.telegramBotToken,
        latest.webhookSecret,
        latest.firebasePrivateKey,
        latest.cryptobotApiToken,
        latest.xrocketApiKey,
        latest.mystarsApiKey,
      ]),
    );
  });

  await firestoreRepo.init();
  await botManager.start();
  FulfillmentService.startRecoveryWorker(() => botManager.getBotInstance(), 30_000);

  const watcherInterval = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      const currentStatus = botManager.getStatus();
      const latestConfig = getEnvConfig();
      if (!currentStatus.connected && latestConfig.telegramBotToken) {
        await botManager.start();
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const latest = getEnvConfig();
      console.error(
        '[Server] Ошибка фоновой проверки бота:',
        maskSecretsInText(raw, [
          latest.telegramBotToken,
          latest.webhookSecret,
          latest.cryptobotApiToken,
          latest.xrocketApiKey,
          latest.mystarsApiKey,
        ]),
      );
    }
  }, 5000);
  watcherInterval.unref?.();

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[Server] QuizyStars server running on 0.0.0.0:${config.port} (Cloud Run ready).`,
    );
  });

  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Получен сигнал ${signal}. Корректная остановка...`);
    clearInterval(watcherInterval);
    FulfillmentService.stopRecoveryWorker();
    botManager.stop(signal);

    const forceExitTimer = setTimeout(() => {
      process.exit(0);
    }, 5000);
    forceExitTimer.unref?.();

    server.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch((error) => {
    console.error('[Server] Критическая ошибка запуска:', error);
    process.exit(1);
  });
}
