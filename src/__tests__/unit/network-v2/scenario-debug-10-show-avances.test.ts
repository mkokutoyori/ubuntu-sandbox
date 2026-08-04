/**
 * Scénario 10 (debug Cisco) — `show commands` avancés : compléments
 * indispensables au debug.
 *
 * Transcription littérale : un routeur du LAN Mandeng présente des
 * comportements intermittents. Avant d'activer des debugs verbeux, on
 * évalue l'état général via `show processes cpu sorted` (règle : jamais de
 * `debug ip packet` au-dessus de 30 % de CPU), `show logging` (historique
 * des flaps), `show tech-support` (sections clés), puis on lance le script
 * bash de collecte de diagnostic — écrit sur disque et exécuté — qui
 * interroge le routeur en SSH et produit un dossier consolidé.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 10 (debug) — show commands avancés', () => {
  const LONG = 60_000;
  let rtr: CiscoRouter;
  let admin: LinuxPC;
  let lienWan: Cable;
  let lan: string;
  let wan: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    admin = new LinuxPC('linux-pc', 'poste-admin', 0, 0);
    rtr.powerOn();
    admin.powerOn();

    [lan, wan] = rtr.getPortNames();
    new Cable('lan').connect(rtr.getPort(lan)!, admin.getPort('eth0')!);

    await rtr.executeCommand('enable');
    await rtr.executeCommand('configure terminal');
    await rtr.executeCommand(`interface ${lan}`);
    await rtr.executeCommand('ip address 192.168.10.254 255.255.255.0');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('exit');
    await rtr.executeCommand(`interface ${wan}`);
    await rtr.executeCommand('description LIEN-WAN-FAI');
    await rtr.executeCommand('ip address 203.0.113.1 255.255.255.252');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('exit');
    // Buffer de logs et horodatage milliseconde, comme préconisé par le scénario.
    await rtr.executeCommand('logging buffered 1000000 debug');
    await rtr.executeCommand('service timestamps debug datetime msec');
    await rtr.executeCommand('service timestamps log datetime msec');
    // Accès SSH pour la collecte à distance.
    await rtr.executeCommand('username admin privilege 15 secret Mandeng2025');
    await rtr.executeCommand('ip domain-name mandeng.local');
    await rtr.executeCommand('crypto key generate rsa modulus 1024');
    await rtr.executeCommand('line vty 0 4');
    await rtr.executeCommand('transport input ssh');
    await rtr.executeCommand('login local');
    await rtr.executeCommand('exit');
    await rtr.executeCommand('end');

    admin.configureInterface('eth0', new IPAddress('192.168.10.50'), new SubnetMask('255.255.255.0'));

    // Le lien WAN flappe : c'est le motif attendu dans le buffer de logs.
    lienWan = new Cable('lien-wan');
  });

  const run = (cmd: string): Promise<string> => rtr.executeCommand(cmd);
  const shell = (cmd: string): Promise<string> => admin.executeCommand(cmd);

  describe('show processes cpu — évaluation avant debug', () => {
    it('expose l\'utilisation CPU 5 s / 1 min / 5 min', async () => {
      const out = await run('show processes cpu sorted');
      expect(out).toMatch(/CPU utilization for five seconds:\s*\d+%\/\d+%; one minute:\s*\d+%; five minutes:\s*\d+%/);
    });

    it('expose l\'en-tête de tableau des processus', async () => {
      const out = await run('show processes cpu sorted');
      expect(out).toMatch(/PID\s+Runtime\(ms\)\s+Invoked\s+uSecs\s+5Sec\s+1Min\s+5Min\s+TTY\s+Process/);
    });

    it('les processus clés du diagnostic devraient être listés (IP Input, OSPF Router, Crypto Engine)', async () => {
      const out = await run('show processes cpu sorted');
      expect(out).toMatch(/IP Input/);
      expect(out).toMatch(/OSPF Router|Crypto Engine/);
    });

    it('`show processes cpu sorted | head -20` limite la sortie à 20 lignes', async () => {
      const out = await run('show processes cpu sorted | head -20');
      expect(out).not.toContain('Invalid input');
      expect(out.split('\n').length).toBeLessThanOrEqual(20);
    });

    it('le taux CPU relevé permet d\'appliquer la règle « pas de debug ip packet au-dessus de 30 % »', async () => {
      const out = await run('show processes cpu sorted');
      const m = /CPU utilization for five seconds:\s*(\d+)%/.exec(out);
      expect(m).not.toBeNull();
      const cpu = Number(m![1]);
      expect(cpu).toBeGreaterThanOrEqual(0);
      expect(cpu).toBeLessThanOrEqual(100);
    });

    it('`show processes memory sorted` complète l\'évaluation avant debug', async () => {
      const out = await run('show processes memory sorted');
      expect(out).not.toContain('Invalid input');
      expect(out).toMatch(/Processor Pool Total|Holding/i);
    });
  });

  describe('show logging — historique des événements', () => {
    it('expose l\'en-tête syslog complet', async () => {
      const out = await run('show logging');
      expect(out).toMatch(/Syslog logging: enabled/);
      expect(out).toMatch(/Console logging: level/);
      expect(out).toMatch(/Monitor logging: level/);
      expect(out).toMatch(/Buffer logging: level/);
    });

    it('`logging buffered 1000000 debug` devrait redimensionner le buffer annoncé', async () => {
      expect(await run('show logging')).toMatch(/Buffer logging: level debugging, 1000000 bytes/);
    });

    it('`service timestamps debug datetime msec` devrait horodater le buffer à la milliseconde', async () => {
      lienWan.connect(rtr.getPort(wan)!, admin.getPort('eth0')!);
      lienWan.disconnect();

      const out = await run('show logging');
      expect(out).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    }, LONG);

    it('le motif de flap du lien WAN est traçable via `show logging | include LINK-3-UPDOWN`', async () => {
      for (let i = 0; i < 3; i++) {
        lienWan.connect(rtr.getPort(wan)!, admin.getPort('eth0')!);
        lienWan.disconnect();
      }

      const out = await run('show logging | include LINK-3-UPDOWN');
      expect(out).toMatch(/LINK-3-UPDOWN/);
    }, LONG);

    it('`show logging | include <motif>` filtre bien le buffer', async () => {
      const out = await run('show logging | include IFMGR');
      expect(out).toMatch(/IFMGR/);
      expect(out).not.toMatch(/Syslog logging: enabled/);
    });

    it('`show logging count` devrait produire un décompte par message', async () => {
      const out = await run('show logging count');
      expect(out).toMatch(/Facility\s+Message Name\s+Sev\s+Occur|Total: \d+/i);
    });
  });

  describe('show tech-support — sections clés', () => {
    it('agrège les sections version / running-config / interfaces / routage', async () => {
      const out = await run('show tech-support');
      expect(out).toContain('------------------ show version ------------------');
      expect(out).toContain('------------------ show running-config ------------------');
      expect(out).toContain('------------------ show interfaces ------------------');
      expect(out).toContain('------------------ show ip route ------------------');
    }, LONG);

    it('inclut la version IOS et le matériel', async () => {
      const out = await run('show tech-support');
      expect(out).toMatch(/Cisco IOS Software/);
      expect(out).toMatch(/uptime is/);
    }, LONG);

    it('`show tech-support` devrait couvrir les processus, le NAT et les adjacences OSPF', async () => {
      const out = await run('show tech-support');
      expect(out).toContain('show processes cpu');
      expect(out).toContain('show ip nat translations');
      expect(out).toContain('show ip ospf neighbor');
    }, LONG);

    it('`show tech-support | redirect <cible>` est accepté', async () => {
      const out = await run('show tech-support | redirect tftp://192.168.99.10/tech-support-20250701.txt');
      expect(out).not.toContain('Invalid input');
    }, LONG);
  });

  describe('commandes de corrélation du workflow de diagnostic', () => {
    const etape1 = [
      'show version',
      'show processes cpu sorted',
      'show interfaces',
      'show logging',
      'show ip route',
    ];

    it.each(etape1)('ÉTAPE 1 — `%s` est toujours sûre et retourne une sortie exploitable', async (cmd) => {
      const out = await run(cmd);
      expect(out).not.toContain('Invalid input');
      expect(out.trim().length).toBeGreaterThan(0);
    }, LONG);

    it('`show clock detail` situe les événements dans le temps', async () => {
      const out = await run('show clock detail');
      expect(out).not.toContain('Invalid input');
      expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('`u all` (abréviation de `undebug all`) est reconnue', async () => {
      expect(await run('u all')).toContain('All possible debugging has been turned off');
    });
  });

  describe('script bash de collecte de diagnostic', () => {
    const CHEMIN = '/tmp/collecte-diagnostic-cisco.sh';

    async function ecrireLeScript(): Promise<void> {
      const script = `#!/bin/bash
# Script de collecte de diagnostic Cisco depuis une machine Linux
ROUTER_IP="192.168.10.254"
ROUTER_USER="admin"
DIAG_DIR="/tmp/cisco-diag"
mkdir -p "$DIAG_DIR"

# Fonction d'exécution de commande Cisco
cisco_show() {
    local cmd="$1"
    local safe_name=$(echo "$cmd" | tr ' /|' '_')
    ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no \\
        "$ROUTER_USER@$ROUTER_IP" "$cmd" 2>/dev/null \\
        > "$DIAG_DIR/\${safe_name}.txt"
    echo "OK $cmd -> $DIAG_DIR/\${safe_name}.txt"
}

echo "=== COLLECTE DIAGNOSTIC CISCO RTR-MANDENG-01 ==="
echo ""

# Informations système
cisco_show "show version"
cisco_show "show processes cpu sorted"
cisco_show "show processes memory sorted"
cisco_show "show clock detail"

# Interfaces
cisco_show "show interfaces"
cisco_show "show interfaces status"
cisco_show "show ip interface brief"
cisco_show "show interfaces counters errors"

# Routage
cisco_show "show ip route"
cisco_show "show ip protocols"
cisco_show "show ip ospf neighbor detail"
cisco_show "show ip ospf database"

# NAT
cisco_show "show ip nat translations verbose"
cisco_show "show ip nat statistics"

# ARP et MAC
cisco_show "show arp"
cisco_show "show ip arp"

# VPN (si applicable)
cisco_show "show crypto isakmp sa detail"
cisco_show "show crypto ipsec sa"
cisco_show "show crypto session"

# DHCP
cisco_show "show ip dhcp binding"
cisco_show "show ip dhcp conflict"
cisco_show "show ip dhcp pool"

# Logs
cisco_show "show logging"
cisco_show "show logging count"

# STP (sur switch)
cisco_show "show spanning-tree summary"
cisco_show "show spanning-tree detail"

echo ""
echo "=== COLLECTE TERMINEE ==="
echo "Fichiers disponibles dans: $DIAG_DIR"
ls -la "$DIAG_DIR"

# Creer un rapport consolide
echo ""
echo "=== RAPPORT RAPIDE ==="
echo ""

# CPU
echo "-- CPU ---------------------------------"
grep "CPU utilization" "$DIAG_DIR/show_processes_cpu_sorted.txt" | head -3

# Interfaces en erreur
echo ""
echo "-- INTERFACES EN ERREUR ----------------"
grep -A 2 "input errors" "$DIAG_DIR/show_interfaces.txt" | \\
    grep -v "^0 " | grep -v "^--$" | head -20

# Logs recents
echo ""
echo "-- DERNIERS LOGS -----------------------"
tail -20 "$DIAG_DIR/show_logging.txt"
`;
      await shell(`cat > ${CHEMIN} <<'FIN_DU_SCRIPT'\n${script}FIN_DU_SCRIPT`);
      await shell(`chmod +x ${CHEMIN}`);
    }

    it('le script est écrit sur disque et rendu exécutable', async () => {
      await ecrireLeScript();

      expect(await shell(`test -x ${CHEMIN} && echo EXECUTABLE`)).toContain('EXECUTABLE');
      expect(await shell(`head -1 ${CHEMIN}`)).toContain('#!/bin/bash');
    }, LONG);

    it('le script s\'exécute et annonce le début et la fin de la collecte', async () => {
      await ecrireLeScript();
      const out = await shell(`bash ${CHEMIN}`);

      expect(out).toContain('=== COLLECTE DIAGNOSTIC CISCO RTR-MANDENG-01 ===');
      expect(out).toContain('=== COLLECTE TERMINEE ===');
      expect(out).toContain('=== RAPPORT RAPIDE ===');
    }, LONG);

    it('le script crée le dossier de diagnostic et l\'énumère', async () => {
      await ecrireLeScript();
      await shell(`bash ${CHEMIN}`);

      const listing = await shell('ls /tmp/cisco-diag');
      expect(listing).toContain('show_version.txt');
      expect(listing).toContain('show_ip_route.txt');
      expect(listing).toContain('show_logging.txt');
    }, LONG);

    it('le script trace chaque commande collectée', async () => {
      await ecrireLeScript();
      const out = await shell(`bash ${CHEMIN}`);

      expect(out).toContain('OK show version ->');
      expect(out).toContain('OK show ip route ->');
      expect(out).toContain('OK show spanning-tree detail ->');
    }, LONG);

    it('la collecte SSH non interactive remplit bien le fichier `show version`', async () => {
      await ecrireLeScript();
      await shell(`bash ${CHEMIN}`);

      const version = await shell('cat /tmp/cisco-diag/show_version.txt');
      expect(version).toMatch(/Cisco IOS Software/);
    }, LONG);

    it('la collecte SSH remplit show ip route / show interfaces / show arp', async () => {
      await ecrireLeScript();
      await shell(`bash ${CHEMIN}`);

      expect(await shell('cat /tmp/cisco-diag/show_ip_route.txt')).toMatch(/directly connected/);
      expect(await shell('cat /tmp/cisco-diag/show_interfaces.txt')).toMatch(/line protocol is/);
      expect(await shell('cat /tmp/cisco-diag/show_arp.txt')).toMatch(/Protocol\s+Address/);
    }, LONG);

    it('la collecte SSH remplit show processes cpu sorted', async () => {
      await ecrireLeScript();
      await shell(`bash ${CHEMIN}`);

      expect(await shell('cat /tmp/cisco-diag/show_processes_cpu_sorted.txt'))
        .toMatch(/CPU utilization for five seconds/);
    }, LONG);

    it('le rapport rapide devrait extraire la ligne d\'utilisation CPU', async () => {
      await ecrireLeScript();
      const out = await shell(`bash ${CHEMIN}`);

      expect(out).toMatch(/CPU utilization for five seconds/);
    }, LONG);

    it('le rapport rapide extrait les derniers logs collectés', async () => {
      await ecrireLeScript();
      const out = await shell(`bash ${CHEMIN}`);

      const idx = out.indexOf('-- DERNIERS LOGS');
      expect(idx).toBeGreaterThan(-1);
      expect(out.slice(idx)).toMatch(/Syslog logging|%[A-Z_]+-\d-/);
    }, LONG);

    it('le script se termine avec un code de sortie nul', async () => {
      await ecrireLeScript();
      await shell(`bash ${CHEMIN}`);

      expect((await shell('echo $?')).trim()).toBe('0');
    }, LONG);
  });
});
