import type { TracerouteProbe } from '../../Router';

export const IOS_TRACEROUTE_BASE_PORT = 33434;

export const IOS_TRACEROUTE_TIMEOUT_SECONDS = 3;

const UNREACHABLE_MARKS: Readonly<Partial<Record<NonNullable<TracerouteProbe['code']>, string>>> = {
  'net-unreachable': '!N',
  'host-unreachable': '!H',
  'protocol-unreachable': '!P',
  'admin-prohibited': '!A',
};

export function iosUnreachableMark(code: TracerouteProbe['code']): string {
  if (code === undefined) return '!N';
  return UNREACHABLE_MARKS[code] ?? '?';
}
