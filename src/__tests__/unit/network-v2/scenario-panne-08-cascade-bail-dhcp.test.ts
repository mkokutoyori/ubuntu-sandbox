/**
 * Scénario 8 — Panne en cascade : extinction du switch d'accès → perte
 * DHCP → expiration des baux.
 *
 * Transcription littérale : le switch qui héberge le serveur DHCP est
 * éteint (T=0). Les machines encore actives conservent leur bail, puis
 * échouent silencieusement au renouvellement (T=50 %), au REBIND
 * (T=87,5 %), et perdent enfin leur adresse à l'expiration (T=100 %).
 * La chronologie du scénario est transcrite dans le script fichier
 * `/tmp/cascade-dhcp.sh`, et la reprise est validée par `dhclient`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 8 — cascade DHCP après extinction du switch d\'accès', () => {
  const LONG = 30_000;
  let sw1: CiscoSwitch;   // SW-MANDENG-01 — distribution
  let sw2: CiscoSwitch;   // SW-MANDENG-02 — accès, héberge le DHCP
  let dhcp: LinuxServer;  // 192.168.10.12 — serveur DHCP
  let pc: LinuxPC;        // client encore actif sur SW-MANDENG-01

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw1 = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    sw2 = new CiscoSwitch('switch-cisco', 'SW-MANDENG-02', 8);
    sw1.powerOn();
    sw2.powerOn();
    new Cable('uplink').connect(sw1.getPort('FastEthernet0/8')!, sw2.getPort('FastEthernet0/8')!);

    dhcp = new LinuxServer('linux-server', 'srv-dhcp', 0, 0);
    dhcp.powerOn();
    new Cable('lien-dhcp').connect(sw2.getPort('FastEthernet0/1')!, dhcp.getPort('eth0')!);
    dhcp.configureInterface('eth0', new IPAddress('192.168.10.12'), new SubnetMask('255.255.255.0'));

    pc = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc.powerOn();
    new Cable('lien-pc').connect(sw1.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
    pc.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));

    await installCascade();
  });

  const run = (cmd: string): Promise<string> => pc.executeCommand(cmd);

  /**
   * Chronologie de la cascade : à partir de la durée de bail et du temps
   * écoulé, le script indique la phase DHCP courante et si l'adresse est
   * encore valide.
   */
  async function installCascade(): Promise<void> {
    await run(`cat << 'CASCADE' > /tmp/cascade-dhcp.sh
#!/bin/bash
set -uo pipefail
BAIL_H="\${1:-24}"     # duree du bail en heures
ECOULE_H="\${2:-0}"    # heures ecoulees depuis l'extinction

T50=$((BAIL_H * 50 / 100))
T875=$((BAIL_H * 875 / 1000))

echo "BAIL_H=$BAIL_H"
echo "ECOULE_H=$ECOULE_H"
echo "T_RENEW=$T50"
echo "T_REBIND=$T875"

if [ "$ECOULE_H" -lt "$T50" ]; then
  echo "PHASE=BAIL_VALIDE"
  echo "ADRESSE=CONSERVEE"
  exit 0
elif [ "$ECOULE_H" -lt "$T875" ]; then
  echo "PHASE=RENEW_ECHOUE"
  echo "ADRESSE=CONSERVEE"
  exit 1
elif [ "$ECOULE_H" -lt "$BAIL_H" ]; then
  echo "PHASE=REBIND_ECHOUE"
  echo "ADRESSE=CONSERVEE"
  exit 2
else
  echo "PHASE=BAIL_EXPIRE"
  echo "ADRESSE=PERDUE_APIPA"
  exit 3
fi
CASCADE
chmod +x /tmp/cascade-dhcp.sh`);
  }

  describe('phase 1 — extinction du switch d\'accès (T=0)', () => {
    it('le serveur DHCP devient injoignable, mais le client conserve son adresse', async () => {
      expect(await run('ping -c 1 192.168.10.12')).toContain('0% packet loss');

      sw2.powerOff();

      expect(await run('ping -c 1 -W 1 192.168.10.12')).toContain('100% packet loss');
      expect(await run("ip addr show eth0 | grep 'inet '")).toContain('192.168.10.101');
    }, LONG);

    it('le client garde son lien physique intact (il est sur l\'autre switch)', async () => {
      sw2.powerOff();
      expect((await run('cat /sys/class/net/eth0/carrier')).trim()).toBe('1');
      expect(await run('ip link show eth0')).toContain('LOWER_UP');
    });
  });

  describe('chronologie de la cascade (script fichier)', () => {
    it('T=0 → bail valide, adresse conservée (code 0)', async () => {
      const out = await run('bash /tmp/cascade-dhcp.sh 24 0');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('PHASE=BAIL_VALIDE');
      expect(out).toContain('ADRESSE=CONSERVEE');
      expect(code).toBe(0);
    });

    it('T=12h (50 %) → échec silencieux du renouvellement, adresse conservée (code 1)', async () => {
      const out = await run('bash /tmp/cascade-dhcp.sh 24 12');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('T_RENEW=12');
      expect(out).toContain('PHASE=RENEW_ECHOUE');
      expect(out).toContain('ADRESSE=CONSERVEE');
      expect(code).toBe(1);
    });

    it('T=21h (87,5 %) → échec du REBIND, adresse encore conservée (code 2)', async () => {
      const out = await run('bash /tmp/cascade-dhcp.sh 24 21');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('T_REBIND=21');
      expect(out).toContain('PHASE=REBIND_ECHOUE');
      expect(out).toContain('ADRESSE=CONSERVEE');
      expect(code).toBe(2);
    });

    it('T=24h → expiration du bail et bascule APIPA (code 3)', async () => {
      const out = await run('bash /tmp/cascade-dhcp.sh 24 24');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('PHASE=BAIL_EXPIRE');
      expect(out).toContain('ADRESSE=PERDUE_APIPA');
      expect(code).toBe(3);
    });

    it('la panne initiale (T=0) et son effet (T=24h) sont bien distants de tout le bail', async () => {
      const t0 = await run('bash /tmp/cascade-dhcp.sh 24 0');
      const t24 = await run('bash /tmp/cascade-dhcp.sh 24 24');
      expect(t0).toContain('ADRESSE=CONSERVEE');
      expect(t24).toContain('ADRESSE=PERDUE_APIPA');
    });
  });

  describe('reprise après remise en service du serveur DHCP', () => {
    it('la remise sous tension du switch rend le serveur DHCP de nouveau joignable', async () => {
      sw2.powerOff();
      expect(await run('ping -c 1 -W 1 192.168.10.12')).toContain('100% packet loss');

      sw2.powerOn();
      expect(await run('ping -c 2 192.168.10.12')).toContain('0% packet loss');
    }, LONG);

    it('`dhclient eth0` est accepté et une adresse reste configurée après la reprise', async () => {
      sw2.powerOff();
      sw2.powerOn();

      const out = await run('sudo dhclient eth0');
      expect(out).not.toMatch(/command not found/);

      const addr = await run("ip addr show eth0 | grep 'inet '");
      expect(addr).toMatch(/inet \d+\.\d+\.\d+\.\d+/);
    }, LONG);
  });

  describe('critère de réussite', () => {
    it('la cascade complète est reproduite : valide → renew → rebind → expiration', async () => {
      const phases: string[] = [];
      for (const h of [0, 12, 21, 24]) {
        const out = await run(`bash /tmp/cascade-dhcp.sh 24 ${h}`);
        phases.push(/PHASE=(\w+)/.exec(out)![1]);
      }
      expect(phases).toEqual([
        'BAIL_VALIDE',
        'RENEW_ECHOUE',
        'REBIND_ECHOUE',
        'BAIL_EXPIRE',
      ]);
    });
  });
});
