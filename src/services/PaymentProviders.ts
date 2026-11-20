import crypto from 'crypto';
import {
  MAX_TOPUP_AMOUNT_USD,
  MIN_TOPUP_AMOUNT_USD,
  getEnvConfig,
} from '../config/env.ts';
import {
  BalanceTopUpProvider,
  BalanceTopUpStatus,
  XRocketErrorProblemDetails,
} from '../types.ts';
import {
  DECIMAL_SCALE,
  MIN_TOPUP_AMOUNT_USD_CENTS,
  MAX_TOPUP_AMOUNT_USD_CENTS,
  convertUsdCentsToCryptoScaled,
  formatScaledDecimal,
  getCryptoInvoiceDecimals,
  parseDecimalToScaled,
} from './Money.ts';

export class ExchangeRateUnavailableError extends Error {
  public readonly code = 'EXCHANGE_RATE_UNAVAILABLE';
  public readonly provider: BalanceTopUpProvider;
  public readonly currency: string;

  constructor(
    provider: BalanceTopUpProvider,
    currency: string,
    reason?: string,
  ) {
    super(
      reason ||
        `Не удалось получить актуальный курс ${currency} у провайдера ${provider}. Повторите попытку позже.`,
    );
    this.name = 'ExchangeRateUnavailableError';
    this.provider = provider;
    this.currency = currency;
  }
}

export interface XRocketAssetOption {
  code: string;
  label: string;
  networks: string[];
  defaultNetwork: string;
}

export const XROCKET_SUPPORTED_ASSETS: XRocketAssetOption[] = [
  {
    code: 'USDT',
    label: 'USDT',
    networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'],
    defaultNetwork: 'TON',
  },
  {
    code: 'TON',
    label: 'TON',
    networks: ['TON'],
    defaultNetwork: 'TON',
  },
  {
    code: 'BTC',
    label: 'BTC',
    networks: ['Bitcoin'],
    defaultNetwork: 'Bitcoin',
  },
  {
    code: 'ETH',
    label: 'ETH',
    networks: ['ERC-20'],
    defaultNetwork: 'ERC-20',
  },
  {
    code: 'TRX',
    label: 'TRX',
    networks: ['TRC-20'],
    defaultNetwork: 'TRC-20',
  },
  {
    code: 'BNB',
    label: 'BNB',
    networks: ['BEP-20'],
    defaultNetwork: 'BEP-20',
  },
  {
    code: 'USDC',
    label: 'USDC',
    networks: ['ERC-20', 'BEP-20'],
    defaultNetwork: 'ERC-20',
  },
];

export interface ProviderMetadata {
  id: BalanceTopUpProvider;
  title: string;
  shortTitle: string;
  buttonLabel: string;
  feePercent: number;
  feeBps: number;
  defaultCurrency: string;
  supportedCurrencies: string[];
  supportedNetworks: string[];
  minAmount: number;
  maxAmount: number;
  minAmountUsdCents: number;
  maxAmountUsdCents: number;
  presetAmounts: number[];
  apiBaseUrl: string;
  officialDocsUrl: string;
  description: string;
}

