/**
 * IPSec – IKEv2 Site-to-Site avec Pre-shared Keys
 *
 * Topologie de référence :
 *
 *   [PC1 192.168.1.10/24] ── [R1 Gi0/0:192.168.1.1 | Gi0/1:10.0.12.1/30] ──── [R2 Gi0/1:10.0.12.2/30 | Gi0/0:192.168.2.1] ── [PC2 192.168.2.10/24]
 *
 * IKEv2 diffère d'IKEv1 par :
 *   - proposal / policy / keyring / profile au lieu de isakmp policy / key
 *   - échange initial réduit à 4 messages (IKE_SA_INIT + IKE_AUTH)
 *   - Child SA négociée dans le même échange qu'IKE_AUTH
 *   - show crypto ikev2 sa (et non isakmp sa)
 *
 * Tests :
 *   2.01 – Établissement basique IKEv2 PSK + vérification des SAs
 *   2.02 – Négociation de proposal : le premier proposal commun est sélectionné
 *   2.03 – Répondeur peut initier en sens inverse (bidirectionnel)
 *   2.04 – show crypto ikev2 sa detail expose les paramètres négociés
 *   2.05 – Compteurs encaps/decaps après trafic bidirectionnel
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helper : topologie IKEv2 complète ─────────────────────────────────────

async function buildIKEv2Topology(opts: {
  r1Enc?:  string;
  r2Enc?:  string;
  r1Int?:  string;
  r2Int?:  string;
  r1Grp?:  string;
  r2Grp?:  string;
  sharedKey?: string;
} = {}) {
  const {
    r1Enc     = 'aes-cbc-256',
    r2Enc     = 'aes-cbc-256',
    r1Int     = 'sha256',
    r2Int     = 'sha256',
    r1Grp     = '14',
    r2Grp     = '14',
    sharedKey = 'IKEv2Secret#99',
  } = opts;

  const r1  = new CiscoRouter('R1');
  const r2  = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  // ── Câblage ───────────────────────────────────────────────────────────────
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  // ══════════════════════════ R1 ════════════════════════════════════════════
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');

  // Interfaces
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.252');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');

  // IKEv2 Proposal (algorithmes de Phase 1)
  await r1.executeCommand('crypto ikev2 proposal PROP_R1');
  await r1.executeCommand(`encryption ${r1Enc}`);
  await r1.executeCommand(`integrity ${r1Int}`);
  await r1.executeCommand(`group ${r1Grp}`);
  await r1.executeCommand('exit');

  // IKEv2 Policy (sélection du proposal)
  await r1.executeCommand('crypto ikev2 policy POL_R1');
  await r1.executeCommand('proposal PROP_R1');
  await r1.executeCommand('exit');

  // IKEv2 Keyring (PSK pour le peer)
  await r1.executeCommand('crypto ikev2 keyring KR_R1');
  await r1.executeCommand('peer R2');
  await r1.executeCommand('address 10.0.12.2');
  await r1.executeCommand(`pre-shared-key ${sharedKey}`);
  await r1.executeCommand('exit');
  await r1.executeCommand('exit');

  // IKEv2 Profile (association identité ↔ clé)
  await r1.executeCommand('crypto ikev2 profile PROF_R1');
  await r1.executeCommand('match identity remote address 10.0.12.2 255.255.255.255');
  await r1.executeCommand('authentication remote pre-share');
  await r1.executeCommand('authentication local pre-share');
  await r1.executeCommand('keyring local KR_R1');
  await r1.executeCommand('exit');

  // Transform-set IPSec Phase 2
  await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r1.executeCommand('mode tunnel');
  await r1.executeCommand('exit');

  // ACL trafic intéressant
  await r1.executeCommand('ip access-list extended VPN_TRAFFIC');
  await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
  await r1.executeCommand('exit');

  // Crypto map référençant le profil IKEv2
  await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r1.executeCommand('set peer 10.0.12.2');
  await r1.executeCommand('set ikev2-profile PROF_R1');
  await r1.executeCommand('set transform-set TSET');
  await r1.executeCommand('match address VPN_TRAFFIC');
  await r1.executeCommand('exit');

  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('crypto map CMAP');
  await r1.executeCommand('exit');

  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
  await r1.executeCommand('end');

  // ══════════════════════════ R2 ════════════════════════════════════════════
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');

  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('ip address 10.0.12.2 255.255.255.252');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto ikev2 proposal PROP_R2');
  await r2.executeCommand(`encryption ${r2Enc}`);
  await r2.executeCommand(`integrity ${r2Int}`);
  await r2.executeCommand(`group ${r2Grp}`);
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto ikev2 policy POL_R2');
  await r2.executeCommand('proposal PROP_R2');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto ikev2 keyring KR_R2');
  await r2.executeCommand('peer R1');
  await r2.executeCommand('address 10.0.12.1');
  await r2.executeCommand(`pre-shared-key ${sharedKey}`);
  await r2.executeCommand('exit');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto ikev2 profile PROF_R2');
  await r2.executeCommand('match identity remote address 10.0.12.1 255.255.255.255');
  await r2.executeCommand('authentication remote pre-share');
  await r2.executeCommand('authentication local pre-share');
  await r2.executeCommand('keyring local KR_R2');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r2.executeCommand('mode tunnel');
  await r2.executeCommand('exit');

  await r2.executeCommand('ip access-list extended VPN_TRAFFIC');
  await r2.executeCommand('permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r2.executeCommand('set peer 10.0.12.1');
  await r2.executeCommand('set ikev2-profile PROF_R2');
  await r2.executeCommand('set transform-set TSET');
  await r2.executeCommand('match address VPN_TRAFFIC');
  await r2.executeCommand('exit');

  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('crypto map CMAP');
  await r2.executeCommand('exit');

  await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.12.1');
  await r2.executeCommand('end');

  // ── PCs ───────────────────────────────────────────────────────────────────
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2 };
}

// ─── Suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('IPSec – IKEv2 Site-to-Site avec Pre-shared Keys', () => {

  // ─── 2.01 : Établissement basique ────────────────────────────────────────
  it('2.01 – should establish IKEv2 SA and child SA, traffic flows encrypted', async () => {
    const { r1, r2, pc1, pc2 } = await buildIKEv2Topology();

    // Trafic intéressant → déclenche IKE_SA_INIT + IKE_AUTH + CREATE_CHILD_SA
    const pingOut = await pc1.executeCommand('ping -c 4 192.168.2.10');
    expect(pingOut).toContain('4 packets transmitted');
    expect(pingOut).toContain('4 received');
    expect(pingOut).toContain('0% packet loss');

    // ── IKEv2 SA sur R1 ──────────────────────────────────────────────────
    const ikev2SA = await r1.executeCommand('show crypto ikev2 sa');
    expect(ikev2SA).toContain('10.0.12.1');   // adresse locale
    expect(ikev2SA).toContain('10.0.12.2');   // adresse distante
    // Statut : READY indique que l'IKE SA est opérationnelle
    expect(ikev2SA).toContain('READY');
    // Rôle initiateur ou répondeur doit être présent
    expect(ikev2SA).toMatch(/Initiator|Responder/i);

    // ── Child SA (IPSec SA) sur R1 ────────────────────────────────────────
    const ipsecSA = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecSA).toContain('interface: GigabitEthernet0/1');
    expect(ipsecSA).toContain('Crypto map tag: CMAP');
    expect(ipsecSA).toContain('local  ident (addr/mask/prot/port): (192.168.1.0/255.255.255.0/0/0)');
    expect(ipsecSA).toContain('remote ident (addr/mask/prot/port): (192.168.2.0/255.255.255.0/0/0)');
    expect(ipsecSA).toContain('current_peer 10.0.12.2');
    expect(ipsecSA).toContain('#pkts encaps: 4');
    expect(ipsecSA).toContain('#pkts encrypt: 4');
    expect(ipsecSA).toContain('#pkts decaps: 4');
    expect(ipsecSA).toContain('#pkts decrypt: 4');
    expect(ipsecSA).toContain('#send errors 0');
    expect(ipsecSA).toContain('#recv errors 0');
    // L'algorithme utilisé (AES-256 + SHA256) doit apparaître dans les SAs ESP
    expect(ipsecSA).toContain('esp-aes');
    expect(ipsecSA).toContain('inbound esp sas:');
    expect(ipsecSA).toContain('outbound esp sas:');

    // ── Symétrie côté R2 ─────────────────────────────────────────────────
    const ikev2SA_R2 = await r2.executeCommand('show crypto ikev2 sa');
    expect(ikev2SA_R2).toContain('10.0.12.2');
    expect(ikev2SA_R2).toContain('10.0.12.1');
    expect(ikev2SA_R2).toContain('READY');

    const ipsecSA_R2 = await r2.executeCommand('show crypto ipsec sa');
    expect(ipsecSA_R2).toContain('#pkts encaps: 4');
    expect(ipsecSA_R2).toContain('#pkts decaps: 4');
  });

  // ─── 2.02 : Négociation de proposal ──────────────────────────────────────
  it('2.02 – should select the first common IKEv2 proposal (AES-256 preferred over AES-128)', async () => {
    // R1 propose d'abord AES-256, R2 accepte les deux → AES-256 doit être choisi
    const { r1, r2, pc1 } = await buildIKEv2Topology({
      r1Enc: 'aes-cbc-256',
      r2Enc: 'aes-cbc-256',
    });

    // Ajout d'un proposal AES-128 moins prioritaire sur les deux routeurs
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto ikev2 proposal PROP_AES128');
    await r1.executeCommand('encryption aes-cbc-128');
    await r1.executeCommand('integrity sha256');
    await r1.executeCommand('group 14');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto ikev2 policy POL_R1');
    // PROP_R1 (AES-256) listé en premier = priorité plus haute
    await r1.executeCommand('proposal PROP_R1 PROP_AES128');
    await r1.executeCommand('exit');
    await r1.executeCommand('end');

    await r2.executeCommand('enable');
    await r2.executeCommand('configure terminal');
    await r2.executeCommand('crypto ikev2 proposal PROP_AES128');
    await r2.executeCommand('encryption aes-cbc-128');
    await r2.executeCommand('integrity sha256');
    await r2.executeCommand('group 14');
    await r2.executeCommand('exit');
    await r2.executeCommand('crypto ikev2 policy POL_R2');
    await r2.executeCommand('proposal PROP_R2 PROP_AES128');
    await r2.executeCommand('exit');
    await r2.executeCommand('end');

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    const detail = await r1.executeCommand('show crypto ikev2 sa detail');
    // La SA IKEv2 doit afficher AES-256 comme algorithme de chiffrement
    expect(detail).toContain('AES-CBC-256');
    expect(detail).not.toContain('AES-CBC-128');
  });

  // ─── 2.03 : Bidirectionnel – répondeur initie ────────────────────────────
  it('2.03 – should allow the responder side (PC2) to initiate the IKEv2 tunnel', async () => {
    const { r1, r2, pc1, pc2 } = await buildIKEv2Topology();

    // PC2 initie → R2 devient initiateur IKEv2
    const pingOut = await pc2.executeCommand('ping -c 3 192.168.1.10');
    expect(pingOut).toContain('3 received');
    expect(pingOut).toContain('0% packet loss');

    const ikev2SA_R2 = await r2.executeCommand('show crypto ikev2 sa');
    expect(ikev2SA_R2).toContain('READY');
    // R2 doit être marqué comme Initiator dans cette SA
    expect(ikev2SA_R2).toContain('Initiator');

    const ikev2SA_R1 = await r1.executeCommand('show crypto ikev2 sa');
    expect(ikev2SA_R1).toContain('READY');
    // R1 est le Responder
    expect(ikev2SA_R1).toContain('Responder');

    // Les child SAs (IPSec) doivent être présentes des deux côtés
    const ipsec_R2 = await r2.executeCommand('show crypto ipsec sa');
    expect(ipsec_R2).toContain('#pkts encaps: 3');
    const ipsec_R1 = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsec_R1).toContain('#pkts decaps: 3');
  });

  // ─── 2.04 : show crypto ikev2 sa detail ──────────────────────────────────
  it('2.04 – show crypto ikev2 sa detail should expose negotiated algorithms and SPI', async () => {
    const { r1, pc1 } = await buildIKEv2Topology();

    await pc1.executeCommand('ping -c 1 192.168.2.10');

    const detail = await r1.executeCommand('show crypto ikev2 sa detail');

    // Informations sur la SA IKEv2
    expect(detail).toContain('IKEv2 SA');
    expect(detail).toContain('10.0.12.1');
    expect(detail).toContain('10.0.12.2');
    expect(detail).toContain('READY');

    // Algorithmes négociés
    expect(detail).toContain('AES-CBC-256');
    expect(detail).toContain('SHA256');
    // Groupe DH
    expect(detail).toContain('DH group 14');

    // Méthode d'authentification
    expect(detail).toContain('pre-share');

    // Présence des SPIs IKEv2 (initiator SPI et responder SPI, 8 octets chacun)
    expect(detail).toMatch(/Local SPI\s*:.*[0-9A-Fa-f]{16}/);
    expect(detail).toMatch(/Remote SPI\s*:.*[0-9A-Fa-f]{16}/);

    // Nombre de child SAs associées
    expect(detail).toMatch(/Child SA.*count.*1|1.*child/i);
  });

  // ─── 2.05 : Compteurs trafic bidirectionnel ───────────────────────────────
  it('2.05 – should track encap/decap counters independently for each direction', async () => {
    const { r1, r2, pc1, pc2 } = await buildIKEv2Topology();

    // 6 paquets de PC1 → PC2
    await pc1.executeCommand('ping -c 6 192.168.2.10');
    // 3 paquets de PC2 → PC1
    await pc2.executeCommand('ping -c 3 192.168.1.10');

    // R1 : 6 envoyés depuis son LAN + 3 reçus depuis l'autre côté
    //       (les replies ICMP du premier ping s'ajoutent aux 3 du second)
    const sa_R1 = await r1.executeCommand('show crypto ipsec sa');
    // Encaps = 6 (pings de PC1 → PC2) + les éventuels ICMP reply de R2 pour le ping de PC2
    expect(sa_R1).toContain('#pkts encaps: 6');
    expect(sa_R1).toContain('#pkts decaps: 6'); // replies du premier ping + 3 pings initiés par PC2

    // R2 : symétrique
    const sa_R2 = await r2.executeCommand('show crypto ipsec sa');
    expect(sa_R2).toContain('#pkts encaps: 6');
    expect(sa_R2).toContain('#pkts decaps: 6');

    // Zéro erreur dans les deux sens
    expect(sa_R1).toContain('#send errors 0');
    expect(sa_R1).toContain('#recv errors 0');
    expect(sa_R2).toContain('#send errors 0');
    expect(sa_R2).toContain('#recv errors 0');
  });
});
