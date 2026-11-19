import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Context, Telegraf } from 'telegraf';
import type { Request, Response } from 'express';
import {
  firestoreRepo,
  StorageUnavailableError,
} from '../db/firestore.ts';
import {
  OrderService,
  normalizeRecipientUsername,
} from '../services/OrderService.ts';
import { PaymentService } from '../services/PaymentService.ts';
import {
  FulfillmentService,
  ManualAdminFulfillmentAdapter,
  type FulfillmentProviderAdapter,
} from '../services/FulfillmentService.ts';
import { ProductService } from '../services/ProductService.ts';
import { UserService } from '../services/UserService.ts';
import {
  botManager,
  maskSecretsInText,
  verifyWebhookSecretToken,
  isValidTelegramUpdatePayload,
} from '../bot/bot.ts';
import { ensureAdmin, ensureOwner } from '../bot/handlers/adminHandler.ts';
import {
  buildAdminMainKeyboard,
  buildAdminOrderActionKeyboard,
  buildAdminOrderRefundConfirmKeyboard,
  buildOrderCheckoutChooserKeyboard,
  buildOrderCryptoCurrencyKeyboard,
  buildTopUpInvoiceKeyboard,
  buildTopUpStep1ProviderKeyboard,
  buildTopUpStep2AmountKeyboard,
  buildTopUpStep3XRocketCurrencyKeyboard,
  buildUserProfileKeyboard,
} from '../bot/keyboards.ts';
import {
  BalanceService,
  calculateTopUpCommission,
  calculateTopUpCommissionCents,
  validateTopUpAmountUsd,
  validateTopUpAmountUsdCents,
} from '../services/BalanceService.ts';
import {
  ExchangeRateUnavailableError,
  PaymentProviderGateway,
  PAYMENT_PROVIDER_CATALOG,
  XRocketApiError,
  buildXRocketApiV1Url,
  computeCryptoBotWebhookSignature,
  computeXRocketWebhookSignature,
  redactSecretsFromText,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from '../services/PaymentProviders.ts';
import {
  bpsFeeAndNetCents,
  centsToUsdString,
  compareScaledDecimal,
  convertUsdCentsToCryptoScaled,
  formatUsdCents,
  parseDecimalToScaled,
  usdInputToCents,
} from '../services/Money.ts';
import {
  formatUsd,
  getEnvConfig,
  MAX_TOPUP_AMOUNT_USD,
  MIN_TOPUP_AMOUNT_USD,
} from '../config/env.ts';
import {
  OUTLINE_EMOJI_REGISTRY,
  oe,
  oeBtn,
  oeSvg,
} from '../bot/outlineEmoji.ts';
import {
  formatCatalogOverviewMessage,
  formatHelpMessage,
  formatOrderCheckoutChooserMessage,
  formatTermsMessage,
  formatTopUpInvoiceCardMessage,
  formatTopUpStep2AmountMessage,
  formatUserProfileMessage,
  formatUserTopUpHistoryMessage,
  formatWelcomeMessage,
} from '../bot/formatters.ts';
import {
  DigitalKeyService,
  DuplicateDigitalKeyError,
  OwnerAccessDeniedError,
  UnsupportedKeyGeneratorError,
} from '../services/DigitalKeyService.ts';
import {
  handleProviderWebhookRequest,
  handleTopUpCalculateRequest,
  renderPlainTextStatus,
} from '../../server.ts';
import type { Order, PaymentRecord, StoreUser } from '../types.ts';

// Force isolated test environment so production Firestore and .data/ are NEVER touched
process.env.NODE_ENV = 'test';
process.env.ALLOW_LOCAL_FALLBACK = 'false';
process.env.ADMIN_IDS = '777000111';

interface AuditTestRecord {
  id: string;
  category: 'Payments' | 'Fulfillment' | 'Security' | 'Database';
  name: string;
  status: 'PASS' | 'FAIL';
  environment: string;
  emulatorUsed: boolean;
  details: string;
}

const testResults: AuditTestRecord[] = [];

function createMockBot(
  sentMessages: Array<{ chatId: number | string; text: string }>,
  shouldFail = false,
): Telegraf {
  return {
    telegram: {
      sendMessage: async (chatId: number | string, text: string) => {
        if (shouldFail) {
          throw new Error('Simulated Telegram API 502 Bad Gateway');
        }
        sentMessages.push({ chatId, text });
        return { message_id: Date.now() };
      },
    },
  } as unknown as Telegraf;
}

function createMockExpressRes(): {
  res: Response;
  getStatus: () => number;
  getJson: () => unknown;
} {
  let statusCode = 200;
  let jsonBody: unknown = null;
  const mockRes = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return mockRes;
    },
    json(payload: unknown) {
      jsonBody = payload;
      mockRes.headersSent = true;
      return mockRes;
    },
  };
  const res = mockRes as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
  };
}

