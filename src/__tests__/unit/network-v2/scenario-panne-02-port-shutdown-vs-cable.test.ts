/**
 * Scénario 2 — Port switch désactivé par erreur : diagnostic différencié
 * câble vs administratif.
 *
 * Transcription littérale : un `shutdown` administratif sur
 * FastEthernet0/2 et un câble débranché sur FastEthernet0/1 produisent
 * des symptômes IDENTIQUES côté Linux (`state DOWN`), mais deux
 * signatures textuelles distinctes côté switch
 * (`administratively down` / `disabled` vs `down` / `notconnect`).
 * Le script de diagnostic différentiel `/tmp/network-diag.sh` tranche.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 2 — port désactivé vs câble débranché', () => {
  let sw: CiscoSwitch;
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let cable1: Cable;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    pc1 = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc2 = new LinuxPC('linux-pc', 'pc-linux-2', 0, 0);
    pc1.powerOn();
    pc2.powerOn();
    cable1 = new Cable('lien-pc1');
    cable1.connect(sw.getPort('FastEthernet0/1')!, pc1.getPort('eth0')!);
    new Cable('lien-pc2').connect(sw.getPort('FastEthernet0/2')!, pc2.getPort('eth0')!);
    await pc1.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');
    await pc2.executeCommand('sudo ip addr add 192.168.10.102/24 dev eth0');
    await sw.executeCommand('enable');
  });

  const swRun = (cmd: string): Promise<string> => sw.executeCommand(cmd);

  async function shutdownPort(iface: string): Promise<void> {
    await swRun('configure terminal');
    await swRun(`interface ${iface}`);
    await swRun('shutdown');
    await swRun('end');
  }

  async function noShutdownPort(iface: string): Promise<void> {
    await swRun('configure terminal');
    await swRun(`interface ${iface}`);
    await swRun('no shutdown');
    await swRun('end');
  }

  /**
   * Script de diagnostic différentiel : il lit l'état réel du port sur le
   * switch (déposé au préalable dans un fichier de constat, comme le
   * ferait une collecte SSH depuis le NOC) et conclut sur la cause.
   */
  async function installDiag(pc: LinuxPC): Promise<void> {
    await pc.executeCommand(`cat << 'DIAG' > /tmp/network-diag.sh
#!/bin/bash
set -uo pipefail
PORT_STATUS_FILE="\${1:-/tmp/port-status.txt}"

echo "=== DIAGNOSTIC RESEAU DIFFERENTIEL ==="

if grep -q "administratively down" "$PORT_STATUS_FILE"; then
  echo "CAUSE=PORT_ADMIN_DISABLE"
  echo "ACTION=no shutdown sur le port"
  exit 2
elif grep -q "is down" "$PORT_STATUS_FILE"; then
  echo "CAUSE=LIEN_PHYSIQUE_ABSENT"
  echo "ACTION=verifier le cable physiquement"
  exit 3
elif grep -q "is up" "$PORT_STATUS_FILE"; then
  echo "CAUSE=AUCUNE"
  echo "ACTION=fausse alarme, port operationnel"
  exit 0
else
  echo "CAUSE=INCONNUE"
  echo "ACTION=investigation approfondie requise"
  exit 4
fi
DIAG
chmod +x /tmp/network-diag.sh`);
  }

  describe('désactivation administrative du port', () => {
    it('`show interfaces` affiche `administratively down` après shutdown', async () => {
      await shutdownPort('FastEthernet0/2');
      const out = await swRun('show interfaces FastEthernet0/2');
      expect(out).toContain('FastEthernet0/2 is administratively down, line protocol is down');
    });

    it('`show interfaces status` affiche `disabled` (et non `notconnect`)', async () => {
      await shutdownPort('FastEthernet0/2');
      const out = await swRun('show interfaces status');
      expect(out).toMatch(/Fa0\/2\s+disabled/);
      expect(out).not.toMatch(/Fa0\/2\s+notconnect/);
    });
  });

  describe('les deux signatures côté switch sont distinctes', () => {
    it('câble absent → `down` sans « administratively » ; shutdown → `administratively down`', async () => {
      cable1.disconnect();
      await shutdownPort('FastEthernet0/2');

      const cableAbsent = await swRun('show interfaces FastEthernet0/1');
      const adminDown = await swRun('show interfaces FastEthernet0/2');

      expect(cableAbsent).toContain('FastEthernet0/1 is down, line protocol is down');
      expect(cableAbsent).not.toContain('administratively');

      expect(adminDown).toContain('administratively down');
    });

    it('`show interfaces status` : `notconnect` pour le câble absent, `disabled` pour le shutdown', async () => {
      cable1.disconnect();
      await shutdownPort('FastEthernet0/2');

      const status = await swRun('show interfaces status');
      expect(status).toMatch(/Fa0\/1\s+notconnect/);
      expect(status).toMatch(/Fa0\/2\s+disabled/);
    });
  });

  describe('symptômes côté Linux (identiques dans les deux cas)', () => {
    // Gap confirmé : un `shutdown` administratif côté switch ne propage
    // pas la perte de porteuse au poste raccordé — celui-ci conserve
    // carrier=1 et LOWER_UP, alors qu'un vrai switch éteint l'émetteur du
    // port et que le poste verrait `state DOWN`, exactement comme pour un
    // câble débranché (c'est tout le propos du scénario : les deux cas
    // sont indistinguables DEPUIS LE POSTE).
    it('gap confirmé : les deux postes devraient afficher `state DOWN` — indistinguables depuis Linux seul', async () => {
      cable1.disconnect();
      await shutdownPort('FastEthernet0/2');

      const linkPc1 = await pc1.executeCommand('ip link show eth0');
      const linkPc2 = await pc2.executeCommand('ip link show eth0');

      expect(linkPc1).toContain('state DOWN');
      expect(linkPc2).toContain('state DOWN');
      expect(linkPc1).toContain('NO-CARRIER');
      expect(linkPc2).toContain('NO-CARRIER');
    });

    it('gap confirmé : le carrier sysfs devrait valoir 0 dans les deux cas', async () => {
      cable1.disconnect();
      await shutdownPort('FastEthernet0/2');

      expect((await pc1.executeCommand('cat /sys/class/net/eth0/carrier')).trim()).toBe('0');
      expect((await pc2.executeCommand('cat /sys/class/net/eth0/carrier')).trim()).toBe('0');
    });
  });

  describe('arbre de décision du script de diagnostic différentiel', () => {
    it('identifie un port administrativement désactivé (code 2)', async () => {
      await shutdownPort('FastEthernet0/2');
      await installDiag(pc1);
      const constat = await swRun('show interfaces FastEthernet0/2');
      await pc1.executeCommand(`cat << 'ST' > /tmp/port-status.txt\n${constat.split('\n')[0]}\nST`);

      const out = await pc1.executeCommand('bash /tmp/network-diag.sh /tmp/port-status.txt');
      const code = Number((await pc1.executeCommand('echo $?')).trim());

      expect(out).toContain('CAUSE=PORT_ADMIN_DISABLE');
      expect(out).toContain('ACTION=no shutdown sur le port');
      expect(code).toBe(2);
    });

    it('identifie un lien physique absent (code 3)', async () => {
      cable1.disconnect();
      await installDiag(pc1);
      const constat = await swRun('show interfaces FastEthernet0/1');
      await pc1.executeCommand(`cat << 'ST' > /tmp/port-status.txt\n${constat.split('\n')[0]}\nST`);

      const out = await pc1.executeCommand('bash /tmp/network-diag.sh /tmp/port-status.txt');
      const code = Number((await pc1.executeCommand('echo $?')).trim());

      expect(out).toContain('CAUSE=LIEN_PHYSIQUE_ABSENT');
      expect(out).toContain('ACTION=verifier le cable physiquement');
      expect(code).toBe(3);
    });

    it('conclut à une fausse alarme sur un port opérationnel (code 0)', async () => {
      await installDiag(pc1);
      const constat = await swRun('show interfaces FastEthernet0/1');
      await pc1.executeCommand(`cat << 'ST' > /tmp/port-status.txt\n${constat.split('\n')[0]}\nST`);

      const out = await pc1.executeCommand('bash /tmp/network-diag.sh /tmp/port-status.txt');
      const code = Number((await pc1.executeCommand('echo $?')).trim());

      expect(out).toContain('CAUSE=AUCUNE');
      expect(code).toBe(0);
    });
  });

  describe('réactivation du port et validation', () => {
    it('`no shutdown` fait disparaître « administratively » et repasse en `connected`', async () => {
      await shutdownPort('FastEthernet0/2');
      expect(await swRun('show interfaces FastEthernet0/2')).toContain('administratively down');

      await noShutdownPort('FastEthernet0/2');

      const out = await swRun('show interfaces FastEthernet0/2');
      expect(out).not.toContain('administratively');
      expect(out).toContain('FastEthernet0/2 is up, line protocol is up');
      expect(await swRun('show interfaces status')).toMatch(/Fa0\/2\s+connected/);
    });

    it('gap confirmé : le poste devrait passer carrier=0 sous shutdown puis 1 après réactivation', async () => {
      await shutdownPort('FastEthernet0/2');
      expect((await pc2.executeCommand('cat /sys/class/net/eth0/carrier')).trim()).toBe('0');

      await noShutdownPort('FastEthernet0/2');

      expect((await pc2.executeCommand('cat /sys/class/net/eth0/carrier')).trim()).toBe('1');
      expect(await pc2.executeCommand('ip link show eth0')).toContain('LOWER_UP');
    });
  });
});
