import { Telegraf } from 'telegraf';
import { Request, Response } from 'express';
import { getEnvConfig } from '../config/env.ts';
import { BotConnectionStatus } from '../types.ts';
import { registerUserHandlers } from './handlers/userHandler.ts';
import { registerPaymentHandlers } from './handlers/paymentHandler.ts';
import { registerAdminHandlers } from './handlers/adminHandler.ts';

function maskSecretInError(msg: string, token: string): string {
  if (!token) return msg;
  return msg.split(token).join('[REDACTED_BOT_TOKEN]');
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

    // Prevent starting duplicate polling instances if already connected with same token
    const tokenFingerprint = `${token.length}:${token.slice(0, 4)}`;
    if (
      this.bot &&
      this.status.connected &&
      this.activeTokenHash === tokenFingerprint
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

      // Global error handler that never leaks the token
      bot.catch((err, ctx) => {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = maskSecretInError(rawMsg, token);
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
        { command: 'orders', description: 'Мои заказы' },
        { command: 'profile', description: 'Мой профиль' },
        { command: 'help', description: 'Помощь и FAQ' },
        { command: 'terms', description: 'Правила магазина' },
        { command: 'paysupport', description: 'Поддержка по платежам' },
      ]);

      this.bot = bot;
      this.activeTokenHash = tokenFingerprint;

      // 3. Configure Webhook or Polling mode
      if (config.botMode === 'webhook' && config.webhookUrl) {
        const normalizedBase = config.webhookUrl.replace(/\/+$/, '');
        const fullWebhookUrl = `${normalizedBase}/webhook/telegram`;

        await bot.telegram.setWebhook(fullWebhookUrl, {
          secret_token: config.webhookSecret || undefined,
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
          `[TelegramBot] 🚀 Бот @${me.username} запущен в режиме WEBHOOK (${fullWebhookUrl})`,
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
            const safeMsg = maskSecretInError(rawMsg, token);
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
      const safeMsg = maskSecretInError(rawMsg, token);
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

  public async handleWebhookRequest(req: Request, res: Response): Promise<void> {
    const config = getEnvConfig();
    if (!this.bot || !this.status.connected) {
      res.status(503).json({ ok: false, error: 'Telegram bot is not connected' });
      return;
    }

    if (config.webhookSecret) {
      const headerSecret = req.header('X-Telegram-Bot-Api-Secret-Token');
      if (headerSecret !== config.webhookSecret) {
        res.status(401).json({ ok: false, error: 'Invalid webhook secret token' });
        return;
      }
    }

    try {
      await this.bot.handleUpdate(req.body, res);
      if (!res.headersSent) {
        res.status(200).json({ ok: true });
      }
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      const safeMsg = maskSecretInError(rawMsg, config.telegramBotToken);
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