export const PAYMENT_PROVIDER_CATALOG: Record<BalanceTopUpProvider, ProviderMetadata> = {
  cryptobot: {
    id: 'cryptobot',
    title: 'CryptoBot (@CryptoBot)',
    shortTitle: 'CryptoBot',
    buttonLabel: '💎 CryptoBot [3%]',
    feePercent: 3,
    feeBps: 300,
    defaultCurrency: 'USD',
    supportedCurrencies: ['USD', 'USDT', 'TON', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC', 'LTC'],
    supportedNetworks: [
      'TON',
      'TRC-20',
      'ERC-20',
      'BEP-20',
      'Bitcoin',
      'Litecoin',
    ],
    minAmount: MIN_TOPUP_AMOUNT_USD,
    maxAmount: MAX_TOPUP_AMOUNT_USD,
    minAmountUsdCents: MIN_TOPUP_AMOUNT_USD_CENTS,
    maxAmountUsdCents: MAX_TOPUP_AMOUNT_USD_CENTS,
    presetAmounts: [],
    apiBaseUrl: 'https://pay.crypt.bot/api',
    officialDocsUrl: 'https://help.send.tg/en/articles/10279948-crypto-pay-api',
    description:
      'Оплата в долларах США (USD / USDT / крипто) через официальный сервис @CryptoBot (комиссия при пополнении 3%).',
  },
  xrocket: {
    id: 'xrocket',
    title: 'xRocket Pay (@xrocket)',
    shortTitle: 'xRocket',
    buttonLabel: '🚀 xRocket [2%]',
    feePercent: 2,
    feeBps: 200,
    defaultCurrency: 'USDT',
    supportedCurrencies: ['USDT', 'TON', 'TONCOIN', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC'],
    supportedNetworks: [
      'TON',
      'TRC-20',
      'BEP-20',
      'ERC-20',
      'Bitcoin',
    ],
    minAmount: MIN_TOPUP_AMOUNT_USD,
    maxAmount: MAX_TOPUP_AMOUNT_USD,
    minAmountUsdCents: MIN_TOPUP_AMOUNT_USD_CENTS,
    maxAmountUsdCents: MAX_TOPUP_AMOUNT_USD_CENTS,
    presetAmounts: [],
    apiBaseUrl: 'https://pay.api.xrocket.exchange',
    officialDocsUrl: 'https://docs.xrocket.exchange/ru/api/pay/reference/pay-rest-api',
    description:
      'Оплата криптовалютой (USDT, TON, BTC, ETH, TRX, BNB, USDC) через xRocket Pay REST API v1 (комиссия при пополнении 2%).',
  },
};

export interface SupportedCurrencyInfo {
  code: string;
  name: string;
  isFiat: boolean;
  decimals: number;
  networks: string[];
}

export interface LiveExchangeRateResult {
  provider: BalanceTopUpProvider;
  currency: string;
  rateUsdStr: string;
  rateScaled1e18: bigint;
  source: string;
  fetchedAt: string;
}

export interface LiveUsdConversionResult {
  provider: BalanceTopUpProvider;
  amountUsdCents: number;
  targetCurrency: string;
  network?: string;
  exchangeRateUsdStr: string;
  convertedAmountStr: string;
  convertedAmount: number;
  scaled1e18: bigint;
  requiresConversionNotice: boolean;
}

export interface CreateProviderInvoiceInput {
  paymentId: string;
  provider: BalanceTopUpProvider;
  amountStr?: string;
  amountPaid?: number;
  currency: string;
  network?: string;
  description: string;
  expiresInSeconds?: number;
}

export interface CreatedProviderInvoice {
  externalInvoiceId: string;
  payUrl: string;
  status: BalanceTopUpStatus;
  amountPaidStr: string;
  amountPaid: number;
  currency: string;
  network?: string;
  recipientMerchantId?: string;
  expiresAt?: string;
}

export interface VerifiedProviderInvoice {
  externalInvoiceId: string;
  paymentId?: string;
  status: BalanceTopUpStatus;
  amountPaidStr: string;
  amountPaid: number;
  currency: string;
  network?: string;
  feeInUsdStr?: string;
  recipientMerchantId?: string;
  paidAt?: string;
}

export interface ParsedWebhookNotification {
  provider: BalanceTopUpProvider;
  externalInvoiceId: string;
  paymentId?: string;
  status: BalanceTopUpStatus;
  amountPaidStr?: string;
  amountPaid?: number;
  currency?: string;
  network?: string;
  feeInUsdStr?: string;
  recipientMerchantId?: string;
}

export interface HttpTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpTransportResponse {
  status: number;
  ok: boolean;
  json: unknown;
  headers?: Record<string, string>;
}

export type ProviderHttpTransport = (
  req: HttpTransportRequest,
) => Promise<HttpTransportResponse>;

export class XRocketApiError extends Error {
  public readonly httpStatus: number;
  public readonly problemDetails: XRocketErrorProblemDetails;

  constructor(
    message: string,
    httpStatus: number,
    problemDetails: XRocketErrorProblemDetails = {},
  ) {
    super(message);
    this.name = 'XRocketApiError';
    this.httpStatus = httpStatus;
    this.problemDetails = problemDetails;
  }
}

/**
 * Builds a canonical xRocket Pay REST API v1 URL without ever duplicating `/api/v1`.
 */
export function buildXRocketApiV1Url(baseUrl: string, endpointPath: string): string {
  const cleanBase = (baseUrl || 'https://pay.api.xrocket.exchange')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '');
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  return `${cleanBase}/api/v1${cleanPath}`;
}

export function maskSecret(value: string | undefined | null): string {
  if (!value) return '[NOT_SET]';
  const trimmed = value.trim();
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

export function redactSecretsFromText(text: string): string {
  if (!text) return text;
  const cfg = getEnvConfig();
  const secrets = [
    cfg.cryptobotApiToken,
    cfg.xrocketApiKey,
    cfg.telegramBotToken,
    cfg.webhookSecret,
    cfg.mystarsApiKey,
    cfg.mystarsWebhookSecret,
  ].filter((s): s is string => Boolean(s && s.trim().length >= 4));

  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(maskSecret(secret));
  }
  return redacted;
}

function safeTimingEqualHexOrUtf8(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const bufA = Buffer.from(expected, 'utf8');
  const bufB = Buffer.from(actual, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function computeCryptoBotWebhookSignature(
  rawBody: string,
  apiToken: string,
): string {
  const secretKey = crypto.createHash('sha256').update(apiToken, 'utf8').digest();
  return crypto.createHmac('sha256', secretKey).update(rawBody, 'utf8').digest('hex');
}

export function verifyCryptoBotWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  apiToken?: string,
): boolean {
  const token = (apiToken ?? getEnvConfig().cryptobotApiToken).trim();
  if (!token || !signatureHeader) return false;
  const expected = computeCryptoBotWebhookSignature(rawBody, token);
  return safeTimingEqualHexOrUtf8(expected.toLowerCase(), signatureHeader.trim().toLowerCase());
}

export function computeXRocketWebhookSignature(
  rawBody: string,
  apiKey: string,
): string {
  const secretKey = crypto.createHash('sha256').update(apiKey, 'utf8').digest();
  return crypto.createHmac('sha256', secretKey).update(rawBody, 'utf8').digest('hex');
}

export function verifyXRocketWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  apiKey?: string,
): boolean {
  const key = (apiKey ?? getEnvConfig().xrocketApiKey).trim();
  if (!key || !signatureHeader) return false;
  const expected = computeXRocketWebhookSignature(rawBody, key);
  return safeTimingEqualHexOrUtf8(expected.toLowerCase(), signatureHeader.trim().toLowerCase());
}

function normalizeProviderStatus(rawStatus: string | undefined): BalanceTopUpStatus {
  const s = (rawStatus || '').trim().toLowerCase();
  if (s === 'paid' || s === 'completed' || s === 'success') {
    return 'paid';
  }
  if (s === 'partially_paid' || s === 'underpaid' || s === 'partial') {
    return 'underpaid';
  }
  if (s === 'expired') {
    return 'expired';
  }
  if (s === 'cancelled' || s === 'canceled') {
    return 'cancelled';
  }
  if (s === 'failed' || s === 'error') {
    return 'failed';
  }
  return 'pending';
}

export function normalizeCurrencyCode(currency: string): string {
  const upper = (currency || '').trim().toUpperCase();
  if (upper === 'TONCOIN') return 'TON';
  return upper;
}

export function normalizeNetworkCode(network: string | undefined): string | undefined {
  if (!network) return undefined;
  const clean = network.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean) return undefined;
  if (clean === 'TRC20' || clean === 'TRC-20' || clean === 'TRON') return 'TRC-20';
  if (clean === 'ERC20' || clean === 'ERC-20' || clean === 'ETH' || clean === 'ETHEREUM') {
    return 'ERC-20';
  }
  if (clean === 'BEP20' || clean === 'BEP-20' || clean === 'BSC' || clean === 'BNB') {
    return 'BEP-20';
  }
  if (clean === 'TON' || clean === 'THEOPENNETWORK') return 'TON';
  if (clean === 'BTC' || clean === 'BITCOIN') return 'Bitcoin';
  return network.trim();
}

