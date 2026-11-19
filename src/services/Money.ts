/**
 * Exact monetary arithmetic module for QuizyStars.
 *
 * Financial rule:
 * - ALL fiat USD values are stored and calculated strictly as integer USD cents
 *   (e.g., $10.00 -> 1000, $0.50 -> 50, $0.01 -> 1).
 * - IEEE-754 floating-point arithmetic (`number` decimals) is FORBIDDEN for balances,
 *   commissions, totals, profits, and invoice verification.
 * - ALL cryptocurrency quantities and exchange rates use scaled `bigint` decimals
 *   at 10^18 precision (wei-like scale) parsed directly from decimal strings.
 */

export const MIN_TOPUP_AMOUNT_USD_CENTS = 50; // $0.50
export const MAX_TOPUP_AMOUNT_USD_CENTS = 5_000_000; // $50,000.00

export const DECIMAL_SCALE_DIGITS = 18;
export const DECIMAL_SCALE = 10n ** BigInt(DECIMAL_SCALE_DIGITS); // 10^18

export interface ExactCommissionBreakdown {
  grossCents: number;
  feeBps: number;
  feePercent: number;
  feeCents: number;
  netCents: number;
}

/**
 * Parses a decimal string or number (only converted cleanly from finite decimal representation)
 * into a scaled bigint with 10^18 precision without floating-point drift.
 */
export function parseDecimalToScaled(raw: string | number): bigint {
  const normalized =
    typeof raw === 'number'
      ? Number.isFinite(raw)
        ? raw.toFixed(DECIMAL_SCALE_DIGITS)
        : ''
      : String(raw ?? '').trim().replace(',', '.');

  if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`Некорректное десятичное число: "${String(raw)}"`);
  }

  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');

  const intPart = BigInt(intPartRaw || '0');
  const paddedFrac = (fracPartRaw + '0'.repeat(DECIMAL_SCALE_DIGITS)).slice(
    0,
    DECIMAL_SCALE_DIGITS,
  );
  const fracPart = BigInt(paddedFrac || '0');

  const combined = intPart * DECIMAL_SCALE + fracPart;
  return negative ? -combined : combined;
}

/**
 * Formats a scaled 10^18 bigint back into an exact canonical decimal string.
 */
export function formatScaledDecimal(
  scaled: bigint,
  options?: { minDecimals?: number; maxDecimals?: number; trimTrailingZeros?: boolean },
): string {
  const minDecimals = options?.minDecimals ?? 2;
  const maxDecimals = options?.maxDecimals ?? 8;
  const trimTrailingZeros = options?.trimTrailingZeros ?? true;

  const clampedMax = Math.max(minDecimals, Math.min(DECIMAL_SCALE_DIGITS, maxDecimals));
  const negative = scaled < 0n;
  const absVal = negative ? -scaled : scaled;

  const divisor = 10n ** BigInt(DECIMAL_SCALE_DIGITS - clampedMax);
  // Half-up rounding at `clampedMax` decimal place
  const roundedUnits = (absVal + divisor / 2n) / divisor;

  const unitScale = 10n ** BigInt(clampedMax);
  const whole = roundedUnits / unitScale;
  const frac = roundedUnits % unitScale;

  let fracStr = frac.toString().padStart(clampedMax, '0');
  if (trimTrailingZeros && clampedMax > minDecimals) {
    while (fracStr.length > minDecimals && fracStr.endsWith('0')) {
      fracStr = fracStr.slice(0, -1);
    }
  }

  const sign = negative && (whole > 0n || BigInt(fracStr || '0') > 0n) ? '-' : '';
  return clampedMax === 0 ? `${sign}${whole.toString()}` : `${sign}${whole.toString()}.${fracStr}`;
}

/**
 * Compares two decimal strings using exact 10^18 scaled bigint math.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareScaledDecimal(a: string | number, b: string | number): -1 | 0 | 1 {
  const sa = parseDecimalToScaled(a);
  const sb = parseDecimalToScaled(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/**
 * Parses a human-entered USD string or number (e.g. "$10.00", "19,99", "0.5", 100)
 * strictly into integer USD cents without IEEE-754 float errors.
 */
