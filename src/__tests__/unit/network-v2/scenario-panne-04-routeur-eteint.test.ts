/**
 * Scénario 4 — Extinction du routeur : perte de l'accès inter-VLAN et à
 * Internet.
 *
 * Transcription littérale : RTR-MANDENG-01 assure le routage entre le
 * VLAN 10 (192.168.10.0/24) et le VLAN 20 (192.168.20.0/24). Son
 * extinction laisse l'intra-VLAN intact (le switch suffit) mais coupe
 * l'inter-VLAN et Internet. La matrice de connectivité du scénario est
 * transcrite en script fichier (`/tmp/matrice-connectivite.sh`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { pingOnSimulatedClock, isPingStep } from '../../support/fastPing';

describe('Scénario 4 — extinction du routeur RTR-MANDENG-01', () => {
  const LONG = 30_000;
  let rtr: CiscoRouter;
  let sw10: CiscoSwitch;
  let sw20: CiscoSwitch;
  let pc1: LinuxPC;  // VLAN 10 — 192.168.10.101
  let pc2: LinuxPC;  // VLAN 10 — 192.168.10.102
  let srv: LinuxPC;  // VLAN 20 — 192.168.20.101

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    rtr.powerOn();
    sw10 = new CiscoSwitch('switch-cisco', 'SW-VLAN10', 8);
    sw20 = new CiscoSwitch('switch-cisco', 'SW-VLAN20', 8);
    sw10.powerOn();
    sw20.powerOn();

    const [g0, g1] = rtr.getPortNames();
    new Cable('rtr-sw10').connect(rtr.getPort(g0)!, sw10.getPort('FastEthernet0/8')!);
    new Cable('rtr-sw20').connect(rtr.getPort(g1)!, sw20.getPort('FastEthernet0/8')!);

    await rtr.executeCommand('enable');
    await rtr.executeCommand('configure terminal');
    await rtr.executeCommand(`interface ${g0}`);
    await rtr.executeCommand('ip address 192.168.10.254 255.255.255.0');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('exit');
    await rtr.executeCommand(`interface ${g1}`);
    await rtr.executeCommand('ip address 192.168.20.254 255.255.255.0');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('end');

    pc1 = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc2 = new LinuxPC('linux-pc', 'pc-linux-2', 0, 0);
    srv = new LinuxPC('linux-pc', 'srv-oracle', 0, 0);
    for (const pc of [pc1, pc2, srv]) pc.powerOn();

    new Cable('lien-pc1').connect(sw10.getPort('FastEthernet0/1')!, pc1.getPort('eth0')!);
    new Cable('lien-pc2').connect(sw10.getPort('FastEthernet0/2')!, pc2.getPort('eth0')!);
    new Cable('lien-srv').connect(sw20.getPort('FastEthernet0/1')!, srv.getPort('eth0')!);

    await pc1.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');
    await pc2.executeCommand('sudo ip addr add 192.168.10.102/24 dev eth0');
    await srv.executeCommand('sudo ip addr add 192.168.20.101/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.10.254');
    await srv.executeCommand('sudo ip route add default via 192.168.20.254');

    await installMatrice();
  });

  const run = (cmd: string): Promise<string> => (isPingStep(cmd)
    ? pingOnSimulatedClock(pc1, cmd)
    : Promise.resolve(pc1.executeCommand(cmd)));

  /**
   * Matrice de connectivité du scénario : chaque ligne « cible|attendu|
   * description » est évaluée et confrontée au résultat attendu.
   */
  async function installMatrice(): Promise<void> {
    await run(`cat << 'MATRICE' > /tmp/matrice-connectivite.sh
#!/bin/bash
set -uo pipefail
# Chaque entree : IP|ATTENDU|DESCRIPTION
TESTS="192.168.10.102|OK|Intra-VLAN 10
192.168.20.101|FAIL|Inter-VLAN 10 vers 20
192.168.10.254|FAIL|Passerelle routeur"

CONFORMES=0
INATTENDUS=0

echo "$TESTS" | while IFS='|' read -r IP ATTENDU DESC; do
  if ping -c 1 -W 1 "$IP" > /dev/null 2>&1; then
    STATUT="OK"
  else
    STATUT="FAIL"
  fi
  if [ "$STATUT" = "$ATTENDU" ]; then
    echo "CONFORME $DESC ($IP): $STATUT"
  else
    echo "INATTENDU $DESC ($IP): $STATUT au lieu de $ATTENDU"
  fi
done
MATRICE
chmod +x /tmp/matrice-connectivite.sh`);
  }

  describe('état nominal — le routeur assure l\'inter-VLAN', () => {
    it('l\'intra-VLAN et l\'inter-VLAN fonctionnent tant que le routeur est allumé', async () => {
      expect(await run('ping -c 2 192.168.10.102')).toContain('0% packet loss');
      expect(await run('ping -c 2 192.168.10.254')).toContain('0% packet loss');
      expect(await run('ping -c 2 192.168.20.101')).toContain('0% packet loss');
    }, LONG);
  });

  describe('effets immédiats de l\'extinction du routeur', () => {
    it('la communication intra-VLAN reste fonctionnelle (le switch suffit)', async () => {
      rtr.powerOff();
      expect(await run('ping -c 2 192.168.10.102')).toContain('0% packet loss');
    }, LONG);

    it('la passerelle ne répond plus', async () => {
      rtr.powerOff();
      expect(await run('ping -c 2 192.168.10.254')).toContain('100% packet loss');
    }, LONG);

    it('la communication inter-VLAN est interrompue', async () => {
      rtr.powerOff();
      expect(await run('ping -c 2 192.168.20.101')).toContain('100% packet loss');
    }, LONG);

    it('la route par défaut existe TOUJOURS dans la table Linux', async () => {
      rtr.powerOff();
      const routes = await run('ip route show');
      expect(routes).toContain('default via 192.168.10.254');
      expect(routes).toContain('192.168.10.0/24');
    });

    it('l\'accès Internet est interrompu', async () => {
      rtr.powerOff();
      expect(await run('ping -c 2 8.8.8.8')).toContain('100% packet loss');
    }, LONG);
  });

  describe('matrice de connectivité post-panne (script fichier)', () => {
    it('les trois lignes de la matrice sont conformes aux attentes après extinction', async () => {
      rtr.powerOff();
      const out = await run('bash /tmp/matrice-connectivite.sh');

      expect(out).toContain('CONFORME Intra-VLAN 10 (192.168.10.102): OK');
      expect(out).toContain('CONFORME Inter-VLAN 10 vers 20 (192.168.20.101): FAIL');
      expect(out).toContain('CONFORME Passerelle routeur (192.168.10.254): FAIL');
      expect(out).not.toContain('INATTENDU');
    }, LONG);
  });

  describe('reprise après redémarrage du routeur', () => {
    it('toutes les communications sont rétablies', async () => {
      rtr.powerOff();
      expect(await run('ping -c 1 192.168.20.101')).toContain('100% packet loss');

      rtr.powerOn();

      expect(await run('ping -c 2 192.168.10.254')).toContain('0% packet loss');
      expect(await run('ping -c 2 192.168.20.101')).toContain('0% packet loss');
    }, LONG);
  });

  describe('critère de réussite', () => {
    it('intra-VLAN préservé, inter-VLAN et passerelle coupés, puis reprise complète', async () => {
      rtr.powerOff();
      expect(await run('ping -c 1 192.168.10.102')).toContain('0% packet loss');
      expect(await run('ping -c 1 192.168.20.101')).toContain('100% packet loss');

      rtr.powerOn();
      expect(await run('ping -c 2 192.168.20.101')).toContain('0% packet loss');
    }, LONG);
  });
});
