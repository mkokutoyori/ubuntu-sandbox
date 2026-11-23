import { readTlsLimits, tlsLimitsError, TLS_LIMIT_KEYS, type RadSecTls } from '@/network/radius/RadSecTlsPolicy';
import type { ConfSection } from './FreeradiusConf';

const TLS_KEYS = new Set(['private_key_password', 'private_key_file', 'certificate_file', 'ca_file', 'require_client_cert', ...TLS_LIMIT_KEYS]);

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
  return {
    limits, certificateFile, privateKeyFile, privateKeyPassword: pairValue(section, 'private_key_password') ?? null,
    caFile: pairValue(section, 'ca_file') ?? null, requireClientCert: /^(yes|true|on)$/i.test(require),
  };
}
