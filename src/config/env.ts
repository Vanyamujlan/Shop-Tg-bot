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
  storeSupportUsername: string;
  firebaseProjectId: string;
  firebaseDatabaseId: string;
  firebaseClientEmail: string;
  firebasePrivateKey: string;
  appletFirebaseConfig: AppletFirebaseConfig;
}

function parseAdminIds(raw: string | undefined): number[] {
  const cleaned = cleanEnvValue('ADMIN_IDS', raw);
  if (!cleaned) return [];
  return cleaned
    .split(',')
    .map((item) => Number(item.replace(/^ADMIN_IDS\s*=\s*/i, '').trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
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
    adminIds: parseAdminIds(process.env.ADMIN_IDS),
    storeSupportUsername,
    firebaseProjectId,
    firebaseDatabaseId: appletConfig.firestoreDatabaseId || '(default)',
    firebaseClientEmail,
    firebasePrivateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    appletFirebaseConfig: appletConfig,
  };
}

export function isAdminTelegramId(telegramId: number | undefined): boolean {
  if (!telegramId) return false;
  const config = getEnvConfig();
  return config.adminIds.includes(telegramId);
}
