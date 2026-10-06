import {
  type BerNode, parseTLV, parseAll, encodeTLV, concat,
  encodeInteger, encodeEnumerated, encodeBoolean, encodeOctetString, encodeRawOctetString,
  encodeSequence, decodeInteger, decodeBoolean, decodeOctetString,
} from '@/network/devices/windows/server/ad/ldap/Ber';
import { encodeFilter, type LdapFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilter';

export const ControlOid = {
  MANAGEDSAIT: '2.16.840.1.113730.3.4.2',
  PROXY_AUTHZ: '2.16.840.1.113730.3.4.18',
  OBSOLETE_PROXY_AUTHZ: '2.16.840.1.113730.3.4.12',
  SUBENTRIES: '1.3.6.1.4.1.4203.1.10.1',
  VALUESRETURNFILTER: '1.2.826.0.1.3344810.2.3',
  ASSERT: '1.3.6.1.1.12',
  PRE_READ: '1.3.6.1.1.13.1',
  POST_READ: '1.3.6.1.1.13.2',
  SORTREQUEST: '1.2.840.113556.1.4.473',
  SORTRESPONSE: '1.2.840.113556.1.4.474',
  PAGEDRESULTS: '1.2.840.113556.1.4.319',
  AUTHZID_REQUEST: '2.16.840.1.113730.3.4.16',
  AUTHZID_RESPONSE: '2.16.840.1.113730.3.4.15',
  SYNC: '1.3.6.1.4.1.4203.1.9.1.1',
  SYNC_STATE: '1.3.6.1.4.1.4203.1.9.1.2',
  SYNC_DONE: '1.3.6.1.4.1.4203.1.9.1.3',
  SYNC_INFO: '1.3.6.1.4.1.4203.1.9.1.4',
  DONTUSECOPY: '1.3.6.1.1.22',
  PASSWORDPOLICY: '1.3.6.1.4.1.42.2.27.8.5.1',
  NOOP: '1.3.6.1.4.1.4203.666.5.2',
  RELAX: '1.3.6.1.4.1.4203.666.5.12',
  CHAINING_BEHAVIOR: '1.3.6.1.4.1.4203.666.11.3',
  DOMAIN_SCOPE: '1.2.840.113556.1.4.1339',
  SERVER_NOTIFICATION: '1.2.840.113556.1.4.528',
  EXTENDED_DN: '1.2.840.113556.1.4.529',
  SHOW_DELETED: '1.2.840.113556.1.4.417',
  DIRSYNC: '1.2.840.113556.1.4.841',
  SESSION_TRACKING: '1.3.6.1.4.1.21008.108.63.1',
  SESSION_TRACKING_USERNAME: '1.3.6.1.4.1.21008.108.63.1.3',
  PERSIST_REQUEST: '2.16.840.1.113730.3.4.3',
  PERSIST_ENTRY_CHANGE_NOTICE: '2.16.840.1.113730.3.4.7',
  VLVREQUEST: '2.16.840.1.113730.3.4.9',
  VLVRESPONSE: '2.16.840.1.113730.3.4.10',
  ACCOUNT_USABILITY: '1.3.6.1.4.1.42.2.27.9.5.8',
  PASSWORD_EXPIRED: '2.16.840.1.113730.3.4.4',
  PASSWORD_EXPIRING: '2.16.840.1.113730.3.4.5',
} as const;

export const EXOP_CANCEL = '1.3.6.1.1.8';

export const LdapSync = {
  NONE: 0x00,
  REFRESH_ONLY: 0x01,
  REFRESH_AND_PERSIST: 0x03,
  PRESENT: 0,
  ADD: 1,
  MODIFY: 2,
  DELETE: 3,
} as const;

export const ChainingBehavior = {
  PREFERRED: 0,
  REQUIRED: 1,
  REFERRALS_PREFERRED: 2,
  REFERRALS_REQUIRED: 3,
} as const;

export const PersistEntryChange = { ADD: 0x1, DELETE: 0x2, MODIFY: 0x4, RENAME: 0x8 } as const;

export function rawTag(node: BerNode): number {
  const classBits = node.tagClass === 'universal' ? 0x00 : node.tagClass === 'application' ? 0x40
    : node.tagClass === 'context' ? 0x80 : 0xc0;
  return classBits | (node.constructed ? 0x20 : 0x00) | node.tagNumber;
}

function context(tagNumber: number, constructed: boolean, content: Uint8Array): Uint8Array {
  return encodeTLV('context', tagNumber, constructed, content);
}

function tryParse(value: Uint8Array | undefined): BerNode | null {
  if (value === undefined || value.length === 0) return null;
  try {
    return parseTLV(value, 0);
  } catch {
    return null;
  }
}

function children(node: BerNode): BerNode[] | null {
  try {
    return parseAll(node.content);
  } catch {
    return null;
  }
}

const LDAP_MAXINT = 2147483647;

export function createPageControlValue(pageSize: number, cookie: Uint8Array): Uint8Array | null {
  if (pageSize < 1 || pageSize > LDAP_MAXINT) return null;
  return encodeSequence([encodeInteger(pageSize), encodeRawOctetString(cookie)]);
}

export interface PageResponse { estimate: number; cookie: Uint8Array }

export function parsePageResponse(value: Uint8Array | undefined): PageResponse | null {
  const root = tryParse(value);
  if (root === null || rawTag(root) !== 0x30) return null;
  const parts = children(root);
  if (parts === null || parts.length < 2) return null;
  return { estimate: decodeInteger(parts[0].content), cookie: parts[1].content };
}

export interface SortKey { attributeType: string; orderingRule: string | null; reverseOrder: boolean }

const KEY_SPACE = new Set([' ', '\t', '\n']);

export function createSortKeyList(keyString: string): SortKey[] | null {
  let at = 0;
  const keys: SortKey[] = [];
  let count = 0;
  for (let p = 0; ;) {
    while (KEY_SPACE.has(keyString[p])) p++;
    if (p >= keyString.length) break;
    count++;
    while (p < keyString.length && !KEY_SPACE.has(keyString[p])) p++;
  }
  if (count === 0) return null;
  for (let i = 0; i < count; i++) {
    while (KEY_SPACE.has(keyString[at])) at++;
    let reverse = false;
    if (keyString[at] === '-') {
      reverse = true;
      at++;
    }
    const attrStart = at;
    while (at < keyString.length && keyString[at] !== ' ' && keyString[at] !== '\t' && keyString[at] !== ':') at++;
    const attributeType = keyString.slice(attrStart, at);
    if (attributeType === '') return null;
    let orderingRule: string | null = null;
    if (keyString[at] === ':') {
      at++;
      const ruleStart = at;
      while (at < keyString.length && keyString[at] !== ' ' && keyString[at] !== '\t') at++;
      if (at > ruleStart) orderingRule = keyString.slice(ruleStart, at);
    }
    keys.push({ attributeType, orderingRule, reverseOrder: reverse });
  }
  return keys;
}

export function createSortControlValue(keys: readonly SortKey[]): Uint8Array {
  return encodeSequence(keys.map(key => {
    const parts = [encodeOctetString(key.attributeType)];
    if (key.orderingRule !== null) parts.push(context(0, false, new TextEncoder().encode(key.orderingRule)));
    if (key.reverseOrder) parts.push(context(1, false, new Uint8Array([0xff])));
    return encodeSequence(parts);
  }));
}

export interface SortResponse { result: number; attribute: string | null }

export function parseSortResponse(value: Uint8Array | undefined): SortResponse | null {
  const root = tryParse(value);
  if (root === null || rawTag(root) !== 0x30) return null;
  const parts = children(root);
  if (parts === null || parts.length < 1 || rawTag(parts[0]) !== 0x0a) return null;
  const attribute = parts[1] !== undefined && rawTag(parts[1]) === 0x80 ? decodeOctetString(parts[1].content) : null;
  return { result: decodeInteger(parts[0].content), attribute };
}

export interface VlvInfo {
  beforeCount: number;
  afterCount: number;
  offset: number;
  count: number;
  attrValue: string | null;
  context: Uint8Array | null;
}

export function createVlvControlValue(info: VlvInfo): Uint8Array {
  const parts = [encodeInteger(info.beforeCount), encodeInteger(info.afterCount)];
  if (info.attrValue === null) {
    parts.push(context(0, true, concat([encodeInteger(info.offset), encodeInteger(info.count)])));
  } else {
    parts.push(context(1, false, new TextEncoder().encode(info.attrValue)));
  }
  if (info.context !== null) parts.push(encodeRawOctetString(info.context));
  return encodeSequence(parts);
}

export interface VlvResponse { position: number; count: number; context: Uint8Array | null; result: number }

export function parseVlvResponse(value: Uint8Array | undefined): VlvResponse | null {
  const root = tryParse(value);
  if (root === null || rawTag(root) !== 0x30) return null;
  const parts = children(root);
  if (parts === null || parts.length < 3) return null;
  const context = parts[3] !== undefined && rawTag(parts[3]) === 0x04 ? parts[3].content : null;
  return {
    position: decodeInteger(parts[0].content),
    count: decodeInteger(parts[1].content),
    result: decodeInteger(parts[2].content),
    context,
  };
}

export function createPersistentSearchValue(changeTypes: number, changesOnly: boolean, returnEcs: boolean): Uint8Array {
  return encodeSequence([encodeInteger(changeTypes), encodeBoolean(changesOnly), encodeBoolean(returnEcs)]);
}

export interface EntryChange { changeType: number; previousDn: string | null; changeNumber: number | null }

export function parseEntryChange(value: Uint8Array | undefined): EntryChange | null {
  const root = tryParse(value);
  if (root === null || rawTag(root) !== 0x30) return null;
  const parts = children(root);
  if (parts === null || parts.length < 1 || rawTag(parts[0]) !== 0x0a) return null;
  let at = 1;
  let previousDn: string | null = null;
  if (parts[at] !== undefined && rawTag(parts[at]) === 0x04) {
    previousDn = decodeOctetString(parts[at].content);
    at++;
  }
  const changeNumber = parts[at] !== undefined && rawTag(parts[at]) === 0x02 ? decodeInteger(parts[at].content) : null;
  return { changeType: decodeInteger(parts[0].content), previousDn, changeNumber };
}

export interface DerefSpec { derefAttr: string; attributes: string[] }

export function createDerefControlValue(specs: readonly DerefSpec[]): Uint8Array {
  return encodeSequence(specs.map(spec => encodeSequence([
    encodeOctetString(spec.derefAttr),
    encodeSequence(spec.attributes.map(attr => encodeOctetString(attr))),
  ])));
}

export interface DerefValue { type: string; values: Uint8Array[] }
export interface DerefResult { derefAttr: string; derefValue: Uint8Array; attrVals: DerefValue[] }

export function parseDerefResponse(value: Uint8Array | undefined): DerefResult[] | null {
  const root = tryParse(value);
  if (root === null) return null;
  const items = children(root);
  if (items === null) return null;
  const results: DerefResult[] = [];
  for (const item of items) {
    const parts = children(item);
    if (parts === null || parts.length < 2) return null;
    const attrVals: DerefValue[] = [];
    if (parts[2] !== undefined && rawTag(parts[2]) === 0xa0) {
      const entries = children(parts[2]);
      if (entries === null) return null;
      for (const entry of entries) {
        const pair = children(entry);
        if (pair === null || pair.length < 2) return null;
        const valueSet = children(pair[1]);
        if (valueSet === null) return null;
        attrVals.push({ type: decodeOctetString(pair[0].content), values: valueSet.map(node => node.content) });
      }
    }
    results.push({ derefAttr: decodeOctetString(parts[0].content), derefValue: parts[1].content, attrVals });
  }
  return results;
}

export function createDirSyncValue(flags: number, maxAttrCount: number, cookie: Uint8Array): Uint8Array {
  return encodeSequence([encodeInteger(flags), encodeInteger(maxAttrCount), encodeRawOctetString(cookie)]);
}

export interface DirSyncResponse { continueFlag: number; cookie: Uint8Array }

export function parseDirSyncResponse(value: Uint8Array | undefined): DirSyncResponse | null {
  const root = tryParse(value);
  if (root === null || rawTag(root) !== 0x30) return null;
  const parts = children(root);
  if (parts === null || parts.length < 3) return null;
  return { continueFlag: decodeInteger(parts[0].content), cookie: parts[2].content };
}

export function createExtendedDnValue(flag: number): Uint8Array {
  return encodeSequence([encodeInteger(flag)]);
}

export function createSessionTrackingValue(
  ip: string | null, name: string | null, formatOid: string, identifier: Uint8Array | null,
): Uint8Array | null {
  const ipBytes = new TextEncoder().encode(ip ?? '');
  const nameBytes = new TextEncoder().encode(name ?? '');
  const oidBytes = new TextEncoder().encode(formatOid);
  if (ipBytes.length > 128 || nameBytes.length > 65536 || oidBytes.length > 1024) return null;
  return encodeSequence([
    encodeRawOctetString(ipBytes),
    encodeRawOctetString(nameBytes),
    encodeRawOctetString(oidBytes),
    encodeRawOctetString(identifier ?? new Uint8Array(0)),
  ]);
}

export function createSyncRequestValue(mode: number, cookie: Uint8Array | null): Uint8Array {
  const parts = [encodeEnumerated(mode)];
  if (cookie !== null && cookie.length > 0) parts.push(encodeRawOctetString(cookie));
  return encodeSequence(parts);
}

export function createChainingValue(resolve: number, continuation: number | null): Uint8Array {
  const parts = [encodeEnumerated(resolve)];
  if (continuation !== null) parts.push(encodeEnumerated(continuation));
  return encodeSequence(parts);
}

export function createAssertionValue(filter: LdapFilter): Uint8Array {
  return encodeFilter(filter);
}

export function createPrePostReadValue(attributes: readonly string[] | null): Uint8Array {
  return encodeSequence((attributes ?? []).map(attr => encodeOctetString(attr)));
}

export function createVrFilterValue(items: readonly LdapFilter[]): Uint8Array {
  return encodeSequence(items.map(item => encodeFilter(item)));
}

export interface PrePostReadAttribute { type: string; values: Uint8Array[] }
export interface PrePostReadResult { dn: string; attributes: PrePostReadAttribute[] }

export function parsePrePostRead(value: Uint8Array | undefined): PrePostReadResult | 'malformed' {
  const root = tryParse(value);
  if (root === null || rawTag(root) !== 0x30) return 'malformed';
  const parts = children(root);
  if (parts === null || parts.length < 1) return 'malformed';
  const list = parts[1] !== undefined ? children(parts[1]) : [];
  if (list === null) return 'malformed';
  const attributes: PrePostReadAttribute[] = [];
  for (const attribute of list) {
    const pair = children(attribute);
    if (pair === null || pair.length < 2) return 'malformed';
    const valueSet = children(pair[1]);
    if (valueSet === null) return 'malformed';
    attributes.push({ type: decodeOctetString(pair[0].content), values: valueSet.map(node => node.content) });
  }
  return { dn: decodeOctetString(parts[0].content), attributes };
}

export const PasswordPolicyError = {
  passwordExpired: 0,
  accountLocked: 1,
  changeAfterReset: 2,
  passwordModNotAllowed: 3,
  mustSupplyOldPassword: 4,
  insufficientPasswordQuality: 5,
  passwordTooShort: 6,
  passwordTooYoung: 7,
  passwordInHistory: 8,
  passwordTooLong: 9,
  noError: 65535,
} as const;

export function passwordPolicyErr2Txt(error: number): string {
  switch (error) {
    case PasswordPolicyError.passwordExpired: return 'Password expired';
    case PasswordPolicyError.accountLocked: return 'Account locked';
    case PasswordPolicyError.changeAfterReset: return 'Password must be changed';
    case PasswordPolicyError.passwordModNotAllowed: return 'Policy prevents password modification';
    case PasswordPolicyError.mustSupplyOldPassword: return 'Policy requires old password in order to change password';
    case PasswordPolicyError.insufficientPasswordQuality: return 'Password fails quality checks';
    case PasswordPolicyError.passwordTooShort: return 'Password is too short for policy';
    case PasswordPolicyError.passwordTooYoung: return 'Password has been changed too recently';
    case PasswordPolicyError.passwordInHistory: return 'New password is in list of old passwords';
    case PasswordPolicyError.passwordTooLong: return 'Password is too long for policy';
    case PasswordPolicyError.noError: return 'No error';
    default: return 'Unknown error code';
  }
}

export interface PasswordPolicyResponse { expire: number; grace: number; error: number }

export function parsePasswordPolicyResponse(value: Uint8Array | undefined): PasswordPolicyResponse | null {
  const root = tryParse(value);
  if (root === null || rawTag(root) !== 0x30) return null;
  const parts = children(root);
  if (parts === null) return null;
  let expire = -1;
  let grace = -1;
  let error: number = PasswordPolicyError.noError;
  for (const part of parts) {
    const tag = rawTag(part);
    if (tag === 0xa0) {
      const inner = children(part);
      if (inner === null || inner.length < 1) return null;
      const innerTag = rawTag(inner[0]);
      if (innerTag === 0x80) expire = decodeInteger(inner[0].content);
      else if (innerTag === 0x81) grace = decodeInteger(inner[0].content);
      else return null;
    } else if (tag === 0x81) {
      error = decodeInteger(part.content);
    } else {
      return null;
    }
  }
  return { expire, grace, error };
}

export interface AccountUsability {
  available: boolean;
  secondsRemaining: number;
  inactive: boolean;
  reset: boolean;
  expired: boolean;
  remainingGrace: number;
  secondsBeforeUnlock: number;
}

export function parseAccountUsability(value: Uint8Array | undefined): AccountUsability | null {
  const root = tryParse(value);
  if (root === null) return null;
  const tag = rawTag(root);
  const usability: AccountUsability = {
    available: false, secondsRemaining: 0, inactive: false, reset: false, expired: false,
    remainingGrace: -1, secondsBeforeUnlock: -1,
  };
  if (tag === 0x80) {
    usability.available = true;
    usability.secondsRemaining = decodeInteger(root.content);
    return usability;
  }
  if (tag !== 0xa1) return null;
  const parts = children(root);
  if (parts === null) return null;
  for (const part of parts) {
    switch (rawTag(part)) {
      case 0x80: usability.inactive = decodeBoolean(part.content); break;
      case 0x81: usability.reset = decodeBoolean(part.content); break;
      case 0x82: usability.expired = decodeBoolean(part.content); break;
      case 0x83: usability.remainingGrace = decodeInteger(part.content); break;
      case 0x84: usability.secondsBeforeUnlock = decodeInteger(part.content); break;
      default: return null;
    }
  }
  return usability;
}

export function parsePasswordExpiring(value: Uint8Array | undefined): number | null {
  if (value === undefined || value.length === 0 || value.length >= 12) return null;
  const text = new TextDecoder().decode(value);
  const match = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  if (match === null || match[0].length !== text.length) return null;
  return Number.parseInt(match[1], 10);
}

export interface SyncStateResponse { state: number; uuid: Uint8Array; cookie: Uint8Array | null }

export function parseSyncState(value: Uint8Array | undefined): SyncStateResponse | null {
  const root = tryParse(value);
  if (root === null) return null;
  const parts = children(root);
  if (parts === null || parts.length < 2) return null;
  const cookie = parts[2] !== undefined ? parts[2].content : null;
  return { state: decodeInteger(parts[0].content), uuid: parts[1].content, cookie };
}

export interface SyncDoneResponse { cookie: Uint8Array | null; refreshDeletes: boolean }

export function parseSyncDone(value: Uint8Array | undefined): SyncDoneResponse | null {
  const root = tryParse(value);
  if (root === null) return null;
  const parts = children(root);
  if (parts === null) return null;
  let cookie: Uint8Array | null = null;
  let refreshDeletes = false;
  let at = 0;
  if (parts[at] !== undefined && rawTag(parts[at]) === 0x04) cookie = parts[at++].content;
  if (parts[at] !== undefined && rawTag(parts[at]) === 0x01) refreshDeletes = decodeBoolean(parts[at].content);
  return { cookie, refreshDeletes };
}

export function formatUuid(raw: Uint8Array): string | null {
  if (raw.length !== 16) return null;
  const hex = Array.from(raw, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
