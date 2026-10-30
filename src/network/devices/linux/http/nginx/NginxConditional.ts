import type { HttpMessage } from '@/network/http/semantics/types';
import { isDecimal } from './NginxSsl';

export type IfModifiedSinceMode = 'off' | 'exact' | 'before';

export interface NginxConditionalDirective {
  readonly name: string;
  readonly args: readonly string[];
}

export interface NginxConditionalSettings {
  readonly etag: boolean;
  readonly ifModifiedSince: IfModifiedSinceMode;
  readonly maxRanges: number;
}

export interface FileValidators {
  readonly lastModifiedSeconds: number;
  readonly etag: string | null;
}

export const NGINX_CONDITIONAL_DIRECTIVES: ReadonlySet<string> = new Set(['etag', 'if_modified_since', 'max_ranges']);

export const DEFAULT_CONDITIONAL_SETTINGS: NginxConditionalSettings = Object.freeze({
  etag: true,
  ifModifiedSince: 'exact',
  maxRanges: 2147483647,
});

const ALLOWED_PARENTS: readonly string[] = ['http', 'server', 'location'];
const MODES: ReadonlySet<string> = new Set(['off', 'exact', 'before']);

export function checkConditionalDirective(
  name: string, args: readonly string[], alreadySet: boolean, parent: string | null,
): string | null {
  if (parent === null || !ALLOWED_PARENTS.includes(parent)) return `"${name}" directive is not allowed here`;
  if (args.length !== 1) return `invalid number of arguments in "${name}" directive`;
  if (alreadySet) return `"${name}" directive is duplicate`;
  if (name === 'max_ranges') return isDecimal(args[0]) ? null : `"${name}" directive invalid number`;
  if (name === 'etag') {
    const value = args[0].toLowerCase();
    return value === 'on' || value === 'off'
      ? null
      : `invalid value "${args[0]}" in "${name}" directive, it must be "on" or "off"`;
  }
  return MODES.has(args[0]) ? null : `invalid value "${args[0]}"`;
}

export function resolveConditionalSettings(
  parent: NginxConditionalSettings, own: readonly NginxConditionalDirective[],
): NginxConditionalSettings {
  if (own.length === 0) return parent;
  let etag = parent.etag;
  let ifModifiedSince = parent.ifModifiedSince;
  let maxRanges = parent.maxRanges;
  for (const { name, args } of own) {
    if (name === 'etag') etag = args[0].toLowerCase() === 'on';
    else if (name === 'max_ranges') maxRanges = Number(args[0]);
    else ifModifiedSince = args[0] as IfModifiedSinceMode;
  }
  return { etag, ifModifiedSince, maxRanges };
}

export function fileValidators(mtimeMs: number, size: number, settings: NginxConditionalSettings): FileValidators {
  const seconds = Math.floor(mtimeMs / 1000);
  return {
    lastModifiedSeconds: seconds,
    etag: settings.etag ? `"${seconds.toString(16)}-${size.toString(16)}"` : null,
  };
}

export function httpDate(seconds: number): string {
  return new Date(seconds * 1000).toUTCString();
}

function parseHttpSeconds(value: string): number {
  const at = Date.parse(value);
  return Number.isNaN(at) ? -1 : Math.floor(at / 1000);
}

function etagListMatches(list: string, etag: string | null, weak: boolean): boolean {
  if (list.trim() === '*') return true;
  if (etag === null) return false;
  const current = weak && etag.startsWith('W/') ? etag.slice(2) : etag;
  return list.split(',').some((candidate) => {
    const text = candidate.trim();
    return (weak && text.startsWith('W/') ? text.slice(2) : text) === current;
  });
}

function modifiedSince(header: string, validators: FileValidators, settings: NginxConditionalSettings): boolean {
  if (settings.ifModifiedSince === 'off') return true;
  const since = parseHttpSeconds(header);
  if (since === validators.lastModifiedSeconds) return false;
  return settings.ifModifiedSince === 'exact' || since < validators.lastModifiedSeconds;
}

export function evaluateConditional(
  req: HttpMessage, validators: FileValidators, settings: NginxConditionalSettings,
): 304 | 412 | null {
  const unmodifiedSince = req.headers.get('If-Unmodified-Since');
  if (unmodifiedSince !== undefined && parseHttpSeconds(unmodifiedSince) < validators.lastModifiedSeconds) return 412;

  const ifMatch = req.headers.get('If-Match');
  if (ifMatch !== undefined && !etagListMatches(ifMatch, validators.etag, false)) return 412;

  const since = req.headers.get('If-Modified-Since');
  const none = req.headers.get('If-None-Match');
  if (since === undefined && none === undefined) return null;
  if (since !== undefined && modifiedSince(since, validators, settings)) return null;
  if (none !== undefined && !etagListMatches(none, validators.etag, true)) return null;
  return 304;
}
