import express from 'express';
import { getEnvConfig } from './src/config/env.ts';
import { firestoreRepo } from './src/db/firestore.ts';
import { botManager } from './src/bot/bot.ts';
import { FulfillmentService } from './src/services/FulfillmentService.ts';

async function bootstrap(): Promise<void> {
  const config = getEnvConfig();
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // 1. Initialize Firestore database and seed initial products/settings
  await firestoreRepo.init();

  // 2. Start Telegram Bot (verifies token via getMe and starts polling or webhook)
  await botManager.start();

  // Periodically check if TELEGRAM_BOT_TOKEN was added/updated in environment
  const watcherInterval = setInterval(async () => {
    const currentStatus = botManager.getStatus();
    const latestConfig = getEnvConfig();
    if (!currentStatus.connected && latestConfig.telegramBotToken) {
      await botManager.start();
    }
  }, 5000);

  // 3. Telegram Webhook endpoint for Cloud Run production deployment
  app.post('/webhook/telegram', async (req, res) => {
    await botManager.handleWebhookRequest(req, res);
  });

  // 4. Healthcheck endpoint for Cloud Run & status verification (NOT a web store or Mini App)
  app.get('/health', (_req, res) => {
    const botStatus = botManager.getStatus();
    const dbStatus = firestoreRepo.getStatus();
    const fulfillment = FulfillmentService.getAdapterInfo();

    res.status(200).json({
      service: 'telegram-digital-store-bot',
      interfaceType: 'telegram-bot-only (no web storefront, no mini app)',
      bot: botStatus,
      database: dbStatus,
      fulfillment,
      timestamp: new Date().toISOString(),
    });
  });

  // 5. Minimal plain-text/JSON status on root path so Cloud Run / container check succeeds
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
        `Проверка здоровья (JSON): /health`,
        `Webhook endpoint: POST /webhook/telegram`,
      ].join('\n'),
    );
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[Server] Серверный процесс запущен на 0.0.0.0:${config.port} (Cloud Run ready).`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[Server] Получен сигнал ${signal}. Остановка бота и сервера...`);
    clearInterval(watcherInterval);
    botManager.stop(signal);
    server.close(() => {
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
