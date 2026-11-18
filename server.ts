import express, { Request, Response } from 'express';
import { getEnvConfig } from './src/config/env.ts';
import { firestoreRepo } from './src/db/firestore.ts';
import { botManager, maskSecretsInText } from './src/bot/bot.ts';
import { FulfillmentService } from './src/services/FulfillmentService.ts';
import { balanceService } from './src/services/BalanceService.ts';
import {
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
        latest.lolzteamApiToken,
        latest.lolzteamWebhookSecret,
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
        latest.lolzteamApiToken,
        latest.lolzteamWebhookSecret,
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
          latest.lolzteamApiToken,
          latest.lolzteamWebhookSecret,
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

  // 4b. Payment Provider Webhook endpoints (CryptoBot, Lolzteam, xRocket)
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
          botInstance.telegram
            .sendMessage(
              topUp.userTelegramId,
              [
                '✅ <b>Баланс успешно пополнен!</b>',
                '━━━━━━━━━━━━━━━━━━━━',
                `🆔 ID пополнения: <code>${topUp.paymentId}</code>`,
                `🏦 Провайдер: <b>${providerTitle}</b>`,
                `💵 Сумма оплаты: <b>${topUp.amountPaid} ${topUp.currency}</b>`,
                `📉 Комиссия (${topUp.feePercent}%): <b>−${topUp.feeAmount} ${topUp.currency}</b>`,
                `💰 Зачислено на баланс: <b>+${topUp.amountCredited} ⭐</b>`,
                result.newBalance !== undefined
                  ? `💳 Текущий баланс: <b>${result.newBalance} ⭐</b>`
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
          latest.lolzteamApiToken,
          latest.lolzteamWebhookSecret,
          latest.xrocketApiKey,
        ]),
      );
      res.status(500).json({ ok: false });
    }
  };

  app.post('/webhook/cryptobot', async (req: RawBodyRequest, res: Response) => {
    await handleProviderWebhook('cryptobot', req, res);
  });

  app.post('/webhook/lolzteam', async (req: RawBodyRequest, res: Response) => {
    await handleProviderWebhook('lolzteam', req, res);
  });

  app.post('/webhook/xrocket', async (req: RawBodyRequest, res: Response) => {
    await handleProviderWebhook('xrocket', req, res);
  });

  // 5. Healthcheck endpoint for Cloud Run & status verification (NOT a web store or Mini App)
  app.get('/health', (_req, res) => {
    const botStatus = botManager.getStatus();
    const dbStatus = firestoreRepo.getStatus();
    const fulfillment = FulfillmentService.getAdapterInfo();
    const providerDiag = paymentProviderGateway.getProviderStatusSummary();

    const httpStatus = dbStatus.degradedMode ? 503 : 200;
    res.status(httpStatus).json({
      service: 'telegram-digital-store-bot',
      interfaceType: 'telegram-bot-only (no web storefront, no mini app)',
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
        lolzteam: {
          configured: providerDiag.lolzteam.configured,
          feePercent: providerDiag.lolzteam.feePercent,
        },
        xrocket: {
          configured: providerDiag.xrocket.configured,
          feePercent: providerDiag.xrocket.feePercent,
        },
      },
      timestamp: new Date().toISOString(),
    });
  });

  // 6. Minimal plain-text status on root path so Cloud Run / container check succeeds
  app.get('/', (_req, res) => {
    const botStatus = botManager.getStatus();
    const dbStatus = firestoreRepo.getStatus();

    res.status(200).type('text/plain; charset=utf-8').send(
      [
        '=== TELEGRAM DIGITAL STORE BOT (SERVER PROCESS) ===',
        'Интерфейс магазина работает исключительно внутри Telegram-бота (без веб-магазина и без Mini Apps).',
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
        `Статус хранилища: ${dbStatus.degradedMode ? 'АВАРИЙНЫЙ РЕЖИМ (НЕДОСТУПНО)' : ' АКТИВНО'}`,
        `Проверка здоровья (JSON): /health`,
        `Webhook endpoints: POST /webhook/telegram, /webhook/cryptobot, /webhook/lolzteam, /webhook/xrocket`,
      ].join('\n'),
    );
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
