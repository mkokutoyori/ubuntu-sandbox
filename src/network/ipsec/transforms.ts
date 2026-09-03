export type IpsecTransformRole =
  | 'esp-encryption' | 'esp-authentication' | 'ah-authentication' | 'compression';

export interface IpsecTransform {
  readonly keyword: string;
  readonly aliases?: readonly string[];
  readonly role: IpsecTransformRole;
  readonly algorithm: string;
  readonly keyLength: number;
  readonly impliedEspAuth?: { algorithm: string; keyLength: number };
}

export const IPSEC_TRANSFORMS: readonly IpsecTransform[] = Object.freeze([
  { keyword: 'esp-aes', aliases: ['esp-aes-128', 'esp-aes 128'], role: 'esp-encryption', algorithm: 'aes-cbc-128', keyLength: 128 },
  { keyword: 'esp-aes-192', aliases: ['esp-aes 192'], role: 'esp-encryption', algorithm: 'aes-cbc-192', keyLength: 192 },
  { keyword: 'esp-aes-256', aliases: ['esp-aes 256'], role: 'esp-encryption', algorithm: 'aes-cbc-256', keyLength: 256 },
  { keyword: 'esp-3des', role: 'esp-encryption', algorithm: '3des-cbc', keyLength: 192 },
  { keyword: 'esp-des', role: 'esp-encryption', algorithm: 'des-cbc', keyLength: 64 },
  {
    keyword: 'esp-gcm', aliases: ['esp-gcm-128', 'esp-gcm 128'],
    role: 'esp-encryption', algorithm: 'aes-gcm-128', keyLength: 128,
    impliedEspAuth: { algorithm: 'aes-gcm', keyLength: 0 },
  },
  {
    keyword: 'esp-gcm-256', aliases: ['esp-gcm 256'],
    role: 'esp-encryption', algorithm: 'aes-gcm-256', keyLength: 256,
    impliedEspAuth: { algorithm: 'aes-gcm', keyLength: 0 },
  },
  { keyword: 'esp-null', role: 'esp-encryption', algorithm: 'null', keyLength: 0 },

  { keyword: 'esp-sha-hmac', aliases: ['esp-sha1-hmac'], role: 'esp-authentication', algorithm: 'hmac-sha-1', keyLength: 160 },
  { keyword: 'esp-sha256-hmac', aliases: ['esp-sha-256-hmac'], role: 'esp-authentication', algorithm: 'hmac-sha-256', keyLength: 256 },
  { keyword: 'esp-sha384-hmac', role: 'esp-authentication', algorithm: 'hmac-sha-384', keyLength: 384 },
  { keyword: 'esp-sha512-hmac', role: 'esp-authentication', algorithm: 'hmac-sha-512', keyLength: 512 },
  { keyword: 'esp-md5-hmac', role: 'esp-authentication', algorithm: 'hmac-md5', keyLength: 128 },

  { keyword: 'ah-sha-hmac', aliases: ['ah-sha1-hmac'], role: 'ah-authentication', algorithm: 'hmac-sha-1', keyLength: 160 },
  { keyword: 'ah-sha256-hmac', aliases: ['ah-sha-256-hmac'], role: 'ah-authentication', algorithm: 'hmac-sha-256', keyLength: 256 },
  { keyword: 'ah-sha384-hmac', role: 'ah-authentication', algorithm: 'hmac-sha-384', keyLength: 384 },
  { keyword: 'ah-sha512-hmac', role: 'ah-authentication', algorithm: 'hmac-sha-512', keyLength: 512 },
  { keyword: 'ah-md5-hmac', role: 'ah-authentication', algorithm: 'hmac-md5', keyLength: 128 },
]);

const BY_WORD = new Map<string, IpsecTransform>();
for (const transform of IPSEC_TRANSFORMS) {
  BY_WORD.set(transform.keyword, transform);
  for (const alias of transform.aliases ?? []) BY_WORD.set(alias, transform);
}

export function findIpsecTransform(word: string): IpsecTransform | null {
  return BY_WORD.get(word.toLowerCase()) ?? null;
}

export function isIpsecTransform(word: string): boolean {
  return findIpsecTransform(word) !== null;
}

export function ipsecTransformKeywords(): string[] {
  return IPSEC_TRANSFORMS.map((t) => t.keyword);
}
