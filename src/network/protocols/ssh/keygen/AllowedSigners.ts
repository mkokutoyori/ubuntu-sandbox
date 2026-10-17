import { base64ToBytes } from '@/crypto/encoding';
import { sshPublicKeyBlob, sshPublicKeyFromBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { matchesPatternList } from '../client/SshClientConfigFile';
import { formatAbsoluteTime, parseAbsoluteTime, type ZoneOffset } from './AbsoluteTime';

const KEY_TYPE_WORD = /^(?:ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-[a-z0-9@.-]+)(?:-cert-v01@openssh\.com)?$/;

interface SignerOptions {
  readonly certAuthority: boolean;
  readonly namespaces?: string;
  readonly validAfter: number;
  readonly validBefore: number;
}

type LineOutcome =
  | { readonly kind: 'skip' }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'entry'; readonly principals: string; readonly key: SshPublicKey; readonly options: SignerOptions };

export type SignersOutcome<T> =
  | { readonly kind: 'found'; readonly value: T; readonly logged: readonly string[] }
  | { readonly kind: 'not-found'; readonly logged: readonly string[] }
  | { readonly kind: 'invalid'; readonly logged: readonly string[] };

export interface SignersContext {
  readonly path: string;
  readonly text: string;
  readonly verifyTime: number;
  readonly zoneOffset: ZoneOffset;
}

function dequote(text: string): { value: string; rest: string } | string {
  if (!text.startsWith('"')) return 'missing start quote';
  let value = '';
  let at = 1;
  for (; at < text.length && text[at] !== '"'; at++) {
    if (text[at] === '\\' && text[at + 1] === '"') at++;
    value += text[at];
  }
  if (at >= text.length) return 'missing end quote';
  return { value, rest: text.slice(at + 1) };
}

function parseOptions(text: string, zoneOffset: ZoneOffset): SignerOptions | string {
  let certAuthority = false;
  let namespaces: string | undefined;
  let validAfter = 0;
  let validBefore = 0;
  let rest = text;
  const keyword = (name: string) => rest.toLowerCase().startsWith(`${name}=`);
  const timeOption = (name: string, current: number): number | string => {
    if (current !== 0) return `multiple "${name}" clauses`;
    const quoted = dequote(rest.slice(name.length + 1));
    if (typeof quoted === 'string') return quoted;
    rest = quoted.rest;
    return parseAbsoluteTime(quoted.value, zoneOffset) || `invalid "${name}" time`;
  };
  while (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') {
    if (rest.toLowerCase().startsWith('cert-authority')) {
      certAuthority = true;
      rest = rest.slice('cert-authority'.length);
    } else if (keyword('namespaces')) {
      if (namespaces !== undefined) return 'multiple "namespaces" clauses';
      const quoted = dequote(rest.slice('namespaces='.length));
      if (typeof quoted === 'string') return quoted;
      namespaces = quoted.value;
      rest = quoted.rest;
    } else if (keyword('valid-after')) {
      const parsed = timeOption('valid-after', validAfter);
      if (typeof parsed === 'string') return parsed;
      validAfter = parsed;
    } else if (keyword('valid-before')) {
      const parsed = timeOption('valid-before', validBefore);
      if (typeof parsed === 'string') return parsed;
      validBefore = parsed;
    }
    if (rest === '' || rest[0] === ' ' || rest[0] === '\t') break;
    if (rest[0] !== ',') return 'unknown key option';
    rest = rest.slice(1);
    if (rest === '') return 'unexpected end-of-options';
  }
  if (validAfter !== 0 && validBefore !== 0 && validBefore <= validAfter) {
    return '"valid-before" time is before "valid-after"';
  }
  return { certAuthority, namespaces, validAfter, validBefore };
}

function splitOptionsFromKey(rest: string): { options: string; key: string } | null {
  let quoted = false;
  let at = 0;
  for (; at < rest.length; at++) {
    const character = rest[at];
    if (character === '"') quoted = !quoted;
    else if (!quoted && (character === ' ' || character === '\t')) break;
  }
  if (quoted) return null;
  return { options: rest.slice(0, at), key: rest.slice(at).replace(/^[ \t]+/, '') };
}

export function parsePublicKeyText(text: string): SshPublicKey | null {
  const [type, body] = text.trim().split(/\s+/);
  if (type === undefined || body === undefined || !KEY_TYPE_WORD.test(type)) return null;
  const key = sshPublicKeyFromBlob(base64ToBytes(body));
  return key !== null && key.algorithm === type ? key : null;
}

