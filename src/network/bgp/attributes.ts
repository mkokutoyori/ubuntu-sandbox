export const BGP_ORIGINS = ['igp', 'egp', 'incomplete'] as const;

export type BgpOrigin = typeof BGP_ORIGINS[number];

export const BGP_ATTRIBUTE_MAX = 4294967295;

export const BGP_WEIGHT_MAX = 65535;

export const BGP_HOLD_TIME_MAX = 65535;

export const BGP_WELL_KNOWN_COMMUNITIES = [
  'internet', 'local-as', 'no-advertise', 'no-export', 'none',
] as const;

const COMMUNITIES = new Set<string>(BGP_WELL_KNOWN_COMMUNITIES);

export function isBgpOrigin(word: string): word is BgpOrigin {
  return (BGP_ORIGINS as readonly string[]).includes(word.toLowerCase());
}

export function isBgpWellKnownCommunity(word: string): boolean {
  return COMMUNITIES.has(word.toLowerCase());
}
