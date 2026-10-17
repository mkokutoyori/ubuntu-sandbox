import { bytesToBase64 } from '@/crypto/encoding';
import { keygenBlobDigest, sshKeyTypeLabel, sshPublicKeyBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { checkRevocation } from '../certificate/RevocationFile';
import { SSH_CERT_TYPE_HOST, parseCertificateLine, type SshCertificate } from '../certificate/SshCertificate';
import type { SshHostKey } from '../SshHostKey';
import type { AuthorizedKey, KeySource } from '../SshPureUtils';
import type { HostCertificateBinding } from './ISshServerContext';
import type { SshServerEvent } from './SshServerEvent';
import type { SshdServerConfig } from './SshdServerConfig';
import { expandPrincipalsPath } from './PrincipalsPath';
import { admitUserCertificate, type TextFile } from './UserCertificateAdmission';
import { simulationNowMs } from '@/network/core/SystemClock';

export interface CertificateServiceHost {
  readonly config: () => SshdServerConfig;
  readonly groupsOf: (user: string) => readonly string[];
  readonly readFile: (path: string) => string | null;
  readonly emit: (event: SshServerEvent) => void;
}

export interface CertificateAccount {
  readonly uid: number;
  readonly home: string;
}

export class SshdCertificateService {
  constructor(private readonly host: CertificateServiceHost) {}

  revocationRefusal(key: SshPublicKey | SshCertificate, source: KeySource): string | null {
    const path = this.host.config().revokedKeys;
    if (path === null) return null;
    const verdict = checkRevocation(this.host.readFile(path), key);
    if (verdict.kind === 'ok') return null;
    const certificate = 'subject' in key ? key : null;
    const blob = bytesToBase64(certificate === null ? sshPublicKeyBlob(key as SshPublicKey) : certificate.blob);
    const fingerprint = keygenBlobDigest(blob, 'sha256') ?? '(null)';
    const label = certificate === null
      ? `${sshKeyTypeLabel((key as SshPublicKey).algorithm)} ${fingerprint}`
      : `${sshKeyTypeLabel(certificate.subject.algorithm)}-CERT ${fingerprint}`;
    const message = verdict.kind === 'revoked'
      ? `Authentication key ${label} revoked by file ${path}`
      : `Error checking authentication key ${label} in revoked keys file ${path}: ${verdict.message}`;
    if (source.ip !== '') this.host.emit({ kind: 'auth_log', level: 'error', text: message });
    return message;
  }

  admit(
    user: string, account: CertificateAccount, certificate: SshCertificate, source: KeySource,
    authorizedKeys: TextFile | null,
  ): AuthorizedKey | null {
    const config = this.host.config();
    const view = config.effectiveFor({ user, groups: [...this.host.groupsOf(user)], address: source.ip });
    const textFile = (path: string | null): TextFile | null => (path === null ? null : { path, text: this.host.readFile(path) });
    const principalsPath = view.authorizedPrincipalsFile === null
      ? null
      : expandPrincipalsPath(view.authorizedPrincipalsFile, { user, uid: account.uid, home: account.home });
    const result = admitUserCertificate({
      certificate, user, source,
      nowSeconds: BigInt(Math.floor(simulationNowMs() / 1000)),
      caSignatureAlgorithms: config.caSignatureAlgorithms,
      trustedCaKeys: textFile(config.trustedUserCaKeys),
      principalsFile: textFile(principalsPath),
      authorizedKeys,
      revokedBy: (key) => (this.revocationRefusal(key, source) === null ? null : (config.revokedKeys ?? '')),
    });
    if (source.ip !== '') for (const log of result.logs) this.host.emit({ kind: 'auth_log', level: log.level, text: log.text });
    return result.key;
  }

  hostCertificates(hostKeys: readonly SshHostKey[]): HostCertificateBinding[] {
    const bindings: HostCertificateBinding[] = [];
    for (const path of this.host.config().hostCertificates) {
      const parsed = parseCertificateLine((this.host.readFile(path) ?? '').split('\n')[0] ?? '');
      if (parsed === null || parsed.certificate.type !== SSH_CERT_TYPE_HOST) continue;
      const subject = bytesToBase64(sshPublicKeyBlob(parsed.certificate.subject));
      const hostKey = hostKeys.find((candidate) => candidate.publicKey === subject);
      if (hostKey !== undefined) bindings.push({ certificate: parsed.certificate, hostKey });
    }
    return bindings;
  }
}
