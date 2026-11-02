export const LAZY_PLATFORMS_FLAG = 'ubuntu-sandbox.lazyPlatforms';

function flagValue(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAZY_PLATFORMS_FLAG) ?? null;
  } catch {
    return null;
  }
}

export function platformsStayLazy(): boolean {
  const value = flagValue();
  return value === '1' || value === 'idle';
}

export function idlePreloadEnabled(): boolean {
  return flagValue() !== '1';
}
