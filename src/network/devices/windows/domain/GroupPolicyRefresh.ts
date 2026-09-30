export const GROUP_POLICY_SYSTEM_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System';

const MINUTE_MS = 60_000;
const MEMBER_INTERVAL_MINUTES = 90;
const MEMBER_OFFSET_MINUTES = 30;
const CONTROLLER_INTERVAL_MINUTES = 5;
const CONTROLLER_OFFSET_MINUTES = 0;
const MAX_INTERVAL_MINUTES = 64_800;
const MAX_OFFSET_MINUTES = 1_440;
const ZERO_INTERVAL_MS = 7_000;

export type PolicyValues = Record<string, string | number> | null;

function policyNumber(values: PolicyValues, name: string): number | undefined {
  if (values === null) return undefined;
  const wanted = name.toLowerCase();
  const found = Object.entries(values).find(([key]) => key.toLowerCase() === wanted);
  if (found === undefined) return undefined;
  const parsed = Number(found[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bounded(value: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), maximum);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function backgroundRefreshDisabled(values: PolicyValues): boolean {
  return policyNumber(values, 'DisableBkGndGroupPolicy') === 1;
}

export function refreshDelayMs(opts: {
  domainController: boolean; values: PolicyValues; hostname: string; cycle: number;
}): number {
  const suffix = opts.domainController ? 'DC' : '';
  const interval = bounded(
    policyNumber(opts.values, `GroupPolicyRefreshTime${suffix}`)
      ?? (opts.domainController ? CONTROLLER_INTERVAL_MINUTES : MEMBER_INTERVAL_MINUTES),
    MAX_INTERVAL_MINUTES);
  const offset = bounded(
    policyNumber(opts.values, `GroupPolicyRefreshTimeOffset${suffix}`)
      ?? (opts.domainController ? CONTROLLER_OFFSET_MINUTES : MEMBER_OFFSET_MINUTES),
    MAX_OFFSET_MINUTES);
  const base = interval === 0 ? ZERO_INTERVAL_MS : interval * MINUTE_MS;
  const jitterSpan = offset * MINUTE_MS;
  const jitter = jitterSpan === 0 ? 0 : fnv1a(`${opts.hostname}#${opts.cycle}`) % (jitterSpan + 1);
  return base + jitter;
}
