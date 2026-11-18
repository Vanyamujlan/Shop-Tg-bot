import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertEmulatorOnlyEnvironment } from '../../src/db/firestore.ts';
import { AUDIT_PROJECT_ID } from './seedSyntheticData.ts';

export const EXPECTED_EMULATOR_HOST = '127.0.0.1:8080';
export const MIN_REQUIRED_JAVA_MAJOR = 21;

export class JavaVersionError extends Error {
  public readonly code = 'JAVA_VERSION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'JavaVersionError';
  }
}

export interface ParsedJavaVersion {
  major: number;
  rawVersion: string;
  firstLine: string;
}

/**
 * Parses Java version output from stderr/stdout across OpenJDK, Oracle Java, Temurin, Corretto, etc.
 * Supports:
 * - 'openjdk version "21.0.13.0.3" 2026-10-24'
 * - 'java version "22.0.1" 2024-04-16'
 * - 'openjdk version "17.0.21" 2026-04-14'
 * - 'java version "1.8.0_392"' (legacy 1.x format -> major 8)
 * - 'openjdk 21.0.4 2024-07-16' (modern --version format without quotes)
 * - 'java 21 2023-09-19'
 */
export function parseJavaMajorVersion(versionOutput: string): ParsedJavaVersion {
  const normalized = String(versionOutput || '')
    .replace(/\r\n/g, '\n')
    .trim();

  if (!normalized) {
    throw new JavaVersionError(
      'Не удалось определить версию Java: вывод команды пуст.',
    );
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let rawVersion: string | null = null;
  let matchedLine = lines[0] || '';

  for (const line of lines) {
    // Format 1: java version "21.0.2" or openjdk version "17.0.10"
    const quotedMatch = line.match(
      /\b(?:java|openjdk|graalvm)\b[^\n"]*?\bversion\s+"([^"]+)"/i,
    );
    if (quotedMatch && quotedMatch[1]) {
      rawVersion = quotedMatch[1].trim();
      matchedLine = line;
      break;
    }

    // Format 2: openjdk 21.0.4 2024-07-16 or java 22.0.1
    const unquotedMatch = line.match(
      /^(?:java|openjdk)\s+([0-9][0-9A-Za-z._+-]*)(?:\s|$)/i,
    );
    if (unquotedMatch && unquotedMatch[1]) {
      rawVersion = unquotedMatch[1].trim();
      matchedLine = line;
      break;
    }
  }

  if (!rawVersion) {
    throw new JavaVersionError(
      `Не удалось распознать формат версии Java из вывода: "${lines[0] || normalized}".`,
    );
  }

  const versionNumbersMatch = rawVersion.match(/^(\d+)(?:\.(\d+))?/);
  if (!versionNumbersMatch) {
    throw new JavaVersionError(
      `Некорректный формат номера версии Java: "${rawVersion}".`,
    );
  }

  const firstNum = Number.parseInt(versionNumbersMatch[1], 10);
  const secondNum =
    versionNumbersMatch[2] !== undefined
      ? Number.parseInt(versionNumbersMatch[2], 10)
      : undefined;

  // Legacy Java 1.8.0_x / 1.7.0_x uses the second number as the major version
  const major =
    firstNum === 1 && secondNum !== undefined && Number.isInteger(secondNum)
      ? secondNum
      : firstNum;

  if (!Number.isInteger(major) || major <= 0) {
    throw new JavaVersionError(
      `Не удалось извлечь major-версию Java из строки "${rawVersion}".`,
    );
  }

  return {
    major,
    rawVersion,
    firstLine: matchedLine,
  };
}

/**
 * Validates that the parsed Java version is >= minMajor (defaults to 21).
 */
export function assertSupportedJavaVersion(
  versionOutput: string,
  minMajor: number = MIN_REQUIRED_JAVA_MAJOR,
): ParsedJavaVersion {
  const parsed = parseJavaMajorVersion(versionOutput);
  if (parsed.major < minMajor) {
    throw new JavaVersionError(
      `Неподдерживаемая версия Java: обнаружена Java ${parsed.major} ("${parsed.rawVersion}"), но для работы Firebase Firestore Emulator требуется Java ${minMajor} или выше.`,
    );
  }
  return parsed;
}

/**
 * Executes `java -version` in an OS-independent way, captures both stderr and stdout,
 * and verifies that Java >= minMajor is installed.
 */
export function verifyJavaRuntime(
  javaCommand = 'java',
  minMajor: number = MIN_REQUIRED_JAVA_MAJOR,
): ParsedJavaVersion {
  const res = spawnSync(javaCommand, ['-version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (res.error) {
    throw new JavaVersionError(
      `Java Runtime ("${javaCommand}") не найден или не удалось запустить процесс: ${res.error.message}. Установите JDK/JRE версии ${minMajor} или выше.`,
    );
  }

  const combinedOutput = [res.stderr, res.stdout]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .trim();

  if (!combinedOutput) {
    throw new JavaVersionError(
      `Команда "${javaCommand} -version" не вернула версию Java (код выхода: ${res.status ?? 'unknown'}).`,
    );
  }

  return assertSupportedJavaVersion(combinedOutput, minMajor);
}

/**
 * Builds an isolated environment object for the Emulator child process WITHOUT mutating
 * the parent process's `process.env` or touching any real project secrets.
 * Runs ProductionGuard on the constructed child environment before returning.
 */
export function buildIsolatedEmulatorChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv };

  // Strip sensitive credentials ONLY in the isolated child process environment copy
  delete childEnv.FIREBASE_PRIVATE_KEY;
  delete childEnv.FIREBASE_CLIENT_EMAIL;
  delete childEnv.GOOGLE_APPLICATION_CREDENTIALS;
  delete childEnv.TELEGRAM_BOT_TOKEN;
  delete childEnv.WEBHOOK_SECRET;

  childEnv.FIRESTORE_EMULATOR_HOST = EXPECTED_EMULATOR_HOST;
  childEnv.GCLOUD_PROJECT = AUDIT_PROJECT_ID;
  childEnv.FIREBASE_PROJECT_ID = AUDIT_PROJECT_ID;
  childEnv.ALLOW_LOCAL_FALLBACK = 'false';
  childEnv.NODE_ENV = 'development';
  childEnv.ADMIN_IDS = '900000001,900000002';
  childEnv.STORE_SUPPORT_USERNAME = 'synthetic_support_bot';

  // Run ProductionGuard on childEnv BEFORE starting any Firebase/Emulator process
  const guardResult = assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID, childEnv);
  if (guardResult.emulatorHost !== EXPECTED_EMULATOR_HOST) {
    throw new Error(
      `ProductionGuard: неожиданный адрес эмулятора "${guardResult.emulatorHost}". Требуется строго "${EXPECTED_EMULATOR_HOST}".`,
    );
  }
  if (guardResult.projectId !== AUDIT_PROJECT_ID) {
    throw new Error(
      `ProductionGuard: неожиданный projectId "${guardResult.projectId}". Требуется строго "${AUDIT_PROJECT_ID}".`,
    );
  }

  return childEnv;
}

function verifyPrerequisitesAndGuard(): NodeJS.ProcessEnv {
  console.log('[AuditCLI] 1/5 Проверка ProductionGuard и создание изолированного окружения дочернего процесса...');
  const childEnv = buildIsolatedEmulatorChildEnv(process.env);
  console.log(
    `[AuditCLI] ✔ ProductionGuard подтверждён до инициализации Firebase: projectId="${AUDIT_PROJECT_ID}", host="${EXPECTED_EMULATOR_HOST}" (родительский process.env не изменён).`,
  );

  console.log('[AuditCLI] 2/5 Проверка конфигурации firebase.json, пакетов, Firebase CLI и Java >= 21...');

  // 1. Check firebase.json
  const firebaseJsonPath = path.resolve(process.cwd(), 'firebase.json');
  if (!fs.existsSync(firebaseJsonPath)) {
    throw new Error('Отсутствует файл firebase.json в корне проекта.');
  }
  const firebaseConfig = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf-8'));
  const fsHost = firebaseConfig?.emulators?.firestore?.host;
  const fsPort = firebaseConfig?.emulators?.firestore?.port;
  const configuredHostPort = `${fsHost}:${fsPort}`;
  if (
    configuredHostPort !== '127.0.0.1:8080' &&
    configuredHostPort !== 'localhost:8080'
  ) {
    throw new Error(
      `Некорректный адрес Firestore Emulator в firebase.json: ${configuredHostPort}. Ожидается 127.0.0.1:8080 или localhost:8080.`,
    );
  }

  // 2. Check required npm packages
  const requiredPackages = [
    '@firebase/rules-unit-testing',
    'firebase-admin',
    'firebase',
    'tsx',
  ];
  for (const pkg of requiredPackages) {
    const pkgJson = path.resolve(process.cwd(), 'node_modules', pkg, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      throw new Error(`Отсутствует обязательный пакет в node_modules: ${pkg}`);
    }
  }

  // 3. Check Java >= 21 runtime (captures both stderr and stdout)
  const javaInfo = verifyJavaRuntime('java', MIN_REQUIRED_JAVA_MAJOR);
  console.log(
    `[AuditCLI] ✔ Java Runtime проверен: major=${javaInfo.major}, version="${javaInfo.rawVersion}" (${javaInfo.firstLine})`,
  );

  // 4. Check Firebase CLI in an OS-independent way
  const firebaseCmd = process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
  const fbRes = spawnSync(firebaseCmd, ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (fbRes.error || fbRes.status !== 0) {
    const errText = fbRes.error ? fbRes.error.message : (fbRes.stderr || fbRes.stdout || '').trim();
    throw new Error(`Firebase CLI не найден или завершился с ошибкой: ${errText}`);
  }
  const fbVersion = (fbRes.stdout || fbRes.stderr || '').trim();
  console.log(`[AuditCLI] ✔ Firebase CLI найден: v${fbVersion}`);

  return childEnv;
}

function verifyExportedArtifacts(): void {
  console.log('[AuditCLI] 4/5 Проверка сохранённых JSON-артефактов и нативного снимка...');

  const resultsPath = path.resolve(
    process.cwd(),
    'firestore-audit-package/export/audit-test-results.json',
  );
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Файл результатов тестов не найден: ${resultsPath}`);
  }
  const resultsJson = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
  if (
    resultsJson.projectId !== AUDIT_PROJECT_ID ||
    resultsJson.emulatorHost !== EXPECTED_EMULATOR_HOST
  ) {
    throw new Error(
      `Несовпадение метаданных в audit-test-results.json: projectId=${resultsJson.projectId}, host=${resultsJson.emulatorHost}`,
    );
  }
  if (resultsJson.failed !== 0 || resultsJson.passed !== resultsJson.totalTests) {
    throw new Error(
      `Не все тесты пройдены: passed=${resultsJson.passed}, failed=${resultsJson.failed}, total=${resultsJson.totalTests}`,
    );
  }

  const dumpPath = path.resolve(
    process.cwd(),
    'firestore-audit-package/export/firestore-collections-dump.json',
  );
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`JSON-дамп коллекций не найден: ${dumpPath}`);
  }
  const dumpJson = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
  const collections = dumpJson?.collections || {};
  const expectedCounts: Record<string, number> = {
    settings: 1,
    admins: 2,
    products: 6,
    users: 4,
    orders: 12,
    payments: 10,
    transactions: 19,
  };
  let totalDocs = 0;
  for (const [col, expected] of Object.entries(expectedCounts)) {
    const actual = Object.keys(collections[col] || {}).length;
    if (actual !== expected) {
      throw new Error(
        `Несовпадение числа документов в коллекции "${col}" внутри JSON-дампа: ожидалось ${expected}, получено ${actual}`,
      );
    }
    totalDocs += actual;
  }

  const nativeMetaPath = path.resolve(
    process.cwd(),
    'firestore-audit-package/export/native-emulator-export/firebase-export-metadata.json',
  );
  if (!fs.existsSync(nativeMetaPath)) {
    throw new Error(`Метаданные нативного экспорта эмулятора не найдены: ${nativeMetaPath}`);
  }

  console.log(
    `[AuditCLI] ✔ Проверены артефакты: ${resultsJson.passed}/${resultsJson.totalTests} PASS, ${totalDocs} документов в 7 коллекциях, нативный снимок сохранён.`,
  );
}

export function runAuditCliMain(): void {
  try {
    const childEnv = verifyPrerequisitesAndGuard();

    const nativeExportDir = path.resolve(
      process.cwd(),
      'firestore-audit-package/export/native-emulator-export',
    );
    fs.rmSync(nativeExportDir, { recursive: true, force: true });

    console.log(
      `[AuditCLI] 3/5 Запуск Firebase Firestore Emulator (${EXPECTED_EMULATOR_HOST}, project: ${AUDIT_PROJECT_ID}) и прогон всех тестов...`,
    );

    const firebaseCmd = process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
    const execResult = spawnSync(
      firebaseCmd,
      [
        'emulators:exec',
        '--only',
        'firestore',
        '--project',
        AUDIT_PROJECT_ID,
        `--export-on-exit=${nativeExportDir}`,
        'npx tsx firestore-audit-package/tests/runEmulatorAuditSuite.ts',
      ],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdio: 'inherit',
        windowsHide: true,
      },
    );

    if (execResult.status !== 0) {
      console.error(
        `[AuditCLI] ✖ Firebase Emulator завершился с ненулевым кодом: ${execResult.status ?? 1}`,
      );
      process.exit(execResult.status ?? 1);
    }

    verifyExportedArtifacts();
    console.log('[AuditCLI] 5/5 ✅ Полный аудит на локальном Firestore Emulator успешно завершён.');
  } catch (err) {
    console.error(
      '[AuditCLI] ✖ Критическая ошибка выполнения audit:emulator:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === executedFilePath) {
  runAuditCliMain();
}
