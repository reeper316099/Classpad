import { Decimal } from 'decimal.js';

/** Isolated Decimal constructor so we never touch global config. 40 significant digits. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type Num = number | string | Dec | Decimal;

export const dec = (n: Num): Dec => new D(n);
export const ZERO = new D(0);
export const HUNDRED = new D(100);

/** Display a decimal without trailing zeros (max 6 dp). */
export const fmt = (d: Dec | null | undefined, dp = 6): string =>
  d == null ? '—' : d.toDecimalPlaces(dp).toString();
