/**
 * Scénario 1 — Câble débranché sur un poste Linux : détection, diagnostic
 * et reprise.
 *
 * Transcription littérale : débranchement du câble de PC-LINUX-1 (port
 * FastEthernet0/1 de SW-MANDENG-01), observation des effets immédiats
 * (logs kernel, `ip link`, `ip addr`, `ping`), diagnostic depuis le
 * switch (`show interfaces`, `show interfaces status`), impact sur les
 * sessions TCP établies et le bail DHCP, puis reprise après reconnexion.
 *
 * Les scripts du scénario sont écrits en fichiers (`/tmp/*.sh`) puis
 * exécutés, conformément à la demande — pas de commandes égrenées.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 1 — câble débranché sur un poste Linux', () => {
  let sw: CiscoSwitch;
  let pc: LinuxPC;
  let cable: Cable;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    pc = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc.powerOn();
    cable = new Cable('lien-pc1');
    cable.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
    await pc.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');
    await sw.executeCommand('enable');
    await installLinkCheck();
  });

  const run = (cmd: string): Promise<string> => pc.executeCommand(cmd);
  const swRun = (cmd: string): Promise<string> => sw.executeCommand(cmd);

  /**
   * Script de constat d'état de lien, tel qu'un administrateur
   * l'exécuterait sur le poste : sysfs (source de vérité kernel),
   * `ip link`, puis verdict.
   */
  async function installLinkCheck(): Promise<void> {
    await run(`cat << 'LINKCHK' > /tmp/link-check.sh
#!/bin/bash
set -uo pipefail
IFACE="\${1:-eth0}"

CARRIER=$(cat /sys/class/net/$IFACE/carrier 2>/dev/null)
OPERSTATE=$(cat /sys/class/net/$IFACE/operstate 2>/dev/null)

echo "IFACE=$IFACE"
echo "CARRIER=\${CARRIER:-inconnu}"
echo "OPERSTATE=\${OPERSTATE:-inconnu}"

if ip link show $IFACE | grep -q "LOWER_UP"; then
  echo "LOWER_UP=oui"
else
  echo "LOWER_UP=non"
fi

if ip link show $IFACE | grep -q "NO-CARRIER"; then
  echo "NO_CARRIER_FLAG=oui"
else
  echo "NO_CARRIER_FLAG=non"
fi

if [ "$CARRIER" = "1" ]; then
  echo "VERDICT=LIEN_PHYSIQUE_OK"
  exit 0
else
  echo "VERDICT=LIEN_PHYSIQUE_ABSENT"
  exit 1
fi
LINKCHK
chmod +x /tmp/link-check.sh`);
  }

  describe('effets immédiats sur le poste Linux lors du débranchement', () => {
    it('le script link-check.sh voit carrier=1 et LOWER_UP tant que le câble est branché', async () => {
      const out = await run('/tmp/link-check.sh eth0');
      expect(out).toContain('CARRIER=1');
      expect(out).toContain('OPERSTATE=up');
      expect(out).toContain('LOWER_UP=oui');
      expect(out).toContain('VERDICT=LIEN_PHYSIQUE_OK');
    });

    it('après débranchement, le script bascule sur carrier=0 et un code de sortie 1', async () => {
      cable.disconnect();
      const out = await run('/tmp/link-check.sh eth0');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('CARRIER=0');
      expect(out).toContain('OPERSTATE=down');
      expect(out).toContain('LOWER_UP=non');
      expect(out).toContain('NO_CARRIER_FLAG=oui');
      expect(out).toContain('VERDICT=LIEN_PHYSIQUE_ABSENT');
      expect(code).toBe(1);
    });

    it('`ip link show eth0` affiche `state DOWN` sans `LOWER_UP`', async () => {
      cable.disconnect();
      const out = await run('ip link show eth0');
      expect(out).toContain('state DOWN');
      expect(out).not.toContain('LOWER_UP');
    });

    it('`ip addr show eth0` conserve l\'IP configurée alors que le lien est DOWN', async () => {
      cable.disconnect();
      const out = await run('ip addr show eth0');
      expect(out).toContain('inet 192.168.10.101/24');
      expect(out).toContain('state DOWN');
    });

    it('un message de perte de lien est journalisé dans /var/log/syslog', async () => {
      cable.disconnect();
      const out = await run('grep "eth0" /var/log/syslog | tail -5');
      expect(out).toMatch(/eth0: Link is Down/);
    });

    it('gap confirmé : le message systemd-networkd « Lost carrier » n\'est pas produit', async () => {
      cable.disconnect();
      const syslog = await run('cat /var/log/syslog');
      expect(syslog).toContain('Lost carrier');
    });

    it('ping vers la passerelle échoue avec 100% de perte', async () => {
      cable.disconnect();
      const out = await run('ping -c 3 192.168.10.254');
      expect(out).toContain('100% packet loss');
      expect(out).toMatch(/Unreachable|unreachable/);
    });
  });

  describe('diagnostic depuis le switch Cisco', () => {
    it('`show interfaces FastEthernet0/1` passe de « up » à « down »', async () => {
      const avant = await swRun('show interfaces FastEthernet0/1');
      expect(avant).toContain('FastEthernet0/1 is up, line protocol is up');

      cable.disconnect();
      const apres = await swRun('show interfaces FastEthernet0/1');
      expect(apres).toContain('FastEthernet0/1 is down, line protocol is down');
      expect(apres).not.toContain('administratively down');
    });

    it('gap confirmé : le suffixe « (notconnect) » de `show interfaces` n\'est pas rendu', async () => {
      cable.disconnect();
      const out = await swRun('show interfaces FastEthernet0/1');
      expect(out).toContain('line protocol is down (notconnect)');
    });

    it('`show interfaces status` affiche `notconnect` pour le port débranché', async () => {
      const avant = await swRun('show interfaces status');
      expect(avant).toMatch(/Fa0\/1\s+connected/);

      cable.disconnect();
      const apres = await swRun('show interfaces status');
      expect(apres).toMatch(/Fa0\/1\s+notconnect/);
    });
  });

  describe('impact sur les services et sessions actives', () => {
    it('l\'adresse IP reste configurée après la perte du lien (pas de libération de bail)', async () => {
      cable.disconnect();
      const out = await run("ip addr show eth0 | grep 'inet '");
      expect(out).toContain('192.168.10.101/24');
    });

    it('plus aucun paquet ne peut être émis une fois la porteuse perdue', async () => {
      cable.disconnect();
      expect(await run('ping -c 1 192.168.10.254')).toContain('100% packet loss');
    });

    it('la route connectée reste dans la table, marquée `linkdown`', async () => {
      // `docs/PRD-Link-State.md` §1.2 rangeait « `ip route` retire la
      // route connectée d'un port sans câble » parmi les comportements
      // réputés corrects. Ni la régression ni le constat jamais vrai :
      // le PRD confondait deux causes. Linux ne retire la route
      // connectée que lorsque l'interface est descendue
      // administrativement ; une simple perte de porteuse la conserve et
      // la marque `linkdown` — c'est ce drapeau qui dit à
      // l'administrateur que la route existe mais que rien ne peut
      // sortir par là. Les deux cas sont vérifiés, ici et juste après.
      const avant = await run('ip route show');
      expect(avant).toContain('192.168.10.0/24');
      expect(avant).not.toContain('linkdown');

      cable.disconnect();
      const apres = await run('ip route show');
      expect(apres).toContain('192.168.10.0/24');
      expect(apres).toMatch(/192\.168\.10\.0\/24.*linkdown/);
    });

    it('l\'interface descendue administrativement, elle, perd sa route connectée', async () => {
      await run('sudo ip link set eth0 down');
      expect(await run('ip route show')).not.toContain('192.168.10.0/24');
    });
  });

  describe('reprise après reconnexion du câble', () => {
    it('la reconnexion remonte le lien : carrier=1, LOWER_UP, verdict OK', async () => {
      cable.disconnect();
      const casse = await run('/tmp/link-check.sh eth0');
      expect(casse).toContain('VERDICT=LIEN_PHYSIQUE_ABSENT');

      const reconnecte = new Cable('lien-pc1-bis');
      reconnecte.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);

      const repris = await run('/tmp/link-check.sh eth0');
      const code = Number((await run('echo $?')).trim());
      expect(repris).toContain('CARRIER=1');
      expect(repris).toContain('LOWER_UP=oui');
      expect(repris).toContain('VERDICT=LIEN_PHYSIQUE_OK');
      expect(code).toBe(0);
    });

    it('le switch réaffiche `connected` après reconnexion', async () => {
      cable.disconnect();
      expect(await swRun('show interfaces status')).toMatch(/Fa0\/1\s+notconnect/);

      const reconnecte = new Cable('lien-pc1-bis');
      reconnecte.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);

      const apres = await swRun('show interfaces status');
      expect(apres).toMatch(/Fa0\/1\s+connected/);
      expect(await swRun('show interfaces FastEthernet0/1'))
        .toContain('FastEthernet0/1 is up, line protocol is up');
    });

    it('un message de rétablissement du lien est journalisé', async () => {
      cable.disconnect();
      const reconnecte = new Cable('lien-pc1-bis');
      reconnecte.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);

      const out = await run('grep "eth0: Link is" /var/log/syslog | tail -3');
      expect(out).toMatch(/eth0: Link is Up/);
    });
  });

  describe('critère de réussite', () => {
    it('perte du lien détectée côté poste ET côté switch, puis reprise complète validée', async () => {
      cable.disconnect();

      const diag = await run('/tmp/link-check.sh eth0');
      expect(diag).toContain('VERDICT=LIEN_PHYSIQUE_ABSENT');
      expect(await swRun('show interfaces status')).toMatch(/Fa0\/1\s+notconnect/);

      const reconnecte = new Cable('lien-pc1-bis');
      reconnecte.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);

      expect(await run('/tmp/link-check.sh eth0'))
        .toContain('VERDICT=LIEN_PHYSIQUE_OK');
      expect(await swRun('show interfaces status')).toMatch(/Fa0\/1\s+connected/);
    });
  });
});
