import type { ClientHello } from '../messages';
import type { TlsProtocolVersion } from './legacyCipherSuites';

const ALL_VERSIONS: readonly TlsProtocolVersion[] = ['1.0', '1.1', '1.2', '1.3'];
const LEGACY_ORDER: readonly TlsProtocolVersion[] = ['1.0', '1.1', '1.2'];

export function offeredVersions(clientHello: ClientHello): TlsProtocolVersion[] {
  const listed = clientHello.extensions.supportedVersions
    .filter((version): version is TlsProtocolVersion => (ALL_VERSIONS as readonly string[]).includes(version));
  if (listed.length > 0) return listed;
  const ceiling = LEGACY_ORDER.indexOf(clientHello.legacyVersion as TlsProtocolVersion);
  return LEGACY_ORDER.slice(0, (ceiling === -1 ? LEGACY_ORDER.length - 1 : ceiling) + 1);
}
