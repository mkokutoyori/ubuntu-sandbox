/**
 * Scénario 5 — Heredoc bash pour envoyer des configurations multi-lignes
 * à un équipement Cisco.
 *
 * Heredoc quoté (<< 'EOF') : aucun caractère !, #, $ n'est interprété.
 * Heredoc non quoté : les variables bash sont expandées, \$ protège le $
 * destiné à Cisco. La méthode la plus robuste passe par un fichier
 * temporaire vérifiable avant envoi.
 *
 * Adaptation assumée : le client ssh du simulateur n'exécute pas un flux
 * stdin de commandes CLI ; l'application au routeur est donc vérifiée en
 * rejouant le fichier généré ligne à ligne sur l'équipement — le cœur du
 * scénario (ce que bash produit exactement) reste testé octet par octet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scénario 5 — Heredoc bash vers configuration Cisco', () => {
  describe('problème 1 — expansion des variables dans heredoc', () => {
    it('heredoc sans protection : $HOSTNAME et $VLAN_ID sont expandés (voulu)', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`HOSTNAME="SW-MANDENG-01"
VLAN_ID=10
cat << EOF
configure terminal
hostname $HOSTNAME
vlan $VLAN_ID
 name ADMIN
exit
end
EOF`);
      expect(out).toBe([
        'configure terminal',
        'hostname SW-MANDENG-01',
        'vlan 10',
        ' name ADMIN',
        'exit',
        'end',
      ].join('\n'));
    });

    it("heredoc avec quotes sur le délimiteur : tout est littéral, $ ! # préservés", async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`cat << 'EOF'
configure terminal
hostname SW-MANDENG-01
enable secret 5 $1$hash$abcdef
banner motd #
Attention! Acces restreint!
#
end
EOF`);
      expect(out).toBe([
        'configure terminal',
        'hostname SW-MANDENG-01',
        'enable secret 5 $1$hash$abcdef',
        'banner motd #',
        'Attention! Acces restreint!',
        '#',
        'end',
      ].join('\n'));
    });
  });

  describe('problème 2 — ! dans le heredoc et bash', () => {
    it("<< 'EOF' préserve les ! ; set +H désactive l'expansion d'historique sans erreur", async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const quoted = await pc.executeCommand(`cat << 'EOF'
banner motd #
Attention! Accès restreint!
#
EOF`);
      expect(quoted).toBe('banner motd #\nAttention! Accès restreint!\n#');

      const unH = await pc.executeCommand(`set +H
cat << EOF
Attention! Accès restreint!
EOF
set -H`);
      expect(unH).toContain('Attention! Accès restreint!');
    });
  });

  describe('problème 3 — # dans le heredoc envoyé à Cisco', () => {
    it("# dans un heredoc n'est JAMAIS un commentaire bash : contenu intégral restitué", async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`cat << 'CISCO_CONFIG'
configure terminal
banner motd #
Bienvenue sur le routeur Mandeng
Contact: admin@mandeng.lan #principal
#
end
CISCO_CONFIG`);
      expect(out).toBe([
        'configure terminal',
        'banner motd #',
        'Bienvenue sur le routeur Mandeng',
        'Contact: admin@mandeng.lan #principal',
        '#',
        'end',
      ].join('\n'));
    });

    it("côté Cisco, le # de « #principal » ferme la bannière prématurément (piège documenté)", async () => {
      // Bash a transmis fidèlement — mais IOS tronque au premier # :
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #');
      await r.executeCommand('Bienvenue sur le routeur Mandeng');
      await r.executeCommand('Contact: admin@mandeng.lan #principal');
      // La bannière s'est fermée sur ce # : la ligne '#' suivante n'est
      // plus dans la bannière.
      expect(r.getBanner('motd')).toBe(
        'Bienvenue sur le routeur Mandeng\nContact: admin@mandeng.lan ',
      );
      const hash = await r.executeCommand('#');
      expect(hash).toContain('% Invalid input');
      await r.executeCommand('end');
    });
  });

  describe('solution complète — fichier temporaire robuste', () => {
    it('mktemp + heredoc quoté : le fichier généré est identique octet par octet, vérifiable avant envoi', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const script = `CONFIG_FILE=$(mktemp /tmp/cisco-config-XXXXX.txt)
cat << 'CISCO_CONFIG' > "$CONFIG_FILE"
configure terminal
!
hostname SW-MANDENG-01
!
banner motd $
╔══════════════════════════════════════╗
║  RÉSEAU MANDENG - ACCÈS RESTREINT   ║
║  Contact: admin@mandeng.lan         ║
║  Ref ticket: #INC-2025 (si pb)      ║
╚══════════════════════════════════════╝
$
!
line vty 0 4
 exec-timeout 5 0
 transport input ssh
 login local
!
end
CISCO_CONFIG
echo "PATH=$CONFIG_FILE"
cat "$CONFIG_FILE"`;
      const out = await pc.executeCommand(script);

      const pathLine = out.split('\n').find((l) => l.startsWith('PATH='))!;
      expect(pathLine).toMatch(/^PATH=\/tmp\/cisco-config-.+\.txt$/);

      const body = out.slice(out.indexOf('\n', out.indexOf('PATH=')) + 1);
      expect(body).toBe([
        'configure terminal',
        '!',
        'hostname SW-MANDENG-01',
        '!',
        'banner motd $',
        '╔══════════════════════════════════════╗',
        '║  RÉSEAU MANDENG - ACCÈS RESTREINT   ║',
        '║  Contact: admin@mandeng.lan         ║',
        '║  Ref ticket: #INC-2025 (si pb)      ║',
        '╚══════════════════════════════════════╝',
        '$',
        '!',
        'line vty 0 4',
        ' exec-timeout 5 0',
        ' transport input ssh',
        ' login local',
        '!',
        'end',
      ].join('\n'));
    });

    it('le fichier généré, rejoué sur le routeur, applique hostname, bannière et VTY sans erreur bloquante', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      await pc.executeCommand(`cat << 'CISCO_CONFIG' > /tmp/push.txt
configure terminal
!
hostname SW-MANDENG-01
!
banner motd $
║  RÉSEAU MANDENG - ACCÈS RESTREINT   ║
║  Ref ticket: #INC-2025 (si pb)      ║
$
!
line vty 0 4
 exec-timeout 5 0
 transport input ssh
!
end
CISCO_CONFIG`);
      const content = await pc.executeCommand('cat /tmp/push.txt');

      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      for (const line of content.split('\n')) {
        await r.executeCommand(line);
      }

      expect(r.getPrompt()).toBe('SW-MANDENG-01#');
      expect(r.getBanner('motd')).toBe(
        '║  RÉSEAU MANDENG - ACCÈS RESTREINT   ║\n║  Ref ticket: #INC-2025 (si pb)      ║',
      );
      const run = await r.executeCommand('show running-config');
      expect(run).toContain(' transport input ssh');
    });
  });

  describe('cas spécial — injection de variables avec \\$ échappé', () => {
    it('heredoc sans quotes : ${SITE_NAME} expandé, \\$ devient $ littéral (délimiteur Cisco)', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`SITE_NAME="MANDENG-DOUALA"
MGMT_IP="192.168.99.10"
SNMP_COMMUNITY="Mandeng2025"
cat << CONFIG
configure terminal
hostname SW-\${SITE_NAME}-01
snmp-server community \${SNMP_COMMUNITY} RO
snmp-server host \${MGMT_IP} version 2c \${SNMP_COMMUNITY}
banner motd \\$
  Système: SW-\${SITE_NAME}-01
  IP mgmt: \${MGMT_IP}
\\$
end
CONFIG`);
      expect(out).toBe([
        'configure terminal',
        'hostname SW-MANDENG-DOUALA-01',
        'snmp-server community Mandeng2025 RO',
        'snmp-server host 192.168.99.10 version 2c Mandeng2025',
        'banner motd $',
        '  Système: SW-MANDENG-DOUALA-01',
        '  IP mgmt: 192.168.99.10',
        '$',
        'end',
      ].join('\n'));
    });
  });

  describe('critère de réussite', () => {
    it("<< 'EOF' préserve !, #, $ ; << EOF injecte les variables en protégeant via \\$ ; fichier temporaire vérifiable", async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);

      const quoted = await pc.executeCommand(`cat << 'EOF'
!$#
enable secret $1$x$y
EOF`);
      expect(quoted).toBe('!$#\nenable secret $1$x$y');

      const injected = await pc.executeCommand(`H="SW-X"
cat << EOF
hostname $H
delim \\$
EOF`);
      expect(injected).toBe('hostname SW-X\ndelim $');

      await pc.executeCommand(`cat << 'EOF' > /tmp/verify.txt
banner motd #
#
EOF`);
      expect(await pc.executeCommand('cat /tmp/verify.txt')).toBe('banner motd #\n#');
    });
  });
});