async function runTest(
  id: string,
  category: AuditTestRecord['category'],
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  try {
    const details = await fn();
    testResults.push({
      id,
      category,
      name,
      status: 'PASS',
      environment: 'Isolated In-Memory Transactional Engine + Mock Telegram API (NODE_ENV=test)',
      emulatorUsed: false,
      details,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : String(error);
    testResults.push({
      id,
      category,
      name,
      status: 'FAIL',
      environment: 'Isolated In-Memory Transactional Engine + Mock Telegram API (NODE_ENV=test)',
      emulatorUsed: false,
      details: errMsg,
    });
    throw error;
  }
}

const TEST_MOCK_CREDS = {
  cryptobotApiToken: 'test_crypto_token_secret_111',
  cryptobotApiUrl: 'https://pay.crypt.bot/api',
  xrocketApiKey: 'test_xrocket_key_secret_444',
  xrocketApiUrl: 'https://pay.api.testnet.xrocket.exchange',
};

let testInvoiceCounter = 800000;

async function payOrderViaCryptoForTest(
  order: Order,
  provider: 'cryptobot' | 'xrocket' = 'cryptobot',
  currency = provider === 'cryptobot' ? 'USD' : 'USDT',
): Promise<{ order: Order; payment: PaymentRecord; duplicate: boolean }> {
  const extInvId = `ext_test_${++testInvoiceCounter}`;
  let createdPaymentId = '';
  let expectedAmount = '';

  const transport = async (
    req: HttpTransportRequest,
  ): Promise<HttpTransportResponse> => {
    if (req.url.endsWith('/getExchangeRates')) {
      return {
        status: 200,
        ok: true,
        json: {
          ok: true,
          result: [
            { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
            { source: 'TON', target: 'USD', rate: '5.50', is_valid: true },
          ],
        },
      };
    }
    if (req.url.endsWith('/api/v1/rates')) {
      return {
        status: 200,
        ok: true,
        json: {
          data: { USDT: '1.00', TON: '5.50' },
        },
      };
    }
    if (req.url.endsWith('/api/v1/currencies')) {
      return {
        status: 200,
        ok: true,
        json: [
          { currency: 'USDT', networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'] },
          { currency: 'TON', networks: ['TON'] },
        ],
      };
    }
    if (req.url.endsWith('/createInvoice')) {
      const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
      createdPaymentId = String(body.payload || '');
      expectedAmount = String(body.amount || '0');
      return {
        status: 200,
        ok: true,
        json: {
          ok: true,
          result: {
            invoice_id: extInvId,
            status: 'active',
            amount: expectedAmount,
            fiat: currency === 'USD' ? 'USD' : undefined,
            asset: currency === 'USD' ? undefined : currency,
            currency_type: currency === 'USD' ? 'fiat' : 'crypto',
            bot_invoice_url: `https://t.me/CryptoBot?start=${extInvId}`,
            payload: createdPaymentId,
          },
        },
      };
    }
    if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
      const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
      createdPaymentId = String(body.clientInvoiceId || '');
      expectedAmount = String(body.priceAmount || '0');
      return {
        status: 201,
        ok: true,
        json: {
          id: extInvId,
          priceAmount: expectedAmount,
          priceCurrency: currency,
          clientInvoiceId: createdPaymentId,
          status: 'PENDING',
          links: {
            telegramBotLink: `https://t.me/xrocket?start=${extInvId}`,
          },
        },
      };
    }
    if (req.url.includes('/getInvoices')) {
      return {
        status: 200,
        ok: true,
        json: {
          ok: true,
          result: {
            items: [
              {
                invoice_id: extInvId,
                status: 'paid',
                amount: expectedAmount,
                fiat: currency === 'USD' ? 'USD' : undefined,
                paid_asset: currency === 'USD' ? undefined : currency,
                currency_type: currency === 'USD' ? 'fiat' : 'crypto',
                payload: createdPaymentId,
                fee_in_usd: '0.03',
                paid_at: new Date().toISOString(),
              },
            ],
          },
        },
      };
    }
    if (req.url.includes('/api/v1/invoices?ids=')) {
      return {
        status: 200,
        ok: true,
        json: [
          {
            id: extInvId,
            priceAmount: expectedAmount,
            priceCurrency: currency,
            clientInvoiceId: createdPaymentId,
            status: 'PAID',
            paidAt: new Date().toISOString(),
          },
        ],
      };
    }
    throw new Error(`Unexpected test transport request: ${req.method} ${req.url}`);
  };

  const gateway = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
  const ps = new PaymentService('test-helper', gateway);

  const created = await ps.createOrReuseOrderPayment({
    orderId: order.orderId,
    callerTelegramId: order.userTelegramId,
    provider,
    currency,
    network: provider === 'xrocket' ? 'TON' : undefined,
  });

  const verified = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
  if (!verified.ok || !verified.order || !verified.payment) {
    throw new Error(`payOrderViaCryptoForTest failed: ${verified.reason}`);
  }
  return {
    order: verified.order,
    payment: verified.payment,
    duplicate: verified.duplicate,
  };
}

async function seedLegacyPaidXtrOrderForRefundTest(
  order: Order,
  chargeId: string,
): Promise<Order> {
  const paymentId = PaymentService.getPaymentDocId(chargeId);
  const now = new Date().toISOString();
  return firestoreRepo.runTransaction(async (tx) => {
    const freshOrder = await tx.get<Order>('orders', order.orderId);
    const freshUser = await tx.get<StoreUser>('users', order.userId);
    if (!freshOrder) throw new Error(`Order ${order.orderId} not found`);

    const updatedOrder: Order = {
      ...freshOrder,
      paymentMethod: 'telegram_stars',
      paymentStatus: 'paid',
      fulfillmentStatus: 'paid',
      telegramPaymentChargeId: chargeId,
      activePaymentId: paymentId,
      paidAt: now,
      updatedAt: now,
    };

    const paymentRec: PaymentRecord = {
      paymentId,
      kind: 'order',
      provider: 'telegram_stars',
      orderId: order.orderId,
      userId: order.userId,
      userTelegramId: order.userTelegramId,
      totalAmount: order.totalPrice,
      expectedUsdCents: order.totalPriceUsdCents ?? order.totalPrice,
      expectedAmountStr: String(order.totalPrice),
      feeUsdCents: 0,
      netUsdCents: order.totalPriceUsdCents ?? order.totalPrice,
      currency: 'XTR',
      invoicePayload: order.orderId,
      telegramPaymentChargeId: chargeId,
      status: 'paid',
      paidAt: now,
      createdAt: now,
      updatedAt: now,
    };

    tx.set<PaymentRecord>('payments', paymentId, paymentRec);
    tx.set<Order>('orders', updatedOrder.orderId, updatedOrder);
    if (freshUser) {
      tx.set<StoreUser>('users', freshUser.userId, {
        ...freshUser,
        totalOrders: (freshUser.totalOrders || 0) + 1,
        totalSpentStars: (freshUser.totalSpentStars || 0) + order.totalPrice,
        updatedAt: now,
      });
    }
    return updatedOrder;
  });
}

async function runFullAuditTestSuite(): Promise<void> {
  console.log('================================================================');
  console.log('🧪 ЗАПУСК ПОЛНОГО НАБОРА АВТОТЕСТОВ QUIZYSTARS (ISOLATED MODE)');
  console.log('================================================================');

  firestoreRepo.enableIsolatedTestMode(true);
  FulfillmentService.baseRetryDelayMs = 10;
  FulfillmentService.staleProcessingLeaseMs = 50;

  const buyer1 = {
    id: 100200301,
    username: 'buyer_one',
    first_name: 'Alex',
    last_name: 'Buyer',
  };
  const buyer2 = {
    id: 100200302,
    username: 'buyer_two',
    first_name: 'Boris',
    last_name: 'Other',
  };

  // ===========================================================================
  // 1. PAYMENTS TESTS (USD cents, CryptoBot / xRocket, payment_locks, XTR disabled)
  // ===========================================================================
  await runTest(
    'P-01',
    'Payments',
    'Успешная атомарная обработка оплаты заказа через CryptoBot в центах USD',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50', // $0.90 = 90 cents
        quantity: 2, // $1.80 = 180 cents
      });
      assert.equal(order.totalPriceUsdCents, 180);
      assert.equal(order.totalPrice, 180);
      assert.equal(order.paymentStatus, 'pending');

      const res = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      assert.equal(res.duplicate, false);
      assert.equal(res.order.paymentStatus, 'paid');
      assert.equal(res.order.fulfillmentStatus, 'paid');
      assert.equal(res.payment.expectedUsdCents, 180);

      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 1);
      assert.equal(user?.totalSpentUsdCents, 180);
      return `Заказ #${order.orderId} ($1.80) оплачен через CryptoBot, PaymentRecord создан, статистика пользователя: 1 заказ / $1.80.`;
    },
  );

  await runTest(
    'P-02',
    'Payments',
    'Повторный платёж / повторный webhook (идемпотентность verifyAndProcessOrderPayment)',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const order = orders[0];
      assert.ok(order.activePaymentId);

      const ps = new PaymentService(
        'p02-replay',
        new PaymentProviderGateway(async () => {
          throw new Error('Provider API should not be called when payment is already paid');
        }, TEST_MOCK_CREDS),
      );
      const dupRes = await ps.verifyAndProcessOrderPayment(order.activePaymentId!);

      assert.equal(dupRes.ok, true);
      assert.equal(dupRes.duplicate, true);
      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 1);
      assert.equal(user?.totalSpentUsdCents, 180);
      return 'Повторная проверка/webhook вернула duplicate=true без дублирования PaymentRecord и без повторного инкремента статистики.';
    },
  );

  await runTest(
    'P-03',
    'Payments',
    'Параллельная обработка одинакового платежа заказа (6 конкурентных потоков)',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250', // $4.20 = 420 cents
        quantity: 1,
      });

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p03_par',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p03_par',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 'inv_p03_par',
                    status: 'paid',
                    amount: '4.20',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    payload: created.payment.paymentId,
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected: ${req.url}`);
      };

      const ps = new PaymentService(
        'p03-par',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });

      const parallelResults = await Promise.all(
        Array.from({ length: 6 }, () =>
          ps.verifyAndProcessOrderPayment(created.payment.paymentId),
        ),
      );

      const freshCount = parallelResults.filter((r) => r.ok && !r.duplicate).length;
      const dupCount = parallelResults.filter((r) => r.ok && r.duplicate).length;
      assert.equal(freshCount, 1);
      assert.equal(dupCount, 5);

      const user = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(user?.totalOrders, 2);
      assert.equal(user?.totalSpentUsdCents, 180 + 420);
      return 'Из 6 параллельных вызовов ровно 1 зафиксировал платёж, 5 получили duplicate=true.';
    },
  );

  await runTest(
    'P-04',
    'Payments',
    'Отклонение недоплаченного платежа по заказу (amount < expectedAmountStr)',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50', // $0.90
        quantity: 1,
      });

      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload || '');
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p04_under',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p04_under',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'inv_p04_under',
                  status: 'paid',
                  amount: '0.10', // ожидалось 0.90 USD
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService(
        'p04',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'underpaid');
      assert.equal(res.reason, 'UNDERPAID');

      const unchanged = await OrderService.getOrderById(order.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');
      return 'Платёж с заниженной суммой (0.10 вместо 0.90 USD) отклонён (UNDERPAID), заказ остался pending.';
    },
  );

  await runTest(
    'P-05',
    'Payments',
    'Отклонение платежа с неверной валютой (INVALID_CURRENCY) и отключение XTR',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const preCheck = await PaymentService.validatePreCheckout({
        invoicePayload: order.orderId,
        telegramUserId: buyer1.id,
        currency: 'XTR',
        totalAmount: order.totalPrice,
      });
      assert.equal(preCheck.ok, false);

      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload || '');
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p05_curr',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p05_curr',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'inv_p05_curr',
                  status: 'paid',
                  amount: '0.90',
                  fiat: 'EUR',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService(
        'p05',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'INVALID_CURRENCY');
      return 'Telegram XTR отклонён в validatePreCheckout, а несовпадение валюты EUR вместо USD отклонено с INVALID_CURRENCY.';
    },
  );

  await runTest(
    'P-06',
    'Payments',
    'Отклонение оплаты заказа другого пользователя',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const ps = new PaymentService(
        'p06',
        new PaymentProviderGateway(async () => {
          throw new Error('Should not reach provider');
        }, TEST_MOCK_CREDS),
      );

      await assert.rejects(
        async () => {
          await ps.createOrReuseOrderPayment({
            orderId: order.orderId,
            callerTelegramId: buyer2.id,
            provider: 'cryptobot',
            currency: 'USD',
          });
        },
        /оплачивать чужой заказ/,
      );
      return 'Попытка оплатить чужой заказ отклонена с ошибкой владельца.';
    },
  );

  await runTest(
    'P-07',
    'Payments',
    'Отклонение оплаты отсутствующего заказа',
    async () => {
      const ps = new PaymentService(
        'p07',
        new PaymentProviderGateway(async () => {
          throw new Error('Should not reach provider');
        }, TEST_MOCK_CREDS),
      );
      await assert.rejects(
        async () => {
          await ps.createOrReuseOrderPayment({
            orderId: 'ord_non_existent_999999',
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USD',
          });
        },
        /не найден/,
      );
      return 'Оплата несуществующего заказа корректно отклонена.';
    },
  );

  await runTest(
    'P-08',
    'Payments',
    'Проброс ошибки Firestore при сбое записи во время оплаты',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload || '');
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'inv_p08_fail',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=inv_p08_fail',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'inv_p08_fail',
                  status: 'paid',
                  amount: '0.90',
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService(
        'p08',
        new PaymentProviderGateway(transport, TEST_MOCK_CREDS),
      );
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });

      firestoreRepo.setSimulatedFailure({
        writeError: 'Simulated Firestore DEADLINE_EXCEEDED on write',
      });

      try {
        await assert.rejects(
          async () => {
            await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
          },
          /Simulated Firestore DEADLINE_EXCEEDED on write/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }

      const afterFail = await OrderService.getOrderById(order.orderId);
      assert.equal(afterFail?.paymentStatus, 'pending');
      return 'Ошибка записи Firestore проброшена вызывающему коду, заказ остался в pending.';
    },
  );

  await runTest(
    'P-09',
    'Payments',
    'Rollback транзакции, запрет чтения после записи и защита markOrderPaid без PaymentRecord',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      // 1. Попытка отметить заказ оплаченным напрямую через markOrderPaid без PaymentRecord
      await assert.rejects(
        async () => {
          await OrderService.markOrderPaid({
            orderId: order.orderId,
            telegramPaymentChargeId: 'unverified_charge_id',
          });
        },
        /PaymentRecord не найден/,
      );

      // 2. Проверка нарушения порядка read-after-write и полного отката транзакции
      await assert.rejects(
        async () => {
          await firestoreRepo.runTransaction(async (tx) => {
            const u = await tx.get<StoreUser>('users', `tg_${buyer1.id}`);
            assert.ok(u);
            tx.set<StoreUser>('users', `tg_${buyer1.id}`, {
              ...u,
              totalOrders: 888888,
            });
            // Нарушаем правило: вызываем tx.get ПОСЛЕ tx.set
            await tx.get<Order>('orders', order.orderId);
          });
        },
        /все операции чтения \(tx\.get\) должны выполняться до операций записи/,
      );

      const userAfterRollback = await UserService.getUserByTelegramId(buyer1.id);
      assert.notEqual(userAfterRollback?.totalOrders, 888888);
      return 'Защита read-before-write сработала, транзакция откатилась, неавторизованный markOrderPaid заблокирован.';
    },
  );

  // ===========================================================================
  // 2. FULFILLMENT TESTS
  // ===========================================================================
  await runTest(
    'F-01',
    'Fulfillment',
    'Повторный запуск одной задачи выдачи (идемпотентность initiateFulfillment)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      const first = await FulfillmentService.initiateFulfillment(paid.order, bot);
      const second = await FulfillmentService.initiateFulfillment(first, bot);

      assert.equal(first.fulfillmentStatus, 'processing');
      assert.equal(second.fulfillmentStatus, 'processing');
      assert.equal(second.fulfillmentAttempts, 1);
      assert.equal(messages.length, 1);
      return 'При повторном вызове initiateFulfillment задача не дублируется (attempts=1, уведомлений=1).';
    },
  );

  await runTest(
    'F-02',
    'Fulfillment',
    'Два параллельных worker на один заказ (атомарный захват до внешней выдачи)',
    async () => {
      let adapterCalls = 0;
      const countingAdapter: FulfillmentProviderAdapter = {
        providerName: 'CountingAutoAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async (ord, ctx) => {
          adapterCalls++;
          await new Promise((r) => setTimeout(r, 25));
          return {
            handledAutomatically: true,
            status: 'completed',
            details: `Автовыдача выполнена (key=${ctx?.idempotencyKey})`,
            externalReference: `ref_${ord.orderId}`,
          };
        },
      };
      FulfillmentService.setAdapter(countingAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      // Запускаем два параллельных worker одновременно
      await Promise.all([
        FulfillmentService.initiateFulfillment(paid.order, bot),
        FulfillmentService.initiateFulfillment(paid.order, bot),
      ]);

      const finalOrder = await OrderService.getOrderById(order.orderId);
      assert.equal(adapterCalls, 1, 'Внешний адаптер должен быть вызван ровно 1 раз');
      assert.equal(finalOrder?.fulfillmentStatus, 'completed');

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return `Атомарный захват перед вызовом адаптера предотвратил гонку: adapterCalls=${adapterCalls}.`;
    },
  );

  await runTest(
    'F-03',
    'Fulfillment',
    'Падение сервера во время внешней обработки (сверка checkExternalStatus и карантин неидемпотентного провайдера)',
    async () => {
      // Сценарий А: Внешний запрос реально выполнился до падения сервера, провайдер подтверждает через checkExternalStatus
      const crashRecoveryAdapter: FulfillmentProviderAdapter = {
        providerName: 'ProviderWithStatusCheck',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          throw new Error('Should not be called if checkExternalStatus returns alreadyExecuted=true');
        },
        checkExternalStatus: async (_ord, key) => ({
          alreadyExecuted: true,
          status: 'completed',
          details: `Выдача подтверждена провайдером по ключу ${key}`,
          externalReference: `ext_verified_${key}`,
        }),
      };
      FulfillmentService.setAdapter(crashRecoveryAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
      });
      await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      // Имитируем состояние, когда сервер упал после захвата 'processing', не успев сохранить externalExecutionReference
      const pastIso = new Date(Date.now() - 5000).toISOString();
      await firestoreRepo.updateDoc<Order>('orders', order.orderId, {
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: pastIso,
        fulfillmentAttempts: 1,
        externalExecutionReference: undefined,
      });

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      const recovered = await FulfillmentService.recoverPendingFulfillments(bot);
      const updatedOrder = await OrderService.getOrderById(order.orderId);
      assert.ok(recovered.length >= 1);
      assert.equal(updatedOrder?.fulfillmentStatus, 'completed');
      assert.ok(updatedOrder?.externalExecutionReference?.startsWith('ext_verified_'));

      // Сценарий Б: Неидемпотентный провайдер без checkExternalStatus — перевод в карантин ручной сверки (без двойной выдачи!)
      let unsafeCalls = 0;
      const nonIdempotentAdapter: FulfillmentProviderAdapter = {
        providerName: 'LegacyNonIdempotentProvider',
        supportsIdempotency: false,
        isConfigured: () => true,
        requestFulfillment: async () => {
          unsafeCalls++;
          return { handledAutomatically: true, status: 'completed', details: 'Done' };
        },
      };
      FulfillmentService.setAdapter(nonIdempotentAdapter);

      const order2 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      await payOrderViaCryptoForTest(order2, 'cryptobot', 'USD');
      await firestoreRepo.updateDoc<Order>('orders', order2.orderId, {
        fulfillmentStatus: 'processing',
        fulfillmentStartedAt: pastIso,
        fulfillmentAttempts: 1,
        externalExecutionReference: undefined,
      });

      await FulfillmentService.recoverPendingFulfillments(bot);
      const quarantinedOrder = await OrderService.getOrderById(order2.orderId);
      assert.equal(unsafeCalls, 0, 'Неидемпотентный адаптер НЕ должен вызываться повторно после крэша');
      assert.equal(quarantinedOrder?.fulfillmentStatus, 'failed');
      assert.equal(quarantinedOrder?.needsManualReconciliation, true);

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return 'Сверка checkExternalStatus восстановила выполненный заказ, а неидемпотентный заказ без сверки переведён в карантин ручной проверки (unsafeCalls=0).';
    },
  );

  await runTest(
    'F-04',
    'Fulfillment',
    'Восстановление зависшего заказа и ограничение числа попыток (MAX_FULFILLMENT_ATTEMPTS=3)',
    async () => {
      let attemptsMade = 0;
      const alwaysFailingAdapter: FulfillmentProviderAdapter = {
        providerName: 'AlwaysFailingAdapter',
        supportsIdempotency: true,
        isConfigured: () => true,
        requestFulfillment: async () => {
          attemptsMade++;
          throw new Error(`Provider timeout on attempt #${attemptsMade}`);
        },
      };
      FulfillmentService.setAdapter(alwaysFailingAdapter);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const bot = createMockBot([]);

      // Попытка 1, 2, 3
      for (let i = 1; i <= 3; i++) {
        await assert.rejects(async () => {
          await FulfillmentService.initiateFulfillment(paid.order, bot);
        });
      }

      const after3 = await OrderService.getOrderById(order.orderId);
      assert.equal(after3?.fulfillmentAttempts, 3);
      assert.equal(after3?.fulfillmentStatus, 'failed');
      assert.equal(after3?.needsManualReconciliation, true);

      // 4-й вызов не вызывает внешний адаптер, оставляя заказ в failed
      const fourth = await FulfillmentService.initiateFulfillment(after3!, bot);
      assert.equal(attemptsMade, 3);
      assert.equal(fourth.fulfillmentStatus, 'failed');

      FulfillmentService.setAdapter(new ManualAdminFulfillmentAdapter());
      return `После ${attemptsMade} неудачных попыток заказ переведён в финальный статус failed (needsManualReconciliation=true) и не застревает в processing.`;
    },
  );

  await runTest(
    'F-05',
    'Fulfillment',
    'Ошибка уведомления Telegram не отменяет подтверждённую оплату или успешную выдачу',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const failingBot = createMockBot([], true); // Telegram API бросает 502

      const inProcessing = await FulfillmentService.initiateFulfillment(
        paid.order,
        failingBot,
      );
      assert.equal(inProcessing.paymentStatus, 'paid');
      assert.equal(inProcessing.fulfillmentStatus, 'processing');
      assert.equal(inProcessing.adminNotifiedAt, undefined);

      const completed = await FulfillmentService.completeOrder({
        orderId: order.orderId,
        adminNote: 'Код активации: STARS-999-XYZ',
        adminTelegramId: 777000111,
        bot: failingBot,
      });
      assert.equal(completed.paymentStatus, 'completed');
      assert.equal(completed.fulfillmentStatus, 'completed');
      assert.equal(completed.buyerNotifiedAt, undefined);
      return 'При падении Telegram API оплата и выдача сохранены в БД (completed), флаги уведомлений ждут повторной отправки.';
    },
  );

  await runTest(
    'F-06',
    'Fulfillment',
    'Повторная отправка уведомления после восстановления связи (retryOrderNotifications)',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const unnotifiedCompleted = orders.find(
        (o) => o.fulfillmentStatus === 'completed' && !o.buyerNotifiedAt,
      );
      assert.ok(unnotifiedCompleted);

      const deliveredMessages: Array<{ chatId: number | string; text: string }> = [];
      const workingBot = createMockBot(deliveredMessages, false);

      const retryRes = await FulfillmentService.retryOrderNotifications(
        unnotifiedCompleted.orderId,
        workingBot,
      );

      assert.equal(retryRes.adminNotified, true);
      assert.equal(retryRes.buyerNotified, true);
      assert.ok(
        deliveredMessages.some((m) => m.text.includes('STARS-999-XYZ')),
        'Покупатель должен получить код активации в повторном уведомлении',
      );
      return `Уведомления админу и покупателю успешно доставлены при повторе (сообщение содержит код активации).`;
    },
  );

  await runTest(
    'F-07',
    'Fulfillment',
    'Защита от двойной выдачи при повторном запуске recovery и completeOrder',
    async () => {
      const orders = await OrderService.getUserOrders(buyer1.id);
      const completedOrder = orders.find((o) => o.fulfillmentStatus === 'completed')!;

      const messages: Array<{ chatId: number | string; text: string }> = [];
      const bot = createMockBot(messages);

      // Повторный вызов completeOrder и recoverPendingFulfillments
      const again = await FulfillmentService.completeOrder({
        orderId: completedOrder.orderId,
        adminNote: 'Повторное нажатие',
        bot,
      });
      await FulfillmentService.recoverPendingFulfillments(bot);

      assert.equal(again.fulfillmentStatus, 'completed');
      assert.equal(
        messages.length,
        0,
        'Повторный вызов для уже уведомлённого и выданного заказа не отправляет дублирующих сообщений',
      );
      return 'Повторный completeOrder и recoverPendingFulfillments не приводят к повторной выдаче или дублированию сообщений.';
    },
  );

  // ===========================================================================
  // 3. SECURITY TESTS
  // ===========================================================================
  await runTest(
    'S-01',
    'Security',
    'Отсутствие WEBHOOK_SECRET блокирует webhook-запуск и запросы',
    async () => {
      const prevMode = process.env.BOT_MODE;
      const prevSecret = process.env.WEBHOOK_SECRET;
      const prevUrl = process.env.WEBHOOK_URL;

      try {
        process.env.BOT_MODE = 'webhook';
        process.env.WEBHOOK_URL = 'https://example.run.app';
        process.env.WEBHOOK_SECRET = '';

        await assert.rejects(
          async () => {
            await botManager.start();
          },
          /WEBHOOK_SECRET обязательна/,
        );

        const { res, getStatus } = createMockExpressRes();
        const req = {
          header: () => undefined,
          body: { update_id: 1001 },
        } as unknown as Request;

        await botManager.handleWebhookRequest(req, res);
        assert.equal(getStatus(), 503);
      } finally {
        process.env.BOT_MODE = prevMode;
        process.env.WEBHOOK_SECRET = prevSecret;
        process.env.WEBHOOK_URL = prevUrl;
      }
      return 'Запуск в режиме webhook без WEBHOOK_SECRET завершается с ошибкой конфигурации, запросы отклоняются с кодом 503.';
    },
  );

  await runTest(
    'S-02',
    'Security',
    'Отклонение запросов с неправильным X-Telegram-Bot-Api-Secret-Token и поддельных updates',
    async () => {
      const prevSecret = process.env.WEBHOOK_SECRET;
      try {
        process.env.WEBHOOK_SECRET = 'super_secret_webhook_token_123456';

        assert.equal(
          verifyWebhookSecretToken('super_secret_webhook_token_123456', 'wrong_token'),
          false,
        );
        assert.equal(
          verifyWebhookSecretToken(
            'super_secret_webhook_token_123456',
            'super_secret_webhook_token_123456',
          ),
          true,
        );
        assert.equal(isValidTelegramUpdatePayload({ foo: 'bar' }), false);
        assert.equal(isValidTelegramUpdatePayload({ update_id: 42 }), true);

        const { res, getStatus } = createMockExpressRes();
        const forgedReq = {
          header: (name: string) =>
            name === 'X-Telegram-Bot-Api-Secret-Token' ? 'forged_token' : undefined,
          body: {
            update_id: 9999,
            message: {
              successful_payment: {
                currency: 'XTR',
                total_amount: 10,
                invoice_payload: 'ord_forged',
                telegram_payment_charge_id: 'chg_forged',
              },
            },
          },
        } as unknown as Request;

        await botManager.handleWebhookRequest(forgedReq, res);
        assert.equal(getStatus(), 401);
      } finally {
        process.env.WEBHOOK_SECRET = prevSecret;
      }
      return 'Запрос с неверным X-Telegram-Bot-Api-Secret-Token отклонён со статусом 401 Unauthorized до вызова handleUpdate.';
    },
  );

  await runTest(
    'S-03',
    'Security',
    'Блокировка неавторизованного admin callback (ensureAdmin)',
    async () => {
      let alertShown = '';
      const fakeAdminCtx = {
        from: { id: 999888777, first_name: 'Hacker' },
        callbackQuery: { id: 'cb_1', data: 'adm:orders:all' },
        answerCbQuery: async (text: string) => {
          alertShown = text;
          return true;
        },
      } as unknown as Context;

      const allowed = await ensureAdmin(fakeAdminCtx);
      assert.equal(allowed, false);
      assert.ok(alertShown.includes('только администраторам'));
      return 'Неавторизованный callback к админ-панели заблокирован (allowed=false).';
    },
  );

  await runTest(
    'S-04',
    'Security',
    'Защита от доступа к чужому заказу (setOrderRecipientUsername, createOrReuseOrderPayment) и блокировка XTR pre_checkout',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const preCheckout = await PaymentService.validatePreCheckout({
        invoicePayload: order.orderId,
        telegramUserId: buyer2.id,
        currency: 'XTR',
        totalAmount: order.totalPrice,
      });
      assert.equal(preCheckout.ok, false);

      await assert.rejects(
        async () => {
          await OrderService.setOrderRecipientUsername(
            order.orderId,
            buyer2.id,
            'intruder_user',
          );
        },
        /изменять чужой заказ/,
      );
      return 'Доступ чужого пользователя к заказу отклонён, а XTR pre_checkout отключён.';
    },
  );

  // ===========================================================================
  // 4. DATABASE TESTS
  // ===========================================================================
  await runTest(
    'D-01',
    'Database',
    'Fail-safe при недоступности Firebase: запрет создания заказов и обработки платежей',
    async () => {
      firestoreRepo.setSimulatedFailure({ unavailable: true });
      try {
        await assert.rejects(
          async () => {
            await OrderService.createOrder({
              telegramUser: buyer1,
              productId: 'stars_pack_50',
              quantity: 1,
            });
          },
          (err: unknown) => err instanceof StorageUnavailableError,
        );

        await assert.rejects(
          async () => {
            await PaymentService.createOrReuseOrderPayment({
              orderId: 'ord_any',
              callerTelegramId: buyer1.id,
              provider: 'cryptobot',
            });
          },
          (err: unknown) => err instanceof StorageUnavailableError,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'При недоступности БД выбрасывается StorageUnavailableError, заказы и платежи безопасно блокируются.';
    },
  );

  await runTest(
    'D-02',
    'Database',
    'Проброс ошибки чтения Firestore (не проглатывается)',
    async () => {
      firestoreRepo.setSimulatedFailure({
        readError: 'Simulated Firestore UNAVAILABLE on read',
      });
      try {
        await assert.rejects(
          async () => {
            await ProductService.getProductById('stars_pack_50');
          },
          /Simulated Firestore UNAVAILABLE on read/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'Ошибка чтения Firestore корректно передана вызывающему коду.';
    },
  );

  await runTest(
    'D-03',
    'Database',
    'Проброс ошибки записи Firestore (не проглатывается)',
    async () => {
      firestoreRepo.setSimulatedFailure({
        writeError: 'Simulated Firestore PERMISSION_DENIED on write',
      });
      try {
        await assert.rejects(
          async () => {
            await ProductService.createProduct({
              name: 'Test Item',
              category: 'stars',
              description: 'Test',
              price: 15,
            });
          },
          /Simulated Firestore PERMISSION_DENIED on write/,
        );
      } finally {
        firestoreRepo.setSimulatedFailure({});
      }
      return 'Ошибка записи Firestore корректно передана вызывающему коду.';
    },
  );

  await runTest(
    'D-04',
    'Database',
    'Cursor pagination (startAfter) без дублей и пропусков',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      for (let i = 1; i <= 5; i++) {
        await OrderService.createOrder({
          telegramUser: buyer1,
          productId: 'stars_pack_50',
          quantity: 1,
        });
        await new Promise((r) => setTimeout(r, 5));
      }

      const page1 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 2,
      });
      assert.equal(page1.items.length, 2);
      assert.equal(page1.hasMore, true);
      assert.ok(page1.nextCursor);

      const page2 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        startAfter: page1.nextCursor,
        limit: 2,
      });
      assert.equal(page2.items.length, 2);
      assert.equal(page2.hasMore, true);

      const page3 = await firestoreRepo.queryDocsPaginated<Order>('orders', {
        where: [{ field: 'userTelegramId', op: '==', value: buyer1.id }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        startAfter: page2.nextCursor,
        limit: 2,
      });
      assert.equal(page3.items.length, 1);
      assert.equal(page3.hasMore, false);

      const allIds = [
        ...page1.items.map((o) => o.orderId),
        ...page2.items.map((o) => o.orderId),
        ...page3.items.map((o) => o.orderId),
      ];
      assert.equal(new Set(allIds).size, 5, 'Все 5 заказов должны быть уникальными без пересечений страниц');
      return 'Постраничная выборка через курсор startAfter вернула 2 + 2 + 1 = 5 уникальных заказов в правильном порядке.';
    },
  );

  await runTest(
    'D-05',
    'Database',
    'Валидация firestore.indexes.json и .gitignore',
    async () => {
      const indexesPath = path.resolve(process.cwd(), 'firestore.indexes.json');
      const indexesRaw = fs.readFileSync(indexesPath, 'utf-8');
      const parsed = JSON.parse(indexesRaw) as {
        indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
      };

      assert.ok(Array.isArray(parsed.indexes));
      assert.ok(parsed.indexes.length >= 10);

      const gitignore = fs.readFileSync(
        path.resolve(process.cwd(), '.gitignore'),
        'utf-8',
      );
      assert.ok(gitignore.includes('.data/'));
      assert.ok(gitignore.includes('.env'));
      return `Проверено ${parsed.indexes.length} составных индексов в firestore.indexes.json и правила защиты .gitignore.`;
    },
  );

  // ===========================================================================
  // 5. AUD-004 & AUD-005 STATE MACHINE, TWO-STEP REFUND & CONCURRENCY TESTS
  // ===========================================================================
  await runTest(
    'A-01',
    'Fulfillment',
    'AUD-005: Запрет перевода неоплаченного заказа в processing/completed и фильтрация кнопок админ-клавиатуры',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const pendingOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      // 1. Клавиатура неоплаченного заказа НЕ должна содержать кнопок выдачи или возврата
      const pendingKbJson = JSON.stringify(
        buildAdminOrderActionKeyboard(pendingOrder),
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_proc:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_proc не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_done:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_done не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_note:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_note не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_refund:${pendingOrder.orderId}`),
        false,
        'Кнопка adm:ord_refund не должна отображаться для неоплаченного заказа',
      );
      assert.equal(
        pendingKbJson.includes(`adm:ord_cancel:${pendingOrder.orderId}`),
        true,
        'Кнопка adm:ord_cancel должна быть доступна для неоплаченного заказа',
      );

      // 2. Серверная транзакция OrderService.updateOrderStatus отклоняет перевод pending -> processing
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: pendingOrder.orderId,
            fulfillmentStatus: 'processing',
            fulfillmentNote: 'Попытка взять неоплаченный заказ в работу',
          });
        },
        /заказ не оплачен/,
      );

      // 3. Серверная транзакция отклоняет перевод pending -> completed
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: pendingOrder.orderId,
            fulfillmentStatus: 'completed',
          });
        },
        /заказ не оплачен/,
      );

      const unchanged = await OrderService.getOrderById(pendingOrder.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');
      assert.equal(unchanged?.fulfillmentStatus, 'pending');
      return 'Неоплаченный заказ защищён от перевода в processing/completed на уровне клавиатуры и серверной транзакции.';
    },
  );

  await runTest(
    'A-02',
    'Security',
    'AUD-004: Серверный запрет отмены уже оплаченного или выданного заказа и запрет отката completed -> processing',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      // Клавиатура оплаченного крипто-заказа содержит кнопки выдачи, но НЕ содержит adm:ord_cancel и отключённую XTR adm:ord_refund
      const paidKbJson = JSON.stringify(buildAdminOrderActionKeyboard(paid.order));
      assert.equal(
        paidKbJson.includes(`adm:ord_proc:${order.orderId}`),
        true,
      );
      assert.equal(
        paidKbJson.includes(`adm:ord_refund:${order.orderId}`),
        false,
        'Кнопка возврата XTR adm:ord_refund должна быть удалена в Stage 4.2',
      );
      assert.equal(
        paidKbJson.includes(`adm:ord_cancel:${order.orderId}`),
        false,
        'Оплаченный заказ не должен иметь кнопки отмены adm:ord_cancel',
      );

      // Попытка отменить оплаченный заказ по старой кнопке отклоняется транзакцией
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: order.orderId,
            paymentStatus: 'cancelled',
            fulfillmentStatus: 'cancelled',
          });
        },
        /Невозможно отменить заказ.*уже имеет статус оплаты "paid"/,
      );

      // Перевод оплаченного заказа в processing разрешён
      const inProc = await OrderService.updateOrderStatus({
        orderId: order.orderId,
        fulfillmentStatus: 'processing',
      });
      assert.equal(inProc?.fulfillmentStatus, 'processing');

      // Завершаем выдачу
      const completed = await FulfillmentService.completeOrder({
        orderId: order.orderId,
        adminNote: 'Выдано',
      });
      assert.equal(completed.fulfillmentStatus, 'completed');

      // Попытка вернуть выполненный заказ обратно в processing блокируется
      await assert.rejects(
        async () => {
          await OrderService.updateOrderStatus({
            orderId: order.orderId,
            fulfillmentStatus: 'processing',
          });
        },
        /Невозможно вернуть уже выполненный заказ/,
      );

      return 'Оплаченный и выданный заказы защищены от отмены и отката статуса, XTR refund кнопка отсутствует.';
    },
  );

  await runTest(
    'A-03',
    'Payments',
    'AUD-004: Блокировка возврата XTR для неоплаченных и новых заказов (отсутствует telegram_payment_charge_id)',
    async () => {
      const pendingOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });

      const confirmKbJson = JSON.stringify(
        buildAdminOrderRefundConfirmKeyboard(pendingOrder),
      );
      assert.equal(confirmKbJson.includes('XTR отключён'), true);
      assert.equal(
        confirmKbJson.includes(`adm:ord_refund_confirm:${pendingOrder.orderId}`),
        false,
      );

      // Попытка выполнить XTR возврат блокируется
      await assert.rejects(
        async () => {
          await PaymentService.executeOrderRefund({
            orderId: pendingOrder.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: async () => {},
          });
        },
        /отсутствует исторический telegram_payment_charge_id/,
      );

      const cancelled = await OrderService.updateOrderStatus({
        orderId: pendingOrder.orderId,
        paymentStatus: 'cancelled',
        fulfillmentStatus: 'cancelled',
      });
      assert.equal(cancelled?.paymentStatus, 'cancelled');

      return 'XTR-подтверждение возврата отключено, вызов executeOrderRefund без исторического chargeId заблокирован.';
    },
  );

  await runTest(
    'A-04',
    'Payments',
    'AUD-004: Защита от повторного возврата и конкурентных запросов для исторического XTR-заказа',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });
      await seedLegacyPaidXtrOrderForRefundTest(order, 'chg_a04_concurrent_refund');

      let telegramApiRefundCalls = 0;
      const slowTelegramRefund = async () => {
        telegramApiRefundCalls++;
        await new Promise((resolve) => setTimeout(resolve, 35));
      };

      // Запускаем 4 одновременных запроса на возврат одного и того же исторического заказа
      const settled = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          PaymentService.executeOrderRefund({
            orderId: order.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: slowTelegramRefund,
          }),
        ),
      );

      const fulfilled = settled.filter(
        (
          s,
        ): s is PromiseFulfilledResult<{
          alreadyRefunded: boolean;
          order: Order;
        }> => s.status === 'fulfilled',
      );
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === 'rejected',
      );

      assert.equal(
        fulfilled.length,
        1,
        'Ровно 1 из параллельных запросов должен выполнить возврат',
      );
      assert.equal(fulfilled[0].value.alreadyRefunded, false);
      assert.equal(fulfilled[0].value.order.paymentStatus, 'refunded');
      assert.equal(
        rejected.length,
        3,
        'Остальные 3 параллельных запроса во время полёта первого должны быть заблокированы in-flight локом',
      );
      assert.ok(
        rejected.every((r) =>
          String(r.reason).includes('уже выполняется параллельным запросом'),
        ),
      );
      assert.equal(
        telegramApiRefundCalls,
        1,
        'Telegram API refundStarPayment должен быть вызван ровно 1 раз',
      );

      const secondAttempt = await PaymentService.executeOrderRefund({
        orderId: order.orderId,
        adminTelegramId: 777000111,
        callTelegramRefund: slowTelegramRefund,
      });
      assert.equal(secondAttempt.alreadyRefunded, true);
      assert.equal(telegramApiRefundCalls, 1);

      return `Из 4 конкурентных запросов ровно 1 выполнил исторический возврат (calls=${telegramApiRefundCalls}), 3 отклонены in-flight локом.`;
    },
  );

  // ===========================================================================
  // 6. STAGE 3.1: AUD-015, AUD-016, AUD-003, AUD-007 TESTS
  // ===========================================================================
  await runTest(
    'A-05',
    'Payments',
    'AUD-015: Распределённая блокировка возврата через Firestore transaction между двумя независимыми экземплярами PaymentService',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 1,
      });
      await seedLegacyPaidXtrOrderForRefundTest(order, 'chg_a05_distributed_lock');

      const serviceNodeA = new PaymentService('node-A');
      const serviceNodeB = new PaymentService('node-B');

      let telegramRefundCalls = 0;
      const simulatedTelegramRefund = async () => {
        telegramRefundCalls++;
        await new Promise((resolve) => setTimeout(resolve, 40));
      };

      const [resA, resB] = await Promise.allSettled([
        serviceNodeA.executeOrderRefund({
          orderId: order.orderId,
          adminTelegramId: 777000111,
          callTelegramRefund: simulatedTelegramRefund,
        }),
        serviceNodeB.executeOrderRefund({
          orderId: order.orderId,
          adminTelegramId: 777000111,
          callTelegramRefund: simulatedTelegramRefund,
        }),
      ]);

      const successes = [resA, resB].filter(
        (
          r,
        ): r is PromiseFulfilledResult<{
          alreadyRefunded: boolean;
          order: Order;
        }> => r.status === 'fulfilled',
      );
      const failures = [resA, resB].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.ok(
        String(failures[0].reason).includes(
          'уже выполняется параллельным запросом',
        ),
      );
      assert.equal(telegramRefundCalls, 1);

      const orderStuck = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      await seedLegacyPaidXtrOrderForRefundTest(orderStuck, 'chg_a05_expired_lock_guard');

      const veryOldTimestamp = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      await firestoreRepo.updateDoc<Order>('orders', orderStuck.orderId, {
        refundState: 'refund_in_progress',
        refundLockToken: 'rflock_crashed_node_old',
        refundStartedAt: veryOldTimestamp,
      });

      let duplicateTelegramCallOnExpiredLock = 0;
      await assert.rejects(
        async () => {
          await serviceNodeB.executeOrderRefund({
            orderId: orderStuck.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: async () => {
              duplicateTelegramCallOnExpiredLock++;
            },
          });
        },
        /уже выполняется параллельным запросом/,
      );
      assert.equal(duplicateTelegramCallOnExpiredLock, 0);

      await serviceNodeB.recoverPendingRefunds({
        quarantineStaleInProgress: true,
      });
      const quarantined = await OrderService.getOrderById(orderStuck.orderId);
      assert.equal(
        quarantined?.refundState,
        'refund_failed_needs_reconciliation',
      );
      assert.equal(quarantined?.needsManualReconciliation, true);

      return 'Распределённая блокировка в Firestore между node-A и node-B предотвратила двойной вызов (calls=1).';
    },
  );

  await runTest(
    'A-06',
    'Payments',
    'AUD-016: Устойчивое восстановление после сбоя Firestore вслед за подтверждённым историческим возвратом',
    async () => {
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_250',
        quantity: 2,
      });
      await seedLegacyPaidXtrOrderForRefundTest(order, 'chg_a06_tg_ok_db_fail');

      const userBeforeRefund = await UserService.getUserByTelegramId(buyer1.id);
      assert.ok(userBeforeRefund);
      const ordersBefore = userBeforeRefund.totalOrders;
      const spentBefore = userBeforeRefund.totalSpentStars;

      const paymentService = new PaymentService('node-recovery');
      let telegramRefundCalls = 0;

      await assert.rejects(
        async () => {
          await paymentService.executeOrderRefund({
            orderId: order.orderId,
            adminTelegramId: 777000111,
            callTelegramRefund: async () => {
              telegramRefundCalls++;
              firestoreRepo.setSimulatedFailure({
                writeError:
                  'Simulated Firestore UNAVAILABLE right after Telegram refundStarPayment succeeded',
              });
            },
          });
        },
        /Simulated Firestore UNAVAILABLE right after Telegram refundStarPayment succeeded/,
      );

      firestoreRepo.setSimulatedFailure({});
      assert.equal(telegramRefundCalls, 1);

      const orderMidCrash = await OrderService.getOrderById(order.orderId);
      assert.equal(orderMidCrash?.refundState, 'refund_in_progress');

      const recoveredOrders = await paymentService.recoverPendingRefunds();
      assert.ok(recoveredOrders.some((o) => o.orderId === order.orderId));

      const orderAfterRecovery = await OrderService.getOrderById(order.orderId);
      assert.equal(orderAfterRecovery?.paymentStatus, 'refunded');
      assert.equal(orderAfterRecovery?.fulfillmentStatus, 'refunded');
      assert.equal(orderAfterRecovery?.refundState, 'refunded');
      assert.equal(orderAfterRecovery?.refundStatsAdjusted, true);

      const retryAfterRecovery = await paymentService.executeOrderRefund({
        orderId: order.orderId,
        adminTelegramId: 777000111,
        callTelegramRefund: async () => {
          telegramRefundCalls++;
        },
      });
      assert.equal(retryAfterRecovery.alreadyRefunded, true);
      assert.equal(telegramRefundCalls, 1);

      const userAfterRecovery = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterRecovery?.totalOrders, ordersBefore - 1);
      assert.equal(
        userAfterRecovery?.totalSpentStars,
        spentBefore - order.totalPrice,
      );

      return 'После сбоя Firestore вслед за успешным ответом заказ, платёж и статистика консистентно восстановлены в refunded.';
    },
  );

  await runTest(
    'A-07',
    'Payments',
    'AUD-003: Корректное уменьшение статистики пользователя (totalOrders, totalSpentUsdCents) при возврате на баланс без двойного вычитания',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();

      // Зачислим $20.00 на внутренний баланс через seed
      await firestoreRepo.runTransaction(async (tx) => {
        const u = await tx.get<StoreUser>('users', `tg_${buyer1.id}`);
        const now = new Date().toISOString();
        tx.set<StoreUser>('users', `tg_${buyer1.id}`, {
          ...(u || {
            userId: `tg_${buyer1.id}`,
            telegramId: buyer1.id,
            firstName: buyer1.first_name,
            isBlocked: false,
            totalOrders: 0,
            totalSpentStars: 0,
            createdAt: now,
          }),
          balanceUsdCents: 2000,
          balance: 20,
          totalOrders: 0,
          totalSpentUsdCents: 0,
          updatedAt: now,
        });
      });

      const p1 = await bs.purchaseWithInternalBalance({
        telegramId: buyer1.id,
        productId: 'stars_pack_50', // $0.90 x 2 = $1.80 (180 cents)
        quantity: 2,
      });
      const p2 = await bs.purchaseWithInternalBalance({
        telegramId: buyer1.id,
        productId: 'stars_pack_250', // $4.20 (420 cents)
        quantity: 1,
      });

      const userAfterPayments = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterPayments?.totalOrders, 2);
      assert.equal(userAfterPayments?.totalSpentUsdCents, 600);

      await bs.refundOrderToInternalBalance({
        orderId: p2.order.orderId,
        reason: 'Тест уменьшения статистики USD',
        adminTelegramId: 777000111,
      });

      const userAfterFirstRefund = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterFirstRefund?.totalOrders, 1);
      assert.equal(userAfterFirstRefund?.totalSpentUsdCents, 180);

      // Повторный возврат НЕ должен уменьшать статистику повторно
      await bs.refundOrderToInternalBalance({
        orderId: p2.order.orderId,
        reason: 'Повтор',
        adminTelegramId: 777000111,
      });

      const userAfterDup = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(userAfterDup?.totalOrders, 1);
      assert.equal(userAfterDup?.totalSpentUsdCents, 180);

      void p1;
      return 'Статистика пользователя корректно уменьшена после возврата на баланс (2 -> 1 заказ, $6.00 -> $1.80), повторные вызовы не дублируют списание.';
    },
  );

  await runTest(
    'A-08',
    'Database',
    'AUD-007: Сохранение статистики пользователя (totalOrders, totalSpentUsdCents, isBlocked) при параллельном обновлении профиля и оплатах/возврате',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();

      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 10000,
        balance: 100,
      });

      // 4 параллельные покупки по $0.90 (90 cents) = $3.60 (360 cents) + 6 параллельных upsertFromTelegram
      const orders = await Promise.all(
        Array.from({ length: 4 }, (_, idx) =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_pack_50',
            quantity: 1,
            orderId: `ord_a08_conc_${idx}`,
          }),
        ),
      );
      await Promise.all(
        Array.from({ length: 6 }, (_, idx) =>
          UserService.upsertFromTelegram({
            id: buyer1.id,
            username: `buyer_one_updated_${idx}`,
            first_name: `Alex_${idx}`,
            last_name: 'Concurrent',
            language_code: 'ru',
          }),
        ),
      );

      const userAfterConcurrentWrites = await UserService.getUserByTelegramId(
        buyer1.id,
      );
      assert.ok(userAfterConcurrentWrites);
      assert.equal(userAfterConcurrentWrites.totalOrders, 4);
      assert.equal(userAfterConcurrentWrites.totalSpentUsdCents, 360);
      assert.ok(
        userAfterConcurrentWrites.username?.startsWith('buyer_one_updated_'),
      );

      await Promise.all([
        bs.refundOrderToInternalBalance({
          orderId: orders[0].order.orderId,
          reason: 'A08 refund',
          adminTelegramId: 777000111,
        }),
        UserService.setUserBlocked(buyer1.id, true),
        UserService.upsertFromTelegram({
          id: buyer1.id,
          username: 'buyer_one_final',
          first_name: 'AlexFinal',
          last_name: 'Concurrent',
          language_code: 'ru',
        }),
      ]);

      const userFinal = await UserService.getUserByTelegramId(buyer1.id);
      assert.ok(userFinal);
      assert.equal(userFinal.totalOrders, 3);
      assert.equal(userFinal.totalSpentUsdCents, 270);
      assert.equal(userFinal.isBlocked, true);
      assert.equal(userFinal.username, 'buyer_one_final');

      return 'Транзакционное обновление профиля сохранило 100% начислений и списаний (3 заказа, $2.70, isBlocked=true).';
    },
  );

  // ===========================================================================
  // 7. STAGE 3.2: BALANCE TOP-UP SYSTEM & PAYMENT PROVIDERS TESTS (B-01..B-15)
  // ===========================================================================
  const mockCreds = TEST_MOCK_CREDS;

  await runTest(
    'B-01',
    'Payments',
    'Проверка комиссий в USD (CryptoBot 3%, xRocket 2%), копеечной точности и минималистичного 3-шагового интерфейса пополнения без пресетов',
    async () => {
      const cb100 = calculateTopUpCommission(100, 'cryptobot');
      assert.equal(cb100.amountPaid, 100);
      assert.equal(cb100.feePercent, 3);
      assert.equal(cb100.feeAmount, 3);
      assert.equal(cb100.amountCredited, 97);

      const xr100 = calculateTopUpCommission(100, 'xrocket');
      assert.equal(xr100.amountPaid, 100);
      assert.equal(xr100.feePercent, 2);
      assert.equal(xr100.feeAmount, 2);
      assert.equal(xr100.amountCredited, 98);

      // Проверка дробных сумм без ошибок округления IEEE-754
      const cbFractional = calculateTopUpCommission(250.5, 'cryptobot');
      assert.equal(cbFractional.feeAmount, 7.52);
      assert.equal(cbFractional.amountCredited, 242.98);

      // Проверка кнопки «Пополнить баланс» в профиле пользователя
      const profileKbJson = JSON.stringify(buildUserProfileKeyboard());
      assert.ok(
        profileKbJson.includes('Пополнить баланс') &&
          profileKbJson.includes('menu:topup'),
        'Кнопка «Пополнить баланс» (menu:topup) должна присутствовать в профиле',
      );

      // Проверка каталога провайдеров (ровно 2 поддерживаемых провайдера: cryptobot и xrocket, presetAmounts пуст)
      assert.deepEqual(
        Object.keys(PAYMENT_PROVIDER_CATALOG).sort(),
        ['cryptobot', 'xrocket'],
      );
      assert.equal(PAYMENT_PROVIDER_CATALOG.cryptobot.feePercent, 3);
      assert.equal(PAYMENT_PROVIDER_CATALOG.xrocket.feePercent, 2);
      assert.equal(PAYMENT_PROVIDER_CATALOG.cryptobot.defaultCurrency, 'USD');
      assert.equal(PAYMENT_PROVIDER_CATALOG.xrocket.defaultCurrency, 'USDT');
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.cryptobot.presetAmounts, []);
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.xrocket.presetAmounts, []);

      // Проверка 3-шагового минималистичного интерфейса
      const step1Kb = JSON.stringify(buildTopUpStep1ProviderKeyboard());
      assert.ok(step1Kb.includes('CryptoBot [3%]'));
      assert.ok(step1Kb.includes('xRocket [2%]'));

      const step2Kb = JSON.stringify(
        buildTopUpStep2AmountKeyboard('xrocket', 100, 'USDT'),
      );
      assert.ok(step2Kb.includes('topup:xr_curr:100'));

      const step3XrKb = JSON.stringify(
        buildTopUpStep3XRocketCurrencyKeyboard(100),
      );
      assert.ok(step3XrKb.includes('USDT (TON)'));
      assert.ok(step3XrKb.includes('BTC (Bitcoin)'));

      return 'Комиссии провайдеров в USD проверены: CryptoBot $100.00 -> $97.00 (3%), xRocket $100.00 -> $98.00 (2%), пресеты удалены.';
    },
  );

  await runTest(
    'B-02',
    'Payments',
    'Успешное пополнение баланса в USD через CryptoBot (создание счёта -> подписанный webhook -> серверная проверка API -> атомарное зачисление)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 910001,
                status: 'active',
                amount: body.amount,
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV910001',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices') && req.method === 'GET') {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 910001,
                    status: 'paid',
                    amount: '100.00',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    payload: created.paymentId,
                    paid_at: new Date().toISOString(),
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const created = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        firstName: buyer1.first_name,
        provider: 'cryptobot',
        amountPaid: 100,
        currency: 'USD',
      });

      assert.equal(created.paymentStatus, 'pending');
      assert.equal(created.amountPaid, 100);
      assert.equal(created.amountUsd, 100);
      assert.equal(created.feePercent, 3);
      assert.equal(created.feeAmount, 3);
      assert.equal(created.amountCredited, 97);
      assert.equal(await service.getBalance(buyer1.id), 0);

      // Проверка минималистичной клавиатуры созданного счёта (3 кнопки)
      const invKb = JSON.stringify(buildTopUpInvoiceKeyboard(created));
      assert.ok(invKb.includes('Оплатить'));
      assert.ok(invKb.includes('Проверить оплату'));
      assert.ok(invKb.includes('Назад'));

      const webhookBody = JSON.stringify({
        update_id: 5001,
        update_type: 'invoice_paid',
        payload: {
          invoice_id: 910001,
          status: 'paid',
          amount: '100.00',
          fiat: 'USD',
          currency_type: 'fiat',
          payload: created.paymentId,
        },
      });
      const validSignature = computeCryptoBotWebhookSignature(
        webhookBody,
        mockCreds.cryptobotApiToken,
      );

      const res = await service.processWebhook({
        provider: 'cryptobot',
        rawBody: webhookBody,
        headers: { 'crypto-pay-api-signature': validSignature },
      });

      assert.equal(res.ok, true);
      assert.equal(res.duplicate, false);
      assert.equal(res.status, 'paid');
      assert.equal(res.newBalance, 97);
      assert.equal(await service.getBalance(buyer1.id), 97);

      const savedTopUp = await service.getTopUpById(created.paymentId);
      assert.equal(savedTopUp?.paymentStatus, 'paid');
      assert.ok(savedTopUp?.paidAt);

      return `Счёт ${created.paymentId} на $100.00 USD успешно подтверждён через серверный API CryptoBot, зачислено $97.00 (комиссия 3%).`;
    },
  );

  await runTest(
    'B-03',
    'Security',
    'Отклонение вебхука с неверной подписью (CryptoBot, xRocket) без зачисления средств',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let verifyApiCalled = 0;
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 910002,
                status: 'active',
                amount: body.amount,
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV910002',
                payload: body.payload,
              },
            },
          };
        }
        verifyApiCalled++;
        throw new Error('Verify API must not be called when webhook signature is invalid');
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const created = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        provider: 'cryptobot',
        amountPaid: 500,
        currency: 'USD',
      });

      const forgedRawBody = JSON.stringify({
        update_type: 'invoice_paid',
        payload: {
          invoice_id: 910002,
          status: 'paid',
          amount: '500.00',
          fiat: 'USD',
          currency_type: 'fiat',
          payload: created.paymentId,
        },
      });

      const forgedCrypto = await service.processWebhook({
        provider: 'cryptobot',
        rawBody: forgedRawBody,
        headers: { 'crypto-pay-api-signature': 'deadbeef0000invalid' },
      });
      assert.equal(forgedCrypto.ok, false);
      assert.equal(forgedCrypto.reason, 'INVALID_WEBHOOK_SIGNATURE');

      const forgedXRocket = await service.processWebhook({
        provider: 'xrocket',
        rawBody: forgedRawBody,
        headers: { 'rocket-pay-signature': 'bad_xrocket_sig' },
      });
      assert.equal(forgedXRocket.ok, false);
      assert.equal(forgedXRocket.reason, 'INVALID_WEBHOOK_SIGNATURE');

      assert.equal(verifyApiCalled, 0);
      assert.equal(await service.getBalance(buyer1.id), 0);

      return 'Поддельные вебхуки CryptoBot и xRocket отклонены с INVALID_WEBHOOK_SIGNATURE, баланс остался $0.00.';
    },
  );

  await runTest(
    'B-04',
    'Payments',
    'xRocket Pay REST API v1 (POST /api/v1/invoices, Bearer Auth, HTTP 201 Created, GET /api/v1/invoices?ids=..., защита от дублирования /api/v1 и идемпотентность)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // Проверка buildXRocketApiV1Url: отсутствие двойного /api/v1/api/v1
      assert.equal(
        buildXRocketApiV1Url(
          'https://pay.api.testnet.xrocket.exchange',
          '/invoices',
        ),
        'https://pay.api.testnet.xrocket.exchange/api/v1/invoices',
      );
      assert.equal(
        buildXRocketApiV1Url(
          'https://pay.api.testnet.xrocket.exchange/api/v1/',
          '/invoices',
        ),
        'https://pay.api.testnet.xrocket.exchange/api/v1/invoices',
      );

      let currentTopUpId = '';
      let capturedCreateRequest: HttpTransportRequest | null = null;

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00', TON: '5.00' } },
          };
        }
        if (
          req.url === 'https://pay.api.testnet.xrocket.exchange/api/v1/invoices' &&
          req.method === 'POST'
        ) {
          capturedCreateRequest = req;
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_inv_v1_404',
              priceAmount: String(body.priceAmount),
              priceCurrency: String(body.priceCurrency),
              payCurrencies: body.payCurrencies,
              clientInvoiceId: body.clientInvoiceId,
              status: 'PENDING',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
              links: {
                telegramBotLink: 'https://t.me/xrocket?start=inv_xr_inv_v1_404',
              },
            },
          };
        }
        if (
          req.url ===
            'https://pay.api.testnet.xrocket.exchange/api/v1/invoices?ids=xr_inv_v1_404' &&
          req.method === 'GET'
        ) {
          assert.equal(
            req.headers.Authorization,
            `Bearer ${mockCreds.xrocketApiKey}`,
          );
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_inv_v1_404',
                priceAmount: '100.00',
                priceCurrency: 'USDT',
                clientInvoiceId: currentTopUpId,
                status: 'PAID',
                paidAt: new Date().toISOString(),
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        provider: 'xrocket',
        amountPaid: 100,
        currency: 'USDT',
        network: 'TON',
      });
      currentTopUpId = topUp.paymentId;

      assert.ok(capturedCreateRequest, 'Запрос POST /api/v1/invoices должен быть выполнен');
      const sentReq = capturedCreateRequest as HttpTransportRequest;
      assert.equal(
        sentReq.headers.Authorization,
        `Bearer ${mockCreds.xrocketApiKey}`,
        'Должен использоваться заголовок Authorization: Bearer <TOKEN>',
      );
      const parsedSentBody = JSON.parse(sentReq.body || '{}') as Record<
        string,
        unknown
      >;
      assert.equal(parsedSentBody.priceAmount, '100.00');
      assert.equal(parsedSentBody.priceCurrency, 'USDT');
      assert.deepEqual(parsedSentBody.payCurrencies, ['USDT']);
      assert.equal(parsedSentBody.clientInvoiceId, topUp.paymentId);
      assert.equal(parsedSentBody.expiresIn, 1800000);
      assert.equal(
        topUp.payUrl,
        'https://t.me/xrocket?start=inv_xr_inv_v1_404',
      );
      assert.equal(topUp.network, 'TON');

      const rawBody = JSON.stringify({
        type: 'invoicePay',
        data: {
          id: 'xr_inv_v1_404',
          priceAmount: '100.00',
          priceCurrency: 'USDT',
          status: 'PAID',
          clientInvoiceId: topUp.paymentId,
        },
      });
      const sig = computeXRocketWebhookSignature(rawBody, mockCreds.xrocketApiKey);

      // Отправляем 3 одинаковых вебхука и 2 ручные проверки параллельно
      const results = await Promise.all([
        service.processWebhook({
          provider: 'xrocket',
          rawBody,
          headers: { 'rocket-pay-signature': sig },
        }),
        service.processWebhook({
          provider: 'xrocket',
          rawBody,
          headers: { 'rocket-pay-signature': sig },
        }),
        service.processWebhook({
          provider: 'xrocket',
          rawBody,
          headers: { 'rocket-pay-signature': sig },
        }),
        service.verifyAndProcessTopUp(topUp.paymentId),
        service.verifyAndProcessTopUp(topUp.paymentId),
      ]);

      const firstTimeCredits = results.filter((r) => r.ok && !r.duplicate);
      const duplicateCredits = results.filter((r) => r.ok && r.duplicate);

      assert.equal(
        firstTimeCredits.length,
        1,
        'Ровно 1 вызов должен выполнить первичное зачисление',
      );
      assert.equal(
        duplicateCredits.length,
        4,
        'Остальные 4 вызова должны идемпотентно вернуть duplicate=true',
      );
      assert.equal(
        await service.getBalance(buyer1.id),
        98,
        'Баланс должен быть пополнен ровно 1 раз на $98.00 (xRocket комиссия 2%)',
      );

      return 'xRocket Pay REST API v1 (POST /api/v1/invoices, Bearer Auth, HTTP 201 Created, links.telegramBotLink) проверен; из 5 параллельных вызовов баланс пополнен ровно 1 раз на $98.00.';
    },
  );

  await runTest(
    'B-05',
    'Security',
    'Диагностика структурированной ошибки xRocket Pay REST API v1 (HTTP 404 Problem Details: status, type, title, detail, instance, kind) и отклонение INVALID_AMOUNT',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // 1. Проверка парсинга HTTP 404 Problem Details от xRocket Pay REST API v1
      const errorTransport = async (): Promise<HttpTransportResponse> => ({
        status: 404,
        ok: false,
        json: {
          status: 404,
          type: 'https://pay.api.xrocket.exchange/errors/not-found',
          title: 'Not Found',
          detail: 'Merchant app or endpoint was not found in xRocket Pay',
          instance: '/api/v1/invoices',
          kind: 'NOT_FOUND',
        },
      });
      const errorGateway = new PaymentProviderGateway(errorTransport, mockCreds);

      let caughtError: unknown = null;
      try {
        await errorGateway.createInvoice({
          provider: 'xrocket',
          paymentId: 'topup_404_check',
          amountPaid: 100,
          currency: 'USDT',
          description: 'Test 404 Problem Details',
        });
      } catch (err) {
        caughtError = err;
      }

      assert.ok(
        caughtError instanceof XRocketApiError,
        'Ошибка xRocket HTTP 404 должна быть экземпляром XRocketApiError со структурированными полями Problem Details',
      );
      assert.equal(caughtError.httpStatus, 404);
      assert.equal(caughtError.problemDetails.status, 404);
      assert.equal(caughtError.problemDetails.title, 'Not Found');
      assert.equal(
        caughtError.problemDetails.detail,
        'Merchant app or endpoint was not found in xRocket Pay',
      );
      assert.equal(caughtError.problemDetails.instance, '/api/v1/invoices');
      assert.equal(caughtError.problemDetails.kind, 'NOT_FOUND');

      // 2. Проверка отклонения платежа с меньшей суммой (INVALID_AMOUNT)
      let currentTopUpId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 55001,
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                status: 'active',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV55001',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices') && req.method === 'GET') {
          // Провайдер возвращает меньшую сумму (50 вместо 200)
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 55001,
                    payload: currentTopUpId,
                    amount: '50.00',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    status: 'paid',
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        provider: 'cryptobot',
        amountPaid: 200,
        currency: 'USD',
      });
      currentTopUpId = topUp.paymentId;

      const check = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(check.ok, false);
      assert.equal(check.status, 'underpaid');
      assert.equal(check.reason, 'UNDERPAID');
      assert.equal(await service.getBalance(buyer1.id), 0);

      const updated = await service.getTopUpById(topUp.paymentId);
      assert.equal(updated?.paymentStatus, 'underpaid');

      return 'Структурированный ответ xRocket HTTP 404 (status, type, title, detail, instance, kind) сохраняется в XRocketApiError; недоплата заблокирована со статусом underpaid (UNDERPAID).';
    },
  );

  await runTest(
    'B-06',
    'Security',
    'Отклонение платежа с неверной валютой (INVALID_CURRENCY)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let currentTopUpId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'TRC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00' } },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_curr_606',
              priceAmount: String(body.priceAmount),
              priceCurrency: 'USDT',
              status: 'PENDING',
              clientInvoiceId: body.clientInvoiceId,
              links: {
                telegramBotLink: 'https://t.me/xrocket?start=xr_curr_606',
              },
            },
          };
        }
        if (
          req.url.includes('/api/v1/invoices?ids=xr_curr_606') &&
          req.method === 'GET'
        ) {
          // Провайдер возвращает TRX вместо ожидаемого USDT
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_curr_606',
                priceAmount: '100.00',
                priceCurrency: 'TRX',
                status: 'PAID',
                clientInvoiceId: currentTopUpId,
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        provider: 'xrocket',
        amountPaid: 100,
        currency: 'USDT',
      });
      currentTopUpId = topUp.paymentId;

      const check = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(check.ok, false);
      assert.equal(check.status, 'failed');
      assert.equal(check.reason, 'INVALID_CURRENCY');
      assert.equal(await service.getBalance(buyer1.id), 0);

      return 'Несовпадение валюты (ожидалась USDT, получена TRX) заблокировано с кодом INVALID_CURRENCY.';
    },
  );

  await runTest(
    'B-07',
    'Payments',
    'Обработка просроченного счёта (INVOICE_EXPIRED)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let currentTopUpId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 910007,
                status: 'active',
                amount: body.amount,
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=IV910007',
                payload: body.payload,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 910007,
                    status: 'expired',
                    amount: '100.00',
                    fiat: 'USD',
                    currency_type: 'fiat',
                    payload: currentTopUpId,
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        provider: 'cryptobot',
        amountPaid: 100,
        currency: 'USD',
      });
      currentTopUpId = topUp.paymentId;

      const check = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(check.ok, false);
      assert.equal(check.status, 'expired');
      assert.equal(check.reason, 'INVOICE_EXPIRED');
      assert.equal(await service.getBalance(buyer1.id), 0);

      const saved = await service.getTopUpById(topUp.paymentId);
      assert.equal(saved?.paymentStatus, 'expired');

      return 'Просроченный счёт переведён в статус expired (INVOICE_EXPIRED), средства не зачислены.';
    },
  );

  await runTest(
    'B-08',
    'Database',
    'Одновременные пополнения баланса одного пользователя через CryptoBot и xRocket (атомарность транзакций без потери начислений)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const invoicesByExtId = new Map<
        string,
        { paymentId: string; amount: number; currency: string }
      >();
      let seq = 1;

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: [
                { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
                { source: 'TON', target: 'USD', rate: '5.00', is_valid: true },
              ],
            },
          };
        }
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'TRC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00', TON: '5.00' } },
          };
        }
        if (req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          const extId = `ext_conc_${seq++}`;
          const paymentId = String(body.payload ?? body.clientInvoiceId ?? '');
          const amount = Number(body.amount ?? body.priceAmount ?? 100);

          if (req.url.includes('crypt.bot')) {
            const curr = String(body.fiat ?? body.asset ?? 'USD');
            invoicesByExtId.set(extId, { paymentId, amount, currency: curr });
            return {
              status: 200,
              ok: true,
              json: {
                ok: true,
                result: {
                  invoice_id: extId,
                  status: 'active',
                  amount: String(amount),
                  fiat: curr,
                  asset: curr,
                  currency_type: body.currency_type ?? 'fiat',
                  bot_invoice_url: `https://t.me/CryptoBot?start=${extId}`,
                },
              },
            };
          }
          if (req.url.includes('xrocket.exchange')) {
            invoicesByExtId.set(extId, { paymentId, amount, currency: 'USDT' });
            return {
              status: 201,
              ok: true,
              json: {
                id: extId,
                priceAmount: amount.toFixed(2),
                priceCurrency: 'USDT',
                clientInvoiceId: paymentId,
                status: 'PENDING',
                links: {
                  telegramBotLink: `https://t.me/xrocket?start=${extId}`,
                },
              },
            };
          }
        }

        // GET status verification
        for (const [extId, info] of invoicesByExtId.entries()) {
          if (req.url.includes(extId)) {
            if (req.url.includes('crypt.bot')) {
              return {
                status: 200,
                ok: true,
                json: {
                  ok: true,
                  result: {
                    items: [
                      {
                        invoice_id: extId,
                        status: 'paid',
                        amount: String(info.amount),
                        fiat: info.currency,
                        asset: info.currency,
                        currency_type: info.currency === 'USD' ? 'fiat' : 'crypto',
                        payload: info.paymentId,
                      },
                    ],
                  },
                },
              };
            }
            if (req.url.includes('xrocket.exchange')) {
              return {
                status: 200,
                ok: true,
                json: [
                  {
                    id: extId,
                    priceAmount: info.amount.toFixed(2),
                    priceCurrency: info.currency,
                    status: 'PAID',
                    clientInvoiceId: info.paymentId,
                  },
                ],
              };
            }
          }
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      // Создаём 3 счёта по $100.00:
      // CryptoBot #1 (3% -> +$97.00), CryptoBot #2 (3% -> +$97.00), xRocket (2% -> +$98.00). Итого: 97 + 97 + 98 = $292.00.
      const [tCrypto1, tCrypto2, tXRocket] = await Promise.all([
        service.createTopUp({
          telegramId: buyer1.id,
          provider: 'cryptobot',
          amountPaid: 100,
          currency: 'USD',
        }),
        service.createTopUp({
          telegramId: buyer1.id,
          provider: 'cryptobot',
          amountPaid: 100,
          currency: 'USDT',
        }),
        service.createTopUp({
          telegramId: buyer1.id,
          provider: 'xrocket',
          amountPaid: 100,
          currency: 'USDT',
        }),
      ]);

      // Одновременно подтверждаем все 3 пополнения
      const settled = await Promise.all([
        service.verifyAndProcessTopUp(tCrypto1.paymentId),
        service.verifyAndProcessTopUp(tCrypto2.paymentId),
        service.verifyAndProcessTopUp(tXRocket.paymentId),
      ]);

      assert.ok(settled.every((s) => s.ok && !s.duplicate));
      const finalBalance = await service.getBalance(buyer1.id);
      assert.equal(
        finalBalance,
        292,
        'Сумма параллельных зачислений ($97.00 + $97.00 + $98.00) должна составить ровно $292.00 без потери обновлений',
      );

      return 'Три параллельных пополнения через CryptoBot (+$97.00, +$97.00) и xRocket (+$98.00) атомарно зачислены: итоговый баланс $292.00.';
    },
  );

  await runTest(
    'B-09',
    'Payments',
    'Защита от двойного списания внутреннего баланса при параллельной оплате заказа ($4.20)',
    async () => {
      // На балансе buyer1 сейчас $292.00 (29200 cents) после теста B-08.
      // Покупаем товар stars_pack_250 ($4.20 = 420 cents) двумя параллельными запросами с одним orderId.
      const service = new BalanceService();
      const sharedOrderId = 'ord_bal_concurrent_b09';

      const [attempt1, attempt2] = await Promise.all([
        service.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          username: buyer1.username,
          firstName: buyer1.first_name,
          productId: 'stars_pack_250', // $4.20 = 420 cents
          quantity: 1,
          orderId: sharedOrderId,
        }),
        service.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          username: buyer1.username,
          firstName: buyer1.first_name,
          productId: 'stars_pack_250', // $4.20 = 420 cents
          quantity: 1,
          orderId: sharedOrderId,
        }),
      ]);

      const firstCalls = [attempt1, attempt2].filter((a) => !a.duplicate);
      const dupCalls = [attempt1, attempt2].filter((a) => a.duplicate);

      assert.equal(firstCalls.length, 1, 'Ровно один вызов должен списать баланс');
      assert.equal(dupCalls.length, 1, 'Второй параллельный вызов должен вернуть duplicate=true');
      assert.equal(
        await service.getBalanceUsdCents(buyer1.id),
        28780,
        'С баланса $292.00 должно списаться ровно $4.20 один раз (остаток $287.80)',
      );
      assert.equal(await service.getBalance(buyer1.id), 287.8);

      const userProfile = await UserService.getUserByTelegramId(buyer1.id);
      assert.equal(
        userProfile?.totalSpentStars,
        0,
        'Оплата с внутреннего баланса НЕ должна затрагивать legacy totalSpentStars',
      );
      assert.equal(userProfile?.totalSpentUsdCents, 420);

      return 'При параллельной оплате одного заказа баланс списан ровно 1 раз ($292.00 -> $287.80), повторный запрос вернул duplicate=true.';
    },
  );

  await runTest(
    'B-10',
    'Security',
    'Отказ при недостаточном внутреннем балансе и запрет ухода баланса в минус',
    async () => {
      const service = new BalanceService();
      assert.equal(await service.getBalanceUsdCents(buyer2.id), 0);

      await assert.rejects(
        async () => {
          await service.purchaseWithInternalBalance({
            telegramId: buyer2.id,
            username: buyer2.username,
            firstName: buyer2.first_name,
            productId: 'stars_pack_50',
            quantity: 1,
            orderId: 'ord_bal_insufficient_b10',
          });
        },
        /Недостаточно средств на внутреннем балансе/,
      );

      assert.equal(await service.getBalanceUsdCents(buyer2.id), 0);
      const nonExistentOrder = await OrderService.getOrderById(
        'ord_bal_insufficient_b10',
      );
      assert.equal(nonExistentOrder, null);

      return 'Попытка покупки при недостаточном балансе отклонена, заказ не создан, баланс остался $0.00.';
    },
  );

  await runTest(
    'B-11',
    'Payments',
    'Безопасный возврат заказа на внутренний баланс (refundOrderToInternalBalance) и защита от повторного возврата',
    async () => {
      const service = new BalanceService();
      const balanceBeforeCents = await service.getBalanceUsdCents(buyer1.id);
      assert.equal(balanceBeforeCents, 28780);

      const [ref1, ref2] = await Promise.all([
        service.refundOrderToInternalBalance({
          orderId: 'ord_bal_concurrent_b09',
          reason: 'Тестовый возврат на внутренний баланс',
          adminTelegramId: 777000111,
        }),
        service.refundOrderToInternalBalance({
          orderId: 'ord_bal_concurrent_b09',
          reason: 'Повторный параллельный запрос возврата',
          adminTelegramId: 777000111,
        }),
      ]);

      const primaryRefunds = [ref1, ref2].filter((r) => !r.alreadyRefunded);
      const duplicateRefunds = [ref1, ref2].filter((r) => r.alreadyRefunded);

      assert.equal(primaryRefunds.length, 1);
      assert.equal(duplicateRefunds.length, 1);

      const balanceAfterCents = await service.getBalanceUsdCents(buyer1.id);
      assert.equal(
        balanceAfterCents,
        29200,
        'После возврата заказа на $4.20 баланс должен восстановиться с $287.80 до $292.00 ровно 1 раз',
      );

      const refundedOrder = await OrderService.getOrderById(
        'ord_bal_concurrent_b09',
      );
      assert.equal(refundedOrder?.paymentStatus, 'refunded');
      assert.equal(refundedOrder?.fulfillmentStatus, 'refunded');
      assert.equal(refundedOrder?.balanceRefunded, true);

      return 'Возврат заказа на внутренний баланс выполнен атомарно ($287.80 -> $292.00), повторный вызов идемпотентно заблокирован.';
    },
  );

  await runTest(
    'B-12',
    'Security',
    'Свободный ввод суммы пополнения в USD ($0.50 – $50,000.00): полное удаление фиксированных пресетов и серверная валидация лимитов',
    async () => {
      assert.equal(MIN_TOPUP_AMOUNT_USD, 0.5);
      assert.equal(MAX_TOPUP_AMOUNT_USD, 50000);

      // 1. Полное отсутствие предложенных фиксированных сумм (100, 250, 500, 1000, 2500, 5000)
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.cryptobot.presetAmounts, []);
      assert.deepEqual(PAYMENT_PROVIDER_CATALOG.xrocket.presetAmounts, []);

      const emptyStep2Kb = JSON.stringify(
        buildTopUpStep2AmountKeyboard('cryptobot', undefined, 'USD'),
      );
      for (const preset of ['100', '250', '500', '1000', '2500', '5000']) {
        assert.equal(
          emptyStep2Kb.includes(`topup:amt:cryptobot:USD:${preset}`),
          false,
          `Кнопка фиксированной суммы ${preset} не должна присутствовать в клавиатуре Шага 2`,
        );
      }

      // 2. Валидация корректных сумм в USD (с поддержкой "$", точки и запятой)
      assert.equal(validateTopUpAmountUsd('0.50'), 0.5);
      assert.equal(validateTopUpAmountUsd('$10.00'), 10);
      assert.equal(validateTopUpAmountUsd('19,99'), 19.99);
      assert.equal(validateTopUpAmountUsd('100'), 100);
      assert.equal(validateTopUpAmountUsd('50000.00'), 50000);

      // 3. Серверный отказ для некорректных сумм (< $0.50, > $50,000.00, <= 0, текст, > 2 знаков после запятой)
      assert.throws(() => validateTopUpAmountUsd('0.49'), /Минимальная сумма пополнения: \$0\.50/);
      assert.throws(() => validateTopUpAmountUsd('0'), /положительным числом/);
      assert.throws(() => validateTopUpAmountUsd(-25), /положительным числом/);
      assert.throws(() => validateTopUpAmountUsd('50000.01'), /Максимальная сумма пополнения за одну операцию: \$50000\.00/);
      assert.throws(() => validateTopUpAmountUsd(10.999), /более 2 знаков после запятой/);
      assert.throws(() => validateTopUpAmountUsd('10.999'), /Введите корректную сумму в USD/);
      assert.throws(() => validateTopUpAmountUsd('abc'), /Введите корректную сумму в USD/);

      return 'Фиксированные пресеты сумм полностью удалены; серверная валидация USD ($0.50 – $50,000.00, не более 2 знаков) работает корректно.';
    },
  );

  await runTest(
    'B-13',
    'Payments',
    'Точный расчёт удержания комиссии в USD ($10.00, $19.99, $100.00) для CryptoBot (3%) и xRocket (2%) и автоматический пересчёт при смене способа оплаты',
    async () => {
      // CryptoBot 3% (зачисление = сумма * 0.97)
      const cb10 = calculateTopUpCommission(10.0, 'cryptobot');
      assert.equal(formatUsd(cb10.amountPaid), '$10.00');
      assert.equal(formatUsd(cb10.feeAmount), '$0.30');
      assert.equal(formatUsd(cb10.amountCredited), '$9.70');

      const cb1999 = calculateTopUpCommission(19.99, 'cryptobot');
      assert.equal(formatUsd(cb1999.amountPaid), '$19.99');
      assert.equal(formatUsd(cb1999.feeAmount), '$0.60');
      assert.equal(formatUsd(cb1999.amountCredited), '$19.39');

      const cb100 = calculateTopUpCommission(100.0, 'cryptobot');
      assert.equal(formatUsd(cb100.amountPaid), '$100.00');
      assert.equal(formatUsd(cb100.feeAmount), '$3.00');
      assert.equal(formatUsd(cb100.amountCredited), '$97.00');

      // xRocket 2% (зачисление = сумма * 0.98)
      const xr10 = calculateTopUpCommission(10.0, 'xrocket');
      assert.equal(formatUsd(xr10.amountPaid), '$10.00');
      assert.equal(formatUsd(xr10.feeAmount), '$0.20');
      assert.equal(formatUsd(xr10.amountCredited), '$9.80');

      const xr1999 = calculateTopUpCommission(19.99, 'xrocket');
      assert.equal(formatUsd(xr1999.amountPaid), '$19.99');
      assert.equal(formatUsd(xr1999.feeAmount), '$0.40');
      assert.equal(formatUsd(xr1999.amountCredited), '$19.59');

      const xr100 = calculateTopUpCommission(100.0, 'xrocket');
      assert.equal(formatUsd(xr100.amountPaid), '$100.00');
      assert.equal(formatUsd(xr100.feeAmount), '$2.00');
      assert.equal(formatUsd(xr100.amountCredited), '$98.00');

      // Автоматический пересчёт при переключении провайдера на Шаге 2
      const msgCrypto = formatTopUpStep2AmountMessage({
        provider: 'cryptobot',
        amountPaid: 100,
        currency: 'USD',
        providerConfigured: true,
      });
      assert.ok(msgCrypto.includes('$100.00'));
      assert.ok(msgCrypto.includes('−$3.00') || msgCrypto.includes('-$3.00'));
      assert.ok(msgCrypto.includes('+$97.00'));

      const msgXRocket = formatTopUpStep2AmountMessage({
        provider: 'xrocket',
        amountPaid: 100,
        currency: 'USDT',
        providerConfigured: true,
      });
      assert.ok(msgXRocket.includes('$100.00'));
      assert.ok(msgXRocket.includes('−$2.00') || msgXRocket.includes('-$2.00'));
      assert.ok(msgXRocket.includes('+$98.00'));

      return 'Расчёт комиссий в USD ($10.00, $19.99, $100.00) для CryptoBot (3%) и xRocket (2%) и автоматический пересчёт проверены.';
    },
  );

  await runTest(
    'B-14',
    'Payments',
    'Конвертация суммы из USD в криптовалюту провайдера (TON) по живому курсу с фиксацией и неизменной суммой зачисления в USD',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let currentTopUpId = '';
      let currentAmountToPay = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'TON', networks: ['TON'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { TON: '5.50' } },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentAmountToPay = String(body.priceAmount);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_ton_conv_1',
              priceAmount: currentAmountToPay,
              priceCurrency: 'TON',
              status: 'PENDING',
              clientInvoiceId: body.clientInvoiceId,
              links: {
                telegramBotLink: 'https://t.me/xrocket?start=xr_ton_conv_1',
              },
            },
          };
        }
        if (
          req.url.includes('/api/v1/invoices?ids=xr_ton_conv_1') &&
          req.method === 'GET'
        ) {
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_ton_conv_1',
                priceAmount: currentAmountToPay,
                priceCurrency: 'TON',
                status: 'PAID',
                clientInvoiceId: currentTopUpId,
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, mockCreds);
      const service = new BalanceService(gateway);

      // Проверка конвертации USD центов -> TON (10000 cents = $100.00 при 1 TON = $5.50 -> 18.1819 TON с точностью 4 знака)
      const tonConv = await gateway.getLiveUsdConversion({
        provider: 'xrocket',
        amountUsdCents: 10000,
        targetCurrency: 'TON',
        network: 'TON',
      });
      assert.equal(tonConv.amountUsdCents, 10000);
      assert.equal(tonConv.targetCurrency, 'TON');
      assert.equal(tonConv.exchangeRateUsdStr, '5.50');
      assert.equal(tonConv.convertedAmountStr, '18.1819');

      // Пользователь вводит $100.00 USD и выбирает оплату в TON через xRocket (комиссия 2% -> к зачислению $98.00)
      const topUp = await service.createTopUp({
        telegramId: buyer1.id,
        username: buyer1.username,
        provider: 'xrocket',
        amountUsdCents: 10000,
        currency: 'TON',
        network: 'TON',
      });
      currentTopUpId = topUp.paymentId;

      assert.equal(topUp.amountUsdCents, 10000);
      assert.equal(topUp.feeUsdCents, 200);
      assert.equal(topUp.amountCreditedUsdCents, 9800);
      assert.equal(topUp.currency, 'TON');
      assert.equal(topUp.exchangeRateUsdStr, '5.50');
      assert.equal(topUp.expectedAmountStr, '18.1819');

      // Карточка счёта уведомляет пользователя о курсе конвертации и фиксированной сумме зачисления в USD
      const invoiceCardHtml = formatTopUpInvoiceCardMessage(topUp);
      assert.ok(invoiceCardHtml.includes('$100.00'));
      assert.ok(invoiceCardHtml.includes('18.1819 TON'));
      assert.ok(invoiceCardHtml.includes('1 TON = $5.50'));
      assert.ok(invoiceCardHtml.includes('+$98.00'));

      // Проверяем подтверждение оплаты и зачисление строго зафиксированной суммы $98.00 USD (9800 cents)
      const verified = await service.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(verified.ok, true);
      assert.equal(verified.status, 'paid');
      assert.equal(verified.newBalanceUsdCents, 9800);
      assert.equal(await service.getBalanceUsdCents(buyer1.id), 9800);

      // История пополнений сохраняет и отображает исходную валюту оплаты (TON) и сумму в USD ($100.00 -> +$98.00)
      const historyHtml = formatUserTopUpHistoryMessage([verified.topUp], 98);
      assert.ok(historyHtml.includes('$100.00'));
      assert.ok(historyHtml.includes('+$98.00'));
      assert.ok(historyHtml.includes('TON'));

      return 'Живая конвертация $100.00 USD -> 18.1819 TON по курсу $5.50 проверена; на баланс зачислено ровно +$98.00 USD.';
    },
  );

  await runTest(
    'B-15',
    'Fulfillment',
    'Визуальный стиль OutlineEmoji во всех разделах бота и веб-интерфейса с брендом QuizyStars',
    async () => {
      // 1. Все иконки реестра OutlineEmoji формируют валидный тег <tg-emoji emoji-id="...">fallback</tg-emoji> и SVG
      const keys = Object.keys(OUTLINE_EMOJI_REGISTRY) as Array<
        keyof typeof OUTLINE_EMOJI_REGISTRY
      >;
      assert.ok(keys.length >= 30);
      for (const k of keys) {
        const tag = oe(k);
        assert.match(tag, /^<tg-emoji emoji-id="\d+">.+<\/tg-emoji>$/);
        assert.ok(oeBtn(k).length > 0);
        assert.ok(oeSvg(k, 18, 'oe-icon').includes('class="oe-icon"'));
      }

      // 2. Сообщения всех разделов используют <tg-emoji> и бренд QuizyStars (без Stars Shop)
      const welcomeHtml = formatWelcomeMessage('Alex', true);
      assert.ok(welcomeHtml.includes('QuizyStars'));
      assert.ok(!welcomeHtml.includes('Stars Shop'));
      assert.ok(welcomeHtml.includes('<tg-emoji emoji-id='));

      const userRecord = await UserService.getUserByTelegramId(buyer1.id);
      assert.ok(userRecord);
      const profileHtml = formatUserProfileMessage(userRecord, false);
      assert.ok(profileHtml.includes('<tg-emoji emoji-id='));
      assert.ok(profileHtml.includes('$98.00'));

      const catalogHtml = formatCatalogOverviewMessage();
      assert.ok(catalogHtml.includes('QuizyStars'));
      assert.ok(catalogHtml.includes('<tg-emoji emoji-id='));

      const termsHtml = formatTermsMessage();
      assert.ok(termsHtml.includes('QuizyStars'));
      assert.ok(termsHtml.includes('<tg-emoji emoji-id='));

      const helpHtml = formatHelpMessage();
      assert.ok(helpHtml.includes('QuizyStars'));
      assert.ok(helpHtml.includes('<tg-emoji emoji-id='));

      // 3. Проверка index.html на наличие мобильной числовой клавиатуры (inputmode="decimal") и бренда QUIZYSTARS
      const indexHtml = fs.readFileSync(
        path.resolve(process.cwd(), 'index.html'),
        'utf-8',
      );
      assert.ok(indexHtml.includes('inputmode="decimal"'));
      assert.ok(indexHtml.includes('QUIZYSTARS'));
      assert.ok(indexHtml.includes('oe-icon'));

      return `Набор OutlineEmoji (${keys.length} иконок <tg-emoji> и SVG) и бренд QuizyStars применены во всех разделах бота и веб-интерфейса.`;
    },
  );

  // ===========================================================================
  // 8. STAGE 3.3: ADMIN-ONLY KEY GENERATOR & AUTOMATIC DIGITAL KEY FULFILLMENT (K-01..K-08)
  // ===========================================================================
  const ownerTelegramId = 999000999;
  const nonOwnerAdminTelegramId = 777000111;
  process.env.OWNER_TELEGRAM_ID = String(ownerTelegramId);

  await runTest(
    'K-01',
    'Security',
    'Обычный пользователь (покупатель) не может открыть или использовать генератор и склад ключей',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      let deniedReply = '';
      const buyerCtx = {
        from: { id: buyer1.id, first_name: 'Buyer' },
        reply: async (text: string) => {
          deniedReply = text;
        },
      } as unknown as Context;

      const allowed = await ensureOwner(buyerCtx);
      assert.equal(allowed, false);
      assert.ok(deniedReply.includes('OWNER_TELEGRAM_ID'));

      await assert.rejects(
        async () => {
          await DigitalKeyService.addKeys({
            actorTelegramId: buyer1.id,
            productId: 'gift_star_box',
            keys: ['GIFT-BUYER-UNAUTHORIZED-01'],
          });
        },
        (err) => err instanceof OwnerAccessDeniedError,
      );

      await assert.rejects(
        async () => {
          await DigitalKeyService.generateKeys({
            actorTelegramId: buyer1.id,
            productId: 'gift_star_box',
            count: 1,
          });
        },
        (err) => err instanceof OwnerAccessDeniedError,
      );

      return 'Доступ обычного пользователя к ensureOwner, addKeys и generateKeys заблокирован на сервере (OwnerAccessDeniedError).';
    },
  );

  await runTest(
    'K-02',
    'Security',
    'Другой администратор из ADMIN_IDS (не являющийся OWNER_TELEGRAM_ID) не имеет доступа к генератору и складу ключей',
    async () => {
      // nonOwnerAdminTelegramId (777000111) входит в ADMIN_IDS, но НЕ равен OWNER_TELEGRAM_ID (999000999)
      const isRegularAdmin = await UserService.isAdmin(nonOwnerAdminTelegramId);
      assert.equal(isRegularAdmin, true);

      let callbackAlert = '';
      const adminCtx = {
        from: { id: nonOwnerAdminTelegramId, first_name: 'RegularAdmin' },
        callbackQuery: { id: 'cb_non_owner_1', data: 'own:keys:home' },
        answerCbQuery: async (text: string) => {
          callbackAlert = text;
        },
      } as unknown as Context;

      const allowed = await ensureOwner(adminCtx);
      assert.equal(allowed, false);
      assert.ok(callbackAlert.includes('OWNER_TELEGRAM_ID'));

      const nonOwnerAdminKb = JSON.stringify(buildAdminMainKeyboard(false));
      const ownerAdminKb = JSON.stringify(buildAdminMainKeyboard(true));
      assert.equal(nonOwnerAdminKb.includes('own:keys:home'), false);
      assert.equal(ownerAdminKb.includes('own:keys:home'), true);

      await assert.rejects(
        async () => {
          await DigitalKeyService.getProductStockSummary({
            actorTelegramId: nonOwnerAdminTelegramId,
            productId: 'gift_star_box',
          });
        },
        (err) => err instanceof OwnerAccessDeniedError,
      );

      return 'Обычный администратор из ADMIN_IDS (777000111) отклонён при попытке вызова ensureOwner и DigitalKeyService (OwnerAccessDeniedError).';
    },
  );

  await runTest(
    'K-03',
    'Fulfillment',
    'Владелец бота (OWNER_TELEGRAM_ID) может добавлять ключи вручную, генерировать ключи по алгоритму и отключать ключи',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // 1. Ручное добавление 2 ключей владельцем
      const manualKeys = await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'stars_pack_50',
        keys: ['STARS50-MANUAL-KEY-0001', 'STARS50-MANUAL-KEY-0002'],
      });
      assert.equal(manualKeys.length, 2);
      assert.equal(manualKeys[0].status, 'available');

      // 2. Генерация 3 ключей для товара с заданным алгоритмом (gift_star_box -> gift_voucher_v1)
      const generatedKeys = await DigitalKeyService.generateKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        count: 3,
      });
      assert.equal(generatedKeys.length, 3);
      for (const gk of generatedKeys) {
        assert.match(
          gk.keyValue,
          /^STARS-GIFT-GIFT-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{4}-[A-F0-9]{4}$/,
        );
        assert.equal(gk.status, 'available');
      }

      // 3. Попытка автогенерации для товара без внутреннего алгоритма (stars_pack_50) должна отклоняться
      await assert.rejects(
        async () => {
          await DigitalKeyService.generateKeys({
            actorTelegramId: ownerTelegramId,
            productId: 'stars_pack_50',
            count: 1,
          });
        },
        (err) => err instanceof UnsupportedKeyGeneratorError,
      );

      // 4. Отключение одного неиспользованного ключа владельцем
      const disabled = await DigitalKeyService.disableKey({
        actorTelegramId: ownerTelegramId,
        keyId: manualKeys[1].keyId,
      });
      assert.equal(disabled.status, 'disabled');

      const summary = await DigitalKeyService.getProductStockSummary({
        actorTelegramId: ownerTelegramId,
        productId: 'stars_pack_50',
      });
      assert.equal(summary.available, 1);
      assert.equal(summary.disabled, 1);

      return 'Владелец успешно добавил ключи вручную, сгенерировал 3 ключа по алгоритму gift_voucher_v1, отключил 1 ключ; генерация без алгоритма запрещена.';
    },
  );

  await runTest(
    'K-04',
    'Security',
    'Дубликаты ключей отклоняются как внутри одной пачки, так и при повторной загрузке существующего ключа',
    async () => {
      // Попытка загрузить дубликат уже существующего на складе ключа STARS50-MANUAL-KEY-0001
      await assert.rejects(
        async () => {
          await DigitalKeyService.addKeys({
            actorTelegramId: ownerTelegramId,
            productId: 'stars_pack_50',
            keys: ['STARS50-MANUAL-KEY-0001'],
          });
        },
        (err) => err instanceof DuplicateDigitalKeyError,
      );

      // Попытка загрузить пачку с одинаковыми ключами внутри одного запроса
      await assert.rejects(
        async () => {
          await DigitalKeyService.addKeys({
            actorTelegramId: ownerTelegramId,
            productId: 'stars_pack_50',
            keys: ['UNIQUE-BATCH-KEY-99', 'unique-batch-key-99'],
          });
        },
        (err) => err instanceof DuplicateDigitalKeyError,
      );

      return 'Повторная загрузка существующего ключа и дубликаты внутри одной пачки отклонены с DuplicateDigitalKeyError.';
    },
  );

  await runTest(
    'K-05',
    'Database',
    'Два одновременных заказа на один и тот же товар гарантированно получают разные ключи (отсутствие двойной выдачи)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        keys: ['GIFT-CONC-UNIQUE-KEY-A', 'GIFT-CONC-UNIQUE-KEY-B'],
      });

      const orderA = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const orderB = await OrderService.createOrder({
        telegramUser: buyer2,
        productId: 'gift_star_box',
        quantity: 1,
      });

      const paidA = await payOrderViaCryptoForTest(orderA, 'cryptobot', 'USD');
      const paidB = await payOrderViaCryptoForTest(orderB, 'cryptobot', 'USD');

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      // Запускаем выдачу обоих заказов одновременно
      const [resA, resB] = await Promise.all([
        FulfillmentService.initiateFulfillment(paidA.order, mockBot),
        FulfillmentService.initiateFulfillment(paidB.order, mockBot),
      ]);

      assert.equal(resA.fulfillmentStatus, 'completed');
      assert.equal(resB.fulfillmentStatus, 'completed');
      assert.equal(resA.deliveredKeyValues?.length, 1);
      assert.equal(resB.deliveredKeyValues?.length, 1);
      assert.notEqual(
        resA.deliveredKeyValues?.[0],
        resB.deliveredKeyValues?.[0],
        'Два параллельных заказа не должны получить один и тот же цифровой ключ',
      );
      assert.notEqual(resA.assignedKeyIds?.[0], resB.assignedKeyIds?.[0]);

      const stock = await DigitalKeyService.getProductStockSummary({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
      });
      assert.equal(stock.available, 0);
      assert.equal(stock.delivered, 2);

      return `Два параллельных заказа атомарно получили разные ключи (${resA.deliveredKeyValues?.[0]} и ${resB.deliveredKeyValues?.[0]}), остаток на складе: 0.`;
    },
  );

  await runTest(
    'K-06',
    'Fulfillment',
    'Повторный webhook или повторный вызов выдачи для того же заказа идемпотентен и не выдаёт второй ключ',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        keys: ['GIFT-IDEMPOTENT-KEY-1', 'GIFT-IDEMPOTENT-KEY-2'],
      });

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      const firstFulfill = await FulfillmentService.initiateFulfillment(
        paid.order,
        mockBot,
      );
      const secondFulfill = await DigitalKeyService.fulfillOrderWithDigitalKey(
        paid.order,
        mockBot,
      );

      assert.equal(firstFulfill.fulfillmentStatus, 'completed');
      assert.equal(secondFulfill.duplicate, true);
      assert.deepEqual(
        firstFulfill.assignedKeyIds,
        secondFulfill.order.assignedKeyIds,
      );
      assert.deepEqual(
        firstFulfill.deliveredKeyValues,
        secondFulfill.order.deliveredKeyValues,
      );

      const stock = await DigitalKeyService.getProductStockSummary({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
      });
      assert.equal(stock.available, 1);
      assert.equal(stock.delivered, 1);

      return 'Повторный вызов выдачи вернул duplicate=true с тем же ключом; второй ключ на складе остался доступным.';
    },
  );

  await runTest(
    'K-07',
    'Fulfillment',
    'Оплаченный заказ без доступных ключей НЕ помечается как выданный (остаётся processing + awaitingKeyStock=true) и уведомляет владельца',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const mockBot = createMockBot(sentMessages);

      const res = await DigitalKeyService.fulfillOrderWithDigitalKey(
        paid.order,
        mockBot,
      );

      assert.equal(res.fulfilled, false);
      assert.equal(res.awaitingStock, true);
      assert.notEqual(res.order.fulfillmentStatus, 'completed');
      assert.equal(res.order.fulfillmentStatus, 'processing');
      assert.equal(res.order.awaitingKeyStock, true);

      const ownerNotice = sentMessages.find(
        (m) => Number(m.chatId) === ownerTelegramId,
      );
      assert.ok(
        ownerNotice &&
          ownerNotice.text.includes('НЕХВАТКА ЦИФРОВЫХ КЛЮЧЕЙ НА СКЛАДЕ'),
      );

      return 'Оплаченный заказ при пустом складе переведён в processing (awaitingKeyStock=true), владельцу отправлено уведомление.';
    },
  );

  await runTest(
    'K-08',
    'Fulfillment',
    'Ошибка отправки сообщения Telegram не приводит к потере выданного ключа (ключ остаётся привязанным к заказу в БД)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      await DigitalKeyService.addKeys({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        keys: ['GIFT-RESILIENT-KEY-777'],
      });

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');

      const failingBot = createMockBot([], true);

      const fulfilled = await FulfillmentService.initiateFulfillment(
        paid.order,
        failingBot,
      );

      assert.equal(fulfilled.fulfillmentStatus, 'completed');
      assert.deepEqual(fulfilled.deliveredKeyValues, ['GIFT-RESILIENT-KEY-777']);
      assert.equal(fulfilled.assignedKeyIds?.length, 1);

      const savedOrder = await OrderService.getOrderById(order.orderId);
      assert.deepEqual(savedOrder?.deliveredKeyValues, ['GIFT-RESILIENT-KEY-777']);

      const deliveredKeys = await DigitalKeyService.listKeysForProduct({
        actorTelegramId: ownerTelegramId,
        productId: 'gift_star_box',
        status: 'delivered',
      });
      assert.equal(deliveredKeys.length, 1);
      assert.equal(deliveredKeys[0].deliveredOrderId, order.orderId);
      assert.equal(deliveredKeys[0].deliveredUserTelegramId, buyer1.id);

      return 'При сбое Telegram API (502) выданный ключ GIFT-RESILIENT-KEY-777 сохранён в заказе и имеет статус delivered.';
    },
  );

  // ===========================================================================
  // 9. STAGE 4.2: PAYMENT INFRASTRUCTURE & FINANCIAL FOUNDATION TESTS (S42-01..S42-17)
  // ===========================================================================
  await runTest(
    'S42-01',
    'Payments',
    'CryptoBot: живой курс GET /getExchangeRates и повторное использование активного pending-счёта заказа',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let createCalls = 0;

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: [
                { source: 'TON', target: 'USD', rate: '5.50', is_valid: true },
                { source: 'USDT', target: 'USD', rate: '1.00', is_valid: true },
              ],
            },
          };
        }
        if (req.url.endsWith('/createInvoice')) {
          createCalls++;
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: `cb_reuse_${createCalls}`,
                status: 'active',
                amount: String(body.amount),
                asset: 'TON',
                currency_type: 'crypto',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_reuse_1',
                payload: body.payload,
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-01', gateway);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m', // $13.90 = 1390 cents
        quantity: 1,
        recipientUsername: '@QuizyBuyer',
      });

      const first = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'TON',
      });
      assert.equal(first.reused, false);
      assert.equal(first.payment.expectedUsdCents, 1390);
      assert.equal(first.payment.exchangeRateUsdStr, '5.50');
      // $13.90 / $5.50 = 2.527272... -> ceil at 4 decimals = 2.5273 TON
      assert.equal(first.payment.expectedAmountStr, '2.5273');

      const second = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'TON',
      });
      assert.equal(second.reused, true);
      assert.equal(second.payment.paymentId, first.payment.paymentId);
      assert.equal(createCalls, 1);

      return 'CryptoBot /getExchangeRates пересчитал $13.90 -> 2.5273 TON (курс 5.50); повторный вызов переиспользовал активный счёт без дубля /createInvoice.';
    },
  );

  await runTest(
    'S42-02',
    'Payments',
    'xRocket: живые курсы /api/v1/rates, валидация сетей /api/v1/currencies и формат вебхука InvoiceWebhookDto',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let currentPaymentId = '';
      let expectedPayAmount = '';

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [
              { currency: 'USDT', networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'] },
              { currency: 'TON', networks: ['TON'] },
            ],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return {
            status: 200,
            ok: true,
            json: { data: { USDT: '1.00', TON: '5.00' } },
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentPaymentId = String(body.clientInvoiceId);
          expectedPayAmount = String(body.priceAmount);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_s42_02_dto',
              priceAmount: expectedPayAmount,
              priceCurrency: 'USDT',
              status: 'PENDING',
              clientInvoiceId: currentPaymentId,
              links: { telegramBotLink: 'https://t.me/xrocket?start=xr_s42_02_dto' },
            },
          };
        }
        if (req.url.includes('/api/v1/invoices?ids=xr_s42_02_dto')) {
          return {
            status: 200,
            ok: true,
            json: [
              {
                id: 'xr_s42_02_dto',
                priceAmount: expectedPayAmount,
                priceCurrency: 'USDT',
                network: 'TRC-20',
                status: 'PAID',
                clientInvoiceId: currentPaymentId,
                payment: {
                  amount: expectedPayAmount,
                  currency: 'USDT',
                  network: 'TRC-20',
                  feeInUsd: '0.15',
                },
              },
            ],
          };
        }
        throw new Error(`Unexpected: ${req.method} ${req.url}`);
      };

      const gateway = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-02', gateway);

      // Несовместимая сеть (TON в сети TRC-20) должна отклоняться
      await assert.rejects(
        async () => {
          await gateway.validateCurrencyAndNetwork('xrocket', 'TON', 'TRC-20');
        },
        /Сеть TRC-20 не поддерживается для TON/,
      );

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_6m', // $19.90 = 1990 cents
        quantity: 1,
        recipientUsername: 'valid_user_99',
      });

      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'xrocket',
        currency: 'USDT',
        network: 'TRC-20',
      });
      assert.equal(created.payment.network, 'TRC-20');
      assert.equal(created.payment.expectedAmountStr, '19.90');

      const webhookRaw = JSON.stringify({
        type: 'invoice',
        timestamp: new Date().toISOString(),
        data: {
          event: 'invoice.paid',
          invoice: {
            id: 'xr_s42_02_dto',
            priceAmount: '19.90',
            priceCurrency: 'USDT',
            clientInvoiceId: created.payment.paymentId,
            status: 'PAID',
          },
          payment: {
            amount: '19.90',
            currency: 'USDT',
            network: 'TRC-20',
            feeInUsd: '0.15',
          },
        },
      });
      const sig = computeXRocketWebhookSignature(
        webhookRaw,
        TEST_MOCK_CREDS.xrocketApiKey,
      );

      const processed = await ps.processOrderWebhook({
        provider: 'xrocket',
        rawBody: webhookRaw,
        headers: { 'rocket-pay-signature': sig },
      });
      assert.equal(processed.ok, true);
      assert.equal(processed.order?.paymentStatus, 'paid');
      assert.equal(processed.order?.providerFeeUsdCents, 15);
      assert.equal(processed.order?.grossRevenueUsdCents, 1990);

      return 'xRocket /api/v1/currencies, /api/v1/rates, валидация сетей и официальный формат InvoiceWebhookDto проверены.';
    },
  );

  await runTest(
    'S42-03',
    'Security',
    'Нулевой статический fallback курсов: ошибка живого API выбрасывает ExchangeRateUnavailableError (HTTP 503)',
    async () => {
      const failingTransport = async (): Promise<HttpTransportResponse> => ({
        status: 503,
        ok: false,
        json: { error: { name: 'SERVICE_UNAVAILABLE' } },
      });
      const gw = new PaymentProviderGateway(failingTransport, TEST_MOCK_CREDS);

      await assert.rejects(
        async () => {
          await gw.getLiveUsdConversion({
            provider: 'cryptobot',
            amountUsdCents: 1000,
            targetCurrency: 'TON',
          });
        },
        (err) =>
          err instanceof ExchangeRateUnavailableError &&
          err.code === 'EXCHANGE_RATE_UNAVAILABLE',
      );

      const { res, getStatus, getJson } = createMockExpressRes();
      const fakeReq = {
        body: { provider: 'xrocket', amountUsd: '10.00', currency: 'TON', network: 'TON' },
      } as unknown as Request;
      await handleTopUpCalculateRequest(fakeReq, res, { gateway: gw });
      assert.equal(getStatus(), 503);
      assert.equal(
        (getJson() as { code?: string })?.code,
        'EXCHANGE_RATE_UNAVAILABLE',
      );

      return 'При недоступности курсов провайдеров статические курсы не используются; выбрасывается ExchangeRateUnavailableError (HTTP 503).';
    },
  );

  await runTest(
    'S42-04',
    'Payments',
    'Точная целочисленная арифметика центов USD ($0.50, $19.99, $100.00) без ошибок IEEE-754',
    async () => {
      assert.equal(usdInputToCents('$0.50'), 50);
      assert.equal(usdInputToCents('19,99'), 1999);
      assert.equal(usdInputToCents('100.00'), 10000);
      assert.equal(formatUsdCents(1999), '$19.99');
      assert.equal(centsToUsdString(50), '0.50');

      const cb050 = calculateTopUpCommissionCents(50, 'cryptobot');
      assert.equal(cb050.feeUsdCents, 2);
      assert.equal(cb050.amountCreditedUsdCents, 48);

      const cb1999 = calculateTopUpCommissionCents(1999, 'cryptobot');
      assert.equal(cb1999.feeUsdCents, 60);
      assert.equal(cb1999.amountCreditedUsdCents, 1939);

      const xr1999 = calculateTopUpCommissionCents(1999, 'xrocket');
      assert.equal(xr1999.feeUsdCents, 40);
      assert.equal(xr1999.amountCreditedUsdCents, 1959);

      const rawBps = bpsFeeAndNetCents(10000, 300);
      assert.equal(rawBps.feeCents, 300);
      assert.equal(rawBps.netCents, 9700);

      assert.equal(validateTopUpAmountUsdCents('0.50'), 50);
      assert.equal(validateTopUpAmountUsdCents('50000.00'), 5_000_000);

      const conv = convertUsdCentsToCryptoScaled({
        amountUsdCents: 1999,
        rateUsdStr: '5.50',
        targetCurrency: 'TON',
      });
      assert.equal(compareScaledDecimal(conv.amountStr, '3.6346'), 0);

      return 'Все суммы и комиссии в центах USD и BigInt 10^18 вычислены точно без погрешностей float.';
    },
  );

  await runTest(
    'S42-05',
    'Security',
    'Недоплата (partially_paid / сумма < expectedAmountStr): заказ остаётся pending, баланс не пополняется',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/rates')) {
          return { status: 200, ok: true, json: { data: { TON: '5.00' } } };
        }
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'TON', networks: ['TON'] }],
          };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.clientInvoiceId);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_underpaid_1',
              priceAmount: String(body.priceAmount), // 2.78 TON for $13.90 @ 5.00
              priceCurrency: 'TON',
              status: 'PENDING',
              clientInvoiceId: paymentId,
              links: { telegramBotLink: 'https://t.me/xrocket?start=xr_underpaid_1' },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: [
            {
              id: 'xr_underpaid_1',
              priceAmount: '2.78',
              paidAmount: '1.50',
              priceCurrency: 'TON',
              status: 'partially_paid',
              clientInvoiceId: paymentId,
            },
          ],
        };
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-05', gw);
      const bs = new BalanceService(gw);

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m',
        quantity: 1,
      });
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'xrocket',
        currency: 'TON',
        network: 'TON',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'underpaid');
      assert.equal(res.reason, 'UNDERPAID');

      const savedOrder = await OrderService.getOrderById(order.orderId);
      assert.equal(savedOrder?.paymentStatus, 'pending');
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 0);

      return 'Частичная оплата (1.50 вместо 2.78 TON) заблокирована со статусом underpaid, заказ не активирован.';
    },
  );

  await runTest(
    'S42-06',
    'Payments',
    'Переплата (paidAmount > expectedAmountStr): пополнение/заказ закрываются строго на контрактную сумму USD',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let topupId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: { ok: true, result: [{ source: 'TON', target: 'USD', rate: '5.00', is_valid: true }] },
          };
        }
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          topupId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'cb_over_1',
                status: 'active',
                amount: '2.00',
                asset: 'TON',
                currency_type: 'crypto',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_over_1',
                payload: topupId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'cb_over_1',
                  status: 'paid',
                  amount: '2.00',
                  paid_amount: '3.50', // покупатель прислал больше TON
                  asset: 'TON',
                  paid_asset: 'TON',
                  currency_type: 'crypto',
                  payload: topupId,
                },
              ],
            },
          },
        };
      };

      const bs = new BalanceService(new PaymentProviderGateway(transport, TEST_MOCK_CREDS));
      const topUp = await bs.createTopUp({
        telegramId: buyer1.id,
        provider: 'cryptobot',
        amountUsdCents: 1000, // $10.00 -> после 3% комиссии $9.70 (970 cents)
        currency: 'TON',
      });
      const verified = await bs.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(verified.ok, true);
      assert.equal(verified.status, 'overpaid');
      assert.equal(
        verified.newBalanceUsdCents,
        970,
        'При переплате в криптовалюте зачисляется строго оговорённые $9.70 (970 центов)',
      );

      return 'Переплата зафиксирована статусом overpaid; баланс пополнен строго на контрактные 970 центов ($9.70).';
    },
  );

  await runTest(
    'S42-07',
    'Payments',
    'Просроченный счёт заказа (expired / expiresAt в прошлом) отклоняется без закрытия заказа',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let paymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          paymentId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'cb_exp_ord_1',
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_exp_ord_1',
                payload: paymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: 'cb_exp_ord_1',
                  status: 'expired',
                  amount: '0.90',
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: paymentId,
                },
              ],
            },
          },
        };
      };

      const ps = new PaymentService('s42-07', new PaymentProviderGateway(transport, TEST_MOCK_CREDS));
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const created = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      const res = await ps.verifyAndProcessOrderPayment(created.payment.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'expired');
      assert.equal(res.reason, 'INVOICE_EXPIRED');

      const unchanged = await OrderService.getOrderById(order.orderId);
      assert.equal(unchanged?.paymentStatus, 'pending');

      return 'Просроченный инвойс по заказу переведён в expired (INVOICE_EXPIRED), заказ остался pending.';
    },
  );

  await runTest(
    'S42-08',
    'Security',
    'Несоответствие валюты или сети в ответе провайдера (INVALID_NETWORK) блокирует зачисление',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let topupId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/api/v1/currencies')) {
          return {
            status: 200,
            ok: true,
            json: [{ currency: 'USDT', networks: ['TON', 'ERC-20', 'TRC-20'] }],
          };
        }
        if (req.url.endsWith('/api/v1/rates')) {
          return { status: 200, ok: true, json: { data: { USDT: '1.00' } } };
        }
        if (req.url.endsWith('/api/v1/invoices') && req.method === 'POST') {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          topupId = String(body.clientInvoiceId);
          return {
            status: 201,
            ok: true,
            json: {
              id: 'xr_bad_net_1',
              priceAmount: String(body.priceAmount),
              priceCurrency: 'USDT',
              status: 'PENDING',
              clientInvoiceId: topupId,
              links: { telegramBotLink: 'https://t.me/xrocket?start=xr_bad_net_1' },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: [
            {
              id: 'xr_bad_net_1',
              priceAmount: '10.00',
              priceCurrency: 'USDT',
              network: 'ERC-20', // ожидалась TON
              status: 'PAID',
              clientInvoiceId: topupId,
            },
          ],
        };
      };

      const bs = new BalanceService(new PaymentProviderGateway(transport, TEST_MOCK_CREDS));
      const topUp = await bs.createTopUp({
        telegramId: buyer1.id,
        provider: 'xrocket',
        amountUsdCents: 1000,
        currency: 'USDT',
        network: 'TON',
      });
      const res = await bs.verifyAndProcessTopUp(topUp.paymentId);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'failed');
      assert.equal(res.reason, 'INVALID_NETWORK');
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 0);

      return 'Подмена сети (ERC-20 вместо TON) отклонена с кодом INVALID_NETWORK.';
    },
  );

  await runTest(
    'S42-09',
    'Security',
    'Неверная подпись HMAC-SHA256 вебхука заказа отклоняется ДО любых исходящих HTTP-запросов (HTTP 401)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let outboundApiCalls = 0;
      const transport = async (): Promise<HttpTransportResponse> => {
        outboundApiCalls++;
        throw new Error('Must never make outbound API calls on forged signature');
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-09', gw);
      const bs = new BalanceService(gw);

      const forgedRaw = JSON.stringify({
        update_type: 'invoice_paid',
        payload: { invoice_id: 'cb_fake_99', status: 'paid', payload: 'ordpay_fake' },
      });

      const directOrderRes = await ps.processOrderWebhook({
        provider: 'cryptobot',
        rawBody: forgedRaw,
        headers: { 'crypto-pay-api-signature': '0000bad_signature' },
      });
      assert.equal(directOrderRes.ok, false);
      assert.equal(directOrderRes.reason, 'INVALID_WEBHOOK_SIGNATURE');

      const { res, getStatus } = createMockExpressRes();
      const fakeReq = {
        rawBody: forgedRaw,
        body: JSON.parse(forgedRaw),
        headers: { 'rocket-pay-signature': 'forged_xr_sig' },
      } as unknown as Request;
      await handleProviderWebhookRequest('xrocket', fakeReq, res, {
        balanceSvc: bs,
        paymentSvc: ps,
      });
      assert.equal(getStatus(), 401);
      assert.equal(outboundApiCalls, 0);

      return 'Невалидные HMAC-подписи вебхуков отклонены со статусом 401 с нулём исходящих API-вызовов.';
    },
  );

  await runTest(
    'S42-10',
    'Database',
    'Атомарный захват payment_locks: защита от конкурентных вебхуков и повторного использования одного externalInvoiceId в другом заказе',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const sharedExtId = 'cb_shared_ext_lock_777';
      let currentPaymentId = '';

      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentPaymentId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: sharedExtId,
                status: 'active',
                amount: String(body.amount),
                fiat: 'USD',
                currency_type: 'fiat',
                bot_invoice_url: `https://t.me/CryptoBot?start=${sharedExtId}`,
                payload: currentPaymentId,
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: {
            ok: true,
            result: {
              items: [
                {
                  invoice_id: sharedExtId,
                  status: 'paid',
                  amount: '0.90',
                  fiat: 'USD',
                  currency_type: 'fiat',
                  payload: currentPaymentId,
                },
              ],
            },
          },
        };
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const ps = new PaymentService('s42-10', gw);

      const order1 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const inv1 = await ps.createOrReuseOrderPayment({
        orderId: order1.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });

      const [r1, r2, r3] = await Promise.all([
        ps.verifyAndProcessOrderPayment(inv1.payment.paymentId),
        ps.verifyAndProcessOrderPayment(inv1.payment.paymentId),
        ps.verifyAndProcessOrderPayment(inv1.payment.paymentId),
      ]);
      assert.equal([r1, r2, r3].filter((r) => r.ok && !r.duplicate).length, 1);

      // Пробуем привязать тот же externalInvoiceId ко второму заказу
      const order2 = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const inv2 = await ps.createOrReuseOrderPayment({
        orderId: order2.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'USD',
      });
      await assert.rejects(
        async () => {
          await ps.verifyAndProcessOrderPayment(inv2.payment.paymentId);
        },
        /PAYMENT_LOCK_CONFLICT/,
      );

      return 'Уникальная блокировка payment_locks/ext_cryptobot_* гарантировала однократную оплату заказа и заблокировала конфликт другого заказа (PAYMENT_LOCK_CONFLICT).';
    },
  );

  await runTest(
    'S42-11',
    'Payments',
    'Внутренний баланс USD: покупка ($100.00 - $13.90 = $86.10), отказ при нехватке и защита от двойного клика',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();
      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 10000,
        balance: 100,
      });

      const [a, b] = await Promise.all([
        bs.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          productId: 'premium_3m', // 1390 cents
          quantity: 1,
          orderId: 'ord_s42_11_shared',
          recipientUsername: '@QuizyReceiver',
        }),
        bs.purchaseWithInternalBalance({
          telegramId: buyer1.id,
          productId: 'premium_3m',
          quantity: 1,
          orderId: 'ord_s42_11_shared',
          recipientUsername: '@QuizyReceiver',
        }),
      ]);

      assert.equal([a, b].filter((x) => !x.duplicate).length, 1);
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 8610);

      await assert.rejects(
        async () => {
          await bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            quantity: 5000, // 10000 > 8610
            recipientUsername: '@QuizyReceiver',
          });
        },
        /Недостаточно средств/,
      );
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 8610);

      return 'Покупка с внутреннего баланса списала ровно 1390 центов (остаток 8610), защита от двойного клика и отрицательного баланса подтверждена.';
    },
  );

  await runTest(
    'S42-12',
    'Payments',
    'Возврат на внутренний баланс USD и запрет автоматического возврата внешних крипто-заказов',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();
      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 5000,
        balance: 50,
      });

      const paidBal = await bs.purchaseWithInternalBalance({
        telegramId: buyer1.id,
        productId: 'premium_6m', // $19.90 = 1990 cents
        quantity: 1,
      });
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 3010);

      const refunded = await bs.refundOrderToInternalBalance({
        orderId: paidBal.order.orderId,
        reason: 'Возврат теста S42-12',
        adminTelegramId: 777000111,
      });
      assert.equal(refunded.alreadyRefunded, false);
      assert.equal(refunded.newBalanceUsdCents, 5000);

      const dupRefund = await bs.refundOrderToInternalBalance({
        orderId: paidBal.order.orderId,
        reason: 'Повтор',
      });
      assert.equal(dupRefund.alreadyRefunded, true);
      assert.equal(await bs.getBalanceUsdCents(buyer1.id), 5000);

      // Крипто-заказ нельзя вернуть через автовозврат на внутренний баланс
      const cryptoOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      await payOrderViaCryptoForTest(cryptoOrder, 'cryptobot', 'USD');
      await assert.rejects(
        async () => {
          await bs.refundOrderToInternalBalance({
            orderId: cryptoOrder.orderId,
            reason: 'Попытка автовозврата крипты',
          });
        },
        /Автоматический возврат криптовалютных платежей не поддерживается/,
      );

      return 'Возврат на баланс идемпотентно восстановил 5000 центов; крипто-заказ защищён от автовозврата.';
    },
  );

  await runTest(
    'S42-13',
    'Payments',
    'Каталог QuizyStars: stars_custom (50..100000 @ $0.02), Premium 3/6/12 мес и нормализация @recipientUsername',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      const customProd = await ProductService.getProductById('stars_custom');
      const p3 = await ProductService.getProductById('premium_3m');
      const p6 = await ProductService.getProductById('premium_6m');
      const p12 = await ProductService.getProductById('premium_12m');
      assert.ok(customProd && p3 && p6 && p12);
      assert.equal(p3.priceUsdCents, 1390);
      assert.equal(p6.priceUsdCents, 1990);
      assert.equal(p12.priceUsdCents, 3490);

      const orderCustom = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 150,
        recipientUsername: '@QuizyStars_Recipient',
      });
      assert.equal(orderCustom.totalPriceUsdCents, 300); // 150 * 2 cents = $3.00
      assert.equal(orderCustom.recipientUsername, 'quizystars_recipient');

      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 49,
          }),
        /допустимо от 50 до 100000/,
      );
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 100001,
          }),
        /допустимо от 50 до 100000/,
      );

      assert.equal(normalizeRecipientUsername('  @Alice_Test '), 'alice_test');
      assert.throws(() => normalizeRecipientUsername('ab'), /Некорректный @username/);

      return 'Проверены цены stars_custom (150 шт = $3.00, лимит 50..100000), Premium ($13.90/$19.90/$34.90) и валидация @username.';
    },
  );

  await runTest(
    'S42-14',
    'Database',
    'Подготовка P&L и MyStars FaaS полей заказа (mystarsPaymentCurrency = usdt_ton, без HTTP-вызовов к api.mystars.tg)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const cfg = getEnvConfig();
      assert.equal(cfg.mystarsPaymentCurrency, 'usdt_ton');

      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_12m',
        quantity: 1,
        recipientUsername: 'mystars_target',
      });
      assert.equal(order.grossRevenueUsdCents, 3490);
      assert.equal(order.mystarsCurrency, 'usdt_ton');

      const paid = await payOrderViaCryptoForTest(order, 'cryptobot', 'USD');
      assert.equal(paid.order.grossRevenueUsdCents, 3490);
      assert.equal(paid.order.providerFeeUsdCents, 3);
      assert.equal(paid.order.mystarsCurrency, 'usdt_ton');

      return 'Поля P&L и mystarsCurrency=usdt_ton корректно инициализированы и обновлены на заказе без реальных запросов к MyStars.';
    },
  );

  await runTest(
    'S42-15',
    'Security',
    'Полное отключение Telegram Stars (XTR) как способа оплаты в сервисах, клавиатурах и сообщениях',
    async () => {
      const pre = await PaymentService.validatePreCheckout({
        invoicePayload: 'ord_any',
        telegramUserId: buyer1.id,
        currency: 'XTR',
        totalAmount: 10,
      });
      assert.equal(pre.ok, false);
      assert.ok(pre.errorMessage?.includes('отключена'));

      await assert.rejects(
        () =>
          PaymentService.processSuccessfulPayment({
            telegramUserId: buyer1.id,
            invoicePayload: 'ord_any',
            currency: 'XTR',
            totalAmount: 10,
            telegramPaymentChargeId: 'chg_xtr_blocked',
          }),
        /XTR_CHECKOUT_DISABLED/,
      );

      const sampleOrder = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_pack_50',
        quantity: 1,
      });
      const checkoutKb = JSON.stringify(
        buildOrderCheckoutChooserKeyboard(sampleOrder, 0),
      );
      assert.equal(checkoutKb.includes('XTR'), false);
      assert.equal(checkoutKb.includes('pay_ord_prov:'), true);

      const cryptoKb = JSON.stringify(
        buildOrderCryptoCurrencyKeyboard(sampleOrder.orderId, 'xrocket', [
          {
            code: 'USDT',
            networks: ['TON'],
            conversion: {
              provider: 'xrocket',
              amountUsdCents: 90,
              targetCurrency: 'USDT',
              network: 'TON',
              exchangeRateUsdStr: '1',
              convertedAmountStr: '0.90',
              convertedAmount: 0.9,
              scaled1e18: 900_000_000_000_000_000n,
              requiresConversionNotice: false,
            },
          },
        ]),
      );
      assert.equal(cryptoKb.includes('USDT:TON'), true);

      const checkoutMsg = formatOrderCheckoutChooserMessage(sampleOrder, 0);
      assert.ok(checkoutMsg.includes('$0.90'));

      return 'XTR checkout полностью заблокирован в PaymentService и удалён из пользовательских клавиатур оплаты.';
    },
  );

  await runTest(
    'S42-16',
    'Payments',
    'Server routes (server.ts): диспетчеризация вебхука заказа (ordpay_*), живой /api/topup/calculate и статус сервера QUIZYSTARS',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      let currentPaymentId = '';
      const transport = async (
        req: HttpTransportRequest,
      ): Promise<HttpTransportResponse> => {
        if (req.url.endsWith('/getExchangeRates')) {
          return {
            status: 200,
            ok: true,
            json: { ok: true, result: [{ source: 'TON', target: 'USD', rate: '5.00', is_valid: true }] },
          };
        }
        if (req.url.endsWith('/createInvoice')) {
          const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
          currentPaymentId = String(body.payload);
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                invoice_id: 'cb_srv_order_1',
                status: 'active',
                amount: String(body.amount),
                asset: 'TON',
                currency_type: 'crypto',
                bot_invoice_url: 'https://t.me/CryptoBot?start=cb_srv_order_1',
                payload: currentPaymentId,
              },
            },
          };
        }
        if (req.url.includes('/getInvoices')) {
          return {
            status: 200,
            ok: true,
            json: {
              ok: true,
              result: {
                items: [
                  {
                    invoice_id: 'cb_srv_order_1',
                    status: 'paid',
                    amount: '2.78',
                    asset: 'TON',
                    paid_asset: 'TON',
                    currency_type: 'crypto',
                    payload: currentPaymentId,
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected: ${req.method} ${req.url}`);
      };

      const gw = new PaymentProviderGateway(transport, TEST_MOCK_CREDS);
      const bs = new BalanceService(gw);
      const ps = new PaymentService('s42-16', gw);

      // 1. Тест /api/topup/calculate
      const calcRes = createMockExpressRes();
      await handleTopUpCalculateRequest(
        { body: { provider: 'cryptobot', amountUsd: '10.00', currency: 'TON' } } as unknown as Request,
        calcRes.res,
        { gateway: gw },
      );
      assert.equal(calcRes.getStatus(), 200);
      const calcJson = calcRes.getJson() as {
        ok: boolean;
        amountUsdCents: number;
        feeUsdCents: number;
        amountCreditedUsdCents: number;
        amountToPayInCurrencyStr: string;
        exchangeRateUsdStr: string;
      };
      assert.equal(calcJson.ok, true);
      assert.equal(calcJson.amountUsdCents, 1000);
      assert.equal(calcJson.feeUsdCents, 30);
      assert.equal(calcJson.amountCreditedUsdCents, 970);
      assert.equal(calcJson.amountToPayInCurrencyStr, '2.00');
      assert.equal(calcJson.exchangeRateUsdStr, '5.00');

      // 2. Тест маршрутизации вебхука в Order через server.ts
      const order = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'premium_3m', // $13.90 -> 2.78 TON @ 5.00
        quantity: 1,
      });
      const inv = await ps.createOrReuseOrderPayment({
        orderId: order.orderId,
        callerTelegramId: buyer1.id,
        provider: 'cryptobot',
        currency: 'TON',
      });

      const rawWh = JSON.stringify({
        update_type: 'invoice_paid',
        payload: {
          invoice_id: 'cb_srv_order_1',
          status: 'paid',
          paid_amount: '2.78',
          paid_asset: 'TON',
          currency_type: 'crypto',
          payload: inv.payment.paymentId,
        },
      });
      const sig = computeCryptoBotWebhookSignature(
        rawWh,
        TEST_MOCK_CREDS.cryptobotApiToken,
      );
      const whRes = createMockExpressRes();
      await handleProviderWebhookRequest(
        'cryptobot',
        {
          rawBody: rawWh,
          body: JSON.parse(rawWh),
          headers: { 'crypto-pay-api-signature': sig },
        } as unknown as Request,
        whRes.res,
        { balanceSvc: bs, paymentSvc: ps, gateway: gw },
      );
      assert.equal(whRes.getStatus(), 200);
      const whJson = whRes.getJson() as { ok: boolean; kind: string; status: string };
      assert.equal(whJson.ok, true);
      assert.equal(whJson.kind, 'order');
      assert.equal(whJson.status, 'paid');

      // 3. Проверка баннера статуса сервера
      const statusText = renderPlainTextStatus();
      assert.ok(statusText.includes('=== QUIZYSTARS STORE SERVER ==='));
      assert.ok(statusText.includes('Валюта расчётов MyStars: usdt_ton'));

      return 'Серверные хендлеры /api/topup/calculate, диспетчер order/topup вебхуков и статус QUIZYSTARS работают корректно.';
    },
  );

  await runTest(
    'S42-17',
    'Security',
    'Маскировка всех чувствительных ключей (CryptoBot, xRocket, Telegram Bot, MyStars API key) в логах и ошибках',
    async () => {
      const prevCb = process.env.CRYPTOBOT_API_TOKEN;
      const prevXr = process.env.XROCKET_API_KEY;
      const prevMs = process.env.MYSTARS_API_KEY;
      const prevTg = process.env.TELEGRAM_BOT_TOKEN;

      try {
        process.env.CRYPTOBOT_API_TOKEN = 'secret_cb_token_998877';
        process.env.XROCKET_API_KEY = 'secret_xr_key_665544';
        process.env.MYSTARS_API_KEY = 'secret_ms_key_332211';
        process.env.TELEGRAM_BOT_TOKEN = '123456:secret_tg_bot_token';

        const leakSample =
          'Err connecting with cb=secret_cb_token_998877 xr=secret_xr_key_665544 ms=secret_ms_key_332211 tg=123456:secret_tg_bot_token';
        const sanitized1 = redactSecretsFromText(leakSample);
        const sanitized2 = maskSecretsInText(leakSample, [
          process.env.CRYPTOBOT_API_TOKEN,
          process.env.XROCKET_API_KEY,
          process.env.MYSTARS_API_KEY,
          process.env.TELEGRAM_BOT_TOKEN,
        ]);

        assert.ok(sanitized1.includes('***'));
        assert.ok(sanitized2.includes('[REDACTED_SECRET]'));
        for (const text of [sanitized1, sanitized2]) {
          assert.equal(text.includes('secret_cb_token_998877'), false);
          assert.equal(text.includes('secret_xr_key_665544'), false);
          assert.equal(text.includes('secret_ms_key_332211'), false);
          assert.equal(text.includes('123456:secret_tg_bot_token'), false);
        }
      } finally {
        process.env.CRYPTOBOT_API_TOKEN = prevCb;
        process.env.XROCKET_API_KEY = prevXr;
        process.env.MYSTARS_API_KEY = prevMs;
        process.env.TELEGRAM_BOT_TOKEN = prevTg;
      }

      return 'Все 4 секретных токена (CryptoBot, xRocket, MyStars, Telegram Bot) надёжно маскируются перед логированием.';
    },
  );

  await runTest(
    'S421-01',
    'Payments',
    'Stage 4.2.1: Строгая валидация Telegram @username (5..32 символов, правила символов/пробелов/@, запрет пустых значений)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);

      // Допустимые форматы (5..32 символа, нормализация одного ведущего @ без повреждения)
      assert.equal(normalizeRecipientUsername('abcde'), 'abcde');
      assert.equal(normalizeRecipientUsername('@AbC_1'), 'abc_1');
      assert.equal(normalizeRecipientUsername('  @QuizyStars_5 '), 'quizystars_5');
      const max32 = 'a' + 'b'.repeat(31);
      assert.equal(normalizeRecipientUsername(`@${max32}`), max32);

      // Недопустимая длина, символы, пробелы, лишние @, подчёркивания и пустые значения
      const invalidUsernames = [
        'abcd',
        '@abcd',
        'a' + 'b'.repeat(32), // 33 символа
        '@@alice',
        'alice test',
        '@ alice',
        'alice\ttest',
        'user!name',
        'иван_тест',
        '_alice',
        'alice_',
        'al__ice',
        '1abcd',
        '',
        '   ',
        '@',
      ];
      for (const bad of invalidUsernames) {
        assert.throws(
          () => normalizeRecipientUsername(bad),
          /(@username|Некорректный|Укажите)/,
          `Ожидался отказ для username=${JSON.stringify(bad)}`,
        );
      }

      // Неопределённый (undefined) допускается только если поле не передано
      assert.equal(normalizeRecipientUsername(undefined), undefined);

      // Проверка интеграции в OrderService.createOrder и setOrderRecipientUsername
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 50,
            recipientUsername: 'abcd',
          }),
        /от 5 до 32/,
      );
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 50,
            recipientUsername: '   ',
          }),
        /не может быть пустым/,
      );

      const created = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'gift_star_box',
        quantity: 1,
      });
      assert.equal(created.recipientUsername, undefined);

      await assert.rejects(
        () => OrderService.setOrderRecipientUsername(created.orderId, buyer1.id, '@@alice'),
        /Некорректный @username/,
      );
      const updatedOrder = await OrderService.setOrderRecipientUsername(
        created.orderId,
        buyer1.id,
        '@Quizy_User5',
      );
      assert.equal(updatedOrder.recipientUsername, 'quizy_user5');

      return 'Проверены 5..32 символа, нормализация @, запрет пробелов/спецсимволов/@@/пустых строк и интеграция с OrderService.';
    },
  );

  await runTest(
    'S421-02',
    'Payments',
    'Stage 4.2.1: Строгая целочисленная валидация количества Stars (без Math.round, отказ для дробных/<=0/NaN/Infinity/строк)',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();

      const starsCustom = await ProductService.getProductById('stars_custom');
      const stars100 = await ProductService.getProductById('stars_pack_100');
      const prem3 = await ProductService.getProductById('premium_3m');
      assert.ok(starsCustom && stars100 && prem3);

      // Граничные корректные значения stars_custom (50..100000 @ $0.02 = 2 цента/шт)
      const minCalc = ProductService.calculateOrderPriceUsdCents(starsCustom, 50);
      assert.deepEqual(minCalc, {
        quantity: 50,
        unitPriceUsdCents: 2,
        totalPriceUsdCents: 100,
      });
      const minStrCalc = ProductService.calculateOrderPriceUsdCents(starsCustom, ' 50 ');
      assert.equal(minStrCalc.quantity, 50);
      assert.equal(minStrCalc.totalPriceUsdCents, 100);

      const maxCalc = ProductService.calculateOrderPriceUsdCents(starsCustom, 100000);
      assert.deepEqual(maxCalc, {
        quantity: 100000,
        unitPriceUsdCents: 2,
        totalPriceUsdCents: 200000,
      });

      // Цены каталога не изменились
      assert.equal(ProductService.calculateOrderPriceUsdCents(stars100, 1).totalPriceUsdCents, 175);
      assert.equal(ProductService.calculateOrderPriceUsdCents(prem3, 1).totalPriceUsdCents, 1390);

      // Некорректные количества (включая дробные, которые ранее округлял Math.round)
      const invalidQuantities: Array<number | string> = [
        49,
        100001,
        50.4,
        50.9,
        100.1,
        '50.5',
        '50,5',
        0,
        '0',
        -1,
        -50,
        '-50',
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        '',
        '   ',
        'abc',
        '50stars',
        '5e1',
        '+50',
        null as unknown as number,
      ];

      for (const badQty of invalidQuantities) {
        assert.throws(
          () => ProductService.calculateOrderPriceUsdCents(starsCustom, badQty),
          /Некорректное количество/,
          `Ожидался отказ для quantity=${String(badQty)}`,
        );
      }

      // Проверка отказа на уровне OrderService.createOrder и BalanceService.purchaseWithInternalBalance
      await assert.rejects(
        () =>
          OrderService.createOrder({
            telegramUser: buyer1,
            productId: 'stars_custom',
            quantity: 50.4,
            recipientUsername: '@alice_ok',
          }),
        /Некорректное количество/,
      );

      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            quantity: 50.9,
            recipientUsername: '@alice_ok',
          }),
        /Некорректное количество/,
      );

      return 'Дробные, <=0, NaN, Infinity, нечисловые и граничные значения валидируются строго без округления на всех точках входа.';
    },
  );

  await runTest(
    'S421-03',
    'Security',
    'Stage 4.2.1: Согласованность серверной валидации в BalanceService, PaymentService и ProductService.createProduct',
    async () => {
      firestoreRepo.enableIsolatedTestMode(true);
      const bs = new BalanceService();
      const ps = new PaymentService('s421-03');

      await UserService.upsertFromTelegram(buyer1);
      await firestoreRepo.updateDoc<StoreUser>('users', `tg_${buyer1.id}`, {
        balanceUsdCents: 10000,
        balance: 100,
      });

      // Искусственно повреждённый заказ с дробным количеством не должен пройти ни через BalanceService, ни через PaymentService
      const orderBadQty = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 50,
        recipientUsername: 'valid_user5',
      });
      await firestoreRepo.updateDoc('orders', orderBadQty.orderId, {
        quantity: 50.5,
      });

      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            orderId: orderBadQty.orderId,
          }),
        /Некорректное количество/,
      );

      await assert.rejects(
        () =>
          ps.createOrReuseOrderPayment({
            orderId: orderBadQty.orderId,
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USD',
          }),
        /Некорректное количество/,
      );

      // Повреждённый recipientUsername в существующем заказе тоже блокируется
      const orderBadUser = await OrderService.createOrder({
        telegramUser: buyer1,
        productId: 'stars_custom',
        quantity: 50,
        recipientUsername: 'valid_user5',
      });
      await firestoreRepo.updateDoc('orders', orderBadUser.orderId, {
        recipientUsername: 'abcd',
      });

      await assert.rejects(
        () =>
          bs.purchaseWithInternalBalance({
            telegramId: buyer1.id,
            productId: 'stars_custom',
            orderId: orderBadUser.orderId,
          }),
        /Некорректный @username/,
      );

      await assert.rejects(
        () =>
          ps.createOrReuseOrderPayment({
            orderId: orderBadUser.orderId,
            callerTelegramId: buyer1.id,
            provider: 'cryptobot',
            currency: 'USD',
          }),
        /Некорректный @username/,
      );

      // Админское создание товара отклоняет некорректные minQuantity/maxQuantity
      await assert.rejects(
        () =>
          ProductService.createProduct({
            name: 'Invalid Stars Pack',
            description: 'Bad bounds',
            category: 'stars',
            price: 100,
            minQuantity: 10.5,
            fulfillmentType: 'manual',
          }),
        /minQuantity/,
      );
      await assert.rejects(
        () =>
          ProductService.createProduct({
            name: 'Invalid Stars Bounds',
            description: 'min > max',
            category: 'stars',
            price: 100,
            minQuantity: 20,
            maxQuantity: 10,
            fulfillmentType: 'manual',
          }),
        /maxQuantity/,
      );

      return 'Единая серверная валидация подтверждена во всех платёжных и каталожных точках входа.';
    },
  );

  console.log('\n================================================================');
  console.log(`📊 РЕЗУЛЬТАТЫ АВТОТЕСТОВ (${testResults.length}/${testResults.length} PASS):`);
  for (const r of testResults) {
    console.log(
      `✅ [${r.status}] [${r.id}] (${r.category}) ${r.name}\n   └─ Среда: ${r.environment} | Emulator: ${r.emulatorUsed ? 'Да' : 'Нет (Isolated Mock)'}\n   └─ Детали: ${r.details}`,
    );
  }
  console.log('================================================================\n');
}

runFullAuditTestSuite()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ ТЕСТЫ ЗАВЕРШИЛИСЬ С ОШИБКОЙ:', err);
    process.exit(1);
  });
