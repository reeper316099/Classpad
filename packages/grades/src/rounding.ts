import { D, type Dec, type Num, dec } from './decimal.js';
import type { RoundingConfig } from './types.js';

export function roundTo(v: Num, cfg: Pick<RoundingConfig, 'mode' | 'decimals'>): Dec {
  const x = dec(v);
  return x.toDecimalPlaces(cfg.decimals, cfg.mode === 'truncate' ? D.ROUND_DOWN : D.ROUND_HALF_UP);
}

export const DEFAULT_ROUNDING: RoundingConfig = { mode: 'half_up', decimals: 2, letterOn: 'raw' };
