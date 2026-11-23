import { readTlsLimits, tlsLimitsError, TLS_LIMIT_KEYS, type RadSecOcsp, type RadSecTls } from '@/network/radius/RadSecTlsPolicy';
import type { ConfSection } from './FreeradiusConf';

const TLS_KEYS = new Set(['private_key_password', 'private_key_file', 'certificate_file', 'ca_file', 'require_client_cert', ...TLS_LIMIT_KEYS]);

const OCSP_KEYS = new Set(['enable', 'url', 'override_cert_url', 'use_nonce', 'timeout', 'softfail']);
const BOOLEAN_WORD = /^(yes|no|true|false|on|off)$/i;

function readOcsp(section: ConfSection): RadSecOcsp | null | { error: string } {
  const ocsp = section.sections.find((candidate) => candidate.name1 === 'ocsp');
  if (ocsp === undefined) return null;
  for (const pair of ocsp.pairs) {
    if (!OCSP_KEYS.has(pair.name)) return { error: `${pair.file}[${pair.line}]: The ocsp setting "${pair.name}" is not implemented in this simulator` };
    if (pair.name !== 'url' && pair.name !== 'timeout' && !BOOLEAN_WORD.test(pair.value)) return { error: `${pair.file}[${pair.line}]: Invalid value "${pair.value}" for variable ${pair.name}` };
  }
  const flag = (name: string, fallback: string) => /^(yes|true|on)$/i.test(pairValue(ocsp, name) ?? fallback);
  const timeout = pairValue(ocsp, 'timeout') ?? '0';
  if (!/^\d+$/.test(timeout)) return { error: `${ocsp.file}[${ocsp.line}]: Invalid value "${timeout}" for variable timeout` };
  if (!flag('enable', 'no')) return null;
  return { url: pairValue(ocsp, 'url') ?? null, overrideCertUrl: flag('override_cert_url', 'no'), useNonce: flag('use_nonce', 'yes'), timeoutSeconds: Number(timeout), softfail: flag('softfail', 'no') };
}

const pairValue = (section: ConfSection, name: string): string | undefined => section.pairs.find((candidate) => candidate.name === name)?.value;

export function readTlsBody(section: ConfSection): RadSecTls | { error: string } {
  const where = `${section.file}[${section.line}]`;
  for (const pair of section.pairs) {
    if (!TLS_KEYS.has(pair.name)) return { error: `${pair.file}[${pair.line}]: The tls setting "${pair.name}" is not implemented in this simulator` };
  }
  const certificateFile = pairValue(section, 'certificate_file');
  const privateKeyFile = pairValue(section, 'private_key_file');
  if (certificateFile === undefined) return { error: `${where}: Failed to find "certificate_file" in the tls section` };
  if (privateKeyFile === undefined) return { error: `${where}: Failed to find "private_key_file" in the tls section` };
  const require = pairValue(section, 'require_client_cert') ?? 'yes';
  if (!/^(yes|no|true|false|on|off)$/i.test(require)) return { error: `${where}: Invalid value "${require}" for variable require_client_cert` };
  const limits = readTlsLimits((name) => pairValue(section, name));
  const limitsError = tlsLimitsError(limits);
  if (limitsError !== null) return { error: `${where}: ${limitsError}` };
  const ocspRead = readOcsp(section);
  if (ocspRead !== null && 'error' in ocspRead) return ocspRead;
  const ocsp: RadSecOcsp | undefined = ocspRead !== null && !('error' in ocspRead) ? ocspRead : undefined;
  return {
    ...(ocsp === undefined ? {} : { ocsp }),
    limits, certificateFile, privateKeyFile, privateKeyPassword: pairValue(section, 'private_key_password') ?? null,
    caFile: pairValue(section, 'ca_file') ?? null, requireClientCert: /^(yes|true|on)$/i.test(require),
  };
}