export function usdInputToCents(raw: string | number): number {
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new Error('Сумма должна быть конечным положительным числом.');
    }
    text = String(raw);
  } else {
    text = String(raw ?? '')
      .trim()
      .replace(/^\$\s*/, '')
      .replace(/,/g, '.')
      .replace(/\s+/g, '');
  }

  if (!text) {
    throw new Error('Введите сумму в USD.');
  }

  if (text.startsWith('-')) {
    throw new Error('Сумма в USD должна быть положительным числом.');
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(
      'Введите корректную сумму в USD (например: 0.50, 10 или 19.99).',
    );
  }

  const [wholeRaw, fracRaw = ''] = text.split('.');
  if (fracRaw.length > 2) {
    throw new Error(
      typeof raw === 'number'
        ? 'Сумма в USD не должна содержать более 2 знаков после запятой.'
        : 'Введите корректную сумму в USD (например: 0.50, 10 или 19.99).',
    );
  }

  const wholeBig = BigInt(wholeRaw);
  const fracBig = BigInt(fracRaw.padEnd(2, '0'));
  const totalCentsBig = wholeBig * 100n + fracBig;

  if (totalCentsBig <= 0n) {
    throw new Error('Сумма в USD должна быть положительным числом.');
  }
  if (totalCentsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Сумма превышает допустимый предел.');
  }

  return Number(totalCentsBig);
}

/**
 * Validates that a USD cents value is a finite safe integer (>= 0).
 */
export function assertValidUsdCents(
  cents: number,
  fieldName = 'amountUsdCents',
  options?: { allowZero?: boolean },
): number {
  if (!Number.isInteger(cents) || !Number.isSafeInteger(cents)) {
    throw new Error(
      `Поле ${fieldName} должно быть целым числом в центах USD (получено: ${String(cents)}).`,
    );
  }
  const allowZero = options?.allowZero ?? false;
  if (allowZero ? cents < 0 : cents <= 0) {
    throw new Error(
      allowZero
        ? `Поле ${fieldName} не может быть отрицательным (получено: ${cents}).`
        : `Поле ${fieldName} должно быть больше 0 центов (получено: ${cents}).`,
    );
  }
  return cents;
}

/**
 * Formats integer USD cents as a canonical plain decimal string without currency symbol: e.g. 1999 -> "19.99".
 */
export function centsToUsdString(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const dollars = Math.trunc(abs / 100);
  const rem = abs % 100;
  const str = `${dollars}.${String(rem).padStart(2, '0')}`;
  return negative ? `-${str}` : str;
}

/**
 * Formats integer USD cents with `$` symbol: e.g. 1999 -> "$19.99", -300 -> "-$3.00".
 */
export function formatUsdCents(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  if (safe < 0) {
    return `-$${centsToUsdString(-safe)}`;
  }
  return `$${centsToUsdString(safe)}`;
}

/**
 * Computes gateway fee and credited net USD cents using integer BigInt arithmetic and basis points
 * (100 bps = 1%). Uses half-up rounding to the nearest cent.
 */
export function bpsFeeAndNetCents(
  grossCents: number,
  feeBps: number,
): ExactCommissionBreakdown {
  const safeGross = assertValidUsdCents(grossCents, 'grossCents');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error(`Некорректная комиссия в б.п.: ${String(feeBps)}`);
  }

  const grossBig = BigInt(safeGross);
  const bpsBig = BigInt(feeBps);
  const feeBig = (grossBig * bpsBig + 5000n) / 10000n;
  const netBig = grossBig - feeBig;

  return {
    grossCents: safeGross,
    feeBps,
    feePercent: Number((feeBps / 100).toFixed(2)),
    feeCents: Number(feeBig),
    netCents: Number(netBig),
  };
}

/**
 * Returns recommended invoice decimal precision for a given payment currency.
 */
