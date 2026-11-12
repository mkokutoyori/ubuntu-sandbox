import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { describeEvent } from './EventDescriptor';
import { levelOf, type XPathEvent, type XPathPredicate } from '../WinEventXPath';

export interface EventHashQuery {
  readonly logPatterns: readonly string[];
  readonly providerPatterns: readonly string[];
  readonly paths: readonly string[];
  readonly predicate: XPathPredicate;
}

export type EventHashResult =
  | { readonly query: EventHashQuery }
  | { readonly error: string; readonly errorId: string };

function elements(value: PSValue): PSValue[] {
  return Array.isArray(value) ? [...value] : [value];
}

function text(value: PSValue): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toMillis(value: PSValue): number | null {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(text(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function keywordMask(value: PSValue): bigint | null {
  let mask = 0n;
  for (const keyword of elements(value)) {
    const raw = text(keyword).trim();
    if (!/^-?\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) return null;
    mask |= BigInt.asUintN(64, BigInt(raw));
  }
  return mask;
}

function isHashtable(value: PSValue): value is Record<string, PSValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function entryKeywords(event: XPathEvent): bigint {
  return BigInt.asUintN(64, BigInt(describeEvent(event).keywords));
}

function criteria(hash: Record<string, PSValue>): { predicate: XPathPredicate } | { error: string; errorId: string } {
  const parts: XPathPredicate[] = [];
  let timeHandled = false;
  for (const key of Object.keys(hash)) {
    const value = hash[key];
    const lower = key.toLowerCase();
    if (value === null || value === undefined) {
      return { error: `A null value was encountered in the ${key} hash table key. Null values are not permitted.`, errorId: 'NullNotAllowedInHashtable' };
    }
    switch (lower) {
      case 'logname': case 'path': case 'providername': case 'suppresshashfilter':
        break;
      case 'id': {
        const wanted = elements(value).map((item) => Number(text(item)));
        parts.push((event) => wanted.includes(event.eventId));
        break;
      }
      case 'level': {
        const wanted = elements(value).map((item) => Number(text(item)));
        parts.push((event) => wanted.includes(levelOf(event.entryType)));
        break;
      }
      case 'keywords': {
        const mask = keywordMask(value);
        if (mask === null) {
          return { error: `Invalid value '${elements(value).map(text).join(', ')}' specified for keyword.`, errorId: 'KeywordLongExpected' };
        }
        parts.push((event) => (entryKeywords(event) & mask) !== 0n);
        break;
      }
      case 'starttime': case 'endtime': {
        if (timeHandled) break;
        timeHandled = true;
        const startRaw = Object.entries(hash).find(([name]) => name.toLowerCase() === 'starttime')?.[1];
        const endRaw = Object.entries(hash).find(([name]) => name.toLowerCase() === 'endtime')?.[1];
        const start = startRaw === undefined ? null : toMillis(startRaw);
        const end = endRaw === undefined ? null : toMillis(endRaw);
        if (startRaw !== undefined && start === null) {
          return { error: `The following value is not in a valid DateTime format: ${text(startRaw)}.`, errorId: 'DateTimeExpected' };
        }
        if (endRaw !== undefined && end === null) {
          return { error: `The following value is not in a valid DateTime format: ${text(endRaw)}.`, errorId: 'DateTimeExpected' };
        }
        parts.push((event) => {
          const at = Math.floor(event.timeGenerated.getTime() / 1000) * 1000;
          return (start === null || at >= Math.floor(start / 1000) * 1000) && (end === null || at <= Math.floor(end / 1000) * 1000);
        });
        break;
      }
      case 'data': {
        const wanted = elements(value).map(text);
        parts.push((event) => wanted.some((item) => Object.values(event.data ?? {}).includes(item)));
        break;
      }
      case 'userid':
        parts.push(() => false);
        break;
      default: {
        const wanted = elements(value).map(text);
        parts.push((event) => wanted.some((item) => event.data?.[key] === item));
      }
    }
  }
  return { predicate: (event, now) => parts.every((part) => part(event, now)) };
}

export function parseEventHashtable(hash: Record<string, PSValue>): EventHashResult {
  const named = (name: string): PSValue | undefined => Object.entries(hash).find(([key]) => key.toLowerCase() === name)?.[1];
  const logs = named('logname');
  const paths = named('path');
  const providers = named('providername');
  if (logs === undefined && paths === undefined && providers === undefined) {
    return { error: 'You must specify at least one Log, Provider or Path key-value pair.', errorId: 'LogProviderOrPathNeeded' };
  }
  for (const reserved of ['logname', 'path', 'providername']) {
    const value = named(reserved);
    if (value === null) {
      return { error: `A null value was encountered in the ${reserved} hash table key. Null values are not permitted.`, errorId: 'NullNotAllowedInHashtable' };
    }
  }
  const built = criteria(hash);
  if ('error' in built) return built;
  let predicate = built.predicate;
  const suppress = named('suppresshashfilter');
  if (suppress !== undefined && isHashtable(suppress)) {
    const suppressed = criteria(suppress);
    if ('error' in suppressed) return suppressed;
    const keep = predicate;
    const drop = suppressed.predicate;
    predicate = (event, now) => keep(event, now) && !drop(event, now);
  }
  const strings = (value: PSValue | undefined): string[] => (value === undefined || value === null ? [] : elements(value).map(text));
  return { query: { logPatterns: strings(logs), providerPatterns: strings(providers), paths: strings(paths), predicate } };
}

