import { CODEC_PROFILES, type SlaCodec } from './types';

export const R_ZERO = 93.2;

export interface EModelInput {
  codec: SlaCodec;
  packetLossPercent: number;
  oneWayDelayMs: number;
  advantageFactor: number;
  burstRatio?: number;
}

export interface EModelResult {
  rFactor: number;
  mos: number;
  icpif: number;
  delayImpairment: number;
  equipmentImpairment: number;
}

export function delayImpairment(oneWayDelayMs: number): number {
  if (oneWayDelayMs < 100) return 0;
  const excess = oneWayDelayMs - 177.3;
  const heaviside = excess > 0 ? 1 : 0;
  return 0.024 * oneWayDelayMs + 0.11 * excess * heaviside;
}

export function effectiveEquipmentImpairment(
  codec: SlaCodec,
  packetLossPercent: number,
  burstRatio: number,
): number {
  const profile = CODEC_PROFILES[codec];
  const loss = Math.max(0, packetLossPercent);
  if (loss === 0) return profile.ie;
  const ratio = Math.max(1, burstRatio);
  return profile.ie + (95 - profile.ie) * (loss / (loss / ratio + profile.bpl));
}

export function mosFromRFactor(rFactor: number): number {
  if (rFactor < 0) return 1;
  if (rFactor > 100) return 4.5;
  const mos = 1 + 0.035 * rFactor + 7e-6 * rFactor * (rFactor - 60) * (100 - rFactor);
  return Math.min(4.5, Math.max(1, mos));
}

export function evaluateEModel(input: EModelInput): EModelResult {
  const id = delayImpairment(input.oneWayDelayMs);
  const ieEff = effectiveEquipmentImpairment(
    input.codec,
    input.packetLossPercent,
    input.burstRatio ?? 1,
  );
  const rFactor = R_ZERO - id - ieEff + input.advantageFactor;
  return {
    rFactor,
    mos: mosFromRFactor(rFactor),
    icpif: Math.max(0, Math.round(id + ieEff - input.advantageFactor)),
    delayImpairment: id,
    equipmentImpairment: ieEff,
  };
}
