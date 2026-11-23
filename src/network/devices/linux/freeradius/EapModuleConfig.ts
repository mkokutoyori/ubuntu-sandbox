import type { ConfSection } from './FreeradiusConf';

export type EapDefaultType = 'md5' | 'tls' | 'peap' | 'ttls';

export interface EapTlsFiles {
  readonly privateKeyFile: string;
  readonly certificateFile: string;
  readonly caFile: string | null;
  readonly privateKeyPassword: string | null;
  readonly fragmentSize: number | null;
  readonly checkCrl: boolean;
  readonly allowExpiredCrl: boolean;
}

export interface EapModuleConfig {
  readonly defaultType: EapDefaultType;
  readonly peapInner: 'md5' | 'mschapv2';
  readonly tls: EapTlsFiles | null;
}

const EAP_KEYS = new Set(['default_eap_type']);
const TLS_CONFIG_KEYS = new Set(['private_key_file', 'certificate_file', 'ca_file', 'private_key_password', 'fragment_size', 'check_crl', 'allow_expired_crl']);
const TYPES: ReadonlySet<string> = new Set(['md5', 'tls', 'peap', 'ttls']);
const isEapType = (text: string): text is EapDefaultType => TYPES.has(text);
export const EAP_DEFAULT_FRAGMENT_SIZE = 1024;

const pairOf = (section: ConfSection, name: string): string | undefined => section.pairs.find((candidate) => candidate.name === name)?.value;
const at = (section: ConfSection): string => `${section.file}[${section.line}]`;

export function readEapModule(modules: ConfSection | undefined): EapModuleConfig | { error: string } | null {
  const eap = modules?.sections.find((section) => section.name1 === 'eap');
  if (eap === undefined) return null;
  for (const pair of eap.pairs) {
    if (!EAP_KEYS.has(pair.name)) return { error: `${pair.file}[${pair.line}]: The eap setting "${pair.name}" is not implemented in this simulator` };
  }
  const declared = pairOf(eap, 'default_eap_type') ?? 'md5';
  if (!isEapType(declared)) return { error: `${at(eap)}: Unknown EAP type ${declared}` };
  const defaultType: EapDefaultType = declared;
  const tlsConfigs = new Map<string, EapTlsFiles>();
  for (const section of eap.sections) {
    if (section.name1 === 'tls-config') {
      for (const pair of section.pairs) {
        if (!TLS_CONFIG_KEYS.has(pair.name)) return { error: `${pair.file}[${pair.line}]: The tls-config setting "${pair.name}" is not implemented in this simulator` };
      }
      const certificateFile = pairOf(section, 'certificate_file');
      const privateKeyFile = pairOf(section, 'private_key_file');
      if (certificateFile === undefined) return { error: `${at(section)}: Failed to find "certificate_file" in the tls-config section` };
      if (privateKeyFile === undefined) return { error: `${at(section)}: Failed to find "private_key_file" in the tls-config section` };
      const fragment = pairOf(section, 'fragment_size');
      if (fragment !== undefined && (!/^\d+$/.test(fragment) || Number(fragment) < 1)) return { error: `${at(section)}: Invalid value "${fragment}" for variable fragment_size` };
      tlsConfigs.set(section.name2 ?? '', {
        privateKeyFile, certificateFile, caFile: pairOf(section, 'ca_file') ?? null,
        privateKeyPassword: pairOf(section, 'private_key_password') ?? null, fragmentSize: fragment === undefined ? null : Number(fragment),
        checkCrl: /^(yes|true|on)$/i.test(pairOf(section, 'check_crl') ?? 'no'), allowExpiredCrl: /^(yes|true|on)$/i.test(pairOf(section, 'allow_expired_crl') ?? 'no'),
      });
    } else if (!TYPES.has(section.name1)) {
      return { error: `${at(section)}: The eap section "${section.name1}" is not implemented in this simulator` };
    }
  }
  if (defaultType === 'md5') return { defaultType, peapInner: 'mschapv2', tls: null };
  const method = eap.sections.find((section) => section.name1 === defaultType);
  if (method === undefined) return { error: `${at(eap)}: Failed to find a "${defaultType}" section for default_eap_type = ${defaultType}` };
  for (const pair of method.pairs) {
    const innerAllowed = pair.name === 'default_eap_type' && (pair.value === 'md5' ? defaultType !== 'tls' : pair.value === 'mschapv2' && defaultType === 'peap');
    if (pair.name !== 'tls' && !innerAllowed) {
      return { error: `${pair.file}[${pair.line}]: The ${defaultType} setting "${pair.name} = ${pair.value}" is not implemented in this simulator` };
    }
  }
  const reference = pairOf(method, 'tls');
  if (reference === undefined) return { error: `${at(method)}: Failed to find "tls" in the ${defaultType} section` };
  const tls = tlsConfigs.get(reference);
  if (tls === undefined) return { error: `${at(method)}: Failed to find tls-config "${reference}"` };
  const inner = pairOf(method, 'default_eap_type');
  return { defaultType, peapInner: inner === 'md5' ? 'md5' : 'mschapv2', tls };
}
