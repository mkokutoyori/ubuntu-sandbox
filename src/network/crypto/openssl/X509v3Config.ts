import { subjectKeyIdentifierOf, EXTENDED_KEY_USAGE_OIDS } from '@/network/pki/der/X509Der';
import type { X509Certificate, X509CertificateFields } from '@/network/pki/X509Certificate';
import { IPAddress, IPv6Address } from '@/network/core/types';

export type CertificateExtensions = NonNullable<X509CertificateFields['extensions']>;

export interface ConfigFile {
  readonly sections: ReadonlyMap<string, readonly (readonly [string, string])[]>;
}

export function parseOpensslConfig(text: string): ConfigFile {
  const sections = new Map<string, [string, string][]>();
  let current = 'default';
  sections.set(current, []);
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    sections.get(current)!.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return { sections };
}

export interface ListItem {
  readonly name: string;
  readonly value: string | null;
}

export function parseValueList(line: string): ListItem[] | null {
  const items: ListItem[] = [];
  let name: string | null = null;
  let state: 'name' | 'value' = 'name';
  let start = 0;
  const strip = (text: string): string | null => {
    const trimmed = text.trim();
    return trimmed === '' ? null : trimmed;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (state === 'name') {
      if (ch === ':') {
        name = strip(line.slice(start, i));
        if (name === null) return null;
        state = 'value';
        start = i + 1;
      } else if (ch === ',') {
        const bare = strip(line.slice(start, i));
        if (bare === null) return null;
        items.push({ name: bare, value: null });
        start = i + 1;
      }
    } else if (ch === ',') {
      const value = strip(line.slice(start, i));
      if (value === null) return null;
      items.push({ name: name!, value });
      name = null;
      state = 'name';
      start = i + 1;
    }
  }
  if (state === 'value') {
    const value = strip(line.slice(start));
    if (value === null) return null;
    items.push({ name: name!, value });
  } else {
    const bare = strip(line.slice(start));
    if (bare === null) return null;
    items.push({ name: bare, value: null });
  }
  return items;
}

const KEY_USAGE_BITS: readonly { readonly short: string; readonly long: string }[] = [
  { short: 'digitalSignature', long: 'Digital Signature' },
  { short: 'nonRepudiation', long: 'Non Repudiation' },
  { short: 'keyEncipherment', long: 'Key Encipherment' },
  { short: 'dataEncipherment', long: 'Data Encipherment' },
  { short: 'keyAgreement', long: 'Key Agreement' },
  { short: 'keyCertSign', long: 'Certificate Sign' },
  { short: 'cRLSign', long: 'CRL Sign' },
  { short: 'encipherOnly', long: 'Encipher Only' },
  { short: 'decipherOnly', long: 'Decipher Only' },
];

const EXTENDED_KEY_USAGE_LONG_NAMES: Readonly<Record<string, string>> = {
  serverAuth: 'TLS Web Server Authentication',
  clientAuth: 'TLS Web Client Authentication',
  codeSigning: 'Code Signing',
  emailProtection: 'E-mail Protection',
  timeStamping: 'Time Stamping',
  OCSPSigning: 'OCSP Signing',
  anyExtendedKeyUsage: 'Any Extended Key Usage',
};

const EXTENDED_KEY_USAGE = Object.keys(EXTENDED_KEY_USAGE_LONG_NAMES).map((short) => ({
  short, long: EXTENDED_KEY_USAGE_LONG_NAMES[short], oid: EXTENDED_KEY_USAGE_OIDS[short],
}));

export interface ExtensionContext {
  readonly publicKey: { readonly material: string };
  readonly issuer?: X509Certificate;
}

export type ExtensionBuild =
  | { readonly ok: true; readonly extensions: CertificateExtensions }
  | { readonly ok: false; readonly error: string };

type MutableExtensions = { -readonly [K in keyof CertificateExtensions]: CertificateExtensions[K] };

function keyIdentifier(publicKeyMaterial: string): string {
  return subjectKeyIdentifierOf({ algorithm: publicKeyMaterial.startsWith('ec-') ? 'ecdsa' : 'rsa', material: publicKeyMaterial });
}

function stripCritical(value: string): { critical: boolean; rest: string } {
  const match = /^\s*critical\s*,\s*/i.exec(value);
  return match ? { critical: true, rest: value.slice(match[0].length) } : { critical: false, rest: value };
}

function resolveSection(config: ConfigFile, reference: string): readonly (readonly [string, string])[] | null {
  return config.sections.get(reference.startsWith('@') ? reference.slice(1) : reference) ?? null;
}

function generalNames(value: string, config: ConfigFile): string[] | { error: string } {
  const source = value.startsWith('@')
    ? (resolveSection(config, value) ?? []).map(([k, v]) => `${k}:${v}`).join(',')
    : value;
  const items = parseValueList(source);
  if (items === null) return { error: 'invalid empty name' };
  const names: string[] = [];
  for (const item of items) {
    if (item.value === null) return { error: `missing value for ${item.name}` };
    switch (item.name.toLowerCase()) {
      case 'dns': names.push(`DNS:${item.value}`); break;
      case 'ip':
        if (IPAddress.tryParse(item.value) === null && IPv6Address.tryParse(item.value) === null) return { error: `bad ip address: ${item.value}` };
        names.push(`IP:${item.value}`);
        break;
      case 'email': names.push(`email:${item.value}`); break;
      case 'uri': names.push(`URI:${item.value}`); break;
      default: return { error: `unsupported option: ${item.name}` };
    }
  }
  return names;
}

