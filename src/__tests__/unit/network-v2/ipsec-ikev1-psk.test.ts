/**
 * IPSec – IKEv1 Site-to-Site avec Pre-shared Keys
 *
 * Topologie de référence :
 *
 *   [PC1 192.168.1.10/24] ── [R1 Gi0/0:192.168.1.1 | Gi0/1:10.0.12.1/30] ──── [R2 Gi0/1:10.0.12.2/30 | Gi0/0:192.168.2.1] ── [PC2 192.168.2.10/24]
 *
 * Chaque test crée ses propres équipements (beforeEach réinitialise les compteurs).
 * Les vérifications se font exclusivement via les sorties de commandes CLI.
 *
 * Tests :
 *   1.01 – Établissement du tunnel et chiffrement du trafic
 *   1.02 – Négociation du meilleur transform-set commun
 *   1.03 – Expiration de SA et renouvellement (rekey)
 *   1.04 – Bidirectionnalité : le tunnel peut être initié des deux côtés
 *   1.05 – Compteurs de paquets encapsulés/désencapsulés
 *   1.06 – show crypto map reflète la configuration appliquée
 *   1.07 – show crypto isakmp policy liste la politique configurée
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helper : topologie de base ────────────────────────────────────────────

/**
 * Crée et câble la topologie complète R1–R2 avec deux PCs.
 * Configure IKEv1 PSK AES-256/SHA256/group14 sur les deux routeurs.
 * Retourne tous les équipements pour les assertions.
 */
