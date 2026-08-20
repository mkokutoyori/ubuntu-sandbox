/**
 * Scénario 5 — Panne partielle : dégradation de lien avec perte de
 * paquets.
 *
 * Transcription littérale : une perte de 20 % est injectée avec
 * `tc qdisc … netem loss 20%`, puis quantifiée par `ping`. Le script
 * fichier `/tmp/mesure-degradation.sh` mesure le taux réel et classe la
 * situation (saine / dégradée / panne totale), et
 * `/tmp/tableau-comparatif.sh` restitue le tableau du scénario.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 5 — dégradation de lien (perte de paquets)', () => {
  const LONG = 30_000;
  let sw: CiscoSwitch;
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let lien: Cable;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    sw.powerOn();
    pc1 = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc2 = new LinuxPC('linux-pc', 'pc-linux-2', 0, 0);
    pc1.powerOn();
    pc2.powerOn();
    lien = new Cable('lien-pc1');
    lien.connect(sw.getPort('FastEthernet0/1')!, pc1.getPort('eth0')!);
    new Cable('lien-pc2').connect(sw.getPort('FastEthernet0/2')!, pc2.getPort('eth0')!);
    await pc1.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');
    await pc2.executeCommand('sudo ip addr add 192.168.10.102/24 dev eth0');
    await sw.executeCommand('enable');
    await installScripts();
  });

  const run = (cmd: string): Promise<string> => pc1.executeCommand(cmd);

  async function installScripts(): Promise<void> {
    // Mesure et classification de la dégradation.
    await run(`cat << 'MESURE' > /tmp/mesure-degradation.sh
#!/bin/bash
set -uo pipefail
CIBLE="\${1:-192.168.10.102}"
COMPTE="\${2:-20}"

SORTIE=$(ping -c $COMPTE -i 0.2 -W 1 "$CIBLE" 2>&1)
PERTE=$(echo "$SORTIE" | grep -o '[0-9]\\+% packet loss' | grep -o '[0-9]\\+')
PERTE=\${PERTE:-100}

echo "CIBLE=$CIBLE"
echo "PAQUETS=$COMPTE"
echo "PERTE_PCT=$PERTE"

if [ "$PERTE" -eq 0 ]; then
  echo "CLASSE=LIEN_SAIN"
  exit 0
elif [ "$PERTE" -ge 100 ]; then
  echo "CLASSE=PANNE_TOTALE"
  exit 2
else
  echo "CLASSE=LIEN_DEGRADE"
  exit 1
fi
MESURE
chmod +x /tmp/mesure-degradation.sh`);

    // Tableau comparatif panne totale vs dégradation.
    await run(`cat << 'TAB' > /tmp/tableau-comparatif.sh
#!/bin/bash
echo "Symptome|Panne totale|Degradation"
echo "ping|100% loss|perte partielle"
echo "message|Unreachable|timeout"
echo "show interfaces|notconnect|connected + erreurs CRC"
echo "detection|immediate|progressive"
echo "impact|service indisponible|service lent/instable"
TAB
chmod +x /tmp/tableau-comparatif.sh`);
  }

  describe('simulation de la dégradation via tc netem', () => {
    it('`tc qdisc add … netem loss 20%` est accepté et reflété par `tc qdisc show`', async () => {
      await run('sudo tc qdisc add dev eth0 root netem loss 20%');
      const out = await run('tc qdisc show dev eth0');
      expect(out).toContain('netem');
      expect(out).toContain('loss 20%');
    });

    it('sans dégradation, `tc qdisc show` n\'affiche aucun netem', async () => {
      expect(await run('tc qdisc show dev eth0')).not.toContain('netem');
    });

    it('`tc qdisc del` supprime la dégradation', async () => {
      await run('sudo tc qdisc add dev eth0 root netem loss 20%');
      expect(await run('tc qdisc show dev eth0')).toContain('netem');

      await run('sudo tc qdisc del dev eth0 root');
      expect(await run('tc qdisc show dev eth0')).not.toContain('netem');
    });
  });

  describe('quantification par le script de mesure', () => {
    it('classe un lien intact en LIEN_SAIN (0 % de perte, code 0)', async () => {
      const out = await run('bash /tmp/mesure-degradation.sh 192.168.10.102 10');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('PERTE_PCT=0');
      expect(out).toContain('CLASSE=LIEN_SAIN');
      expect(code).toBe(0);
    }, LONG);

    it('classe un lien à 20 % de perte en LIEN_DEGRADE (code 1)', async () => {
      await run('sudo tc qdisc add dev eth0 root netem loss 20%');
      const out = await run('bash /tmp/mesure-degradation.sh 192.168.10.102 40');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('CLASSE=LIEN_DEGRADE');
      expect(code).toBe(1);

      const perte = Number(/PERTE_PCT=(\d+)/.exec(out)![1]);
      expect(perte).toBeGreaterThan(0);
      expect(perte).toBeLessThan(100);
    }, LONG);

    it('classe un câble débranché en PANNE_TOTALE (100 % de perte, code 2)', async () => {
      lien.disconnect();
      const out = await run('bash /tmp/mesure-degradation.sh 192.168.10.102 4');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('PERTE_PCT=100');
      expect(out).toContain('CLASSE=PANNE_TOTALE');
      expect(code).toBe(2);
    }, LONG);
  });

  describe('distinction dégradation vs panne totale', () => {
    it('la perte mesurée à 20 % reste strictement inférieure à celle d\'une panne totale', async () => {
      await run('sudo tc qdisc add dev eth0 root netem loss 20%');
      const degrade = await run('bash /tmp/mesure-degradation.sh 192.168.10.102 40');
      const perteDegradee = Number(/PERTE_PCT=(\d+)/.exec(degrade)![1]);

      await run('sudo tc qdisc del dev eth0 root');
      lien.disconnect();
      const totale = await run('bash /tmp/mesure-degradation.sh 192.168.10.102 4');
      const perteTotale = Number(/PERTE_PCT=(\d+)/.exec(totale)![1]);

      expect(perteTotale).toBe(100);
      expect(perteDegradee).toBeLessThan(perteTotale);
    }, LONG);

    it('le tableau comparatif restitue les signatures des deux types de panne', async () => {
      const out = await run('bash /tmp/tableau-comparatif.sh');
      expect(out).toContain('ping|100% loss|perte partielle');
      expect(out).toContain('message|Unreachable|timeout');
      expect(out).toContain('show interfaces|notconnect|connected + erreurs CRC');
    });

    it('un lien dégradé reste `connected` côté switch (contrairement à un câble absent)', async () => {
      await run('sudo tc qdisc add dev eth0 root netem loss 20%');
      expect(await sw.executeCommand('show interfaces status')).toMatch(/Fa0\/1\s+connected/);

      lien.disconnect();
      expect(await sw.executeCommand('show interfaces status')).toMatch(/Fa0\/1\s+notconnect/);
    });
  });

  describe('critère de réussite', () => {
    it('la perte injectée est mesurable et distincte d\'une panne totale', async () => {
      await run('sudo tc qdisc add dev eth0 root netem loss 20%');
      const out = await run('bash /tmp/mesure-degradation.sh 192.168.10.102 40');

      expect(out).toContain('CLASSE=LIEN_DEGRADE');
      const perte = Number(/PERTE_PCT=(\d+)/.exec(out)![1]);
      expect(perte).toBeGreaterThan(0);
      expect(perte).toBeLessThan(100);
    }, LONG);
  });
});
