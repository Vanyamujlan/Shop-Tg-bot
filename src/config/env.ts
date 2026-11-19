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
  const storeSupportUsername = (supportCleaned || 'support').replace(/^@/, '');

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

/**
 * Server-side limits for free-form balance top-ups in US Dollars (USD).
 */
export const MIN_TOPUP_AMOUNT_USD = 0.5;
export const MAX_TOPUP_AMOUNT_USD = 50000.0;

/**
 * Reference USD exchange rates for supported payment currencies (1 unit in USD).
 * Used when a user enters a top-up amount in USD ($) and chooses a non-USD crypto asset.
 * The rate and net credited USD amount are locked in Firestore at invoice creation time.
 */
export const CRYPTO_USD_RATES: Readonly<Record<string, number>> = Object.freeze({
  USD: 1.0,
  USDT: 1.0,
  USDC: 1.0,
  TON: 5.5,
  TONCOIN: 5.5,
  TRX: 0.25,
  BNB: 600.0,
  ETH: 3000.0,
  BTC: 90000.0,
  LTC: 100.0,
});

/**
 * Formats a numeric USD amount consistently as `$10.00`, `$19.99`, `$100.00`.
 */
export function formatUsd(amount: number): string {
  const num = Number.isFinite(amount) ? amount : 0;
  const sign = num < 0 ? '-' : '';
  return `${sign}$${Math.abs(num).toFixed(2)}`;
}


