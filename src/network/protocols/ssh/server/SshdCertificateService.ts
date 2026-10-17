import { bytesToBase64 } from '@/crypto/encoding';
import { sshPublicKeyBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { checkRevocation, revocationFailureText } from '../certificate/RevocationFile';
import { SSH_CERT_TYPE_HOST, parseCertificateLine, type SshCertificate } from '../certificate/SshCertificate';
import type { SshHostKey } from '../SshHostKey';
import type { AuthorizedKey, KeySource } from '../SshPureUtils';
import type { HostCertificateBinding } from './ISshServerContext';
import type { SshServerEvent } from './SshServerEvent';
import type { SshdEffectiveView, SshdServerConfig } from './SshdServerConfig';
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

  revocationRefusal(user: string, key: SshPublicKey | SshCertificate, source: KeySource): string | null {
    const path = this.viewOf(user, source).revokedKeys;
    if (path === null) return null;
    const verdict = checkRevocation(this.host.readFile(path), key);
    if (verdict.kind === 'ok') return null;
    const message = revocationFailureText('Authentication key', path, key, verdict);
    if (source.ip !== '') this.host.emit({ kind: 'auth_log', level: 'error', text: message });
    return message;
  }

  private viewOf(user: string, source: KeySource): SshdEffectiveView {
    return this.host.config().effectiveFor({ user, groups: [...this.host.groupsOf(user)], address: source.ip });
  }

  admit(
    user: string, account: CertificateAccount, certificate: SshCertificate, source: KeySource,
    authorizedKeys: TextFile | null,
  ): AuthorizedKey | null {
    const view = this.viewOf(user, source);
    const textFile = (path: string | null): TextFile | null => (path === null ? null : { path, text: this.host.readFile(path) });
    const principalsPath = view.authorizedPrincipalsFile === null
      ? null
      : expandPrincipalsPath(view.authorizedPrincipalsFile, { user, uid: account.uid, home: account.home });
    const result = admitUserCertificate({
      certificate, user, source,
      nowSeconds: BigInt(Math.floor(simulationNowMs() / 1000)),
      caSignatureAlgorithms: view.caSignatureAlgorithms,
      trustedCaKeys: textFile(view.trustedUserCaKeys),
      principalsFile: textFile(principalsPath),
      authorizedKeys,
      revokedBy: (key) => (this.revocationRefusal(user, key, source) === null ? null : (view.revokedKeys ?? '')),
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
