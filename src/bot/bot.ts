import crypto from 'node:crypto';
import { Telegraf } from 'telegraf';
import { Request, Response } from 'express';
import { getEnvConfig } from '../config/env.ts';
import { BotConnectionStatus } from '../types.ts';
import { registerUserHandlers } from './handlers/userHandler.ts';
import { registerPaymentHandlers } from './handlers/paymentHandler.ts';
import { registerAdminHandlers } from './handlers/adminHandler.ts';

export function maskSecretsInText(
  msg: string,
  secrets: Array<string | undefined>,
): string {
  let result = msg;
  for (const secret of secrets) {
    if (secret && secret.trim().length > 0) {
      result = result.split(secret).join('[REDACTED_SECRET]');
    }
  }
  return result;
}

export function verifyWebhookSecretToken(
  expectedSecret: string | undefined,
  providedHeader: string | undefined,
): boolean {
  if (!expectedSecret || !expectedSecret.trim()) {
    return false;
  }
  if (!providedHeader || typeof providedHeader !== 'string') {
    return false;
  }
  const expectedBuf = Buffer.from(expectedSecret, 'utf-8');
  const providedBuf = Buffer.from(providedHeader, 'utf-8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function isValidTelegramUpdatePayload(body: unknown): body is {
  update_id: number;
  [key: string]: unknown;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const rec = body as Record<string, unknown>;
  return typeof rec.update_id === 'number' && Number.isInteger(rec.update_id);
}

class TelegramBotManager {
  private bot: Telegraf | null = null;
  private isStarting = false;
  private pollingStarted = false;
  private activeTokenHash = '';
  private status: BotConnectionStatus = {
    connected: false,
    mode: 'unconfigured',
    pollingActive: false,
    lastCheckedAt: new Date().toISOString(),
    error: 'Переменная окружения TELEGRAM_BOT_TOKEN не задана.',
  };

  public getStatus(): BotConnectionStatus {
    return { ...this.status };
  }

  public getBotInstance(): Telegraf | null {
    return this.bot;
  }

  public async start(): Promise<BotConnectionStatus> {
    if (this.isStarting) {
      return this.getStatus();
    }

    const config = getEnvConfig();
    const token = config.telegramBotToken;

    // Validate mandatory webhook configuration before connecting
    if (config.botMode === 'webhook') {
      if (!config.webhookSecret || config.webhookSecret.trim().length === 0) {
        const errText =
          'КРИТИЧЕСКАЯ ОШИБКА КОНФИГУРАЦИИ: В режиме webhook переменная WEBHOOK_SECRET обязательна и не может быть пустой.';
        this.status = {
          connected: false,
          mode: 'webhook',
          pollingActive: false,
          lastCheckedAt: new Date().toISOString(),
          error: errText,
        };
        throw new Error(errText);
      }
      if (!config.webhookUrl || config.webhookUrl.trim().length === 0) {
        const errText =
          'КРИТИЧЕСКАЯ ОШИБКА КОНФИГУРАЦИИ: В режиме webhook переменная WEBHOOK_URL обязательна и не может быть пустой.';
        this.status = {
          connected: false,
          mode: 'webhook',
          pollingActive: false,
          lastCheckedAt: new Date().toISOString(),
          error: errText,
        };
        throw new Error(errText);
      }
    }

    if (!token) {
      this.status = {
        connected: false,
        mode: 'unconfigured',
        pollingActive: false,
        lastCheckedAt: new Date().toISOString(),
        error:
          'Отсутствует TELEGRAM_BOT_TOKEN. Добавьте токен бота в Secrets / Environment Variables.',
      };
      console.warn(
        '[TelegramBot] ⚠️ TELEGRAM_BOT_TOKEN не найден в переменных окружения. Ожидание настройки секрета...',
      );
      return this.getStatus();
    }

    // Prevent starting duplicate polling instances if already connected with same token and mode
    const tokenFingerprint = `${config.botMode}:${token.length}:${token.slice(0, 4)}`;
    if (
      this.bot &&
      this.status.connected &&
      this.activeTokenHash === tokenFingerprint &&
      (config.botMode === 'webhook' || this.pollingStarted)
    ) {
      return this.getStatus();
    }

    this.isStarting = true;

    try {
      // Stop any previous instance cleanly to avoid 409 Conflict
      if (this.bot && this.pollingStarted) {
        try {
          this.bot.stop('Reloading configuration');
        } catch {
          // Ignore stop errors
        }
        this.pollingStarted = false;
      }

      const bot = new Telegraf(token);

      // Global error handler that never leaks secrets
      bot.catch((err, ctx) => {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = maskSecretsInText(rawMsg, [
          token,
          config.webhookSecret,
          config.firebasePrivateKey,
          config.cryptobotApiToken,
          config.lolzteamApiToken,
          config.lolzteamWebhookSecret,
          config.xrocketApiKey,
        ]);
        console.error(
          `[TelegramBot] Ошибка при обработке обновления (${ctx.updateType}): ${safeMsg}`,
        );
      });

      // Register all store handlers
      registerUserHandlers(bot);
      registerPaymentHandlers(bot);
      registerAdminHandlers(bot, () => this.getStatus());

      // 1. Verify connection with real Telegram API getMe call
      console.log('[TelegramBot] Проверка подключения к Telegram Bot API (getMe)...');
      const me = await bot.telegram.getMe();

      console.log(
        `[TelegramBot] ✅ Успешная проверка getMe: Имя="${me.first_name}", Username=@${me.username} (ID: ${me.id})`,
      );

      // 2. Register bot commands menu in Telegram
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Главное меню магазина' },
        { command: 'catalog', description: 'Каталог товаров (Stars, Premium, Gifts)' },
        { command: 'topup', description: 'Пополнить внутренний баланс' },
        { command: 'orders', description: 'Мои заказы' },
        { command: 'profile', description: 'Мой профиль' },
        { command: 'help', description: 'Помощь и FAQ' },
        { command: 'terms', description: 'Правила магазина' },
        { command: 'paysupport', description: 'Поддержка по платежам' },
      ]);

      this.bot = bot;
      this.activeTokenHash = tokenFingerprint;

      // 3. Configure Webhook or Polling mode
      if (config.botMode === 'webhook') {
        const normalizedBase = config.webhookUrl.replace(/\/+$/, '');
        const fullWebhookUrl = `${normalizedBase}/webhook/telegram`;

        await bot.telegram.setWebhook(fullWebhookUrl, {
          secret_token: config.webhookSecret,
          allowed_updates: [
            'message',
            'callback_query',
            'pre_checkout_query',
          ],
        });

        this.pollingStarted = false;
        this.status = {
          connected: true,
          mode: 'webhook',
          pollingActive: false,
          botId: me.id,
          botUsername: me.username,
          botFirstName: me.first_name,
          lastCheckedAt: new Date().toISOString(),
        };

        console.log(
          `[TelegramBot] 🚀 Бот @${me.username} запущен в защищённом режиме WEBHOOK (${fullWebhookUrl})`,
        );
      } else {
        // Ensure webhook is removed before starting long polling to prevent conflicts
        await bot.telegram.deleteWebhook({ drop_pending_updates: false });

        // Launch polling in background without blocking the HTTP health server
        bot
          .launch({
            allowedUpdates: ['message', 'callback_query', 'pre_checkout_query'],
            dropPendingUpdates: false,
          })
          .catch((launchErr) => {
            const rawMsg =
              launchErr instanceof Error ? launchErr.message : String(launchErr);
            const safeMsg = maskSecretsInText(rawMsg, [
              token,
              config.webhookSecret,
              config.cryptobotApiToken,
              config.lolzteamApiToken,
              config.lolzteamWebhookSecret,
              config.xrocketApiKey,
            ]);
            console.error(`[TelegramBot] Ошибка фонового polling: ${safeMsg}`);
            this.pollingStarted = false;
            this.status.pollingActive = false;
            this.status.error = safeMsg;
          });

        this.pollingStarted = true;
        this.status = {
          connected: true,
          mode: 'polling',
          pollingActive: true,
          botId: me.id,
          botUsername: me.username,
          botFirstName: me.first_name,
          lastCheckedAt: new Date().toISOString(),
        };

        console.log(
          `[TelegramBot] 🚀 Бот "${me.first_name}" (@${me.username}) успешно запущен в режиме POLLING!`,
        );
      }

      return this.getStatus();
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      const safeMsg = maskSecretsInText(rawMsg, [
        token,
        config.webhookSecret,
        config.firebasePrivateKey,
        config.cryptobotApiToken,
        config.lolzteamApiToken,
        config.lolzteamWebhookSecret,
        config.xrocketApiKey,
      ]);
      this.pollingStarted = false;
      this.status = {
        connected: false,
        mode: config.botMode,
        pollingActive: false,
        lastCheckedAt: new Date().toISOString(),
        error: `Ошибка подключения Telegram Bot API: ${safeMsg}`,
      };
      console.error(`[TelegramBot] ❌ Не удалось подключить бота: ${safeMsg}`);
      return this.getStatus();
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Handles incoming Telegram Webhook HTTP POST requests.
   * Enforces mandatory constant-time verification of `X-Telegram-Bot-Api-Secret-Token`
   * and rejects any unauthenticated or malformed update payloads.
   */
  public async handleWebhookRequest(req: Request, res: Response): Promise<void> {
    const config = getEnvConfig();

    // 1. Always verify WEBHOOK_SECRET is configured and matches header BEFORE anything else
    if (!config.webhookSecret || config.webhookSecret.trim().length === 0) {
      res.status(503).json({
        ok: false,
        error: 'Webhook secret is not configured on server',
      });
      return;
    }

    const headerSecret = req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!verifyWebhookSecretToken(config.webhookSecret, headerSecret)) {
      res.status(401).json({
        ok: false,
        error: 'Unauthorized: invalid or missing X-Telegram-Bot-Api-Secret-Token',
      });
      return;
    }

    // 2. Validate Telegram Update payload structure
    if (!isValidTelegramUpdatePayload(req.body)) {
      res.status(400).json({
        ok: false,
        error: 'Bad Request: invalid Telegram update payload',
      });
      return;
    }

    // 3. Ensure bot instance is ready
    if (!this.bot || !this.status.connected) {
      res.status(503).json({ ok: false, error: 'Telegram bot is not connected' });
      return;
    }

    try {
      await this.bot.handleUpdate(req.body as unknown as Parameters<Telegraf['handleUpdate']>[0], res);
      if (!res.headersSent) {
        res.status(200).json({ ok: true });
      }
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      const safeMsg = maskSecretsInText(rawMsg, [
        config.telegramBotToken,
        config.webhookSecret,
      ]);
      console.error('[TelegramBot] Ошибка обработки webhook update:', safeMsg);
      if (!res.headersSent) {
        res.status(500).json({ ok: false });
      }
    }
  }

  public stop(reason = 'SIGTERM'): void {
    if (this.bot && this.pollingStarted) {
      try {
        this.bot.stop(reason);
      } catch {
        // Ignore if bot wasn't running
      }
      this.pollingStarted = false;
      this.status.pollingActive = false;
    }
  }
}

export const botManager = new TelegramBotManager();
