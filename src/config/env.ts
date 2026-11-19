import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ quiet: true });

interface AppletFirebaseConfig {
  projectId: string;
  firestoreDatabaseId: string;
  apiKey?: string;
  appId?: string;
  authDomain?: string;
}

function loadAppletFirebaseConfig(): AppletFirebaseConfig {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppletFirebaseConfig>;
      return {
        projectId: parsed.projectId || '',
        firestoreDatabaseId: parsed.firestoreDatabaseId || '(default)',
        apiKey: parsed.apiKey,
        appId: parsed.appId,
        authDomain: parsed.authDomain,
      };
    }
  } catch {
    // Fallback to env variables if config file is unreadable
  }
  return {
    projectId: '',
    firestoreDatabaseId: '(default)',
  };
}

/**
 * Strips accidental "KEY=" prefixes and surrounding quotes if a variable
 * was pasted as "KEY=value" into the secret manager UI.
 */
export function cleanEnvValue(key: string, raw: string | undefined): string {
  if (!raw) return '';
  let val = raw.trim();
  const prefixPattern = new RegExp(`^${key}\\s*=\\s*`, 'i');
  if (prefixPattern.test(val)) {
    val = val.replace(prefixPattern, '').trim();
  }
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1).trim();
  }
  return val;
}

export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  allowLocalFallback: boolean;
  storeName: string;
  telegramBotToken: string;
  botMode: 'polling' | 'webhook';
  webhookUrl: string;
  webhookSecret: string;
  adminIds: number[];
  ownerTelegramId: number | null;
  storeSupportUsername: string;
  firebaseProjectId: string;
  firebaseDatabaseId: string;
  firebaseClientEmail: string;
  firebasePrivateKey: string;
  appletFirebaseConfig: AppletFirebaseConfig;
  cryptobotApiToken: string;
  cryptobotApiUrl: string;
  xrocketApiKey: string;
  xrocketApiUrl: string;
  mystarsPaymentCurrency: 'usdt_ton';
  mystarsApiBaseUrl: string;
  mystarsApiKey: string;
  tonWalletAddress: string;
}