function parseLine(context: SignersContext, line: string, number: number, requiredPrincipal?: string): LineOutcome {
  const where = `${context.path}:${number}`;
  const trimmed = line.replace(/^[ \t]+/, '');
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'skip' };
  const separator = trimmed.search(/[ \t]/);
  if (separator < 0) return { kind: 'invalid', error: `${where}: invalid line` };
  const principals = trimmed.slice(0, separator);
  if (requiredPrincipal !== undefined && !matchesPatternList(principals, requiredPrincipal, false)) return { kind: 'skip' };
  const rest = trimmed.slice(separator).replace(/^[ \t]+/, '');
  const firstWord = rest.split(/[ \t]/)[0];
  let key = KEY_TYPE_WORD.test(firstWord) ? parsePublicKeyText(rest) : null;
  let optionText = '';
  if (key === null) {
    const split = splitOptionsFromKey(rest);
    if (split === null) return { kind: 'invalid', error: `${where}: invalid options` };
    optionText = split.options;
    key = parsePublicKeyText(split.key);
    if (key === null) return { kind: 'invalid', error: `${where}: invalid key` };
  }
  const options = parseOptions(optionText, context.zoneOffset);
  if (typeof options === 'string') return { kind: 'invalid', error: `${where}: bad options: ${options}` };
  return { kind: 'entry', principals, key, options };
}

function sameKey(first: SshPublicKey, second: SshPublicKey): boolean {
  const left = sshPublicKeyBlob(first);
  const right = sshPublicKeyBlob(second);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function eachLine(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function entryRefusals(
  context: SignersContext, number: number, entry: Extract<LineOutcome, { kind: 'entry' }>,
  signer: SshPublicKey, namespace: string | undefined,
): readonly string[] | null {
  const where = `${context.path}:${number}`;
  if (entry.options.certAuthority || !sameKey(entry.key, signer)) return null;
  const { namespaces, validAfter, validBefore } = entry.options;
  if (namespaces !== undefined && namespace !== undefined && !matchesPatternList(namespaces, namespace, false)) {
    return [`${where}: key is not permitted for use in signature namespace "${namespace}"`];
  }
  const verifying = formatAbsoluteTime(context.verifyTime, context.zoneOffset);
  if (validAfter !== 0 && context.verifyTime < validAfter) {
    return [`${where}: key is not yet valid: verify time ${verifying} < valid-after ${formatAbsoluteTime(validAfter, context.zoneOffset)}`];
  }
  if (validBefore !== 0 && context.verifyTime > validBefore) {
    return [`${where}: key has expired: verify time ${verifying} > valid-before ${formatAbsoluteTime(validBefore, context.zoneOffset)}`];
  }
  return [];
}

function scan(
  context: SignersContext, signer: SshPublicKey, principal: string | undefined, namespace: string | undefined,
): SignersOutcome<string> {
  const logged: string[] = [];
  const lines = eachLine(context.text);
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseLine(context, lines[index], index + 1, principal);
    if (parsed.kind === 'skip') continue;
    if (parsed.kind === 'invalid') return { kind: 'invalid', logged: [...logged, parsed.error] };
    const refusals = entryRefusals(context, index + 1, parsed, signer, namespace);
    if (refusals === null) continue;
    if (refusals.length > 0) {
      logged.push(...refusals);
      continue;
    }
    return { kind: 'found', value: parsed.principals, logged };
  }
  return { kind: 'not-found', logged };
}

export function checkAllowedSigner(
  context: SignersContext, signer: SshPublicKey, principal: string, namespace: string,
): SignersOutcome<string> {
  return scan(context, signer, principal, namespace);
}

export function findPrincipals(context: SignersContext, signer: SshPublicKey): SignersOutcome<string> {
  return scan(context, signer, undefined, undefined);
}

export function matchPrincipals(context: SignersContext, principal: string): SignersOutcome<readonly string[]> {
  const matched: string[] = [];
  const lines = eachLine(context.text);
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseLine(context, lines[index], index + 1, principal);
    if (parsed.kind === 'skip') continue;
    if (parsed.kind === 'invalid') return { kind: 'invalid', logged: [parsed.error] };
    matched.push(parsed.principals);
  }
  return matched.length === 0 ? { kind: 'not-found', logged: [] } : { kind: 'found', value: matched, logged: [] };
}
