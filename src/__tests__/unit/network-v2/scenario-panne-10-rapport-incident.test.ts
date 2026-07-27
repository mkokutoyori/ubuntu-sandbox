/**
 * Scénario 10 — Rapport de panne complet : détection, diagnostic,
 * escalade et validation post-reprise.
 *
 * Transcription littérale des trois scripts du scénario, écrits en
 * fichiers puis exécutés :
 *   - `/tmp/network-incident-report.sh` — diagnostic couche par couche
 *     (1 physique, 2 liaison/ARP, 3 réseau/routage, 4 transport,
 *     7 application), score et statut ;
 *   - `/tmp/escalade.sh` — niveau d'escalade dérivé du score ;
 *   - `/tmp/validation-post-reprise.sh` — checklist de clôture.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 10 — rapport d\'incident réseau complet', () => {
  const LONG = 60_000;
  let sw: CiscoSwitch;
  let rtr: CiscoRouter;
  let pc: LinuxPC;
  let dc: LinuxServer;
  let lienPc: Cable;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    sw.powerOn();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    rtr.powerOn();
    pc = new LinuxPC('linux-pc', 'pc-admin', 0, 0);
    dc = new LinuxServer('linux-server', 'dc01', 0, 0);
    pc.powerOn();
    dc.powerOn();

    const [g0] = rtr.getPortNames();
    new Cable('rtr-sw').connect(rtr.getPort(g0)!, sw.getPort('FastEthernet0/8')!);
    lienPc = new Cable('lien-pc');
    lienPc.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
    new Cable('lien-dc').connect(sw.getPort('FastEthernet0/2')!, dc.getPort('eth0')!);

    await rtr.executeCommand('enable');
    await rtr.executeCommand('configure terminal');
    await rtr.executeCommand(`interface ${g0}`);
    await rtr.executeCommand('ip address 192.168.10.254 255.255.255.0');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('end');

    pc.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));
    dc.configureInterface('eth0', new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));
    await pc.executeCommand('sudo ip route add default via 192.168.10.254');

    dc.dnsService.addRecord({ name: 'mandeng.lan', type: 'A', value: '192.168.10.10', ttl: 3600 });
    dc.dnsService.start();
    await pc.executeCommand("sudo sh -c 'echo \"nameserver 192.168.10.10\" > /etc/resolv.conf'");

    await installScripts();
  });

  const run = (cmd: string): Promise<string> => pc.executeCommand(cmd);

  async function installScripts(): Promise<void> {
    // ─── Rapport d'incident couche par couche ───
    await run(`cat << 'RAPPORT' > /tmp/network-incident-report.sh
#!/bin/bash
set -uo pipefail

ROUTEUR="192.168.10.254"
DC="192.168.10.10"
RAPPORT="/tmp/incident-rapport.txt"

SCORE=0
MAX=0

: > "$RAPPORT"

verifier() {
  DESC="$1"; CMD="$2"
  MAX=$((MAX + 1))
  if eval "$CMD" > /dev/null 2>&1; then
    echo "OK $DESC" >> "$RAPPORT"
    SCORE=$((SCORE + 1))
  else
    echo "KO $DESC" >> "$RAPPORT"
  fi
}

echo "=== RAPPORT D'INCIDENT RESEAU - MANDENG ===" >> "$RAPPORT"

echo "--- COUCHE 1 PHYSIQUE ---" >> "$RAPPORT"
verifier "Interface eth0 operationnelle" "[ \\"\\$(cat /sys/class/net/eth0/operstate)\\" = up ]"
verifier "Porteuse detectee" "[ \\"\\$(cat /sys/class/net/eth0/carrier)\\" = 1 ]"

echo "--- COUCHE 2 LIAISON ---" >> "$RAPPORT"
verifier "Resolution ARP de la passerelle" "ping -c 1 -W 1 $ROUTEUR"

echo "--- COUCHE 3 RESEAU ---" >> "$RAPPORT"
verifier "Route par defaut configuree" "ip route show default | grep -q via"
verifier "Passerelle joignable" "ping -c 1 -W 1 $ROUTEUR"

echo "--- COUCHE 4 TRANSPORT ---" >> "$RAPPORT"
verifier "TCP SSH vers DC01" "nc -z -w 2 $DC 22"

echo "--- COUCHE 7 APPLICATION ---" >> "$RAPPORT"
verifier "Resolution DNS interne" "nslookup mandeng.lan $DC | grep -q 'Address:.*192.168'"

POURCENT=$((SCORE * 100 / MAX))

echo "SCORE=$SCORE/$MAX" >> "$RAPPORT"
echo "POURCENT=$POURCENT" >> "$RAPPORT"

if [ "$POURCENT" -ge 90 ]; then
  STATUT="RESEAU_OPERATIONNEL"
elif [ "$POURCENT" -ge 70 ]; then
  STATUT="RESEAU_DEGRADE"
elif [ "$POURCENT" -ge 50 ]; then
  STATUT="PANNE_PARTIELLE"
else
  STATUT="PANNE_MAJEURE"
fi

echo "STATUT=$STATUT" >> "$RAPPORT"
cat "$RAPPORT"
exit $((100 - POURCENT))
RAPPORT
chmod +x /tmp/network-incident-report.sh`);

    // ─── Escalade dérivée du score ───
    await run(`cat << 'ESCALADE' > /tmp/escalade.sh
#!/bin/bash
set -uo pipefail
POURCENT="\${1:-100}"

if [ "$POURCENT" -ge 90 ]; then
  echo "NIVEAU=0"
  echo "ACTION=surveillance continue"
elif [ "$POURCENT" -ge 70 ]; then
  echo "NIVEAU=1"
  echo "ACTION=technicien reseau sous 30 minutes"
elif [ "$POURCENT" -ge 50 ]; then
  echo "NIVEAU=2"
  echo "ACTION=responsable infrastructure sous 15 minutes"
else
  echo "NIVEAU=3"
  echo "ACTION=crise, intervention immediate"
fi
ESCALADE
chmod +x /tmp/escalade.sh`);

    // ─── Checklist de validation post-reprise ───
    await run(`cat << 'CHECK' > /tmp/validation-post-reprise.sh
#!/bin/bash
set -uo pipefail
REUSSIS=0
ECHOUES=0

controler() {
  DESC="$1"; CMD="$2"
  if eval "$CMD" > /dev/null 2>&1; then
    echo "OK $DESC"
    REUSSIS=$((REUSSIS + 1))
  else
    echo "KO $DESC"
    ECHOUES=$((ECHOUES + 1))
  fi
}

controler "Passerelle routeur accessible" "ping -c 1 -W 1 192.168.10.254"
controler "DNS interne fonctionnel" "nslookup mandeng.lan 192.168.10.10 | grep -q 'Address:.*192.168'"
controler "SSH vers DC01" "nc -z -w 2 192.168.10.10 22"

echo "REUSSIS=$REUSSIS"
echo "ECHOUES=$ECHOUES"

if [ "$ECHOUES" -eq 0 ]; then
  echo "INCIDENT=CLOTURE"
  exit 0
else
  echo "INCIDENT=MAINTENU_OUVERT"
  exit 1
fi
CHECK
chmod +x /tmp/validation-post-reprise.sh`);
  }

  describe('infrastructure saine — score maximal', () => {
    it('le rapport atteint 100 % et le statut RESEAU_OPERATIONNEL', async () => {
      const out = await run('bash /tmp/network-incident-report.sh');
      expect(out).toContain('POURCENT=100');
      expect(out).toContain('STATUT=RESEAU_OPERATIONNEL');
      expect(out).not.toContain('KO ');
    }, LONG);

    it('le rapport est écrit dans un fichier réutilisable', async () => {
      await run('bash /tmp/network-incident-report.sh');
      const fichier = await run('cat /tmp/incident-rapport.txt');
      expect(fichier).toContain("=== RAPPORT D'INCIDENT RESEAU - MANDENG ===");
      expect(fichier).toContain('--- COUCHE 1 PHYSIQUE ---');
      expect(fichier).toContain('--- COUCHE 7 APPLICATION ---');
      expect(fichier).toContain('STATUT=RESEAU_OPERATIONNEL');
    }, LONG);

    it('le code de sortie vaut 0 sur une infrastructure saine', async () => {
      await run('bash /tmp/network-incident-report.sh');
      const code = Number((await run('echo $?')).trim());
      expect(code).toBe(0);
    }, LONG);
  });

  describe('panne physique — la couche 1 échoue en premier', () => {
    it('un câble débranché fait chuter le score dès la couche 1', async () => {
      lienPc.disconnect();
      const out = await run('bash /tmp/network-incident-report.sh');

      expect(out).toContain('KO Interface eth0 operationnelle');
      expect(out).toContain('KO Porteuse detectee');
      expect(out).toContain('STATUT=PANNE_MAJEURE');

      const pourcent = Number(/POURCENT=(\d+)/.exec(out)![1]);
      expect(pourcent).toBeLessThan(50);
    }, LONG);

    it('le code de sortie reflète le score (100 - pourcentage)', async () => {
      lienPc.disconnect();
      const out = await run('bash /tmp/network-incident-report.sh');
      const pourcent = Number(/POURCENT=(\d+)/.exec(out)![1]);
      const code = Number((await run('echo $?')).trim());
      expect(code).toBe(100 - pourcent);
    }, LONG);
  });

  describe('panne applicative — les couches basses restent saines', () => {
    it('l\'arrêt du DNS dégrade le score sans toucher aux couches 1 à 3', async () => {
      dc.dnsService.stop();
      const out = await run('bash /tmp/network-incident-report.sh');

      expect(out).toContain('OK Interface eth0 operationnelle');
      expect(out).toContain('OK Porteuse detectee');
      expect(out).toContain('OK Passerelle joignable');
      expect(out).toContain('KO Resolution DNS interne');

      const pourcent = Number(/POURCENT=(\d+)/.exec(out)![1]);
      expect(pourcent).toBeGreaterThan(50);
      expect(pourcent).toBeLessThan(100);
    }, LONG);

    it('le rapport localise la couche exacte de défaillance', async () => {
      dc.dnsService.stop();
      await run('bash /tmp/network-incident-report.sh');
      const fichier = await run('cat /tmp/incident-rapport.txt');

      const lignes = fichier.split('\n');
      const idxApplication = lignes.findIndex((l) => l.includes('COUCHE 7 APPLICATION'));
      const echecs = lignes.filter((l) => l.startsWith('KO '));

      expect(echecs).toHaveLength(1);
      expect(lignes.indexOf(echecs[0])).toBeGreaterThan(idxApplication);
    }, LONG);
  });

  describe('procédure d\'escalade dérivée du score', () => {
    it('100 % → niveau 0, surveillance continue', async () => {
      const out = await run('bash /tmp/escalade.sh 100');
      expect(out).toContain('NIVEAU=0');
      expect(out).toContain('ACTION=surveillance continue');
    });

    it('75 % → niveau 1, technicien réseau', async () => {
      const out = await run('bash /tmp/escalade.sh 75');
      expect(out).toContain('NIVEAU=1');
    });

    it('60 % → niveau 2, responsable infrastructure', async () => {
      const out = await run('bash /tmp/escalade.sh 60');
      expect(out).toContain('NIVEAU=2');
    });

    it('20 % → niveau 3, crise', async () => {
      const out = await run('bash /tmp/escalade.sh 20');
      expect(out).toContain('NIVEAU=3');
      expect(out).toContain('ACTION=crise, intervention immediate');
    });

    it('le score réel d\'une panne physique déclenche bien le niveau 3', async () => {
      lienPc.disconnect();
      const rapport = await run('bash /tmp/network-incident-report.sh');
      const pourcent = Number(/POURCENT=(\d+)/.exec(rapport)![1]);

      const escalade = await run(`bash /tmp/escalade.sh ${pourcent}`);
      expect(escalade).toContain('NIVEAU=3');
    }, LONG);
  });

  describe('validation post-reprise et clôture', () => {
    it('la checklist clôture l\'incident quand tout est rétabli', async () => {
      const out = await run('bash /tmp/validation-post-reprise.sh');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('ECHOUES=0');
      expect(out).toContain('INCIDENT=CLOTURE');
      expect(code).toBe(0);
    }, LONG);

    it('la checklist maintient l\'incident ouvert tant qu\'un service manque', async () => {
      dc.dnsService.stop();
      const out = await run('bash /tmp/validation-post-reprise.sh');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('KO DNS interne fonctionnel');
      expect(out).toContain('INCIDENT=MAINTENU_OUVERT');
      expect(code).toBe(1);
    }, LONG);

    it('après reprise du service, la checklist repasse à CLOTURE', async () => {
      dc.dnsService.stop();
      expect(await run('bash /tmp/validation-post-reprise.sh'))
        .toContain('INCIDENT=MAINTENU_OUVERT');

      dc.dnsService.start();

      const out = await run('bash /tmp/validation-post-reprise.sh');
      expect(out).toContain('ECHOUES=0');
      expect(out).toContain('INCIDENT=CLOTURE');
    }, LONG);
  });

  describe('critère de réussite', () => {
    it('score 100 sur infrastructure saine, chute localisée en cas de panne, clôture après reprise', async () => {
      expect(await run('bash /tmp/network-incident-report.sh')).toContain('POURCENT=100');

      lienPc.disconnect();
      const panne = await run('bash /tmp/network-incident-report.sh');
      expect(panne).toContain('KO Porteuse detectee');
      expect(panne).toContain('STATUT=PANNE_MAJEURE');

      const reconnecte = new Cable('lien-pc-bis');
      reconnecte.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);

      expect(await run('bash /tmp/validation-post-reprise.sh')).toContain('INCIDENT=CLOTURE');
    }, LONG);
  });
});
