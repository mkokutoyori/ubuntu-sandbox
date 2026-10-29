export const DEFAULT_SA_LIFETIME_SECONDS = 3600;
export const DEFAULT_SA_LIFETIME_KILOBYTES = 4608000;

export function formatSaLifetime(kilobytes: number, seconds: number): string {
  return `Security-association lifetime: ${kilobytes} kilobytes/${seconds} seconds`;
}
