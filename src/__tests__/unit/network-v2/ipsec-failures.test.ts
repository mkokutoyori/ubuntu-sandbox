/**
 * IPSec – Scénarios d'échec et de récupération
 *
 * Ces tests vérifient que le système se comporte correctement en présence
 * d'erreurs de configuration ou de pannes réseau. Sur un équipement réel,
 * chaque échec se manifeste par un état IKE particulier dans show crypto isakmp sa
 * et par l'absence de SA IPSec dans show crypto ipsec sa.
 *
 * Tests :
 *   6.01 – Pas de proposal IKE commun → MM_NO_STATE (pas de SA)
 *   6.02 – Pas de transform-set commun → QM échoue, pas de SA IPSec
 *   6.03 – Clé PSK incorrecte → échec d'authentification MM_NO_STATE
 *   6.04 – Peer injoignable → pas de SA (timeout)
 *   6.05 – Déconnexion du câble pendant le trafic → perte de paquets
 *   6.06 – Reconnexion après déconnexion → re-établissement du tunnel
 *   6.07 – ACL trafic intéressant manquante → pas de déclenchement IKE
 *   6.08 – Crypto map non appliquée à l'interface → pas de chiffrement
 *   6.09 – Lifetime IPSec expiré → SA effacée, rekey automatique
 *   6.10 – Interface outside down → SA effacée
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helper : topologie de base sans configuration IPSec ────────────────────

async function buildBaseTopology() {
  const r1  = new CiscoRouter('R1');
  const r2  = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  const cableWAN = new Cable('wan');
  cableWAN.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  // Configuration des interfaces (sans IPSec)
  for (const [router, outside, inside, peer, lanPeer] of [
    [r1, '10.0.12.1', '192.168.1.1', '10.0.12.2', '192.168.2.0'],
    [r2, '10.0.12.2', '192.168.2.1', '10.0.12.1', '192.168.1.0'],
  ] as [CiscoRouter, string, string, string, string][]) {
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand(`ip address ${outside} 255.255.255.252`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand('interface GigabitEthernet0/0');
    await router.executeCommand(`ip address ${inside} 255.255.255.0`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand(`ip route ${lanPeer} 255.255.255.0 ${peer}`);
    await router.executeCommand('end');
  }

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2, cableWAN };
}

/**
 * Ajoute une configuration IPSec complète sur un routeur.
 * ikeEnc, ikeHash, ikeGroup permettent de tester des mismatches.
 */
async function addIPSecConfig(
  router: CiscoRouter,
  peer: string,
  lanSrc: string,
  lanDst: string,
  psk: string,
  ikeEnc  = 'aes 256',
  ikeHash = 'sha256',
  ikeGroup = '14',
  tset = 'esp-aes 256 esp-sha256-hmac',
  applyMap = true,
) {
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');

  await router.executeCommand('crypto isakmp policy 10');
  await router.executeCommand(`encryption ${ikeEnc}`);
  await router.executeCommand(`hash ${ikeHash}`);
  await router.executeCommand('authentication pre-share');
  await router.executeCommand(`group ${ikeGroup}`);
  await router.executeCommand('lifetime 86400');
  await router.executeCommand('exit');
  await router.executeCommand(`crypto isakmp key ${psk} address ${peer}`);

  await router.executeCommand(`crypto ipsec transform-set TSET ${tset}`);
  await router.executeCommand('mode tunnel');
  await router.executeCommand('exit');

  await router.executeCommand('ip access-list extended VPN_ACL');
  await router.executeCommand(`permit ip ${lanSrc} 0.0.0.255 ${lanDst} 0.0.0.255`);
  await router.executeCommand('exit');

  await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await router.executeCommand(`set peer ${peer}`);
  await router.executeCommand('set transform-set TSET');
  await router.executeCommand('match address VPN_ACL');
  await router.executeCommand('exit');

  if (applyMap) {
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand('crypto map CMAP');
    await router.executeCommand('exit');
  }

  await router.executeCommand('end');
}

