/**
 * Scénario 3 — Extinction du switch d'accès : panne totale d'un segment
 * LAN.
 *
 * Transcription littérale : SW-MANDENG-02 (switch d'accès secondaire,
 * 4 postes raccordés) est éteint. On observe la chute de l'uplink sur
 * SW-MANDENG-01, la perte simultanée de TOUTES les machines du segment,
 * puis la remise sous tension et la validation complète.
 *
 * Le balayage de connectivité du scénario est transcrit en script
 * fichier (`/tmp/check-segment.sh`) exécuté depuis le poste
 * d'administration, plutôt qu'en commandes égrenées.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 3 — extinction du switch d\'accès SW-MANDENG-02', () => {
  // Chaque balayage enchaîne 4 pings avec délai d'attente : marge large.
  const LONG = 30_000;
  let sw1: CiscoSwitch;
  let sw2: CiscoSwitch;
  let admin: LinuxPC;
  let segment: LinuxPC[];

  const SEGMENT_IPS = ['192.168.10.103', '192.168.10.104', '192.168.10.200', '192.168.10.201'];

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw1 = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    sw2 = new CiscoSwitch('switch-cisco', 'SW-MANDENG-02', 8);
    sw1.powerOn();
    sw2.powerOn();

    // Uplink SW-MANDENG-01 (Fa0/8) ↔ SW-MANDENG-02 (Fa0/8)
    new Cable('uplink').connect(sw1.getPort('FastEthernet0/8')!, sw2.getPort('FastEthernet0/8')!);

    // Poste d'administration sur le switch de distribution.
    admin = new LinuxPC('linux-pc', 'pc-admin', 0, 0);
    admin.powerOn();
    new Cable('lien-admin').connect(sw1.getPort('FastEthernet0/1')!, admin.getPort('eth0')!);
    await admin.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');

    // 4 postes derrière le switch d'accès.
    segment = [];
    for (let i = 0; i < SEGMENT_IPS.length; i++) {
      const pc = new LinuxPC('linux-pc', `pc-seg-${i + 1}`, 0, 0);
      pc.powerOn();
      new Cable(`lien-seg-${i + 1}`)
        .connect(sw2.getPort(`FastEthernet0/${i + 1}`)!, pc.getPort('eth0')!);
      await pc.executeCommand(`sudo ip addr add ${SEGMENT_IPS[i]}/24 dev eth0`);
      segment.push(pc);
    }

    await sw1.executeCommand('enable');
    await installSegmentCheck();
  });

  const run = (cmd: string): Promise<string> => admin.executeCommand(cmd);

  /** Balayage de connectivité du segment, tel que décrit par le scénario. */
  async function installSegmentCheck(): Promise<void> {
    await run(`cat << 'SEG' > /tmp/check-segment.sh
#!/bin/bash
set -uo pipefail
HOSTS="192.168.10.103 192.168.10.104 192.168.10.200 192.168.10.201"

ACCESSIBLES=0
INACCESSIBLES=0

for IP in $HOSTS; do
  if ping -c 1 -W 1 $IP > /dev/null 2>&1; then
    echo "$IP : ACCESSIBLE"
    ACCESSIBLES=$((ACCESSIBLES + 1))
  else
    echo "$IP : INACCESSIBLE"
    INACCESSIBLES=$((INACCESSIBLES + 1))
  fi
done

echo "ACCESSIBLES=$ACCESSIBLES"
echo "INACCESSIBLES=$INACCESSIBLES"

if [ "$INACCESSIBLES" -eq 0 ]; then
  echo "VERDICT=SEGMENT_OPERATIONNEL"
  exit 0
elif [ "$ACCESSIBLES" -eq 0 ]; then
  echo "VERDICT=SEGMENT_TOTALEMENT_INJOIGNABLE"
  exit 2
else
  echo "VERDICT=SEGMENT_PARTIELLEMENT_INJOIGNABLE"
  exit 1
fi
SEG
chmod +x /tmp/check-segment.sh`);
  }

  describe('état nominal avant la panne', () => {
    it('le script voit les 4 machines du segment accessibles', async () => {
      const out = await run('bash /tmp/check-segment.sh');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('ACCESSIBLES=4');
      expect(out).toContain('INACCESSIBLES=0');
      expect(out).toContain('VERDICT=SEGMENT_OPERATIONNEL');
      expect(code).toBe(0);
    }, LONG);

    it('l\'uplink vers SW-MANDENG-02 est `connected` sur le switch de distribution', async () => {
      expect(await sw1.executeCommand('show interfaces status')).toMatch(/Fa0\/8\s+connected/);
    });
  });

  describe('effets immédiats à l\'extinction du switch d\'accès', () => {
    it('toutes les machines du segment deviennent injoignables simultanément', async () => {
      sw2.powerOff();

      const out = await run('bash /tmp/check-segment.sh');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('ACCESSIBLES=0');
      expect(out).toContain('INACCESSIBLES=4');
      expect(out).toContain('VERDICT=SEGMENT_TOTALEMENT_INJOIGNABLE');
      expect(code).toBe(2);
      for (const ip of SEGMENT_IPS) expect(out).toContain(`${ip} : INACCESSIBLE`);
    }, LONG);

    it('les machines restées sur SW-MANDENG-01 ne sont pas affectées', async () => {
      sw2.powerOff();
      // Le poste d'administration conserve son lien et son adressage.
      expect(await admin.executeCommand('ip link show eth0')).toContain('LOWER_UP');
      expect((await admin.executeCommand('cat /sys/class/net/eth0/carrier')).trim()).toBe('1');
    });

    it('gap confirmé : l\'extinction du switch distant devrait faire tomber l\'uplink de SW-MANDENG-01', async () => {
      sw2.powerOff();
      // Un vrai switch éteint coupe la porteuse : Fa0/8 doit passer
      // `notconnect` sur le switch de distribution.
      expect(await sw1.executeCommand('show interfaces status')).toMatch(/Fa0\/8\s+notconnect/);
    });
  });

  describe('remise sous tension et validation complète', () => {
    it('la remise sous tension rétablit l\'accès aux 4 machines', async () => {
      sw2.powerOff();
      expect(await run('bash /tmp/check-segment.sh'))
        .toContain('VERDICT=SEGMENT_TOTALEMENT_INJOIGNABLE');

      sw2.powerOn();

      const out = await run('bash /tmp/check-segment.sh');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('ACCESSIBLES=4');
      expect(out).toContain('VERDICT=SEGMENT_OPERATIONNEL');
      expect(code).toBe(0);
    });

    it('l\'uplink est de nouveau `connected` après remise sous tension', async () => {
      sw2.powerOff();
      sw2.powerOn();
      expect(await sw1.executeCommand('show interfaces status')).toMatch(/Fa0\/8\s+connected/);
    });
  });

  describe('critère de réussite', () => {
    it('perte simultanée de tout le segment, puis reprise complète validée par le script', async () => {
      sw2.powerOff();
      const panne = await run('bash /tmp/check-segment.sh');
      expect(panne).toContain('INACCESSIBLES=4');

      sw2.powerOn();
      const reprise = await run('bash /tmp/check-segment.sh');
      expect(reprise).toContain('ACCESSIBLES=4');
      expect(reprise).toContain('VERDICT=SEGMENT_OPERATIONNEL');
    }, LONG);
  });
});
