import fs from 'node:fs';
import path from 'node:path';
import express, { Request, Response } from 'express';
import { formatUsd, getEnvConfig } from './src/config/env.ts';
import { firestoreRepo } from './src/db/firestore.ts';
import { botManager, maskSecretsInText } from './src/bot/bot.ts';
import { oe } from './src/bot/outlineEmoji.ts';
import { FulfillmentService } from './src/services/FulfillmentService.ts';
import {
  balanceService,
  calculateTopUpCommission,
  validateTopUpAmountUsd,
} from './src/services/BalanceService.ts';
import {
  convertUsdToPaymentCurrency,
  paymentProviderGateway,
  PAYMENT_PROVIDER_CATALOG,
} from './src/services/PaymentProviders.ts';
import { BalanceTopUpProvider } from './src/types.ts';

interface RawBodyRequest extends Request {
  rawBody?: string;
}

let isShuttingDown = false;

async function bootstrap(): Promise<void> {
  const config = getEnvConfig();
  const app = express();

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString('utf8');
      },
    }),
  );

  // Process-level unhandled rejection / exception protection without leaking secrets
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
      ]),
    );
  });

  // 1. Initialize Firestore database and seed initial products/settings
  await firestoreRepo.init();

  // 2. Start Telegram Bot (verifies token via getMe and starts polling or webhook)
  await botManager.start();

  // 3. Automatically start singleton recovery worker for pending/interrupted fulfillments
  FulfillmentService.startRecoveryWorker(() => botManager.getBotInstance(), 30_000);

  // Periodically check if TELEGRAM_BOT_TOKEN was added/updated in environment
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
        ]),
      );
    }
  }, 5000);
  watcherInterval.unref?.();

  // 4. Telegram Webhook endpoint for Cloud Run production deployment
  app.post('/webhook/telegram', async (req, res) => {
    await botManager.handleWebhookRequest(req, res);
  });

  // 4b. Payment Provider Webhook endpoints (CryptoBot, xRocket)
  const handleProviderWebhook = async (
    provider: BalanceTopUpProvider,
    req: RawBodyRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const rawBody =
        typeof req.rawBody === 'string'
          ? req.rawBody
          : JSON.stringify(req.body ?? {});

      const result = await balanceService.processWebhook({
        provider,
        rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
        parsedBody: req.body,
      });

      if (!result.ok && result.reason === 'INVALID_WEBHOOK_SIGNATURE') {
        res.status(401).json({
          ok: false,
          error: 'Unauthorized: invalid webhook signature',
        });
        return;
      }

      // Notify user in Telegram if balance was newly credited via webhook
      if (result.ok && !result.duplicate && result.status === 'paid' && result.topUp) {
        const botInstance = botManager.getBotInstance();
        if (botInstance) {
          const topUp = result.topUp;
          const providerTitle = PAYMENT_PROVIDER_CATALOG[topUp.provider].title;
          const usdVal = topUp.amountUsd ?? topUp.amountPaid;
          const isConverted =
            topUp.currency !== 'USD' &&
            topUp.currency !== 'USDT' &&
            topUp.currency !== 'USDC';
          botInstance.telegram
            .sendMessage(
              topUp.userTelegramId,
              [
                `${oe('check')} <b>Баланс успешно пополнен!</b>`,
                '━━━━━━━━━━━━━━━━━━━━',
                `${oe('id')} ID пополнения: <code>${topUp.paymentId}</code>`,
                `${oe('provider')} Провайдер: <b>${providerTitle}</b>`,
                `${oe('usd')} Введённая сумма: <b>${formatUsd(usdVal)}</b>`,
                isConverted
                  ? `${oe('coin')} Валюта оплаты: <b>${topUp.amountPaid} ${topUp.currency}</b>`
                  : '',
                `${oe('percent')} Комиссия (${topUp.feePercent}%): <b>−${formatUsd(topUp.feeAmount)}</b>`,
                `${oe('money')} Зачислено на баланс: <b>+${formatUsd(topUp.amountCredited)}</b>`,
                result.newBalance !== undefined
                  ? `${oe('wallet')} Текущий баланс: <b>${formatUsd(result.newBalance)}</b>`
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
              { parse_mode: 'HTML' },
            )
            .catch(() => {
              // Ignore notification transport error; credit is already committed in DB
            });
        }
      }

      res.status(200).json({
        ok: result.ok,
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
        ]),
      );
      res.status(500).json({ ok: false });
    }
  };

  app.post('/webhook/cryptobot', async (req: RawBodyRequest, res: Response) => {
    await handleProviderWebhook('cryptobot', req, res);
  });

  app.post('/webhook/xrocket', async (req: RawBodyRequest, res: Response) => {
    await handleProviderWebhook('xrocket', req, res);
  });

  // 4c. Server-side validation & commission calculation endpoint for the USD Top-Up screen
  app.post('/api/topup/calculate', (req: Request, res: Response) => {
    try {
      const rawProvider = String(req.body?.provider || 'cryptobot').toLowerCase();
      const provider: BalanceTopUpProvider =
        rawProvider === 'xrocket' ? 'xrocket' : 'cryptobot';
      const meta = PAYMENT_PROVIDER_CATALOG[provider];
      const rawCurrency = String(
        req.body?.currency || meta.defaultCurrency,
      ).toUpperCase();
      const currency = meta.supportedCurrencies.includes(rawCurrency)
        ? rawCurrency
        : meta.defaultCurrency;

      const amountUsd = validateTopUpAmountUsd(req.body?.amountUsd);
      const calc = calculateTopUpCommission(amountUsd, provider);
      const conversion = convertUsdToPaymentCurrency(amountUsd, currency);

      res.status(200).json({
        ok: true,
        provider,
        providerTitle: meta.shortTitle,
        currency,
        amountUsd,
        amountUsdFormatted: formatUsd(amountUsd),
        feePercent: calc.feePercent,
        feeAmount: calc.feeAmount,
        feeAmountFormatted: formatUsd(calc.feeAmount),
        amountCredited: calc.amountCredited,
        amountCreditedFormatted: formatUsd(calc.amountCredited),
        amountToPayInCurrency: conversion.convertedAmount,
        exchangeRateUsd: conversion.exchangeRateUsd,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        ok: false,
        error: msg,
      });
    }
  });

  // 5. Healthcheck endpoint for Cloud Run & status verification
  app.get('/health', (_req, res) => {
    const botStatus = botManager.getStatus();
    const dbStatus = firestoreRepo.getStatus();
    const fulfillment = FulfillmentService.getAdapterInfo();
    const providerDiag = paymentProviderGateway.getProviderStatusSummary();

    const httpStatus = dbStatus.degradedMode ? 503 : 200;
    res.status(httpStatus).json({
      service: 'telegram-digital-store-bot',
      interfaceType: 'telegram-bot-and-usd-topup-preview',
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

  const renderPlainTextStatus = (): string => {
    const botStatus = botManager.getStatus();
    const dbStatus = firestoreRepo.getStatus();
    return [
      '=== TELEGRAM DIGITAL STORE BOT (SERVER PROCESS) ===',
      'Stars Shop — Пополнение внутреннего баланса в USD ($0.50 – $50,000.00) через CryptoBot (3%) и xRocket (2%).',
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
      `Проверка здоровья (JSON): /health`,
      `Расчёт пополнения (JSON): POST /api/topup/calculate`,
      `Webhook endpoints: POST /webhook/telegram, /webhook/cryptobot, /webhook/xrocket`,
    ].join('\n');
  };

  app.get('/status', (_req, res) => {
    res.status(200).type('text/plain; charset=utf-8').send(renderPlainTextStatus());
  });

  // 6. Serve interactive USD Top-Up screen for browser preview or plain-text status for CLI healthchecks
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

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[Server] Серверный процесс запущен на 0.0.0.0:${config.port} (Cloud Run ready).`,
    );
  });

  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Получен сигнал ${signal}. Корректная остановка фоновых задач, бота и сервера...`);
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

bootstrap().catch((error) => {
  console.error('[Server] Критическая ошибка запуска:', error);
  process.exit(1);
});
