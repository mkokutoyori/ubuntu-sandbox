/**
 * `certreq`/`certutil` — the client-side commands MS-WCCE describes for
 * submitting a certificate request against AD CS's `CertSvc`
 * (PRD-Windows-Server-Advanced.md §5 P13, §2.1.13). Simplified CLI (no
 * PKCS#10 `.req` file parsing — this simulator's PKI layer doesn't
 * byte-model ASN.1 CSRs any more than it does for the certificates
 * themselves): `-submit` takes the subject and template name directly.
 */

import type { WindowsAdcsRole } from '../windows/server/adcs/CaRole';
import type { WindowsCertStore } from './CertStore';

export interface CertReqContext {
  adcs: WindowsAdcsRole | null;
  /** PRD §5 P14 — a successfully issued cert lands here too, so `New-WebBinding -CertificateHash` can reference it exactly like a self-signed one. */
  certStore: WindowsCertStore;
}

function parseSubmitArgs(args: string[]): { subject?: string; template?: string; eku?: string } {
  let subject: string | undefined;
  let template: string | undefined;
  let eku: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.toLowerCase() === '-subject' && args[i + 1]) { subject = args[++i]; continue; }
    if (a.toLowerCase() === '-template' && args[i + 1]) { template = args[++i]; continue; }
    if (a.toLowerCase() === '-eku' && args[i + 1]) { eku = args[++i]; continue; }
  }
  return { subject, template, eku };
}

/** `certreq -submit -template <name> -subject <CN=...>` */
export function cmdCertreq(ctx: CertReqContext, args: string[]): string {
  if (args[0]?.toLowerCase() !== '-submit') {
    return 'CertReq usage: CertReq [-submit] -template <template> -subject <subject>';
  }
  const { subject, template, eku } = parseSubmitArgs(args.slice(1));
  if (!ctx.adcs) {
    return 'CertReq: The RPC server is unavailable. 0x800706ba (WIN32: 1722 RPC_S_SERVER_UNAVAILABLE)';
  }
  if (!subject || !template) {
    return 'CertReq usage: CertReq [-submit] -template <template> -subject <subject>';
  }
  const res = ctx.adcs.submitRequest(subject, template, { requestedEku: eku });
  if (!res.ok) return res.message;
  ctx.certStore.add(res.certificate!, res.privateKey!);
  return `CertReq: Certificate Retrieved\nSerial Number: ${res.certificate!.serialNumber}\nSubject: ${res.certificate!.subject}\nIssuer: ${res.certificate!.issuer}`;
}

/** `certutil -submit -template <name> -subject <CN=...>` — same semantics as `certreq -submit`, matching real Windows offering both tools for the same operation. */
export function cmdCertutil(ctx: CertReqContext, args: string[]): string {
  if (args[0]?.toLowerCase() !== '-submit') {
    return 'CertUtil usage: CertUtil [-submit] -template <template> -subject <subject>';
  }
  return cmdCertreq(ctx, args);
}
