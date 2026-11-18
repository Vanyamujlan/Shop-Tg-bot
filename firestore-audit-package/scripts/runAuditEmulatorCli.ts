import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { assertEmulatorOnlyEnvironment } from '../../src/db/firestore.ts';
import { AUDIT_PROJECT_ID } from './seedSyntheticData.ts';

const EXPECTED_EMULATOR_HOST = '127.0.0.1:8080';

function verifyPrerequisites(): void {
  console.log('[AuditCLI] 1/5 Проверка зависимостей и конфигурации эмулятора...');

  // 1. Check firebase.json
  const firebaseJsonPath = path.resolve(process.cwd(), 'firebase.json');
  if (!fs.existsSync(firebaseJsonPath)) {
    throw new Error('Отсутствует файл firebase.json в корне проекта.');
  }
  const firebaseConfig = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf-8'));
  const fsHost = firebaseConfig?.emulators?.firestore?.host;
  const fsPort = firebaseConfig?.emulators?.firestore?.port;
  if (`${fsHost}:${fsPort}` !== EXPECTED_EMULATOR_HOST) {
    throw new Error(
      `Некорректный адрес Firestore Emulator в firebase.json: ${fsHost}:${fsPort}. Ожидается строго ${EXPECTED_EMULATOR_HOST}.`,
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

  // 3. Check Firebase CLI
  try {
    const fbVersion = execFileSync('firebase', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    console.log(`[AuditCLI] ✔ Firebase CLI найден: v${fbVersion}`);
  } catch (err) {
    throw new Error(
      `Firebase CLI не найден или не запускается: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4. Check Java >= 21 runtime required by Firestore Emulator
  try {
    const javaOut = execFileSync('java', ['-version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const combined = javaOut || '';
    console.log(`[AuditCLI] ✔ Java Runtime проверен ${combined.split('\n')[0] || ''}`);
  } catch (err) {
    throw new Error(
      `Java Runtime (JRE >= 21) не найден для запуска Firestore Emulator: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function sanitizeAndGuardEnvironment(): NodeJS.ProcessEnv {
  console.log('[AuditCLI] 2/5 Очистка секретов окружения и запуск ProductionGuard...');

  // Explicitly remove any production credentials or tokens from current process
  delete process.env.FIREBASE_PRIVATE_KEY;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.WEBHOOK_SECRET;

  process.env.FIRESTORE_EMULATOR_HOST = EXPECTED_EMULATOR_HOST;
  process.env.GCLOUD_PROJECT = AUDIT_PROJECT_ID;
  process.env.FIREBASE_PROJECT_ID = AUDIT_PROJECT_ID;
  process.env.ALLOW_LOCAL_FALLBACK = 'false';

  const guardResult = assertEmulatorOnlyEnvironment(AUDIT_PROJECT_ID);
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

  console.log(
    `[AuditCLI] ✔ ProductionGuard подтверждён: projectId="${guardResult.projectId}", host="${guardResult.emulatorHost}"`,
  );

  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.FIREBASE_PRIVATE_KEY;
  delete cleanEnv.FIREBASE_CLIENT_EMAIL;
  delete cleanEnv.GOOGLE_APPLICATION_CREDENTIALS;
  delete cleanEnv.TELEGRAM_BOT_TOKEN;
  delete cleanEnv.WEBHOOK_SECRET;

  return cleanEnv;
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

function main(): void {
  try {
    verifyPrerequisites();
    const cleanEnv = sanitizeAndGuardEnvironment();

    const nativeExportDir = path.resolve(
      process.cwd(),
      'firestore-audit-package/export/native-emulator-export',
    );
    fs.rmSync(nativeExportDir, { recursive: true, force: true });

    console.log(
      `[AuditCLI] 3/5 Запуск Firebase Firestore Emulator (${EXPECTED_EMULATOR_HOST}, project: ${AUDIT_PROJECT_ID}) и прогон всех тестов...`,
    );

    const execResult = spawnSync(
      'firebase',
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
        env: cleanEnv,
        stdio: 'inherit',
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

main();