export function getCryptoInvoiceDecimals(currency: string): number {
  const upper = currency.trim().toUpperCase();
  if (upper === 'USD') return 2;
  if (upper === 'USDT' || upper === 'USDC') return 4;
  if (upper === 'TON' || upper === 'TRX' || upper === 'NOT' || upper === 'HMSTR') {
    return 4;
  }
  return 8; // BTC, ETH, LTC, BNB, SOL
}

/**
 * Converts integer USD cents into a crypto (or USD) decimal string using a live exchange rate string
 * (USD per 1 unit of targetCurrency) with exact bigint scaled arithmetic.
 *
 * Uses ceiling rounding at `targetDecimals` so floating-point truncation never shortchanges the store,
 * except when division is already exact at `targetDecimals`.
 */
export function convertUsdCentsToCryptoScaled(params: {
  amountUsdCents: number;
  rateUsdStr: string;
  targetCurrency: string;
  targetDecimals?: number;
}): {
  amountUsdCents: number;
  targetCurrency: string;
  exchangeRateUsdStr: string;
  amountStr: string;
  scaled1e18: bigint;
} {
  const safeCents = assertValidUsdCents(params.amountUsdCents, 'amountUsdCents');
  const currency = params.targetCurrency.trim().toUpperCase();
  const rateScaled = parseDecimalToScaled(params.rateUsdStr);
  if (rateScaled <= 0n) {
    throw new Error(
      `Курс обмена для ${currency} должен быть строго положительным (получено: ${params.rateUsdStr}).`,
    );
  }

  const decimals = params.targetDecimals ?? getCryptoInvoiceDecimals(currency);

  if (currency === 'USD' && rateScaled === DECIMAL_SCALE) {
    const exactStr = centsToUsdString(safeCents);
    return {
      amountUsdCents: safeCents,
      targetCurrency: 'USD',
      exchangeRateUsdStr: '1.00',
      amountStr: exactStr,
      scaled1e18: parseDecimalToScaled(exactStr),
    };
  }

  // amountUsd in 1e18 scale = safeCents * 10^16
  const amountUsd1e18 = BigInt(safeCents) * 10_000_000_000_000_000n;
  // Target value scaled to 10^decimals: (amountUsd1e18 * 10^decimals) / rateScaled
  const targetFactor = 10n ** BigInt(decimals);
  const numerator = amountUsd1e18 * targetFactor;
  const quotient = numerator / rateScaled;
  const remainder = numerator % rateScaled;
  // Ceiling if remainder > 0 so locked crypto payable amount covers full USD value
  const quantizedUnits = remainder > 0n ? quotient + 1n : quotient;

  const scaled1e18 = quantizedUnits * 10n ** BigInt(DECIMAL_SCALE_DIGITS - decimals);
  const minDec = currency === 'USD' || currency === 'USDT' || currency === 'USDC' ? 2 : 2;
  const amountStr = formatScaledDecimal(scaled1e18, {
    minDecimals: minDec,
    maxDecimals: decimals,
    trimTrailingZeros: currency !== 'USD',
  });

  return {
    amountUsdCents: safeCents,
    targetCurrency: currency,
    exchangeRateUsdStr: formatScaledDecimal(rateScaled, {
      minDecimals: 2,
      maxDecimals: 8,
      trimTrailingZeros: true,
    }),
    amountStr,
    scaled1e18,
  };
}

/**
 * Converts a paid crypto decimal string into integer USD cents using a rate string (USD per 1 coin).
 */
export function convertCryptoAmountToUsdCents(
  cryptoAmountStr: string,
  rateUsdStr: string,
): number {
  const amountScaled = parseDecimalToScaled(cryptoAmountStr);
  const rateScaled = parseDecimalToScaled(rateUsdStr);
  if (amountScaled <= 0n || rateScaled <= 0n) {
    return 0;
  }
  // usdCents = (amountScaled * rateScaled * 100) / (10^18 * 10^18)
  const scaleSq = DECIMAL_SCALE * DECIMAL_SCALE;
  const centsBig = (amountScaled * rateScaled * 100n + scaleSq / 2n) / scaleSq;
  return Number(centsBig);
}
