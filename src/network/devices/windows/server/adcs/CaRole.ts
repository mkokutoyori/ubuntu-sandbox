/**
 * WindowsAdcsRole — the "Active Directory Certificate Services" (AD-Certificate)
 * role, `CertSvc` service (PRD-Windows-Server-Advanced.md §5 P13, §2.1.13,
 * MS-WCCE). No new cryptographic primitive: this façade instantiates a
 * `CertificateAuthority` (`src/network/pki/`, already mature) as an
 * enterprise root CA and delegates issuance/signing entirely to it — the
 * only things this role adds are the service, the cmdlets/CLI, and a
 * minimal certificate-template store gating requests by purpose (EKU) and
 * validity period.
 */

import { CertificateAuthority, type IssuedCertificate } from '@/network/pki/CertificateAuthority';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { DEFAULT_CERT_TEMPLATES, type CertTemplateDef } from './CertificateTemplate';
import { type IEventBus } from '@/events/EventBus';
import { detachedBus } from '@/events/BusHolder';

export interface AdcsOpResult { ok: boolean; message: string }

export interface CaTemplateView {
  readonly name: string;
  readonly displayName: string;
  readonly eku: readonly string[];
  readonly validityDays: number;
}

export interface CertificateRequestOptions {
  readonly subjectAltNames?: readonly string[];
  /** The purpose the requester wants the certificate for (e.g. `serverAuth`) — rejected if the template doesn't allow it. */
  readonly requestedEku?: string;
}

export interface CertificateRequestResult extends AdcsOpResult {
  readonly certificate?: X509Certificate;
  /** The freshly generated private key — callers (e.g. `WindowsCertStore`) need it to actually use the certificate for TLS. */
  readonly privateKey?: PkiPrivateKey;
}

export class WindowsAdcsRole {
  private ca: CertificateAuthority | null = null;
  private caCommonName: string | null = null;
  private readonly templates: readonly CertTemplateDef[] = DEFAULT_CERT_TEMPLATES;
  /** Issued certs kept by serial number so `Get-Certificate` can re-fetch a prior `certreq -submit` result. */
  private readonly issued = new Map<string, IssuedCertificate>();

  constructor(
    private readonly now: () => number,
    private readonly bus: IEventBus = detachedBus(),
    private readonly deviceId: string = '',
  ) {}

  isInstalled(): boolean { return this.ca !== null; }

  /** `Install-AdcsCertificationAuthority -CACommonName <name>` — creates this forest's enterprise root CA. Idempotent errors mirror real certutil's "already configured" refusal. */
  installCA(caCommonName: string): AdcsOpResult {
    if (this.ca) {
      return { ok: false, message: 'Install-AdcsCertificationAuthority : The Certification Authority is already installed on this computer.' };
    }
    this.caCommonName = caCommonName;
    this.ca = CertificateAuthority.generate(`CN=${caCommonName}`, { now: this.now() });
    return { ok: true, message: `Active Directory Certificate Services\n\nThe installation of Active Directory Certificate Services completed successfully.\nCA name: ${caCommonName}` };
  }

  getCaCommonName(): string | null { return this.caCommonName; }
  getCaCertificate(): X509Certificate | null { return this.ca?.rootCertificate ?? null; }

  listTemplates(): CaTemplateView[] {
    return this.templates.map(t => ({ name: t.name, displayName: t.displayName, eku: t.eku, validityDays: t.validityDays }));
  }

  getTemplate(name: string): CaTemplateView | null {
    const t = this.templates.find(t => t.name.toLowerCase() === name.toLowerCase());
    return t ? { name: t.name, displayName: t.displayName, eku: t.eku, validityDays: t.validityDays } : null;
  }

  /**
   * `Add-CATemplate -TemplateName <name>` — publishes a template to this
   * CA so it starts issuing against it. Every template in this simulator's
   * fixed catalog is already unconditionally issuable (`submitRequest`
   * matches by name against the whole catalog, no separate "published"
   * set — PRD §2.2: no template versioning/ACLs), so this only needs to
   * validate the name is real, matching real AD CS's rejection of an
   * unknown template.
   */
  addTemplate(name: string): AdcsOpResult {
    if (!this.ca) {
      return { ok: false, message: 'Add-CATemplate : The Certification Authority is not installed on this computer.' };
    }
    const t = this.templates.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!t) {
      return { ok: false, message: `Add-CATemplate : Cannot find a certificate template with name '${name}'.` };
    }
    return { ok: true, message: `Add-CATemplate : Template '${t.name}' added to the CA.` };
  }

  /**
   * `certreq -submit`/`certutil -submit` — issues a certificate against
   * `templateName`, delegating the actual signing to the underlying
   * `CertificateAuthority`. A `requestedEku` outside the template's allowed
   * purposes is denied before any certificate is generated, mirroring real
   * AD CS's policy-module enrollment check. `subject` is the full subject
   * DN (e.g. `CN=www.lab.local`), taken as-is — callers build it from
   * whatever they were given (a bare DNS name, an existing DN, ...).
   */
  submitRequest(subject: string, templateName: string, opts: CertificateRequestOptions = {}): CertificateRequestResult {
    if (!this.ca) {
      return { ok: false, message: 'certreq : The RPC server is unavailable. 0x800706ba (Certification Authority not installed)' };
    }
    const template = this.templates.find(t => t.name.toLowerCase() === templateName.toLowerCase());
    if (!template) {
      return { ok: false, message: `certreq : The requested certificate template is not supported by this CA. 0x80094800 (-2146875392 CERTSRV_E_UNSUPPORTED_CERT_TYPE)\nCertReq: The requested certificate template is not supported by this CA.` };
    }
    if (opts.requestedEku && !template.eku.includes(opts.requestedEku)) {
      return { ok: false, message: `certreq : Denied by Policy Module  0x80094800, The permissions on this certificate template do not allow the current user to enroll for this type of certificate. 0x80094800 (-2146875392 CERTSRV_E_UNSUPPORTED_CERT_TYPE)\nCertReq: Denied by Policy Module` };
    }
    const now = this.now();
    const issued: IssuedCertificate = this.ca.issueCertificate({
      subject,
      notBefore: now,
      notAfter: now + template.validityDays * 24 * 3600 * 1000,
      subjectAltNames: opts.subjectAltNames,
      extKeyUsage: template.eku,
    });
    this.issued.set(issued.cert.serialNumber, issued);
    this.bus.publish({
      topic: 'adcs.certificate.issued',
      payload: { deviceId: this.deviceId, subject, templateName: template.name, serialNumber: issued.cert.serialNumber },
    });
    return { ok: true, message: 'Certificate issued.', certificate: issued.cert, privateKey: issued.privateKey };
  }

  /** `Get-Certificate` — re-fetches a previously issued certificate by its serial number (this simulator's synchronous `certreq -submit` never leaves a request "Pending", so there's nothing else to poll). */
  getIssuedCertificate(serialNumber: string): X509Certificate | null {
    return this.issued.get(serialNumber)?.cert ?? null;
  }

  listIssuedCertificates(): X509Certificate[] {
    return [...this.issued.values()].map(i => i.cert);
  }
}