function parseXRocketErrorDetails(
  httpStatus: number,
  rawJson: unknown,
): { errorMessage: string; details: XRocketErrorProblemDetails } {
  const obj =
    rawJson && typeof rawJson === 'object'
      ? (rawJson as Record<string, unknown>)
      : {};

  const details: XRocketErrorProblemDetails = {
    status: typeof obj.status === 'number' ? obj.status : httpStatus,
    type: typeof obj.type === 'string' ? obj.type : undefined,
    title: typeof obj.title === 'string' ? obj.title : undefined,
    detail:
      typeof obj.detail === 'string'
        ? obj.detail
        : typeof obj.message === 'string'
          ? obj.message
          : undefined,
    instance: typeof obj.instance === 'string' ? obj.instance : undefined,
    kind: typeof obj.kind === 'string' ? obj.kind : undefined,
  };

  const parts: string[] = [`HTTP ${httpStatus}`];
  if (details.title) parts.push(details.title);
  if (details.detail && details.detail !== details.title) {
    parts.push(details.detail);
  }
  if (details.kind) parts.push(`kind=${details.kind}`);
  if (details.instance) parts.push(`instance=${details.instance}`);

  const formatted = redactSecretsFromText(
    `Ошибка xRocket Pay API (${parts.join(' | ')})`,
  );
  return { errorMessage: formatted, details };
}

const defaultFetchTransport: ProviderHttpTransport = async (req) => {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    json,
  };
};

export interface ProviderCredentialsOverride {
  cryptobotApiToken?: string;
  cryptobotApiUrl?: string;
  xrocketApiKey?: string;
  xrocketApiUrl?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;

export class PaymentProviderGateway {
  private transport: ProviderHttpTransport;
  private credentialsOverride: ProviderCredentialsOverride;
  private rateCache = new Map<string, CacheEntry<Map<string, LiveExchangeRateResult>>>();
  private currencyCache = new Map<string, CacheEntry<SupportedCurrencyInfo[]>>();

  constructor(
    transport: ProviderHttpTransport = defaultFetchTransport,
    credentialsOverride: ProviderCredentialsOverride = {},
  ) {
    this.transport = transport;
    this.credentialsOverride = credentialsOverride;
  }

  public setTransport(transport: ProviderHttpTransport): void {
    this.transport = transport;
    this.clearCaches();
  }

  public setCredentialsOverride(override: ProviderCredentialsOverride): void {
    this.credentialsOverride = { ...override };
    this.clearCaches();
  }

  public clearCaches(): void {
    this.rateCache.clear();
    this.currencyCache.clear();
  }

  private getCredentials() {
    const cfg = getEnvConfig();
    return {
      cryptobotApiToken:
        this.credentialsOverride.cryptobotApiToken ?? cfg.cryptobotApiToken,
      cryptobotApiUrl:
        this.credentialsOverride.cryptobotApiUrl ?? cfg.cryptobotApiUrl,
      xrocketApiKey:
        this.credentialsOverride.xrocketApiKey ?? cfg.xrocketApiKey,
      xrocketApiUrl:
        this.credentialsOverride.xrocketApiUrl ?? cfg.xrocketApiUrl,
    };
  }

  public isProviderConfigured(provider: BalanceTopUpProvider): boolean {
    const creds = this.getCredentials();
    if (provider === 'cryptobot') {
      return Boolean(creds.cryptobotApiToken && creds.cryptobotApiToken.trim().length > 0);
    }
    if (provider === 'xrocket') {
      return Boolean(creds.xrocketApiKey && creds.xrocketApiKey.trim().length > 0);
    }
    return false;
  }

  public getProviderStatusSummary(): Record<
    BalanceTopUpProvider,
    { configured: boolean; feePercent: number; maskedKey: string }
  > {
    const creds = this.getCredentials();
    return {
      cryptobot: {
        configured: this.isProviderConfigured('cryptobot'),
        feePercent: PAYMENT_PROVIDER_CATALOG.cryptobot.feePercent,
        maskedKey: maskSecret(creds.cryptobotApiToken),
      },
      xrocket: {
        configured: this.isProviderConfigured('xrocket'),
        feePercent: PAYMENT_PROVIDER_CATALOG.xrocket.feePercent,
        maskedKey: maskSecret(creds.xrocketApiKey),
      },
    };
  }

  public verifyWebhookSignature(
    provider: BalanceTopUpProvider,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const creds = this.getCredentials();
    const getHeader = (name: string): string | undefined => {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) {
          return Array.isArray(v) ? v[0] : v;
        }
      }
      return undefined;
    };