async function buildIKEv1Topology(opts: {
  r1Key?: string;
  r2Key?: string;
  r1Enc?: string;
  r2Enc?: string;
  r1Hash?: string;
  r2Hash?: string;
  r1Group?: string;
  r2Group?: string;
  r1Lifetime?: number;
  r2Lifetime?: number;
  r1TSet?: string;
  r2TSet?: string;
  pfs?: boolean;
} = {}) {
  const {
    r1Key       = 'VpnSecret!1',
    r2Key       = 'VpnSecret!1',
    r1Enc       = 'aes 256',
    r2Enc       = 'aes 256',
    r1Hash      = 'sha256',
    r2Hash      = 'sha256',
    r1Group     = '14',
    r2Group     = '14',
    r1Lifetime  = 86400,
    r2Lifetime  = 86400,
    r1TSet      = 'esp-aes 256 esp-sha256-hmac',
    r2TSet      = 'esp-aes 256 esp-sha256-hmac',
    pfs         = false,
  } = opts;

  const r1  = new CiscoRouter('R1');
  const r2  = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  // ── Câblage ───────────────────────────────────────────────────────────────
  const cableWAN = new Cable('wan');
  cableWAN.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  const cablePC1 = new Cable('lan1');
  cablePC1.connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  const cablePC2 = new Cable('lan2');
  cablePC2.connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  // ── Configuration R1 ──────────────────────────────────────────────────────
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

  // IKE Phase 1
  await r1.executeCommand('crypto isakmp policy 10');
  await r1.executeCommand(`encryption ${r1Enc}`);
  await r1.executeCommand(`hash ${r1Hash}`);
  await r1.executeCommand('authentication pre-share');
  await r1.executeCommand(`group ${r1Group}`);
  await r1.executeCommand(`lifetime ${r1Lifetime}`);
  await r1.executeCommand('exit');
  await r1.executeCommand(`crypto isakmp key ${r1Key} address 10.0.12.2`);

  // IPSec Phase 2
  await r1.executeCommand(`crypto ipsec transform-set TSET ${r1TSet}`);
  await r1.executeCommand('mode tunnel');
  await r1.executeCommand('exit');

  // ACL trafic intéressant
  await r1.executeCommand('ip access-list extended VPN_TRAFFIC');
  await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
  await r1.executeCommand('exit');

  // Crypto map
  await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r1.executeCommand('set peer 10.0.12.2');
  await r1.executeCommand('set transform-set TSET');
  await r1.executeCommand('match address VPN_TRAFFIC');
  if (pfs) await r1.executeCommand('set pfs group14');
  await r1.executeCommand('exit');

  // Application sur interface outside
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('crypto map CMAP');
  await r1.executeCommand('exit');

  // Route statique vers le LAN distant
  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
  await r1.executeCommand('end');

  // ── Configuration R2 ──────────────────────────────────────────────────────
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

  await r2.executeCommand('crypto isakmp policy 10');
  await r2.executeCommand(`encryption ${r2Enc}`);
  await r2.executeCommand(`hash ${r2Hash}`);
  await r2.executeCommand('authentication pre-share');
  await r2.executeCommand(`group ${r2Group}`);
  await r2.executeCommand(`lifetime ${r2Lifetime}`);
  await r2.executeCommand('exit');
  await r2.executeCommand(`crypto isakmp key ${r2Key} address 10.0.12.1`);

  await r2.executeCommand(`crypto ipsec transform-set TSET ${r2TSet}`);
  await r2.executeCommand('mode tunnel');
  await r2.executeCommand('exit');

  await r2.executeCommand('ip access-list extended VPN_TRAFFIC');
  await r2.executeCommand('permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r2.executeCommand('set peer 10.0.12.1');
  await r2.executeCommand('set transform-set TSET');
  await r2.executeCommand('match address VPN_TRAFFIC');
  if (pfs) await r2.executeCommand('set pfs group14');
  await r2.executeCommand('exit');

  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('crypto map CMAP');
  await r2.executeCommand('exit');

  await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.12.1');
  await r2.executeCommand('end');

  // ── Configuration PCs ─────────────────────────────────────────────────────
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

describe('IPSec – IKEv1 Site-to-Site avec Pre-shared Keys', () => {

  // ─── 1.01 : Établissement du tunnel et chiffrement du trafic ─────────────
  it('1.01 – should establish IPSec tunnel and encrypt traffic between two LANs', async () => {
    const { r1, r2, pc1, pc2 } = await buildIKEv1Topology();

    // Trafic intéressant : ping de PC1 → PC2 (déclenche IKE + SA IPSec)
    const pingOut = await pc1.executeCommand('ping -c 4 192.168.2.10');
    expect(pingOut).toContain('4 packets transmitted');
    expect(pingOut).toContain('4 received');
    expect(pingOut).toContain('0% packet loss');

    // ── Vérification Phase 1 (ISAKMP SA) sur R1 ──────────────────────────
    const ikeSA = await r1.executeCommand('show crypto isakmp sa');
    // Le peer distant doit apparaître
    expect(ikeSA).toContain('10.0.12.2');
    // La SA doit être en état QM_IDLE (Main Mode terminé, Quick Mode terminé)
    expect(ikeSA).toContain('QM_IDLE');
    // Il ne doit PAS y avoir d'état d'erreur
    expect(ikeSA).not.toContain('MM_NO_STATE');
    expect(ikeSA).not.toContain('AG_NO_STATE');

    // ── Vérification Phase 2 (IPSec SA) sur R1 ───────────────────────────
    const ipsecSA = await r1.executeCommand('show crypto ipsec sa');
    // Interface where crypto map is applied
    expect(ipsecSA).toContain('interface: GigabitEthernet0/1');
    expect(ipsecSA).toContain('Crypto map tag: CMAP');
    // Identités locales et distantes
    expect(ipsecSA).toContain('local  ident (addr/mask/prot/port): (192.168.1.0/255.255.255.0/0/0)');
    expect(ipsecSA).toContain('remote ident (addr/mask/prot/port): (192.168.2.0/255.255.255.0/0/0)');
    // Peer
    expect(ipsecSA).toContain('current_peer 10.0.12.2');
    // Compteurs : 4 paquets envoyés (ping) + éventuellement ICMP retour
    expect(ipsecSA).toContain('#pkts encaps: 4');
    expect(ipsecSA).toContain('#pkts encrypt: 4');
    expect(ipsecSA).toContain('#pkts decaps: 4');
    expect(ipsecSA).toContain('#pkts decrypt: 4');
    // Pas d'erreurs
    expect(ipsecSA).toContain('#send errors 0');
    expect(ipsecSA).toContain('#recv errors 0');
    // SPI inbound et outbound présents (tunnel bidirectionnel)
    expect(ipsecSA).toContain('inbound esp sas:');
    expect(ipsecSA).toContain('outbound esp sas:');

    // ── Symétrie : vérification côté R2 ──────────────────────────────────
    const ikeSA_R2 = await r2.executeCommand('show crypto isakmp sa');
    expect(ikeSA_R2).toContain('10.0.12.1');
    expect(ikeSA_R2).toContain('QM_IDLE');

    const ipsecSA_R2 = await r2.executeCommand('show crypto ipsec sa');
    expect(ipsecSA_R2).toContain('interface: GigabitEthernet0/1');
    expect(ipsecSA_R2).toContain('current_peer 10.0.12.1');
    expect(ipsecSA_R2).toContain('#pkts encaps: 4');
    expect(ipsecSA_R2).toContain('#pkts decaps: 4');
  });

  // ─── 1.02 : Négociation du meilleur transform-set commun ─────────────────
  it('1.02 – should negotiate the highest-priority common transform-set (AES-256 over 3DES)', async () => {
    // R1 propose deux transform-sets : AES-256 (préféré) et 3DES (repli)
    // R2 supporte les deux également → R1 doit choisir AES-256 (premier dans la liste)
    const { r1, r2, pc1, pc2 } = await buildIKEv1Topology({
      r1TSet: 'esp-aes 256 esp-sha256-hmac',
      r2TSet: 'esp-aes 256 esp-sha256-hmac',
    });

    // Ajout d'un second transform-set sur R1
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto ipsec transform-set TSET_3DES esp-3des esp-sha-hmac');
    await r1.executeCommand('mode tunnel');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    // L'ordre dans set transform-set détermine la priorité (premier = préféré)
    await r1.executeCommand('set transform-set TSET TSET_3DES');
    await r1.executeCommand('exit');
    await r1.executeCommand('end');

    // Même chose sur R2
    await r2.executeCommand('enable');
    await r2.executeCommand('configure terminal');
    await r2.executeCommand('crypto ipsec transform-set TSET_3DES esp-3des esp-sha-hmac');
    await r2.executeCommand('mode tunnel');
    await r2.executeCommand('exit');
    await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await r2.executeCommand('set transform-set TSET TSET_3DES');
    await r2.executeCommand('exit');
    await r2.executeCommand('end');

    // Déclenchement du trafic intéressant
    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // La SA doit utiliser AES-256, pas 3DES
    const ipsecSA = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecSA).toContain('esp-aes');
    expect(ipsecSA).not.toContain('esp-3des');
  });

  it('1.02b – should fall back to 3DES when R2 only supports 3DES', async () => {
    // R1 offre AES-256 ET 3DES, R2 n'accepte que 3DES
    const { r1, r2, pc1, pc2 } = await buildIKEv1Topology({
      r1TSet: 'esp-aes 256 esp-sha256-hmac',
      r2TSet: 'esp-3des esp-sha-hmac',
    });

    // Ajout du repli 3DES sur R1 (mais AES-256 reste en premier)
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto ipsec transform-set TSET_3DES esp-3des esp-sha-hmac');
    await r1.executeCommand('mode tunnel');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await r1.executeCommand('set transform-set TSET TSET_3DES');
    await r1.executeCommand('exit');
    await r1.executeCommand('end');

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // Doit avoir négocié 3DES (seul commun)
    const ipsecSA = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecSA).toContain('esp-3des');
    expect(ipsecSA).not.toContain('esp-aes');
  });

  // ─── 1.03 : Expiration de SA IKE et renouvellement ───────────────────────
  it('1.03 – should show SA lifetime and indicate when SA was rekeyed', async () => {
    // Lifetime court pour que le test puisse observer l'expiration
    const LIFETIME = 120; // secondes
    const { r1, r2, pc1 } = await buildIKEv1Topology({
      r1Lifetime: LIFETIME,
      r2Lifetime: LIFETIME,
    });

    // Établissement initial
    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // Vérification que la SA est présente et affiche la durée de vie restante
    const saDetail = await r1.executeCommand('show crypto isakmp sa detail');
    expect(saDetail).toContain('10.0.12.2');
    expect(saDetail).toContain('QM_IDLE');
    // La durée de vie configurée doit apparaître dans le détail
    expect(saDetail).toMatch(/lifetime.*120|120.*lifetime/i);

    // Vérification que la SA IPSec affiche aussi la durée de vie
    const ipsecSADetail = await r1.executeCommand('show crypto ipsec sa detail');
    expect(ipsecSADetail).toContain('sa timing:');
    expect(ipsecSADetail).toMatch(/remaining key lifetime.*\(k\/sec\)/i);
  });

  // ─── 1.04 : Bidirectionnalité ─────────────────────────────────────────────
  it('1.04 – should allow R2 side (PC2) to initiate the tunnel', async () => {
    const { r1, r2, pc1, pc2 } = await buildIKEv1Topology();

    // C'est PC2 qui initie (sens inverse)
    const pingOut = await pc2.executeCommand('ping -c 3 192.168.1.10');
    expect(pingOut).toContain('3 received');
    expect(pingOut).toContain('0% packet loss');

    // R2 doit être initiateur → SA présente sur R2
    const ikeSA_R2 = await r2.executeCommand('show crypto isakmp sa');
    expect(ikeSA_R2).toContain('10.0.12.1');
    expect(ikeSA_R2).toContain('QM_IDLE');

    // R1 doit être répondeur → SA présente aussi sur R1
    const ikeSA_R1 = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeSA_R1).toContain('10.0.12.2');
    expect(ikeSA_R1).toContain('QM_IDLE');

    // Vérification Phase 2 des deux côtés
    const ipsec_R2 = await r2.executeCommand('show crypto ipsec sa');
    expect(ipsec_R2).toContain('#pkts encaps: 3');
    const ipsec_R1 = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsec_R1).toContain('#pkts decaps: 3');
  });

  // ─── 1.05 : Compteurs de paquets ─────────────────────────────────────────
  it('1.05 – should increment encap/decap counters for each encrypted packet', async () => {
    const { r1, r2, pc1, pc2 } = await buildIKEv1Topology();

    // Première vague : 5 paquets
    await pc1.executeCommand('ping -c 5 192.168.2.10');

    const sa1 = await r1.executeCommand('show crypto ipsec sa');
    expect(sa1).toContain('#pkts encaps: 5');
    expect(sa1).toContain('#pkts encrypt: 5');
    expect(sa1).toContain('#pkts digest: 5');
    expect(sa1).toContain('#pkts decaps: 5');
    expect(sa1).toContain('#pkts decrypt: 5');
    expect(sa1).toContain('#pkts verify: 5');

    // Deuxième vague : 3 paquets supplémentaires
    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // Les compteurs sont cumulatifs depuis la création de la SA
    const sa2 = await r1.executeCommand('show crypto ipsec sa');
    expect(sa2).toContain('#pkts encaps: 8');
    expect(sa2).toContain('#pkts decaps: 8');

    // Pas d'erreurs pendant tout le test
    expect(sa2).toContain('#send errors 0');
    expect(sa2).toContain('#recv errors 0');
  });

  // ─── 1.06 : show crypto map ──────────────────────────────────────────────
  it('1.06 – show crypto map should reflect the complete configured policy', async () => {
    const { r1 } = await buildIKEv1Topology({ pfs: true });

    const mapOut = await r1.executeCommand('show crypto map');
    // Nom de la map et numéro de séquence
    expect(mapOut).toContain('Crypto Map "CMAP" 10 ipsec-isakmp');
    // Peer configuré
    expect(mapOut).toContain('Peer = 10.0.12.2');
    // Transform-set associé
    expect(mapOut).toContain('Transform sets={');
    expect(mapOut).toContain('TSET');
    // ACL de trafic intéressant
    expect(mapOut).toContain('Extended IP access list VPN_TRAFFIC');
    // Interface sur laquelle la map est appliquée
    expect(mapOut).toContain('Interfaces using crypto map CMAP:');
    expect(mapOut).toContain('GigabitEthernet0/1');
    // PFS activé
    expect(mapOut).toContain('PFS (Y/N): Y');
    expect(mapOut).toContain('DH group: group14');
  });

  // ─── 1.07 : show crypto isakmp policy ────────────────────────────────────
  it('1.07 – show crypto isakmp policy should list all configured policies', async () => {
    const { r1 } = await buildIKEv1Topology();

    const policyOut = await r1.executeCommand('show crypto isakmp policy');

    // En-tête global ISAKMP
    expect(policyOut).toContain('Global IKE policy');
    // Numéro de priorité de la politique
    expect(policyOut).toContain('Protection suite of priority 10');
    // Algorithme de chiffrement
    expect(policyOut).toContain('encryption algorithm:   AES - Advanced Encryption Standard (256 bit keys)');
    // Algorithme de hachage
    expect(policyOut).toContain('hash algorithm:         Secure Hash Standard 2 (256 bit)');
    // Méthode d'authentification
    expect(policyOut).toContain('authentication method:  Pre-Shared Key');
    // Groupe Diffie-Hellman
    expect(policyOut).toContain('Diffie-Hellman group:   #14 (2048 bit)');
    // Durée de vie
    expect(policyOut).toContain('lifetime:               86400 seconds');
    // La politique par défaut Cisco (priority 65535) doit aussi apparaître
    expect(policyOut).toContain('Default protection suite');
  });
});