export function buildExtensions(
  entries: readonly (readonly [string, string])[], config: ConfigFile, context: ExtensionContext,
): ExtensionBuild {
  const extensions: MutableExtensions = {};
  const critical: string[] = [];
  const fail = (name: string, value: string, reason: string): ExtensionBuild => ({
    ok: false, error: `error in extension name=${name}, value=${value}: ${reason}`,
  });
  for (const [name, rawValue] of entries) {
    const { critical: isCritical, rest } = stripCritical(rawValue);
    if (isCritical) critical.push(name);
    switch (name) {
      case 'basicConstraints': {
        const items = parseValueList(rest);
        if (items === null) return fail(name, rawValue, 'invalid value');
        let cA = false;
        let pathLenConstraint: number | undefined;
        for (const item of items) {
          if (item.name === 'CA') {
            const v = (item.value ?? '').toLowerCase();
            if (['true', 'y', 'yes', 'on'].includes(v)) cA = true;
            else if (['false', 'n', 'no', 'off'].includes(v)) cA = false;
            else return fail(name, rawValue, 'invalid boolean');
          } else if (item.name === 'pathlen') {
            if (item.value === null || !/^\d+$/.test(item.value)) return fail(name, rawValue, 'invalid pathlen');
            pathLenConstraint = Number(item.value);
          } else {
            return fail(name, rawValue, `invalid name ${item.name}`);
          }
        }
        extensions.basicConstraints = pathLenConstraint === undefined ? { cA } : { cA, pathLenConstraint };
        break;
      }
      case 'keyUsage': {
        const items = parseValueList(rest);
        if (items === null) return fail(name, rawValue, 'invalid value');
        const usage: NonNullable<CertificateExtensions['keyUsage']>[number][] = [];
        for (const item of items) {
          const bit = KEY_USAGE_BITS.find((b) => b.short === item.name || b.long === item.name);
          if (!bit) return fail(name, rawValue, `unknown bit string argument ${item.name}`);
          usage.push(bit.short as NonNullable<CertificateExtensions['keyUsage']>[number]);
        }
        extensions.keyUsage = usage;
        break;
      }
      case 'extendedKeyUsage': {
        const items = parseValueList(rest);
        if (items === null) return fail(name, rawValue, 'invalid value');
        const usage: string[] = [];
        for (const item of items) {
          const known = EXTENDED_KEY_USAGE.find((e) => e.short === item.name || e.long === item.name || e.oid === item.name);
          if (known) usage.push(known.short);
          else if (/^\d+(\.\d+)+$/.test(item.name)) usage.push(item.name);
          else return fail(name, rawValue, `invalid object identifier ${item.name}`);
        }
        extensions.extKeyUsage = usage;
        break;
      }
      case 'subjectAltName': {
        const names = generalNames(rest, config);
        if ('error' in names) return fail(name, rawValue, names.error);
        extensions.subjectAltName = names;
        break;
      }
      case 'crlDistributionPoints': {
        const names = generalNames(rest, config);
        if ('error' in names) return fail(name, rawValue, names.error);
        extensions.crlDistributionPoints = names.map((n) => n.replace(/^URI:/, ''));
        break;
      }
      case 'authorityInfoAccess': {
        const access: { method: 'OCSP' | 'caIssuers'; uri: string }[] = [];
        for (const part of rest.split(',')) {
          const match = /^\s*(OCSP|caIssuers)\s*;\s*URI\s*:\s*(.+?)\s*$/.exec(part);
          if (!match) return fail(name, rawValue, 'invalid syntax');
          access.push({ method: match[1] as 'OCSP' | 'caIssuers', uri: match[2] });
        }
        extensions.authorityInfoAccess = access;
        break;
      }
      case 'subjectKeyIdentifier': {
        if (rest.trim() !== 'hash') return fail(name, rawValue, 'unsupported value');
        extensions.subjectKeyIdentifier = keyIdentifier(context.publicKey.material);
        break;
      }
      case 'authorityKeyIdentifier': {
        const items = parseValueList(rest) ?? [];
        const akid: { keyid?: string; issuer?: string; serial?: string } = {};
        const issuer = context.issuer;
        for (const item of items) {
          const [kind, always] = item.name.split(':');
          const mandatory = always === 'always' || item.value === 'always';
          if (kind === 'keyid') {
            const keyid = issuer?.extensions?.subjectKeyIdentifier ?? (issuer ? keyIdentifier(issuer.publicKey.material) : undefined);
            if (keyid === undefined && mandatory) return fail(name, rawValue, 'unable to get issuer keyid');
            if (keyid !== undefined) akid.keyid = keyid;
          } else if (kind === 'issuer') {
            if (!mandatory && akid.keyid !== undefined) continue;
            if (issuer) { akid.issuer = issuer.issuer === issuer.subject ? issuer.subject : issuer.issuer; akid.serial = issuer.serialNumber; }
            else if (mandatory) return fail(name, rawValue, 'unable to get issuer details');
          } else {
            return fail(name, rawValue, `invalid name ${item.name}`);
          }
        }
        extensions.authorityKeyIdentifier = akid;
        break;
      }
      default:
        return { ok: false, error: `error in extension name=${name}: unknown extension name` };
    }
  }
  if (critical.length > 0) extensions.criticalExtensions = critical;
  return { ok: true, extensions };
}
