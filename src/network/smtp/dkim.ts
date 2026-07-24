import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from '@/network/pki/PkiKeyPair';
import { sha256Hex } from '@/crypto/hash/sha256';

export interface DkimSignature {
  readonly domain: string;
  readonly selector: string;
  readonly signedHeaders: readonly string[];
  readonly canonicalization: { readonly header: 'relaxed' | 'simple'; readonly body: 'relaxed' | 'simple' };
  readonly bodyHash: string;
  readonly signature: string;
}

export type DkimVerifyResult = 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';

export interface DkimKeyLookup {
  resolvePublicKey(selector: string, domain: string): Promise<PkiPublicKey | null>;
}

export interface DkimSignOptions {
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: PkiPrivateKey;
  readonly headerCanon?: 'relaxed' | 'simple';
  readonly bodyCanon?: 'relaxed' | 'simple';
  readonly signedHeaderNames?: readonly string[];
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function canonicalizeHeaderSimple(name: string, value: string): string {
  return `${name}: ${value}`;
}

function canonicalizeHeaderRelaxed(name: string, value: string): string {
  return `${name.toLowerCase()}:${value.trim().replace(/\s+/g, ' ')}`;
}

function canonicalizeHeader(mode: 'relaxed' | 'simple', name: string, value: string): string {
  return mode === 'relaxed' ? canonicalizeHeaderRelaxed(name, value) : canonicalizeHeaderSimple(name, value);
}

function canonicalizeBodySimple(body: string): string {
  if (body === '') return '';
  const stripped = body.replace(/(?:\r\n)+$/, '');
  return stripped === '' ? '' : `${stripped}\r\n`;
}

function canonicalizeBodyRelaxed(body: string): string {
  if (body === '') return '';
  const lines = body.split('\r\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const cleaned = lines.map((l) => l.replace(/[ \t]+/g, ' ').replace(/ +$/, ''));
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return cleaned.length === 0 ? '' : `${cleaned.join('\r\n')}\r\n`;
}

function canonicalizeBody(mode: 'relaxed' | 'simple', body: string): string {
  return mode === 'relaxed' ? canonicalizeBodyRelaxed(body) : canonicalizeBodySimple(body);
}

function buildSigningInput(
  headers: ReadonlyMap<string, string>,
  signedHeaders: readonly string[],
  headerCanon: 'relaxed' | 'simple',
  bodyHash: string,
): string {
  const headerBlock = signedHeaders.map((name) => canonicalizeHeader(headerCanon, name, headers.get(name) ?? '')).join('\r\n');
  return `${headerBlock}\r\nbh=${bodyHash}`;
}

export function signDkim(headers: ReadonlyMap<string, string>, body: string, opts: DkimSignOptions): DkimSignature {
  const headerCanon = opts.headerCanon ?? 'relaxed';
  const bodyCanon = opts.bodyCanon ?? 'relaxed';
  const signedHeaders = opts.signedHeaderNames ?? [...headers.keys()];
  const bodyHash = hexToBase64(sha256Hex(canonicalizeBody(bodyCanon, body)));
  const signingInput = buildSigningInput(headers, signedHeaders, headerCanon, bodyHash);
  const signature = PkiKeyPair.sign(opts.privateKey, signingInput);
  return {
    domain: opts.domain,
    selector: opts.selector,
    signedHeaders,
    canonicalization: { header: headerCanon, body: bodyCanon },
    bodyHash,
    signature,
  };
}

export async function verifyDkim(
  lookup: DkimKeyLookup,
  headers: ReadonlyMap<string, string>,
  body: string,
  sig: DkimSignature,
): Promise<DkimVerifyResult> {
  let publicKey: PkiPublicKey | null;
  try {
    publicKey = await lookup.resolvePublicKey(sig.selector, sig.domain);
  } catch {
    return 'temperror';
  }
  if (!publicKey) return 'permerror';

  const bodyHash = hexToBase64(sha256Hex(canonicalizeBody(sig.canonicalization.body, body)));
  if (bodyHash !== sig.bodyHash) return 'fail';

  const signingInput = buildSigningInput(headers, sig.signedHeaders, sig.canonicalization.header, sig.bodyHash);
  return PkiKeyPair.verify(publicKey, signingInput, sig.signature) ? 'pass' : 'fail';
}

export function formatDkimSignatureHeader(sig: DkimSignature): string {
  const tags = [
    'v=1',
    'a=rsa-sha256',
    `c=${sig.canonicalization.header}/${sig.canonicalization.body}`,
    `d=${sig.domain}`,
    `s=${sig.selector}`,
    `h=${sig.signedHeaders.join(':')}`,
    `bh=${sig.bodyHash}`,
    `b=${sig.signature}`,
  ];
  return `DKIM-Signature: ${tags.join('; ')}`;
}

export function parseDkimSignatureHeader(value: string): DkimSignature | null {
  const tags = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) tags.set(key, val);
  }
  const domain = tags.get('d');
  const selector = tags.get('s');
  const h = tags.get('h');
  const bh = tags.get('bh');
  const b = tags.get('b');
  const c = tags.get('c') ?? 'simple/simple';
  const [headerCanon, bodyCanon] = c.split('/');
  if (!domain || !selector || !h || !bh || !b) return null;
  if (headerCanon !== 'relaxed' && headerCanon !== 'simple') return null;
  if (bodyCanon !== 'relaxed' && bodyCanon !== 'simple') return null;
  return {
    domain,
    selector,
    signedHeaders: h.split(':'),
    canonicalization: { header: headerCanon, body: bodyCanon },
    bodyHash: bh,
    signature: b,
  };
}

export interface DkimSelector {
  readonly domain: string;
  readonly selector: string;
  readonly keyPair: PkiKeyPair;
}

export function generateDkimSelector(domain: string, selectorName?: string): DkimSelector {
  const keyPair = PkiKeyPair.generate('rsa');
  const selector = selectorName ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { domain, selector, keyPair };
}
