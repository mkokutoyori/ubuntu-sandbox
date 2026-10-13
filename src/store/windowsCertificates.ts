import type { WindowsPC } from '@/network/devices/WindowsPC';
import { reserveCertificateSerial } from '@/network/pki/serialReservation';
import { certToPem, pemToCert, pemToPrivateKey, privateKeyToPem } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';

export interface WindowsCertificateEntry {
  certificate: string;
  privateKey: string;
}

export interface WindowsCertificateState {
  personal?: WindowsCertificateEntry[];
  trustedAuthorities?: string[];
  rdpIdentity?: WindowsCertificateEntry;
  ldapIdentity?: WindowsCertificateEntry;
}

const entryOf = (cert: X509Certificate, privateKey: PkiPrivateKey): WindowsCertificateEntry => ({
  certificate: certToPem(cert), privateKey: privateKeyToPem(privateKey),
});

const identityOf = (saved: WindowsCertificateEntry): { cert: X509Certificate; privateKey: PkiPrivateKey } | null => {
  const cert = pemToCert(saved.certificate);
  const privateKey = pemToPrivateKey(saved.privateKey);
  return cert && privateKey ? { cert, privateKey } : null;
};

export function captureWindowsCertificates(device: WindowsPC, twin: WindowsPC): WindowsCertificateState | undefined {
  const factoryPersonal = new Set(twin.getCertStore().list().map((c) => c.serialNumber));
  const personal = device.getCertStore().entriesSnapshot()
    .filter((e) => !factoryPersonal.has(e.cert.serialNumber))
    .map((e) => entryOf(e.cert, e.privateKey));
  const factoryTrusted = new Set(twin.getTrustedCertificateAuthorities().map((c) => c.serialNumber));
  const trustedAuthorities = device.getTrustedCertificateAuthorities()
    .filter((c) => !factoryTrusted.has(c.serialNumber))
    .map(certToPem);
  const identities = device.getTlsIdentities();
  const state: WindowsCertificateState = {
    ...(personal.length > 0 ? { personal } : {}),
    ...(trustedAuthorities.length > 0 ? { trustedAuthorities } : {}),
    ...(identities.rdp ? { rdpIdentity: entryOf(identities.rdp.cert, identities.rdp.privateKey) } : {}),
    ...(identities.ldap ? { ldapIdentity: entryOf(identities.ldap.cert, identities.ldap.privateKey) } : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}

export function restoreWindowsCertificates(device: WindowsPC, saved: WindowsCertificateState): void {
  for (const entry of saved.personal ?? []) {
    const identity = identityOf(entry);
    if (!identity) continue;
    reserveCertificateSerial(identity.cert.serialNumber);
    device.getCertStore().add(identity.cert, identity.privateKey);
  }
  for (const pem of saved.trustedAuthorities ?? []) {
    const cert = pemToCert(pem);
    if (!cert) continue;
    reserveCertificateSerial(cert.serialNumber);
    device.addTrustedCertificateAuthority(cert);
  }
  const rdp = saved.rdpIdentity ? identityOf(saved.rdpIdentity) : null;
  const ldap = saved.ldapIdentity ? identityOf(saved.ldapIdentity) : null;
  for (const identity of [rdp, ldap]) if (identity) reserveCertificateSerial(identity.cert.serialNumber);
  device.restoreTlsIdentities({ ...(rdp ? { rdp } : {}), ...(ldap ? { ldap } : {}) });
}