function parseAdminIds(raw: string | undefined): number[] {
  const cleaned = cleanEnvValue('ADMIN_IDS', raw);
  if (!cleaned) return [];
  return cleaned
    .split(',')
    .map((item) => Number(item.replace(/^ADMIN_IDS\s*=\s*/i, '').trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function parseOwnerTelegramId(raw: string | undefined): number | null {
  const cleaned = cleanEnvValue('OWNER_TELEGRAM_ID', raw);
  if (!cleaned) return null;
  const num = Number(cleaned.replace(/^OWNER_TELEGRAM_ID\s*=\s*/i, '').trim());
  return Number.isInteger(num) && num > 0 ? num : null;
}

function normalizePrivateKey(raw: string | undefined): string {
  const cleaned = cleanEnvValue('FIREBASE_PRIVATE_KEY', raw);
  if (!cleaned) return '';
  return cleaned.replace(/\\n/g, '\n').trim();
}

function resolveFirebaseProjectId(
  rawProjectId: string,
  clientEmail: string,
  appletProjectId: string,
): string {
  // Extract project ID from service account email (<name>@<project-id>.iam.gserviceaccount.com)
  const emailMatch = clientEmail.match(/@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/i);
  const serviceAccountProjectId = emailMatch ? emailMatch[1] : '';

  const isPlaceholder =
    !rawProjectId ||
    rawProjectId === 'my-telegram-shop-12345' ||
    rawProjectId === 'your-project-id' ||
    rawProjectId === 'remixed-project-id';

  if (serviceAccountProjectId && (isPlaceholder || rawProjectId !== serviceAccountProjectId)) {
    return serviceAccountProjectId;
  }

  return rawProjectId || serviceAccountProjectId || appletProjectId || '';
}

export function getEnvConfig(): AppConfig {
  if (process.env.NODE_ENV !== 'test') {
    dotenv.config({ quiet: true });
  }
  const appletConfig = loadAppletFirebaseConfig();

  const rawNodeEnv = cleanEnvValue('NODE_ENV', process.env.NODE_ENV).toLowerCase();
  const nodeEnv: 'development' | 'production' | 'test' =
    rawNodeEnv === 'test'
      ? 'test'
      : rawNodeEnv === 'development'
        ? 'development'
        : 'production';

  const rawAllowFallback = cleanEnvValue(
    'ALLOW_LOCAL_FALLBACK',
    process.env.ALLOW_LOCAL_FALLBACK,
  ).toLowerCase();
  const allowLocalFallback =
    nodeEnv === 'test' || rawAllowFallback === 'true' || rawAllowFallback === '1';

  const botModeCleaned = cleanEnvValue('BOT_MODE', process.env.BOT_MODE).toLowerCase();
  const botMode: 'polling' | 'webhook' =
    botModeCleaned === 'webhook' ? 'webhook' : 'polling';

  const supportCleaned = cleanEnvValue(
    'STORE_SUPPORT_USERNAME',
    process.env.STORE_SUPPORT_USERNAME,
  );
  const storeSupportUsername = (supportCleaned || 'quizystars_support').replace(/^@/, '');
  const storeName =
    cleanEnvValue('STORE_NAME', process.env.STORE_NAME) || 'QuizyStars';

  const firebaseClientEmail = cleanEnvValue(
    'FIREBASE_CLIENT_EMAIL',
    process.env.FIREBASE_CLIENT_EMAIL,
  );
  const rawFirebaseProjectId = cleanEnvValue(
    'FIREBASE_PROJECT_ID',
    process.env.FIREBASE_PROJECT_ID,
  );
  const firebaseProjectId = resolveFirebaseProjectId(
    rawFirebaseProjectId,
    firebaseClientEmail,
    appletConfig.projectId,
  );

  const ownerTelegramId = parseOwnerTelegramId(process.env.OWNER_TELEGRAM_ID);
  const parsedAdmins = parseAdminIds(process.env.ADMIN_IDS);
  const adminIds =
    ownerTelegramId && !parsedAdmins.includes(ownerTelegramId)
      ? [ownerTelegramId, ...parsedAdmins]
      : parsedAdmins;

  const xrocketToken =
    cleanEnvValue('XROCKET_API_KEY', process.env.XROCKET_API_KEY) ||
    cleanEnvValue('XROCKET_API_TOKEN', process.env.XROCKET_API_TOKEN);

  return {
    port: Number(process.env.PORT || 3000),
    nodeEnv,
    allowLocalFallback,
    storeName,
    telegramBotToken: cleanEnvValue(
      'TELEGRAM_BOT_TOKEN',
      process.env.TELEGRAM_BOT_TOKEN,
    ),
    botMode,
    webhookUrl: cleanEnvValue('WEBHOOK_URL', process.env.WEBHOOK_URL),
    webhookSecret: cleanEnvValue('WEBHOOK_SECRET', process.env.WEBHOOK_SECRET),
    adminIds,
    ownerTelegramId,
    storeSupportUsername,
    firebaseProjectId,
    firebaseDatabaseId: appletConfig.firestoreDatabaseId || '(default)',
    firebaseClientEmail,
    firebasePrivateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    appletFirebaseConfig: appletConfig,
    cryptobotApiToken: cleanEnvValue(
      'CRYPTOBOT_API_TOKEN',
      process.env.CRYPTOBOT_API_TOKEN,
    ),
    cryptobotApiUrl:
      cleanEnvValue('CRYPTOBOT_API_URL', process.env.CRYPTOBOT_API_URL) ||
      'https://pay.crypt.bot/api',
    xrocketApiKey: xrocketToken,
    xrocketApiUrl:
      cleanEnvValue('XROCKET_API_URL', process.env.XROCKET_API_URL) ||
      'https://pay.api.xrocket.exchange',
    mystarsPaymentCurrency: 'usdt_ton',
    mystarsApiBaseUrl:
      cleanEnvValue('MYSTARS_API_BASE_URL', process.env.MYSTARS_API_BASE_URL) ||
      'https://api.mystars.tg',
    mystarsApiKey: cleanEnvValue('MYSTARS_API_KEY', process.env.MYSTARS_API_KEY),
    tonWalletAddress: cleanEnvValue(
      'TON_WALLET_ADDRESS',
      process.env.TON_WALLET_ADDRESS,
    ),
  };
}

export function isAdminTelegramId(telegramId: number | undefined): boolean {
  if (!telegramId) return false;
  const config = getEnvConfig();
  return config.adminIds.includes(telegramId);
}

/**
 * Checks whether the given Telegram ID strictly matches OWNER_TELEGRAM_ID.
 * Regular admins in ADMIN_IDS who are not OWNER_TELEGRAM_ID return false.
 */
export function isOwnerTelegramId(telegramId: number | undefined): boolean {
  if (!telegramId || !Number.isInteger(telegramId) || telegramId <= 0) {
    return false;
  }
  const config = getEnvConfig();
  if (!config.ownerTelegramId) {
    return false;
  }
  return config.ownerTelegramId === telegramId;
}

export {
  MIN_TOPUP_AMOUNT_USD_CENTS,
  MAX_TOPUP_AMOUNT_USD_CENTS,
  centsToUsdString,
  formatUsdCents,
  usdInputToCents,
} from '../services/Money.ts';

/**
 * Server-side limits for free-form balance top-ups in US Dollars (USD).
 * Derived from integer cent bounds ($0.50 – $50,000.00).
 */
export const MIN_TOPUP_AMOUNT_USD = 0.5;
export const MAX_TOPUP_AMOUNT_USD = 50000.0;

/**
 * Formats a numeric USD dollar value using exact integer cent rounding.
 */
export function formatUsd(amountUsd: number): string {
  const num = Number.isFinite(amountUsd) ? amountUsd : 0;
  const sign = num < 0 ? '-' : '';
  const absCents = Math.round(Math.abs(num) * 100);
  const dollars = Math.trunc(absCents / 100);
  const rem = absCents % 100;
  return `${sign}$${dollars}.${String(rem).padStart(2, '0')}`;
}



