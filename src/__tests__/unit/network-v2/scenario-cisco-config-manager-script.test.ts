/**
 * Scénario 10 — Intégration complète : script bash de gestion de
 * configuration Cisco gérant tous les cas spéciaux (!, #, ^C,
 * délimiteurs de bannière, indentation, copy-paste).
 *
 * Le script cisco-config-manager.sh du scénario s'appuie sur `ssh` pour
 * dialoguer avec les équipements. Adaptation assumée (même convention
 * que les scénarios 5/8) : le client ssh du simulateur ne rejoue pas un
 * flux stdin de commandes CLI ; on teste donc les FONCTIONS bash pures
 * du script (nettoyage de config, garde-fou du délimiteur de bannière,
 * parsing de sections, audit sécurité + code de sortie) exécutées sur un
 * LinuxPC, et on vérifie le versant Cisco en rejouant la config générée
 * sur un CiscoRouter. Le cœur du scénario — la robustesse du bash face
 * aux !, #, ^C et le code de retour de l'audit — reste testé fidèlement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;
beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
});

describe('Scénario 10 — cisco-config-manager.sh : gestion des cas spéciaux', () => {
  describe('cisco_config — nettoyage de la config avant envoi', () => {
    it("supprime les en-têtes show run et le `end` final, mais PRÉSERVE tous les ! et # internes", async () => {
      const script = `
cisco_clean() {
  echo "$1" | \\
    grep -v '^Building configuration' | \\
    grep -v '^Current configuration' | \\
    grep -v '^! Last configuration' | \\
    grep -v '^! NVRAM config' | \\
    sed 's/^end$//' | \\
    sed '/^[[:space:]]*$/d'
}
RAW='Building configuration...
Current configuration : 1283 bytes
! Last configuration change at 10:00
!
hostname SW-MANDENG-01
!
banner motd ^C
# Ref: #INC en cas de probleme
^C
!
line vty 0 15
 transport input ssh
end'
cisco_clean "$RAW"
`;
      const out = await pc.executeCommand(script);
      const lines = out.split('\n');
      // En-têtes retirés.
      expect(out).not.toMatch(/^Building configuration/m);
      expect(out).not.toMatch(/^Current configuration/m);
      expect(out).not.toMatch(/^! Last configuration/m);
      // `end` final retiré (plus aucune ligne exactement "end").
      expect(lines).not.toContain('end');
      // ! séparateurs de bloc et # internes PRÉSERVÉS.
      expect(lines).toContain('!');
      expect(lines).toContain('# Ref: #INC en cas de probleme');
      expect(out).toContain('hostname SW-MANDENG-01');
      expect(out).toContain('transport input ssh');
    });
  });

  describe('cisco_set_banner — garde-fou du délimiteur (critère de réussite explicite)', () => {
    it("REFUSE (exit 1) un contenu qui contient le délimiteur choisi, AVANT tout envoi", async () => {
      const script = `
SAFE_BANNER_DELIMITER='$'
cisco_set_banner_guard() {
  local banner_content="$1"
  if echo "$banner_content" | grep -qF "$SAFE_BANNER_DELIMITER"; then
    echo "ERREUR: Le contenu de la banniere contient le delimiteur '$SAFE_BANNER_DELIMITER'" >&2
    return 1
  fi
  echo "OK"
  return 0
}
cisco_set_banner_guard 'Cout: 5\\$ par acces'   # contient un $
echo "exit=$?"
`;
      const out = await pc.executeCommand(script);
      expect(out).toMatch(/ERREUR: Le contenu de la banniere contient le delimiteur/);
      expect(out).toMatch(/exit=1/);
      expect(out).not.toContain('OK');
    });

    it("ACCEPTE (exit 0) un contenu sans le délimiteur, même s'il contient des # et pseudo-graphiques", async () => {
      const script = `
SAFE_BANNER_DELIMITER='$'
cisco_set_banner_guard() {
  local banner_content="$1"
  if echo "$banner_content" | grep -qF "$SAFE_BANNER_DELIMITER"; then
    echo "ERREUR" >&2
    return 1
  fi
  echo "OK"
  return 0
}
BANNER='Ref: #INC si probleme
Contact: admin@mandeng.lan'
cisco_set_banner_guard "$BANNER"
echo "exit=$?"
`;
      const out = await pc.executeCommand(script);
      expect(out).toContain('OK');
      expect(out).toMatch(/exit=0/);
    });
  });

  describe('cisco_parse_sections — awk : directives, enfants indentés, séparateurs !', () => {
    it("classe chaque ligne (DIRECTIVE / CHILD / SECTION) et ignore les en-têtes show run", async () => {
      const script = `
cisco_parse_sections() {
  echo "$1" | awk '
    /^!$/ { if (current_block != "") { print "SECTION: " current_block; current_block = "" } next }
    /^Building|^Current configuration/ { next }
    /^! (Last|NVRAM)/ { next }
    /^ / { if (current_block != "") print "  CHILD: " $0; next }
    /^[a-zA-Z]/ { current_block = $0; print "DIRECTIVE: " $0 }
  '
}
RUN='Building configuration...
!
interface GigabitEthernet0/0
 ip address 192.168.10.1 255.255.255.0
 no shutdown
!
line vty 0 15
 transport input ssh'
cisco_parse_sections "$RUN"
`;
      const out = await pc.executeCommand(script);
      expect(out).toContain('DIRECTIVE: interface GigabitEthernet0/0');
      expect(out).toContain('  CHILD:  ip address 192.168.10.1 255.255.255.0');
      expect(out).toContain('  CHILD:  no shutdown');
      expect(out).toContain('SECTION: interface GigabitEthernet0/0');
      expect(out).toContain('DIRECTIVE: line vty 0 15');
      // L'en-tête show run est ignoré.
      expect(out).not.toMatch(/Building configuration/);
    });
  });

  describe('cisco_audit — détection des non-conformités + code de sortie', () => {
    const auditScript = (showRun: string) => `
cisco_audit() {
  local show_run="$1"
  local issues=0
  if echo "$show_run" | grep -qE 'password 0 |^password [^78]'; then
    echo "CRITIQUE: mot de passe en clair"; issues=$((issues + 1))
  fi
  if echo "$show_run" | grep -q '^enable secret'; then
    echo "OK: enable secret"
  else
    echo "CRITIQUE: enable secret manquant"; issues=$((issues + 1))
  fi
  if echo "$show_run" | grep -q '^service password-encryption'; then
    echo "OK: password-encryption"
  else
    echo "AVERT: password-encryption absent"
  fi
  if echo "$show_run" | grep -q '^banner motd'; then
    echo "OK: banniere"
  else
    echo "AVERT: aucune banniere"
  fi
  local vty
  vty=$(echo "$show_run" | awk '/^line vty/{f=1} f && /transport input/{print; f=0}')
  if echo "$vty" | grep -q 'ssh$'; then
    echo "OK: vty ssh only"
  else
    echo "ANOMALIE: vty telnet/all"; issues=$((issues + 1))
  fi
  if echo "$show_run" | grep -q '^login block-for'; then
    echo "OK: brute-force protection"
  else
    echo "AVERT: login block-for absent"
  fi
  echo "issues=$issues"
  return $issues
}
cisco_audit "$SHOW_RUN"
echo "exit=$?"
`;

    it("config CONFORME : aucun problème critique, exit 0", async () => {
      const conforming = `hostname SW-MANDENG-01
enable secret 5 $1$abc$hashed
service password-encryption
login block-for 120 attempts 5 within 30
banner motd ^C
Acces restreint
^C
line vty 0 15
 transport input ssh`;
      const out = await pc.executeCommand(`SHOW_RUN='${conforming.replace(/'/g, "'\\''")}'\n${auditScript(conforming)}`);
      expect(out).toContain('issues=0');
      expect(out).toMatch(/exit=0/);
      expect(out).toContain('OK: enable secret');
      expect(out).toContain('OK: vty ssh only');
    });

    it("config NON conforme : enable secret manquant + vty telnet → issues=2, exit 2", async () => {
      const nonConforming = `hostname R1
service password-encryption
line vty 0 15
 transport input telnet`;
      const out = await pc.executeCommand(`SHOW_RUN='${nonConforming.replace(/'/g, "'\\''")}'\n${auditScript(nonConforming)}`);
      expect(out).toContain('CRITIQUE: enable secret manquant');
      expect(out).toContain('ANOMALIE: vty telnet/all');
      expect(out).toContain('issues=2');
      expect(out).toMatch(/exit=2/);
    });
  });

  describe('apply-config baseline — la config générée s\'applique sur un vrai routeur Cisco', () => {
    it("le fichier baseline (hostname, ssh, vty, login block-for) est rejoué sans erreur bloquante", async () => {
      const baseline = [
        'hostname SW-MANDENG-01',
        'ip domain-name mandeng.lan',
        'service password-encryption',
        'login block-for 120 attempts 5 within 30',
        'ip ssh version 2',
        'line vty 0 15',
        ' exec-timeout 5 0',
        ' transport input ssh',
        ' login local',
      ];
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      for (const line of baseline) {
        const out = await r.executeCommand(line);
        expect(out).not.toMatch(/Invalid input detected/);
      }
      await r.executeCommand('end');

      expect(r.getPrompt()).toBe('SW-MANDENG-01#');
      const run = await r.executeCommand('show running-config');
      expect(run).toContain('hostname SW-MANDENG-01');
      expect(run).toContain('transport input ssh');
    });
  });
});
