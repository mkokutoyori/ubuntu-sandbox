/**
 * `CiscoRouter.installIkeCertAuth` construisait son CertificateVerifier sans horloge (donc sur l'heure globale du
 * simulateur) quand l'appelant n'en donnait pas, ce que font `crypto pki import` et l'enrolement de CiscoIOSShell : un
 * routeur dont `clock set` avait avance de deux ans validait toujours le certificat d'un an de son pair IKE. L'inspection SSL
 * du pare-feu (SslDeepInspection) avait le meme defaut en amont du serveur. Corrige : le verificateur du routeur lit
 * `getSystemClockMs()` du routeur, celui de l'inspection `TcpStack.nowMs` du pare-feu.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (routeur en avance de deux ans). Le TEMOIN (a
 * l'heure, le certificat est valide) passe des deux cotes. L'inspection SSL du pare-feu n'a PAS de sonde discriminante : sa
 * ligne `clock: () => tcp().nowMs()` n'est couverte que par les lots new_firewall, qui passent avant et apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { simulationNowMs } from '@/network/core/SystemClock';

const TWO_YEARS = 2 * 365 * 24 * 3600 * 1000;

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

function lab() {
  const now = simulationNowMs();
  const ca = CertificateAuthority.generate('CN=lab-ca', { now });
  const issued = ca.issueCertificate({ subject: 'CN=peer', notBefore: now - 1000, notAfter: now + 365 * 24 * 3600 * 1000 });
  const router = new CiscoRouter('R1');
  router.installIkeCertAuth({ localCert: issued.cert, localKey: issued.privateKey, trustAnchors: [ca.rootCertificate] });
  const engine = router._getOrCreateIPSecEngine() as unknown as { ikeCertAuth: { verifier: { verify(cert: unknown): { ok: boolean; reason?: string } } } };
  return { router, issued, verify: () => engine.ikeCertAuth.verifier.verify(issued.cert) };
}

describe('IKE : le routeur verifie les certificats sur sa propre horloge', () => {
  it('TEMOIN — a l heure, le certificat d un an est valide', () => {
    expect(lab().verify().ok).toBe(true);
  });

  it('un routeur avance de deux ans refuse ce certificat', () => {
    const { router, verify } = lab();
    router._stepSystemClock(TWO_YEARS);
    expect(verify()).toEqual({ ok: false, reason: 'expired' });
  });
});