    if (provider === 'cryptobot') {
      return verifyCryptoBotWebhookSignature(
        rawBody,
        getHeader('crypto-pay-api-signature'),
        creds.cryptobotApiToken,
      );
    }
    if (provider === 'xrocket') {
      return verifyXRocketWebhookSignature(
        rawBody,
        getHeader('rocket-pay-signature'),
        creds.xrocketApiKey,
      );
    }
    return false;
  }

  /**
   * Queries live supported currencies (and networks) from the provider's official API.
   * Falls back explicitly if the endpoint returns an unexpected payload, and caches briefly (30s).
   */
  public async getSupportedCurrencies(
    provider: BalanceTopUpProvider,
    options?: { forceRefresh?: boolean },
  ): Promise<SupportedCurrencyInfo[]> {
    const cacheKey = provider;
    const nowMs = Date.now();
    const cached = this.currencyCache.get(cacheKey);
    if (!options?.forceRefresh && cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    if (!this.isProviderConfigured(provider)) {
      throw new ExchangeRateUnavailableError(
        provider,
        'USD',
        `Провайдер ${PAYMENT_PROVIDER_CATALOG[provider].shortTitle} не настроен (отсутствует API-ключ).`,
      );
    }

    const creds = this.getCredentials();
    const resultList: SupportedCurrencyInfo[] = [];

    if (provider === 'cryptobot') {
      const url = `${creds.cryptobotApiUrl.replace(/\/+$/, '')}/getCurrencies`;
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          'Crypto-Pay-API-Token': creds.cryptobotApiToken,
        },
      });
      const data = res.json as {
        ok?: boolean;
        result?: Array<Record<string, unknown>>;
      } | null;

      if (!res.ok || !data?.ok || !Array.isArray(data.result)) {
        throw new Error(
          redactSecretsFromText(
            `Не удалось получить список валют CryptoBot (HTTP ${res.status}).`,
          ),
        );
      }

      for (const item of data.result) {
        const code = normalizeCurrencyCode(String(item.code ?? ''));
        if (!code) continue;
        resultList.push({
          code,
          name: String(item.name ?? code),
          isFiat: Boolean(item.is_fiat),
          decimals:
            typeof item.decimals === 'number'
              ? item.decimals
              : getCryptoInvoiceDecimals(code),
          networks: Array.isArray(item.networks)
            ? item.networks.map((n) => String(n))
            : [],
        });
      }
    } else if (provider === 'xrocket') {
      const url = buildXRocketApiV1Url(creds.xrocketApiUrl, '/currencies');
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${creds.xrocketApiKey}`,
        },
      });

      if (!res.ok) {
        const { errorMessage, details } = parseXRocketErrorDetails(res.status, res.json);
        throw new XRocketApiError(errorMessage, res.status, details);
      }

      const raw = res.json;
      let items: Array<Record<string, unknown>> = [];
      if (Array.isArray(raw)) {
        items = raw as Array<Record<string, unknown>>;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (Array.isArray(obj.data)) items = obj.data as Array<Record<string, unknown>>;
        else if (Array.isArray(obj.items)) items = obj.items as Array<Record<string, unknown>>;
        else if (Array.isArray(obj.currencies)) items = obj.currencies as Array<Record<string, unknown>>;
      }

      for (const item of items) {
        const code = normalizeCurrencyCode(
          String(item.currency ?? item.code ?? item.symbol ?? ''),
        );
        if (!code) continue;
        const rawNets = Array.isArray(item.networks) ? item.networks : [];
        const networks = rawNets
          .map((n) => {
            if (typeof n === 'string') return n;
            if (n && typeof n === 'object') {
              const no = n as Record<string, unknown>;
              return String(no.network ?? no.code ?? no.name ?? '');
            }
            return '';
          })
          .filter(Boolean);

        resultList.push({
          code,
          name: String(item.name ?? code),
          isFiat: Boolean(item.isFiat),
          decimals:
            typeof item.decimals === 'number'
              ? item.decimals
              : getCryptoInvoiceDecimals(code),
          networks,
        });
      }
    }

    if (resultList.length > 0) {
      this.currencyCache.set(cacheKey, {
        value: resultList,
        expiresAtMs: nowMs + DEFAULT_CACHE_TTL_MS,
      });
    }

    return resultList;
  }

  /**
   * Validates requested payment currency and optional network using provider metadata / live currencies.
   */
  public async validateCurrencyAndNetwork(
    provider: BalanceTopUpProvider,
    currency: string,
    network?: string,
  ): Promise<{ currency: string; network?: string }> {
    const normCurr = normalizeCurrencyCode(currency);
    const normNet = normalizeNetworkCode(network);
    const catalog = PAYMENT_PROVIDER_CATALOG[provider];
    if (!catalog) {
      throw new Error(`Неизвестный провайдер: ${String(provider)}`);
    }

    if (!catalog.supportedCurrencies.includes(normCurr) && normCurr !== 'TONCOIN') {
      throw new Error(
        `Валюта ${normCurr} не поддерживается провайдером ${catalog.shortTitle}.`,
      );
    }

    if (normNet) {
      let validNetworks: string[] = [];
      try {
        const live = await this.getSupportedCurrencies(provider);
        const match = live.find((c) => c.code === normCurr);
        if (match && match.networks.length > 0) {
          validNetworks = match.networks.map((n) => normalizeNetworkCode(n) || n);
        }
      } catch {
        // If live currencies endpoint unavailable during offline test mocks that only stub rates,
        // fallback cleanly to static network compatibility matrix (never rates).
      }

      if (validNetworks.length === 0 && provider === 'xrocket') {
        const assetMeta = XROCKET_SUPPORTED_ASSETS.find((a) => a.code === normCurr);
        if (assetMeta) {
          validNetworks = assetMeta.networks.map((n) => normalizeNetworkCode(n) || n);
        }
      }

      if (validNetworks.length > 0 && !validNetworks.includes(normNet)) {
        throw new Error(
          `Сеть ${normNet} не поддерживается для ${normCurr} у провайдера ${catalog.shortTitle}. Доступные: ${validNetworks.join(', ')}.`,
        );
      }
    }

    return { currency: normCurr, network: normNet };
  }

  /**
   * Fetches live USD exchange rates from CryptoBot (`GET /getExchangeRates`) or
   * xRocket (`GET /api/v1/rates`). NEVER falls back to static rate tables.
   */
  public async getUsdExchangeRate(
    provider: BalanceTopUpProvider,
    currency: string,
    options?: { forceRefresh?: boolean; customRateUsdStr?: string },
  ): Promise<LiveExchangeRateResult> {
    const normCurr = normalizeCurrencyCode(currency || 'USD');
    const fetchedAt = new Date().toISOString();

    if (options?.customRateUsdStr) {
      const scaled = parseDecimalToScaled(options.customRateUsdStr);
      if (scaled <= 0n) {
        throw new ExchangeRateUnavailableError(
          provider,
          normCurr,
          `Некорректный пользовательский курс для ${normCurr}: ${options.customRateUsdStr}`,
        );
      }
      return {
        provider,
        currency: normCurr,
        rateUsdStr: formatScaledDecimal(scaled, { minDecimals: 2, maxDecimals: 8 }),
        rateScaled1e18: scaled,
        source: 'override',
        fetchedAt,
      };
    }

    if (normCurr === 'USD') {
      return {
        provider,
        currency: 'USD',
        rateUsdStr: '1.00',
        rateScaled1e18: DECIMAL_SCALE,
        source: 'usd_parity',
        fetchedAt,
      };
    }

    if (!this.isProviderConfigured(provider)) {
      throw new ExchangeRateUnavailableError(
        provider,
        normCurr,
        `Невозможно получить курс ${normCurr}: провайдер ${PAYMENT_PROVIDER_CATALOG[provider].shortTitle} не настроен.`,
      );
    }

    const nowMs = Date.now();
    const cachedMap = this.rateCache.get(provider);
    if (!options?.forceRefresh && cachedMap && cachedMap.expiresAtMs > nowMs) {
      const hit = cachedMap.value.get(normCurr);
      if (hit) return hit;
    }

    const creds = this.getCredentials();
    const ratesMap = new Map<string, LiveExchangeRateResult>();

    if (provider === 'cryptobot') {
      const url = `${creds.cryptobotApiUrl.replace(/\/+$/, '')}/getExchangeRates`;
      let res: HttpTransportResponse;
      try {
        res = await this.transport({
          url,
          method: 'GET',
          headers: {
            'Crypto-Pay-API-Token': creds.cryptobotApiToken,
          },
        });
      } catch (err) {
        throw new ExchangeRateUnavailableError(
          provider,
          normCurr,
          `Ошибка сети при получении курса CryptoBot для ${normCurr}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const data = res.json as {
        ok?: boolean;
        error?: { name?: string };
        result?: Array<Record<string, unknown>>;
      } | null;

      if (!res.ok || !data?.ok || !Array.isArray(data.result)) {
        throw new ExchangeRateUnavailableError(
          provider,
          normCurr,
          redactSecretsFromText(
            `Провайдер CryptoBot не вернул актуальные курсы (HTTP ${res.status}, ${data?.error?.name || 'unknown'}).`,
          ),
        );
      }

      for (const entry of data.result) {
        if (entry.is_valid === false) continue;
        const source = normalizeCurrencyCode(String(entry.source ?? ''));
        const target = normalizeCurrencyCode(String(entry.target ?? ''));
        const rawRate = entry.rate !== undefined ? String(entry.rate) : '';
        if (!source || !target || !rawRate) continue;

        let rateScaled: bigint;
        try {
          rateScaled = parseDecimalToScaled(rawRate);
        } catch {
          continue;
        }
        if (rateScaled <= 0n) continue;

        if (target === 'USD' && source !== 'USD') {
          ratesMap.set(source, {
            provider,
            currency: source,
            rateUsdStr: formatScaledDecimal(rateScaled, { minDecimals: 2, maxDecimals: 8 }),
            rateScaled1e18: rateScaled,
            source: 'cryptobot_getExchangeRates',
            fetchedAt,
          });
        } else if (source === 'USD' && target !== 'USD' && !ratesMap.has(target)) {
          const inverted = (DECIMAL_SCALE * DECIMAL_SCALE) / rateScaled;
          if (inverted > 0n) {
            ratesMap.set(target, {
              provider,
              currency: target,
              rateUsdStr: formatScaledDecimal(inverted, { minDecimals: 2, maxDecimals: 8 }),
              rateScaled1e18: inverted,
              source: 'cryptobot_getExchangeRates_inv',
              fetchedAt,
            });
          }
        }
      }
    } else if (provider === 'xrocket') {
      const url = buildXRocketApiV1Url(creds.xrocketApiUrl, '/rates');
      let res: HttpTransportResponse;
      try {
        res = await this.transport({
          url,
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${creds.xrocketApiKey}`,
          },
        });
      } catch (err) {
        throw new ExchangeRateUnavailableError(
          provider,
          normCurr,
          `Ошибка сети при получении курса xRocket для ${normCurr}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!res.ok) {
        const { errorMessage } = parseXRocketErrorDetails(res.status, res.json);
        throw new ExchangeRateUnavailableError(provider, normCurr, errorMessage);
      }

      const parsedItems = this.extractXRocketRatesEntries(res.json, fetchedAt);
      for (const item of parsedItems) {
        ratesMap.set(item.currency, item);
      }
    }

    if (ratesMap.size > 0) {
      this.rateCache.set(provider, {
        value: ratesMap,
        expiresAtMs: nowMs + DEFAULT_CACHE_TTL_MS,
      });
    }

    const resolved = ratesMap.get(normCurr);
    if (!resolved || resolved.rateScaled1e18 <= 0n) {
      throw new ExchangeRateUnavailableError(
        provider,
        normCurr,
        `Актуальный курс ${normCurr}/USD не найден в ответе провайдера ${PAYMENT_PROVIDER_CATALOG[provider].shortTitle}.`,
      );
    }

    return resolved;
  }

  private extractXRocketRatesEntries(
    rawJson: unknown,
    fetchedAt: string,
  ): LiveExchangeRateResult[] {
    const out: LiveExchangeRateResult[] = [];
    if (!rawJson || typeof rawJson !== 'object') return out;

    const pushEntry = (codeRaw: string, rateRaw: string | number) => {
      const code = normalizeCurrencyCode(codeRaw);
      if (!code || code === 'USD') return;
      try {
        const scaled = parseDecimalToScaled(rateRaw);
        if (scaled <= 0n) return;
        out.push({
          provider: 'xrocket',
          currency: code,
          rateUsdStr: formatScaledDecimal(scaled, { minDecimals: 2, maxDecimals: 8 }),
          rateScaled1e18: scaled,
          source: 'xrocket_rates',
          fetchedAt,
        });
      } catch {
        // Ignore unparseable entries
      }
    };

    const rawObj = rawJson as Record<string, unknown>;
    const listCandidate = Array.isArray(rawJson)
      ? rawJson
      : Array.isArray(rawObj.data)
        ? rawObj.data
        : Array.isArray(rawObj.rates)
          ? rawObj.rates
          : Array.isArray(rawObj.items)
            ? rawObj.items
            : null;

    if (listCandidate) {
      for (const item of listCandidate) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const quote = normalizeCurrencyCode(
          String(rec.quote ?? rec.to ?? rec.toCurrency ?? rec.fiat ?? rec.target ?? 'USD'),
        );
        const base = normalizeCurrencyCode(
          String(
            rec.currency ??
              rec.base ??
              rec.from ??
              rec.fromCurrency ??
              rec.crypto ??
              rec.code ??
              rec.symbol ??
              '',
          ),
        );
        const rawRate = rec.rate ?? rec.price ?? rec.usd ?? rec.value;
        if (!base || rawRate === undefined || rawRate === null) continue;
        if (quote === 'USD') {
          pushEntry(base, rawRate as string | number);
        }
      }
      return out;
    }

    // Map format: { data: { TON: { USD: "5.40" }, USDT: "1.00" } } or { TON: "5.40" }
    const mapRoot =
      rawObj.data && typeof rawObj.data === 'object' && !Array.isArray(rawObj.data)
        ? (rawObj.data as Record<string, unknown>)
        : rawObj.rates && typeof rawObj.rates === 'object' && !Array.isArray(rawObj.rates)
          ? (rawObj.rates as Record<string, unknown>)
          : rawObj;

    for (const [key, val] of Object.entries(mapRoot)) {
      if (typeof val === 'string' || typeof val === 'number') {
        pushEntry(key, val);
      } else if (val && typeof val === 'object') {
        const nested = val as Record<string, unknown>;
        const usdVal = nested.USD ?? nested.usd ?? nested.rate ?? nested.price;
        if (typeof usdVal === 'string' || typeof usdVal === 'number') {
          pushEntry(key, usdVal);
        }
      }
    }

    return out;
  }

  /**
   * Computes exact payable crypto/USD string from integer USD cents using LIVE provider exchange rates.
   */
  public async getLiveUsdConversion(params: {
    provider: BalanceTopUpProvider;
    amountUsdCents: number;
    targetCurrency: string;
    network?: string;
    customRateUsdStr?: string;
    forceRefresh?: boolean;
  }): Promise<LiveUsdConversionResult> {
    const normCurr = normalizeCurrencyCode(params.targetCurrency || 'USD');
    const normNet = normalizeNetworkCode(params.network);

    const rateInfo = await this.getUsdExchangeRate(params.provider, normCurr, {
      forceRefresh: params.forceRefresh,
      customRateUsdStr: params.customRateUsdStr,
    });

    const converted = convertUsdCentsToCryptoScaled({
      amountUsdCents: params.amountUsdCents,
      rateUsdStr: rateInfo.rateUsdStr,
      targetCurrency: normCurr,
    });

    return Object.freeze({
      provider: params.provider,
      amountUsdCents: params.amountUsdCents,
      targetCurrency: normCurr,
      ...(normNet ? { network: normNet } : {}),
      exchangeRateUsdStr: rateInfo.rateUsdStr,
      convertedAmountStr: converted.amountStr,
      convertedAmount: Number(converted.amountStr),
      scaled1e18: converted.scaled1e18,
      requiresConversionNotice: normCurr !== 'USD',
    });
  }

  /**
   * Parses webhook JSON payload into a normalized notification object.
   * Supports both official xRocket `InvoiceWebhookDto` (`{ type: 'invoice', data: { invoice, payment } }`)
   * and legacy webhook formats. NEVER trusts payload alone — callers re-verify via provider API.
   */
  public parseWebhookPayload(
    provider: BalanceTopUpProvider,
    body: unknown,
  ): ParsedWebhookNotification {
    if (!body || typeof body !== 'object') {
      throw new Error('Некорректный JSON-пейлоад вебхука');
    }
    const obj = body as Record<string, unknown>;

    if (provider === 'cryptobot') {
      const payloadObj =
        obj.payload && typeof obj.payload === 'object'
          ? (obj.payload as Record<string, unknown>)
          : obj;
      const externalInvoiceId = String(payloadObj.invoice_id ?? '');
      if (!externalInvoiceId) {
        throw new Error('В вебхуке CryptoBot отсутствует invoice_id');
      }
      const currencyRaw =
        payloadObj.currency_type === 'fiat'
          ? String(payloadObj.fiat ?? 'USD')
          : String(payloadObj.paid_asset ?? payloadObj.asset ?? payloadObj.fiat ?? 'USDT');
      const rawAmount = payloadObj.paid_amount ?? payloadObj.amount;
      const amountPaidStr = rawAmount !== undefined ? String(rawAmount) : undefined;
      return {
        provider: 'cryptobot',
        externalInvoiceId,
        paymentId: payloadObj.payload ? String(payloadObj.payload) : undefined,
        status: normalizeProviderStatus(String(payloadObj.status ?? 'paid')),
        amountPaidStr,
        amountPaid: amountPaidStr !== undefined ? Number(amountPaidStr) : undefined,
        currency: normalizeCurrencyCode(currencyRaw),
        feeInUsdStr:
          payloadObj.fee_in_usd !== undefined ? String(payloadObj.fee_in_usd) : undefined,
      };
    }

    if (provider === 'xrocket') {
      const dataObj =
        obj.data && typeof obj.data === 'object'
          ? (obj.data as Record<string, unknown>)
          : obj;

      const invoiceObj =
        dataObj.invoice && typeof dataObj.invoice === 'object'
          ? (dataObj.invoice as Record<string, unknown>)
          : dataObj;

      const paymentObj =
        dataObj.payment && typeof dataObj.payment === 'object'
          ? (dataObj.payment as Record<string, unknown>)
          : undefined;

      const externalInvoiceId = String(
        invoiceObj.id ?? invoiceObj.invoiceId ?? dataObj.id ?? dataObj.invoiceId ?? '',
      );
      if (!externalInvoiceId) {
        throw new Error('В вебхуке xRocket отсутствует id инвойса');
      }

      const rawPaymentId =
        invoiceObj.clientInvoiceId ??
        invoiceObj.payload ??
        dataObj.clientInvoiceId ??
        dataObj.payload ??
        undefined;

      const rawAmount =
        paymentObj?.amount ??
        invoiceObj.paidAmount ??
        invoiceObj.priceAmount ??
        invoiceObj.amount ??
        dataObj.priceAmount ??
        dataObj.amount;
      const amountPaidStr = rawAmount !== undefined ? String(rawAmount) : undefined;

      const rawCurrency =
        paymentObj?.currency ??
        invoiceObj.paidCurrency ??
        invoiceObj.priceCurrency ??
        invoiceObj.currency ??
        dataObj.priceCurrency ??
        dataObj.currency ??
        'USDT';

      const rawNetwork =
        paymentObj?.network ?? invoiceObj.network ?? dataObj.network ?? undefined;

      const rawEvent =
        typeof dataObj.event === 'string' ? dataObj.event : undefined;
      const rawStatus =
        invoiceObj.status ??
        dataObj.status ??
        (rawEvent === 'invoice.paid' || rawEvent === 'invoicePay' ? 'paid' : 'paid');

      return {
        provider: 'xrocket',
        externalInvoiceId,
        paymentId: rawPaymentId ? String(rawPaymentId) : undefined,
        status: normalizeProviderStatus(String(rawStatus)),
        amountPaidStr,
        amountPaid: amountPaidStr !== undefined ? Number(amountPaidStr) : undefined,
        currency: normalizeCurrencyCode(String(rawCurrency)),
        network:
          typeof rawNetwork === 'string' ? normalizeNetworkCode(rawNetwork) : undefined,
      };
    }

    throw new Error(`Неизвестный платёжный провайдер: ${String(provider)}`);
  }

  /**
   * Creates an invoice via the provider's official API preserving exact decimal strings.
   */
  public async createInvoice(
    input: CreateProviderInvoiceInput,
  ): Promise<CreatedProviderInvoice> {
    if (!this.isProviderConfigured(input.provider)) {
      throw new Error(
        `Платёжный провайдер ${PAYMENT_PROVIDER_CATALOG[input.provider].shortTitle} не настроен (отсутствует API-ключ в переменных окружения).`,
      );
    }

    const creds = this.getCredentials();
    const expiresInSeconds = input.expiresInSeconds ?? 1800;
    const upperCurr = normalizeCurrencyCode(input.currency);
    const amountString =
      input.amountStr && input.amountStr.trim().length > 0
        ? input.amountStr.trim()
        : input.amountPaid !== undefined
          ? upperCurr === 'USD'
            ? input.amountPaid.toFixed(2)
            : String(input.amountPaid)
          : '';

    if (!amountString) {
      throw new Error('Не указана сумма для выставления счёта (amountStr / amountPaid).');
    }

    if (input.provider === 'cryptobot') {
      const isFiat = upperCurr === 'RUB' || upperCurr === 'USD' || upperCurr === 'EUR';
      const bodyPayload: Record<string, unknown> = isFiat
        ? {
            currency_type: 'fiat',
            fiat: upperCurr,
            accepted_assets: 'USDT,TON,BTC,ETH,LTC,BNB,TRX,USDC',
            amount: amountString,
            description: input.description,
            payload: input.paymentId,
            expires_in: expiresInSeconds,
          }
        : {
            currency_type: 'crypto',
            asset: upperCurr,
            amount: amountString,
            description: input.description,
            payload: input.paymentId,
            expires_in: expiresInSeconds,
          };

      const res = await this.transport({
        url: `${creds.cryptobotApiUrl.replace(/\/+$/, '')}/createInvoice`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Crypto-Pay-API-Token': creds.cryptobotApiToken,
        },
        body: JSON.stringify(bodyPayload),
      });

      const data = res.json as {
        ok?: boolean;
        error?: { code?: number; name?: string };
        result?: {
          invoice_id?: number | string;
          status?: string;
          amount?: string | number;
          asset?: string;
          fiat?: string;
          currency_type?: string;
          bot_invoice_url?: string;
          pay_url?: string;
          mini_app_invoice_url?: string;
          expiration_date?: string;
        };
      } | null;

      if (!res.ok || !data?.ok || !data.result?.invoice_id) {
        const errName = data?.error?.name || `HTTP_${res.status}`;
        throw new Error(
          redactSecretsFromText(`Ошибка создания счёта CryptoBot: ${errName}`),
        );
      }

      const inv = data.result;
      const payUrl =
        inv.bot_invoice_url || inv.pay_url || inv.mini_app_invoice_url || '';
      if (!payUrl) {
        throw new Error('CryptoBot не вернул ссылку на оплату (bot_invoice_url)');
      }

      const resolvedCurr =
        inv.currency_type === 'fiat'
          ? String(inv.fiat || upperCurr)
          : String(inv.asset || upperCurr);
      const resolvedAmountStr =
        inv.amount !== undefined ? String(inv.amount) : amountString;

      return {
        externalInvoiceId: String(inv.invoice_id),
        payUrl,
        status: normalizeProviderStatus(inv.status || 'active'),
        amountPaidStr: resolvedAmountStr,
        amountPaid: Number(resolvedAmountStr),
        currency: normalizeCurrencyCode(resolvedCurr),
        ...(input.network ? { network: normalizeNetworkCode(input.network) } : {}),
        expiresAt:
          inv.expiration_date ||
          new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    }

    if (input.provider === 'xrocket') {
      const priceCurrency = normalizeCurrencyCode(input.currency);
      const expiresInMs = expiresInSeconds * 1000;
      const bodyPayload: Record<string, unknown> = {
        priceAmount: amountString,
        priceCurrency,
        payCurrencies: [priceCurrency],
        clientInvoiceId: input.paymentId,
        description: input.description,
        expiresIn: expiresInMs,
      };

      const url = buildXRocketApiV1Url(creds.xrocketApiUrl, '/invoices');
      const res = await this.transport({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${creds.xrocketApiKey}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        const { errorMessage, details } = parseXRocketErrorDetails(
          res.status,
          res.json,
        );
        throw new XRocketApiError(errorMessage, res.status, details);
      }

      const rawObj =
        res.json && typeof res.json === 'object'
          ? (res.json as Record<string, unknown>)
          : {};
      const inv =
        rawObj.data && typeof rawObj.data === 'object'
          ? (rawObj.data as Record<string, unknown>)
          : rawObj;

      const linksObj =
        inv.links && typeof inv.links === 'object'
          ? (inv.links as Record<string, unknown>)
          : {};

      const externalId = inv.id !== undefined ? String(inv.id) : '';
      const payUrl = String(
        linksObj.telegramBotLink ??
          linksObj.webLink ??
          inv.telegramBotLink ??
          inv.link ??
          inv.payUrl ??
          '',
      );

      if (!externalId || !payUrl) {
        const { errorMessage, details } = parseXRocketErrorDetails(
          res.status,
          res.json,
        );
        throw new XRocketApiError(
          `${errorMessage} — ответ API не содержит id или links.telegramBotLink`,
          res.status,
          details,
        );
      }

      const resolvedAmountStr = String(
        inv.priceAmount ?? inv.amount ?? amountString,
      );
      const resolvedCurrency = normalizeCurrencyCode(
        String(inv.priceCurrency ?? inv.currency ?? priceCurrency),
      );
      const resolvedExpiresAt =
        typeof inv.expiresAt === 'string' && inv.expiresAt.length > 0
          ? inv.expiresAt
          : new Date(Date.now() + expiresInMs).toISOString();

      return {
        externalInvoiceId: externalId,
        payUrl,
        status: normalizeProviderStatus(String(inv.status ?? 'PENDING')),
        amountPaidStr: resolvedAmountStr,
        amountPaid: Number(resolvedAmountStr),
        currency: resolvedCurrency,
        ...(input.network ? { network: normalizeNetworkCode(input.network) } : {}),
        expiresAt: resolvedExpiresAt,
      };
    }

    throw new Error(`Неподдерживаемый платёжный провайдер: ${String(input.provider)}`);
  }

  /**
   * Queries the provider's authoritative server-side API to verify the real status,
   * exact amount string, currency, network, fee, and clientInvoiceId/payload of an invoice.
   */
  public async verifyInvoiceStatus(params: {
    provider: BalanceTopUpProvider;
    externalInvoiceId: string;
    paymentId: string;
  }): Promise<VerifiedProviderInvoice> {
    if (!this.isProviderConfigured(params.provider)) {
      throw new Error(
        `Платёжный провайдер ${PAYMENT_PROVIDER_CATALOG[params.provider].shortTitle} не настроен.`,
      );
    }

    const creds = this.getCredentials();

    if (params.provider === 'cryptobot') {
      const url = `${creds.cryptobotApiUrl.replace(/\/+$/, '')}/getInvoices?invoice_ids=${encodeURIComponent(params.externalInvoiceId)}`;
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          'Crypto-Pay-API-Token': creds.cryptobotApiToken,
        },
      });

      const data = res.json as {
        ok?: boolean;
        error?: { name?: string };
        result?:
          | {
              items?: Array<{
                invoice_id?: number | string;
                status?: string;
                amount?: string | number;
                paid_amount?: string | number;
                asset?: string;
                paid_asset?: string;
                fiat?: string;
                currency_type?: string;
                fee_in_usd?: string | number;
                payload?: string;
                paid_at?: string;
              }>;
            }
          | Array<{
              invoice_id?: number | string;
              status?: string;
              amount?: string | number;
              paid_amount?: string | number;
              asset?: string;
              paid_asset?: string;
              fiat?: string;
              currency_type?: string;
              fee_in_usd?: string | number;
              payload?: string;
              paid_at?: string;
            }>;
      } | null;

      if (!res.ok || !data?.ok || !data.result) {
        throw new Error(
          redactSecretsFromText(
            `Ошибка проверки статуса счёта CryptoBot: ${data?.error?.name || res.status}`,
          ),
        );
      }

      const items = Array.isArray(data.result)
        ? data.result
        : data.result.items || [];
      const found = items.find(
        (item) => String(item.invoice_id) === String(params.externalInvoiceId),
      );
      if (!found) {
        throw new Error(
          `Счёт CryptoBot #${params.externalInvoiceId} не найден в ответе API`,
        );
      }

      const rawCurrency =
        found.currency_type === 'fiat'
          ? String(found.fiat || 'USD')
          : String(found.paid_asset || found.asset || found.fiat || 'USDT');

      // For fiat USD invoices where CryptoBot reports paid_amount in crypto (when paid_asset != USD),
      // use `amount` (fiat USD amount billed) if currency_type === 'fiat', otherwise `paid_amount ?? amount`.
      const rawAmount =
        found.currency_type === 'fiat'
          ? (found.amount ?? found.paid_amount ?? '0')
          : (found.paid_amount ?? found.amount ?? '0');
      const amountPaidStr = String(rawAmount);

      return {
        externalInvoiceId: String(found.invoice_id),
        paymentId: found.payload ? String(found.payload) : undefined,
        status: normalizeProviderStatus(found.status),
        amountPaidStr,
        amountPaid: Number(amountPaidStr),
        currency: normalizeCurrencyCode(rawCurrency),
        feeInUsdStr:
          found.fee_in_usd !== undefined ? String(found.fee_in_usd) : undefined,
        paidAt: found.paid_at,
      };
    }

    if (params.provider === 'xrocket') {
      const url = buildXRocketApiV1Url(
        creds.xrocketApiUrl,
        `/invoices?ids=${encodeURIComponent(params.externalInvoiceId)}`,
      );
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${creds.xrocketApiKey}`,
        },
      });

      if (!res.ok) {
        const { errorMessage, details } = parseXRocketErrorDetails(
          res.status,
          res.json,
        );
        throw new XRocketApiError(errorMessage, res.status, details);
      }

      const raw = res.json;
      let items: Array<Record<string, unknown>> = [];
      if (Array.isArray(raw)) {
        items = raw as Array<Record<string, unknown>>;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (Array.isArray(obj.data)) {
          items = obj.data as Array<Record<string, unknown>>;
        } else if (Array.isArray(obj.items)) {
          items = obj.items as Array<Record<string, unknown>>;
        } else if (obj.data && typeof obj.data === 'object') {
          items = [obj.data as Record<string, unknown>];
        } else if (obj.id !== undefined) {
          items = [obj];
        }
      }

      const found = items.find(
        (item) => String(item.id) === String(params.externalInvoiceId),
      );
      if (!found) {
        throw new XRocketApiError(
          `Счёт xRocket Pay #${params.externalInvoiceId} не найден в ответе API v1`,
          404,
          {
            status: 404,
            title: 'Not Found',
            detail: `Invoice ${params.externalInvoiceId} not returned by GET /api/v1/invoices`,
            kind: 'invoice_not_found',
          },
        );
      }

      const paymentObj =
        found.payment && typeof found.payment === 'object'
          ? (found.payment as Record<string, unknown>)
          : undefined;

      const resolvedPaymentId =
        found.clientInvoiceId !== undefined
          ? String(found.clientInvoiceId)
          : found.payload !== undefined
            ? String(found.payload)
            : undefined;

      const rawAmount =
        paymentObj?.amount ?? found.paidAmount ?? found.priceAmount ?? found.amount ?? '0';
      const amountPaidStr = String(rawAmount);

      const resolvedCurrency = normalizeCurrencyCode(
        String(
          paymentObj?.currency ??
            found.paidCurrency ??
            found.priceCurrency ??
            found.currency ??
            'USDT',
        ),
      );

      const resolvedNetwork = normalizeNetworkCode(
        typeof paymentObj?.network === 'string'
          ? paymentObj.network
          : typeof found.network === 'string'
            ? found.network
            : undefined,
      );

      const rawFeeUsd = paymentObj?.feeInUsd ?? found.feeInUsd ?? found.feeUsd;

      return {
        externalInvoiceId: String(found.id),
        paymentId: resolvedPaymentId,
        status: normalizeProviderStatus(String(found.status ?? 'PENDING')),
        amountPaidStr,
        amountPaid: Number(amountPaidStr),
        currency: resolvedCurrency,
        ...(resolvedNetwork ? { network: resolvedNetwork } : {}),
        ...(rawFeeUsd !== undefined ? { feeInUsdStr: String(rawFeeUsd) } : {}),
        paidAt:
          typeof paymentObj?.finalizedAt === 'string'
            ? paymentObj.finalizedAt
            : typeof found.paidAt === 'string'
              ? found.paidAt
              : typeof found.paid === 'string'
                ? found.paid
                : undefined,
      };
    }

    throw new Error(`Неизвестный платёжный провайдер: ${String(params.provider)}`);
  }
}

export const paymentProviderGateway = new PaymentProviderGateway();
