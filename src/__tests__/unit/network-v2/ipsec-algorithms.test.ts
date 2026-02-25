/**
 * IPSec – Combinaisons d'algorithmes de chiffrement et d'intégrité
 *
 * Topologie commune :
 *   [PC1 192.168.1.10/24] ── [R1 Gi0/0:192.168.1.1 | Gi0/1:10.0.12.1/30]
 *                            ──── [R2 Gi0/1:10.0.12.2/30 | Gi0/0:192.168.2.1] ── [PC2 192.168.2.10/24]
 *
 * Tests :
 *   3.01 – ESP AES-128 + SHA1
 *   3.02 – ESP AES-128 + SHA256
 *   3.03 – ESP AES-256 + SHA256 (référence)
 *   3.04 – ESP AES-256 + SHA384
 *   3.05 – ESP AES-256 + SHA512
 *   3.06 – ESP 3DES + MD5 (héritage)
 *   3.07 – ESP 3DES + SHA1 (héritage)
 *   3.08 – ESP AES-256-GCM (mode AEAD, pas de hmac séparé)
 *   3.09 – AH seul SHA256 (intégrité sans chiffrement)
 *   3.10 – ESP AES-256 + AH SHA256 (combiné)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helper générique ───────────────────────────────────────────────────────

async function buildAlgoTopology(transformSet: string) {
  const r1  = new CiscoRouter('R1');
  const r2  = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  // ── R1 ────────────────────────────────────────────────────────────────────
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

  // Politique ISAKMP identique pour tous les tests algo
  await r1.executeCommand('crypto isakmp policy 10');
  await r1.executeCommand('encryption aes 256');
  await r1.executeCommand('hash sha256');
  await r1.executeCommand('authentication pre-share');
  await r1.executeCommand('group 14');
  await r1.executeCommand('lifetime 86400');
  await r1.executeCommand('exit');
  await r1.executeCommand('crypto isakmp key AlgoTest!1 address 10.0.12.2');

  // Transform-set variable
  await r1.executeCommand(`crypto ipsec transform-set TSET ${transformSet}`);
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

  // ── R2 ────────────────────────────────────────────────────────────────────
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
  await r2.executeCommand('encryption aes 256');
  await r2.executeCommand('hash sha256');
  await r2.executeCommand('authentication pre-share');
  await r2.executeCommand('group 14');
  await r2.executeCommand('lifetime 86400');
  await r2.executeCommand('exit');
  await r2.executeCommand('crypto isakmp key AlgoTest!1 address 10.0.12.1');

  await r2.executeCommand(`crypto ipsec transform-set TSET ${transformSet}`);
  await r2.executeCommand('mode tunnel');
  await r2.executeCommand('exit');

  await r2.executeCommand('ip access-list extended VPN_ACL');
  await r2.executeCommand('permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r2.executeCommand('set peer 10.0.12.1');
  await r2.executeCommand('set transform-set TSET');
  await r2.executeCommand('match address VPN_ACL');
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

describe('IPSec – Combinaisons d\'algorithmes ESP/AH', () => {

  // ─── 3.01 : AES-128 + SHA1 ───────────────────────────────────────────────
  it('3.01 – ESP AES-128 + SHA1-HMAC should establish tunnel and pass traffic', async () => {
    const { r1, pc1, pc2 } = await buildAlgoTopology('esp-aes esp-sha-hmac');

    const ping = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(ping).toContain('3 received');
    expect(ping).toContain('0% packet loss');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    // La SA doit afficher l'algorithme AES (128-bit par défaut)
    expect(sa).toContain('esp-aes');
    expect(sa).toContain('esp-sha-hmac');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#send errors 0');

    // show crypto ipsec transform-set doit lister le set
    const tsets = await r1.executeCommand('show crypto ipsec transform-set');
    expect(tsets).toContain('TSET');
    expect(tsets).toContain('esp-aes');
    expect(tsets).toContain('esp-sha-hmac');
  });

  // ─── 3.02 : AES-128 + SHA256 ─────────────────────────────────────────────
  it('3.02 – ESP AES-128 + SHA256-HMAC should negotiate and encrypt traffic', async () => {
    const { r1, pc1 } = await buildAlgoTopology('esp-aes esp-sha256-hmac');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('esp-aes');
    expect(sa).toContain('esp-sha256-hmac');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');
  });

  // ─── 3.03 : AES-256 + SHA256 (référence) ─────────────────────────────────
  it('3.03 – ESP AES-256 + SHA256-HMAC should be the recommended algorithm combination', async () => {
    const { r1, pc1 } = await buildAlgoTopology('esp-aes 256 esp-sha256-hmac');

    await pc1.executeCommand('ping -c 4 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    // Vérification de l'algorithme AES-256
    expect(sa).toContain('esp-256-aes');
    expect(sa).toContain('esp-sha256-hmac');
    expect(sa).toContain('#pkts encaps: 4');

    // Le mode doit être Tunnel (par défaut)
    expect(sa).toContain('Tunnel');
  });

  // ─── 3.04 : AES-256 + SHA384 ─────────────────────────────────────────────
  it('3.04 – ESP AES-256 + SHA384-HMAC should establish and verify integrity', async () => {
    const { r1, pc1 } = await buildAlgoTopology('esp-aes 256 esp-sha384-hmac');

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('esp-256-aes');
    expect(sa).toContain('esp-sha384-hmac');
    expect(sa).toContain('#pkts encaps: 2');
    expect(sa).toContain('#recv errors 0');
  });

  // ─── 3.05 : AES-256 + SHA512 ─────────────────────────────────────────────
  it('3.05 – ESP AES-256 + SHA512-HMAC should establish and verify integrity', async () => {
    const { r1, pc1 } = await buildAlgoTopology('esp-aes 256 esp-sha512-hmac');

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('esp-256-aes');
    expect(sa).toContain('esp-sha512-hmac');
    expect(sa).toContain('#pkts encaps: 2');
    expect(sa).toContain('#recv errors 0');
  });

  // ─── 3.06 : 3DES + MD5 (héritage) ───────────────────────────────────────
  it('3.06 – ESP 3DES + MD5-HMAC (legacy) should still negotiate and pass traffic', async () => {
    const { r1, pc1 } = await buildAlgoTopology('esp-3des esp-md5-hmac');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('esp-3des');
    expect(sa).toContain('esp-md5-hmac');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');

    // Vérification dans show crypto ipsec transform-set
    const tsets = await r1.executeCommand('show crypto ipsec transform-set');
    expect(tsets).toContain('esp-3des');
    expect(tsets).toContain('esp-md5-hmac');
  });

  // ─── 3.07 : 3DES + SHA1 (héritage) ──────────────────────────────────────
  it('3.07 – ESP 3DES + SHA1-HMAC (legacy) should negotiate and pass traffic', async () => {
    const { r1, pc1 } = await buildAlgoTopology('esp-3des esp-sha-hmac');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('esp-3des');
    expect(sa).toContain('esp-sha-hmac');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');
  });

  // ─── 3.08 : AES-GCM-256 (AEAD – pas de HMAC séparé) ─────────────────────
  it('3.08 – ESP AES-256-GCM (AEAD) should provide combined encryption and authentication', async () => {
    // AES-GCM combine chiffrement + intégrité en un seul algorithme
    const { r1, pc1 } = await buildAlgoTopology('esp-gcm 256');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    // L'algorithme AEAD ne nécessite pas de HMAC séparé
    expect(sa).toContain('esp-gcm');
    // Pas d'algorithme HMAC séparé
    expect(sa).not.toContain('esp-sha-hmac');
    expect(sa).not.toContain('esp-md5-hmac');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');

    // Le mode doit être Tunnel
    expect(sa).toContain('Tunnel');
  });

  // ─── 3.09 : AH seul SHA256 (intégrité sans chiffrement) ─────────────────
  it('3.09 – AH-only with SHA256-HMAC should provide integrity without encryption', async () => {
    const { r1, r2, pc1 } = await buildAlgoTopology('ah-sha256-hmac');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');

    // AH protège l'intégrité mais ne chiffre PAS le contenu
    expect(sa).toContain('ah-sha256-hmac');

    // Avec AH seul, on voit les SAs AH (pas ESP)
    expect(sa).toContain('inbound ah sas:');
    expect(sa).toContain('outbound ah sas:');
    // Pas de SA ESP
    expect(sa).not.toContain('inbound esp sas:');
    expect(sa).not.toContain('outbound esp sas:');

    // SPI AH présent
    expect(sa).toMatch(/spi:.*\(ah\)/i);

    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');
  });

  // ─── 3.10 : ESP AES-256 + AH SHA256 (combiné) ───────────────────────────
  it('3.10 – ESP AES-256-GCM combined with AH SHA256 should provide both encryption and outer integrity', async () => {
    // Combinaison : ESP pour le chiffrement + AH pour l'intégrité de l'en-tête IP externe
    const { r1, pc1 } = await buildAlgoTopology('ah-sha256-hmac esp-aes 256 esp-sha256-hmac');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');

    // Les deux protocoles sont actifs
    expect(sa).toContain('inbound ah sas:');
    expect(sa).toContain('outbound ah sas:');
    expect(sa).toContain('inbound esp sas:');
    expect(sa).toContain('outbound esp sas:');

    // L'algorithme AH
    expect(sa).toContain('ah-sha256-hmac');
    // L'algorithme ESP
    expect(sa).toContain('esp-aes');

    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');
  });
});
