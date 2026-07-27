/**
 * Scénario 6 — Panne logique : VLAN mal configuré après modification de
 * switch.
 *
 * Transcription littérale : PC-LINUX-3 est déplacé par erreur du VLAN 10
 * vers le VLAN 20. Aucun log physique n'est produit (le lien reste UP) et
 * `ip link` affiche `state UP` — mais l'ARP ne se résout plus. Le script
 * fichier `/tmp/diag-couche2.sh` distingue une panne physique (lien DOWN)
 * d'une panne logique (lien UP + ARP incomplet).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 6 — VLAN mal configuré (panne logique)', () => {
  const LONG = 30_000;
  let sw: CiscoSwitch;
  let pc1: LinuxPC;  // 192.168.10.101 — VLAN 10, port Fa0/1
  let pc3: LinuxPC;  // 192.168.10.103 — VLAN 10 attendu, port Fa0/3
  let lien3: Cable;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    sw.powerOn();
    pc1 = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc3 = new LinuxPC('linux-pc', 'pc-linux-3', 0, 0);
    pc1.powerOn();
    pc3.powerOn();
    new Cable('lien-pc1').connect(sw.getPort('FastEthernet0/1')!, pc1.getPort('eth0')!);
    lien3 = new Cable('lien-pc3');
    lien3.connect(sw.getPort('FastEthernet0/3')!, pc3.getPort('eth0')!);
    await pc1.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');
    await pc3.executeCommand('sudo ip addr add 192.168.10.103/24 dev eth0');

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('name VLAN_ADMIN');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('name VLAN_PRODUCTION');
    await sw.executeCommand('exit');
    for (const p of ['FastEthernet0/1', 'FastEthernet0/3']) {
      await sw.executeCommand(`interface ${p}`);
      await sw.executeCommand('switchport mode access');
      await sw.executeCommand('switchport access vlan 10');
      await sw.executeCommand('exit');
    }
    await sw.executeCommand('end');

    await installDiag();
  });

  const run = (cmd: string): Promise<string> => pc3.executeCommand(cmd);
  const swRun = (cmd: string): Promise<string> => sw.executeCommand(cmd);

  async function setAccessVlan(iface: string, vlan: number): Promise<void> {
    await swRun('configure terminal');
    await swRun(`interface ${iface}`);
    await swRun(`switchport access vlan ${vlan}`);
    await swRun('end');
  }

  /**
   * Diagnostic de couche 2 : distingue panne physique (lien DOWN) de
   * panne logique (lien UP mais ARP non résolu).
   */
  async function installDiag(): Promise<void> {
    await run(`cat << 'DIAG2' > /tmp/diag-couche2.sh
#!/bin/bash
set -uo pipefail
IFACE="\${1:-eth0}"
CIBLE="\${2:-192.168.10.101}"

CARRIER=$(cat /sys/class/net/$IFACE/carrier 2>/dev/null)
CARRIER=\${CARRIER:-0}

echo "CARRIER=$CARRIER"

if [ "$CARRIER" != "1" ]; then
  echo "COUCHE=1_PHYSIQUE"
  echo "CAUSE=CABLE_OU_PORT_DOWN"
  exit 3
fi

# Le lien est UP : on teste la resolution ARP vers la cible.
ip neigh flush all > /dev/null 2>&1
ping -c 1 -W 1 "$CIBLE" > /dev/null 2>&1
VOISIN=$(ip neigh show | grep "$CIBLE" || true)

echo "VOISIN=\${VOISIN:-aucun}"

if echo "$VOISIN" | grep -q "REACHABLE\\|STALE\\|DELAY"; then
  echo "COUCHE=OK"
  echo "CAUSE=AUCUNE"
  exit 0
else
  echo "COUCHE=2_LIAISON"
  echo "CAUSE=VLAN_OU_COMMUTATION"
  exit 2
fi
DIAG2
chmod +x /tmp/diag-couche2.sh`);
  }

  describe('état nominal — les deux postes sont dans le VLAN 10', () => {
    it('PC-LINUX-3 joint PC-LINUX-1 et le diagnostic conclut COUCHE=OK', async () => {
      expect(await run('ping -c 2 192.168.10.101')).toContain('0% packet loss');

      const out = await run('bash /tmp/diag-couche2.sh eth0 192.168.10.101');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('CARRIER=1');
      expect(out).toContain('COUCHE=OK');
      expect(code).toBe(0);
    }, LONG);

    it('`show vlan brief` place Fa0/3 dans le VLAN 10', async () => {
      const out = await swRun('show vlan brief');
      const ligne10 = out.split('\n').find((l) => /^10\s/.test(l.trim())) ?? '';
      expect(ligne10).toContain('Fa0/3');
    });
  });

  describe('introduction de la panne logique (VLAN 20 au lieu de VLAN 10)', () => {
    it('le lien physique reste UP — aucune détection automatique côté poste', async () => {
      await setAccessVlan('FastEthernet0/3', 20);

      const link = await run('ip link show eth0');
      expect(link).toContain('state UP');
      expect(link).toContain('LOWER_UP');
      expect(link).not.toContain('NO-CARRIER');
      expect((await run('cat /sys/class/net/eth0/carrier')).trim()).toBe('1');
    });

    it('le switch reste `connected` sur le port — la panne est invisible en couche 1', async () => {
      await setAccessVlan('FastEthernet0/3', 20);
      expect(await swRun('show interfaces status')).toMatch(/Fa0\/3\s+connected/);
    });

    it('la connectivité vers le voisin du même sous-réseau est perdue', async () => {
      await setAccessVlan('FastEthernet0/3', 20);
      expect(await run('ping -c 2 192.168.10.101')).toContain('100% packet loss');
    }, LONG);

    it('le diagnostic conclut à une panne de COUCHE 2 (VLAN), pas de couche 1', async () => {
      await setAccessVlan('FastEthernet0/3', 20);

      const out = await run('bash /tmp/diag-couche2.sh eth0 192.168.10.101');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('CARRIER=1');
      expect(out).toContain('COUCHE=2_LIAISON');
      expect(out).toContain('CAUSE=VLAN_OU_COMMUTATION');
      expect(code).toBe(2);
    }, LONG);

    it('un câble débranché est bien classé COUCHE 1 par le même script', async () => {
      lien3.disconnect();

      const out = await run('bash /tmp/diag-couche2.sh eth0 192.168.10.101');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('CARRIER=0');
      expect(out).toContain('COUCHE=1_PHYSIQUE');
      expect(code).toBe(3);
    }, LONG);
  });

  describe('diagnostic côté switch', () => {
    it('`show interfaces switchport` révèle le VLAN d\'accès incorrect', async () => {
      await setAccessVlan('FastEthernet0/3', 20);
      const out = await swRun('show interfaces FastEthernet0/3 switchport');
      expect(out).toMatch(/Access Mode VLAN: 20/);
    });

    it('`show vlan brief` montre Fa0/3 sorti du VLAN 10 et entré dans le VLAN 20', async () => {
      await setAccessVlan('FastEthernet0/3', 20);
      const out = await swRun('show vlan brief');
      const ligne10 = out.split('\n').find((l) => /^10\s/.test(l.trim())) ?? '';
      const ligne20 = out.split('\n').find((l) => /^20\s/.test(l.trim())) ?? '';
      expect(ligne10).not.toContain('Fa0/3');
      expect(ligne20).toContain('Fa0/3');
    });
  });

  describe('validation post-correction', () => {
    it('le retour en VLAN 10 rétablit la connectivité et le verdict COUCHE=OK', async () => {
      await setAccessVlan('FastEthernet0/3', 20);
      expect(await run('bash /tmp/diag-couche2.sh eth0 192.168.10.101'))
        .toContain('COUCHE=2_LIAISON');

      await setAccessVlan('FastEthernet0/3', 10);

      const out = await run('bash /tmp/diag-couche2.sh eth0 192.168.10.101');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('COUCHE=OK');
      expect(code).toBe(0);
    }, LONG);

    it('après correction, l\'entrée ARP de la passerelle voisine est de nouveau résolue', async () => {
      await setAccessVlan('FastEthernet0/3', 20);
      await setAccessVlan('FastEthernet0/3', 10);

      await run('ip neigh flush all');
      await run('ping -c 1 192.168.10.101');
      const voisins = await run('ip neigh show');
      expect(voisins).toContain('192.168.10.101');
      expect(voisins).toMatch(/REACHABLE|STALE|DELAY/);
    }, LONG);
  });
});