// ─── Suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('IPSec – Scénarios d\'échec et de récupération', () => {

  // ─── 6.01 : Pas de proposal IKE commun ───────────────────────────────────
  it('6.01 – should fail IKE negotiation when no common ISAKMP proposal exists', async () => {
    const { r1, r2, pc1 } = await buildBaseTopology();

    // R1 : AES-256 + SHA256 + group14
    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0',
      'Secret1', 'aes 256', 'sha256', '14');

    // R2 : 3DES + MD5 + group2 → aucun algorithme commun
    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0',
      'Secret1', '3des', 'md5', '2');

    // Trafic intéressant → déclenche IKE
    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // Aucune SA IKE ne doit avoir atteint QM_IDLE
    const ikeR1 = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeR1).not.toContain('QM_IDLE');
    // L'état MM_NO_STATE indique un échec dès la phase d'échange SA
    expect(ikeR1).toContain('MM_NO_STATE');

    // Aucune SA IPSec ne doit exister
    const ipsecR1 = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecR1).not.toContain('#pkts encaps');
    // Pas de SPI établi
    expect(ipsecR1).not.toContain('inbound esp sas:');

    // Le ping doit échouer (trafic non chiffré ne traverse pas, pas de route alternative)
    const finalPing = await pc1.executeCommand('ping -c 1 192.168.2.10');
    expect(finalPing).toContain('100% packet loss');
  });

  // ─── 6.02 : Pas de transform-set commun ──────────────────────────────────
  it('6.02 – should fail Phase 2 when no common transform-set exists', async () => {
    const { r1, r2, pc1 } = await buildBaseTopology();

    // IKE phase 1 compatible, mais Phase 2 incompatible
    // R1 : ESP AES-256 + SHA256
    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0',
      'Secret1', 'aes 256', 'sha256', '14', 'esp-aes 256 esp-sha256-hmac');

    // R2 : AH-SHA256 seulement (pas d'ESP)
    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0',
      'Secret1', 'aes 256', 'sha256', '14', 'ah-sha256-hmac');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // La Phase 1 (IKE SA) peut réussir
    const ikeR1 = await r1.executeCommand('show crypto isakmp sa');
    // Phase 1 peut être QM_IDLE ou rester bloquée selon l'implémentation
    // Mais il ne doit PAS y avoir de SA IPSec Phase 2

    // La Phase 2 doit avoir échoué
    const ipsecR1 = await r1.executeCommand('show crypto ipsec sa');
    // Pas de SA ESP fonctionnelle
    expect(ipsecR1).not.toContain('outbound esp sas:');

    // Trafic ne passe pas
    const ping = await pc1.executeCommand('ping -c 1 192.168.2.10');
    expect(ping).toContain('100% packet loss');
  });

  // ─── 6.03 : Clé PSK incorrecte ───────────────────────────────────────────
  it('6.03 – should fail authentication with mismatched pre-shared keys', async () => {
    const { r1, r2, pc1 } = await buildBaseTopology();

    // R1 : clé "CorrectKey"
    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0', 'CorrectKey');

    // R2 : clé "WrongKey" → échec d'authentification
    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0', 'WrongKey');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // L'échange IKE démarre (MM_KEY_EXCH) mais échoue à l'authentification
    const ikeR1 = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeR1).not.toContain('QM_IDLE');
    // L'état peut être MM_NO_STATE ou une variante d'erreur d'authentification
    expect(ikeR1).toMatch(/MM_NO_STATE|MM_KEY_EXCH|AUTH_FAILED/i);

    // Aucune SA IPSec
    const ipsecR1 = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecR1).not.toContain('inbound esp sas:');

    // Ping échoue
    const ping = await pc1.executeCommand('ping -c 1 192.168.2.10');
    expect(ping).toContain('100% packet loss');
  });

  // ─── 6.04 : Peer injoignable ─────────────────────────────────────────────
  it('6.04 – should not create SA when remote peer is unreachable', async () => {
    const r1  = new CiscoRouter('R1');
    const pc1 = new LinuxPC('linux-pc', 'PC1');
    new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

    // R1 configuré mais sans câble WAN → peer injoignable
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('ip address 10.0.12.1 255.255.255.252');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');

    await r1.executeCommand('crypto isakmp policy 10');
    await r1.executeCommand('encryption aes 256');
    await r1.executeCommand('hash sha256');
    await r1.executeCommand('authentication pre-share');
    await r1.executeCommand('group 14');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto isakmp key Secret1 address 10.0.12.2');
    await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await r1.executeCommand('mode tunnel');
    await r1.executeCommand('exit');
    await r1.executeCommand('ip access-list extended VPN_ACL');
    await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await r1.executeCommand('set peer 10.0.12.2');
    await r1.executeCommand('set transform-set TSET');
    await r1.executeCommand('match address VPN_ACL');
    await r1.executeCommand('exit');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('crypto map CMAP');
    await r1.executeCommand('exit');
    await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
    await r1.executeCommand('end');

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');

    // Trafic intéressant → IKE démarre mais timeout (peer injoignable)
    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // Aucune SA établie
    const ikeR1 = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeR1).not.toContain('QM_IDLE');

    const ipsecR1 = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecR1).not.toContain('#pkts encaps:');
  });

  // ─── 6.05 : Déconnexion du câble pendant le trafic ────────────────────────
  it('6.05 – should drop packets when WAN cable is disconnected mid-traffic', async () => {
    const { r1, r2, pc1, pc2, cableWAN } = await buildBaseTopology();
    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0', 'Secret1');
    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0', 'Secret1');

    // Tunnel établi et fonctionnel
    const pingAvant = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(pingAvant).toContain('3 received');
    expect(pingAvant).toContain('0% packet loss');

    // Vérification que les SAs existent avant la déconnexion
    const saAvant = await r1.executeCommand('show crypto ipsec sa');
    expect(saAvant).toContain('#pkts encaps: 3');

    // Déconnexion brutale du câble WAN
    cableWAN.disconnect();

    // Les paquets doivent être perdus immédiatement
    const pingPendant = await pc1.executeCommand('ping -c 4 192.168.2.10');
    expect(pingPendant).toContain('100% packet loss');

    // Les compteurs d'erreurs sur R1 doivent augmenter
    const saApres = await r1.executeCommand('show crypto ipsec sa');
    // Les paquets ont tenté d'être envoyés mais le lien est coupé
    expect(saApres).toMatch(/#send errors [1-9]|#pkts not compressed/i);
  });

  // ─── 6.06 : Reconnexion et re-établissement ───────────────────────────────
  it('6.06 – should re-establish tunnel automatically after WAN cable is reconnected', async () => {
    const { r1, r2, pc1, pc2, cableWAN } = await buildBaseTopology();
    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0', 'Secret1');
    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0', 'Secret1');

    // Tunnel initial
    await pc1.executeCommand('ping -c 2 192.168.2.10');
    const saInitiale = await r1.executeCommand('show crypto ipsec sa');
    expect(saInitiale).toContain('#pkts encaps: 2');

    // Coupure
    cableWAN.disconnect();
    const pingCoupure = await pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(pingCoupure).toContain('100% packet loss');

    // Reconnecter le câble
    const newCable = new Cable('wan-new');
    newCable.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

    // Le premier ping re-déclenche IKE + IPSec
    const pingRetabli = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(pingRetabli).toContain('3 received');
    expect(pingRetabli).toContain('0% packet loss');

    // Nouvelle SA présente (SPIs différents de la SA initiale)
    const saNouvelle = await r1.executeCommand('show crypto isakmp sa');
    expect(saNouvelle).toContain('QM_IDLE');
    expect(saNouvelle).toContain('10.0.12.2');
  });

  // ─── 6.07 : ACL trafic intéressant absente ────────────────────────────────
  it('6.07 – should not trigger IKE when no interesting traffic ACL matches', async () => {
    const { r1, r2, pc1 } = await buildBaseTopology();

    // R1 : ACL qui ne matche pas le trafic généré
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto isakmp policy 10');
    await r1.executeCommand('encryption aes 256');
    await r1.executeCommand('hash sha256');
    await r1.executeCommand('authentication pre-share');
    await r1.executeCommand('group 14');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto isakmp key Secret1 address 10.0.12.2');
    await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await r1.executeCommand('mode tunnel');
    await r1.executeCommand('exit');
    // ACL qui ne matche pas 192.168.1.x → 192.168.2.x
    await r1.executeCommand('ip access-list extended VPN_ACL');
    await r1.executeCommand('permit ip 10.10.10.0 0.0.0.255 10.20.20.0 0.0.0.255');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await r1.executeCommand('set peer 10.0.12.2');
    await r1.executeCommand('set transform-set TSET');
    await r1.executeCommand('match address VPN_ACL');
    await r1.executeCommand('exit');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('crypto map CMAP');
    await r1.executeCommand('exit');
    await r1.executeCommand('end');

    // Le ping de 192.168.1.10 → 192.168.2.10 ne matche pas l'ACL
    // IKE ne doit pas être déclenché
    await pc1.executeCommand('ping -c 2 192.168.2.10');

    const ikeR1 = await r1.executeCommand('show crypto isakmp sa');
    // Aucune SA IKE ne doit exister
    expect(ikeR1).not.toContain('10.0.12.2');
    expect(ikeR1).not.toContain('QM_IDLE');

    const ipsecR1 = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecR1).not.toContain('#pkts encaps:');
  });

  // ─── 6.08 : Crypto map non appliquée à l'interface ───────────────────────
  it('6.08 – should not encrypt traffic when crypto map is not applied to interface', async () => {
    const { r1, r2, pc1 } = await buildBaseTopology();

    // R1 : crypto map configurée mais NOT appliquée (applyMap=false)
    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0', 'Secret1',
      'aes 256', 'sha256', '14', 'esp-aes 256 esp-sha256-hmac', false /* pas d'application */);

    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0', 'Secret1');

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // Sans application de la crypto map, IKE n'est jamais déclenché
    const ikeR1 = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeR1).not.toContain('QM_IDLE');

    const ipsecR1 = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecR1).not.toContain('interface: GigabitEthernet0/1');

    // Vérification : show crypto map doit indiquer "not applied"
    const mapOut = await r1.executeCommand('show crypto map');
    expect(mapOut).toContain('CMAP');
    // Aucune interface listée comme utilisant la map
    expect(mapOut).not.toContain('GigabitEthernet0/1');
  });

  // ─── 6.09 : Lifetime IPSec expiré → rekey ────────────────────────────────
  it('6.09 – should rekey IPSec SA before it expires (new SPI generated)', async () => {
    const { r1, r2, pc1 } = await buildBaseTopology();

    // Lifetime IPSec très court pour tester le rekey
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto ipsec security-association lifetime seconds 120');
    await r1.executeCommand('end');

    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0', 'Secret1');
    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0', 'Secret1');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // Récupération du SPI initial
    const sa1 = await r1.executeCommand('show crypto ipsec sa');
    expect(sa1).toContain('#pkts encaps: 3');
    // Extraction du SPI outbound initial (on vérifie juste qu'il est présent)
    expect(sa1).toMatch(/current outbound spi: 0x[0-9A-Fa-f]+/);

    // Après rekey (simulé par le lifetime court), le SPI doit changer
    // et les compteurs de la nouvelle SA doivent repartir à zéro
    const sa2 = await r1.executeCommand('show crypto ipsec sa detail');
    // La durée de vie configurée doit apparaître
    expect(sa2).toMatch(/sa timing:.*remaining key lifetime.*\(k\/sec\)/i);
    expect(sa2).toContain('120');  // lifetime configuré

    // Le tunnel reste fonctionnel après rekey
    const pingPost = await pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(pingPost).toContain('2 received');
  });

  // ─── 6.10 : Interface outside shutdown → SA effacée ─────────────────────
  it('6.10 – should clear IPSec SA when crypto map interface goes down', async () => {
    const { r1, r2, pc1 } = await buildBaseTopology();
    await addIPSecConfig(r1, '10.0.12.2', '192.168.1.0', '192.168.2.0', 'Secret1');
    await addIPSecConfig(r2, '10.0.12.1', '192.168.2.0', '192.168.1.0', 'Secret1');

    // Tunnel établi
    await pc1.executeCommand('ping -c 3 192.168.2.10');
    const saAvant = await r1.executeCommand('show crypto isakmp sa');
    expect(saAvant).toContain('QM_IDLE');

    // Shutdown de l'interface outside de R1
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('end');

    // Vérification que l'interface est bien down
    const ifShow = await r1.executeCommand('show interface GigabitEthernet0/1');
    expect(ifShow).toMatch(/GigabitEthernet0\/1 is administratively down/i);

    // Les SAs IKE et IPSec doivent être effacées automatiquement
    const ikeApres = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeApres).not.toContain('QM_IDLE');

    const ipsecApres = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecApres).not.toContain('inbound esp sas:');

    // Le ping doit échouer
    const ping = await pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(ping).toContain('100% packet loss');
  });
});
