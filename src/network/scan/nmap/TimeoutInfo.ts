export interface TimeoutInfo {
  readonly srtt: number;
  readonly rttvar: number;
  readonly timeout: number;
}

const MIN_RTT_TIMEOUT_US = 100_000;
const MAX_RTT_TIMEOUT_US = 10_000_000;
const INITIAL_RTT_TIMEOUT_US = 1_000_000;
const RTTVAR_FLOOR_US = 5_000;
const RTTVAR_CEILING_US = 2_000_000;
const RTTVAR_RUNAWAY_US = 2_300_000;
const PCAP_CLOCK_SKEW_US = 50_000;
const SKEWED_DELTA_US = 10_000;
const IMPLAUSIBLE_RTT_US = 8_000_000;
const BOGUS_RTTDELTA_US = 1_500_000;

export const UNMEASURED: TimeoutInfo = { srtt: -1, rttvar: -1, timeout: INITIAL_RTT_TIMEOUT_US };

function box(low: number, high: number, value: number): number {
  return Math.min(high, Math.max(low, value));
}

export function isMeasured(to: TimeoutInfo): boolean {
  return to.srtt !== -1;
}

export function adjustTimeouts(to: TimeoutInfo, deltaMs: number): TimeoutInfo {
  let delta = Math.round(deltaMs * 1000);
  if (delta < 0 && delta > -PCAP_CLOCK_SKEW_US) delta = SKEWED_DELTA_US;

  let srtt: number;
  let rttvar: number;
  if (to.srtt === -1 && to.rttvar === -1) {
    srtt = delta;
    rttvar = box(RTTVAR_FLOOR_US, RTTVAR_CEILING_US, srtt);
  } else {
    if (delta >= IMPLAUSIBLE_RTT_US || delta < 0) return to;
    const rttdelta = delta - to.srtt;
    if (rttdelta > BOGUS_RTTDELTA_US && rttdelta > 3 * to.srtt + 2 * to.rttvar) return to;
    srtt = to.srtt + (rttdelta >> 3);
    rttvar = to.rttvar + ((Math.abs(rttdelta) - to.rttvar) >> 2);
  }
  if (rttvar > RTTVAR_RUNAWAY_US) rttvar = RTTVAR_CEILING_US;
  const timeout = box(MIN_RTT_TIMEOUT_US, MAX_RTT_TIMEOUT_US, srtt + (rttvar << 2));
  return { srtt, rttvar, timeout };
}
