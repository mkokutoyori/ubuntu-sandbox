/**
 * Sanity tests for the new CLI foundation (`command-kernel/cli/`) as
 * plugged into the router equipment stack. Exercises the single-gate
 * pipeline end-to-end : `Router.executeCommand` → `CliInterpreter` →
 * hierarchical resolution → command execution → typed output.
 *
 * These tests are the executable proof that the legacy `IRouterShell`
 * is no longer consulted for command execution. Any command not yet
 * migrated to the new registry MUST fail through this path (that's
 * the migration signal).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  EquipmentRegistry.resetInstance();
});

describe('Router CLI foundation — command-kernel single-gate pipeline', () => {
  describe('Cisco IOS', () => {
    it('the default prompt is `<hostname>>` (user mode)', () => {
      const r = new CiscoRouter('R1');
      expect(r.getPrompt()).toBe('R1>');
    });

    it('`enable` transitions from user to privileged mode and updates the prompt', async () => {
      const r = new CiscoRouter('R1');
      expect(r.getPrompt()).toBe('R1>');
      await r.executeCommand('enable');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('`disable` transitions back from privileged to user', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('disable');
      expect(r.getPrompt()).toBe('R1>');
    });

    it('`configure terminal` pushes into config mode', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      expect(r.getPrompt()).toBe('R1(config)#');
    });

    it('`exit` from config mode returns to privileged', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('exit');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('`end` from config mode returns straight to privileged', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('end');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('abbreviations resolve preferring unique prefixes (`en` → `enable`, `sh` → `show`, `conf t` → `configure terminal`)', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('en');
      expect(r.getPrompt()).toBe('R1#');
      await r.executeCommand('conf t');
      expect(r.getPrompt()).toBe('R1(config)#');
      await r.executeCommand('end');
      const out = await r.executeCommand('sh version');
      expect(out).toMatch(/Cisco IOS Software/);
    });

    it('`show version` produces the full IOS banner using only MachineApi as data source', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show version');
      expect(out).toMatch(/Cisco IOS Software/);
      expect(out).toMatch(/^R1 uptime is /m);
      expect(out).toMatch(/Version 15\.7\(3\)M5/);
    });

    it('`show` alone is incomplete (no legacy fallback)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show');
      expect(out).toMatch(/Incomplete/);
    });

    it('`show ip interface brief` produces the IOS tabular banner using only MachineApi', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show ip interface brief');
      // En-tête IOS exact (largeurs de colonnes reproduites inline par
      // la commande — aucun formateur legacy).
      expect(out).toMatch(/^Interface {18}IP-Address {6}OK\? Method Status {16}Protocol$/m);
      // Chaque interface de démarrage (GigabitEthernet0/0..3) est listée
      // avec `unassigned` (aucune IP par défaut) et `down`/`down` (câble
      // non connecté).
      expect(out).toMatch(/^GigabitEthernet0\/0 {9}unassigned {6}YES manual down {18}down$/m);
      expect(out).toMatch(/^GigabitEthernet0\/3 /m);
    });

    it('abbreviation `sh ip int br` résout jusqu\'à la feuille (préfixe-unique)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('sh ip int br');
      expect(out).toMatch(/^Interface {18}IP-Address /m);
      expect(out).toMatch(/GigabitEthernet0\/0/);
    });

    it('`show ip` seul est incomplete (composite non exécutable, pas de fallback legacy)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show ip');
      expect(out).toMatch(/Incomplete/);
    });

    it('`show ip interface` seul est incomplete (composite non exécutable)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show ip interface');
      expect(out).toMatch(/Incomplete/);
    });

    it('`show ip route` produit la ligne de codes IOS et « Gateway of last resort » à partir de MachineApi', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show ip route');
      expect(out).toMatch(/^Codes: C - connected, S - static, R - RIP, O - OSPF, D - EIGRP, B - BGP/m);
      // Sans nexthop par défaut → gateway not set.
      expect(out).toMatch(/^Gateway of last resort is not set$/m);
    });

    it('abbreviation `sh ip ro` résout jusqu\'à `show ip route`', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('sh ip ro');
      expect(out).toMatch(/^Codes: C - connected/m);
    });

    // ─── Vague setup config/config-if ─────────────────────────────────

    it('`hostname R99` (config) met à jour le prompt à travers MachineApi', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('hostname R99');
      expect(r.getPrompt()).toBe('R99(config)#');
    });

    it('`interface GigabitEthernet0/0` push config-if avec le nom d\'interface dans le prompt/état', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const out = await r.executeCommand('interface GigabitEthernet0/0');
      expect(out).toBe('');
      expect(r.getPrompt()).toBe('R1(config-if)#');
    });

    it('`interface DoesNotExist` refuse la transition avec le message Cisco et reste en config', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const out = await r.executeCommand('interface DoesNotExist');
      expect(out).toMatch(/Invalid input/);
      expect(r.getPrompt()).toBe('R1(config)#');
    });

    it('`ip address 10.1.1.1 255.255.255.0` (config-if) configure l\'IP, visible dans `show ip interface brief`', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      const out = await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      expect(out).toBe('');
      await r.executeCommand('end');
      const brief = await r.executeCommand('show ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\s+10\.1\.1\.1\s+/m);
    });

    it('`no shutdown` puis IP → route connectée présente dans `show ip route`', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      await r.executeCommand('no shutdown');
      await r.executeCommand('end');
      const routes = await r.executeCommand('show ip route');
      // La route directement connectée doit apparaître avec le code C.
      expect(routes).toMatch(/^C\s+10\.1\.1\.0\/24 is directly connected, GigabitEthernet0\/0$/m);
    });

    it('`shutdown` remet l\'interface admin-down (visible dans show ip int brief)', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('shutdown');
      await r.executeCommand('end');
      const brief = await r.executeCommand('show ip interface brief');
      expect(brief).toMatch(/GigabitEthernet0\/0.*administratively down/);
    });

    it('`no ip address` (config-if) retire l\'IP', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      await r.executeCommand('no ip address');
      await r.executeCommand('end');
      const brief = await r.executeCommand('show ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\s+unassigned\s+/m);
    });

    it('`exit` de config-if efface `selectedInterface` (clearOnExit) et revient à config', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      expect(r.getPrompt()).toBe('R1(config-if)#');
      await r.executeCommand('exit');
      expect(r.getPrompt()).toBe('R1(config)#');
      // Rentrer à nouveau dans config-if, ip address doit demander la
      // sélection (déjà refaite par le nouveau push) — vérif indirecte :
      // pas d'effet résiduel de la session précédente.
      await r.executeCommand('interface GigabitEthernet0/1');
      await r.executeCommand('ip address 10.2.2.2 255.255.255.0');
      await r.executeCommand('end');
      const brief = await r.executeCommand('show ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/1\s+10\.2\.2\.2/m);
    });

    // ─── Vague statiques + description ─────────────────────────────────

    it('`ip route 10.9.9.0 255.255.255.0 192.168.0.2` ajoute une route statique visible dans show ip route', async () => {
      const r = new CiscoRouter('R1');
      // Setup : monter une interface pour que le next-hop soit résolu.
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('ip address 192.168.0.1 255.255.255.0');
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      const setOut = await r.executeCommand('ip route 10.9.9.0 255.255.255.0 192.168.0.2');
      expect(setOut).toBe('');
      await r.executeCommand('end');
      const routes = await r.executeCommand('show ip route');
      // Cisco code `S` pour static + AD 1 par défaut, métrique 0.
      expect(routes).toMatch(/^S\s+10\.9\.9\.0\/24 \[1\/0\] via 192\.168\.0\.2, /m);
    });

    it('`no ip route 10.9.9.0 255.255.255.0 192.168.0.2` retire la route (silencieux si absente)', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('ip address 192.168.0.1 255.255.255.0');
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      await r.executeCommand('ip route 10.9.9.0 255.255.255.0 192.168.0.2');
      await r.executeCommand('no ip route 10.9.9.0 255.255.255.0 192.168.0.2');
      await r.executeCommand('end');
      const routes = await r.executeCommand('show ip route');
      expect(routes).not.toMatch(/10\.9\.9\.0/);
    });

    it('`description Uplink WAN` (config-if) via MachineApi (lecture DTO)', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      const out = await r.executeCommand('description Uplink WAN');
      expect(out).toBe('');
      // Preuve via la MachineApi : la description est bien posée.
      const cli = (r as unknown as { getCommandKernelCli(): { machine: { router: { interface(name: string): { description: string } | null } } } })
        .getCommandKernelCli();
      const info = cli.machine.router.interface('GigabitEthernet0/0');
      expect(info?.description).toBe('Uplink WAN');
    });

    it('`no description` efface la description via MachineApi', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('description Temp');
      await r.executeCommand('no description');
      const cli = (r as unknown as { getCommandKernelCli(): { machine: { router: { interface(name: string): { description: string } | null } } } })
        .getCommandKernelCli();
      const info = cli.machine.router.interface('GigabitEthernet0/0');
      expect(info?.description).toBe('');
    });

    it('an unmigrated command fails through the new pipeline (signal for migration)', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      // `show ip mroute` : vue multicast non migrée →
      // « Incomplete » via le nouveau pipeline (`show ip` composite).
      const out = await r.executeCommand('show ip mroute');
      expect(out).toMatch(/inconnu|Incomplete|not-found|introuvable|Invalid input|Unrecognized command/i);
    });
  });

  describe('Huawei VRP', () => {
    it('the default prompt is `<hostname>` (user-view mode)', () => {
      const r = new HuaweiRouter('R2');
      expect(r.getPrompt()).toBe('<R2>');
    });

    it('`system-view` transitions from user-view to system-view and updates the prompt', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('system-view');
      expect(out).toContain('Enter system view');
      expect(r.getPrompt()).toBe('[R2]');
    });

    it('`quit` from system-view returns to user-view', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('quit');
      expect(r.getPrompt()).toBe('<R2>');
    });

    it('`display version` produces the VRP banner using only MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display version');
      expect(out).toMatch(/Huawei Versatile Routing Platform/);
      expect(out).toMatch(/^R2 uptime is /m);
    });

    it('abbreviations resolve on VRP too (`sys` → `system-view`, `dis ver` → `display version`)', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('sys');
      expect(r.getPrompt()).toBe('[R2]');
      const out = await r.executeCommand('dis ver');
      expect(out).toMatch(/Huawei Versatile Routing Platform/);
    });

    it('`return` (alias VRP de `end`) revient à user-view depuis interface-view', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      expect(r.getPrompt()).toBe('[R2-GE0/0/0]');
      await r.executeCommand('return');
      expect(r.getPrompt()).toBe('<R2>');
    });

    it('`display clock` produit la ligne date + weekday + timezone VRP', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display clock');
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
      expect(out).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/m);
      expect(out).toMatch(/^Time Zone\(UTC\) : UTC$/m);
    });

    it('`display current-configuration` synthétise sysname + interfaces + ip route-static depuis MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      // Configure quelques éléments via le kernel.
      await r.executeCommand('system-view');
      await r.executeCommand('sysname R99');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('description Uplink WAN');
      await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      await r.executeCommand('ip route-static 20.0.0.0 255.0.0.0 10.1.1.2');
      await r.executeCommand('return');
      const out = await r.executeCommand('display current-configuration');
      expect(out).toMatch(/^sysname R99$/m);
      expect(out).toMatch(/^interface GigabitEthernet0\/0\/0$/m);
      expect(out).toMatch(/^ description Uplink WAN$/m);
      expect(out).toMatch(/^ ip address 10\.1\.1\.1 255\.255\.255\.0$/m);
      expect(out).toMatch(/^ip route-static 20\.0\.0\.0 255\.0\.0\.0 10\.1\.1\.2$/m);
      expect(out).toMatch(/^return$/m);
    });

    it('`display current-configuration | include interface` filtre via le pipe kernel', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display current-configuration | include interface');
      // Chaque ligne restante doit contenir "interface".
      const lines = out.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toMatch(/interface/);
    });

    it('`save` produit le dialogue VRP exact (partagé routeur/switch)', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('save');
      expect(out).toMatch(/^The current configuration will be written to the device\.$/m);
      expect(out).toMatch(/Save the configuration successfully\./);
    });

    it('`display arp` produit les colonnes VRP (aucune entrée par défaut)', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display arp');
      expect(out).toMatch(/^IP ADDRESS +MAC ADDRESS +EXPIRE\(M\) +TYPE +INTERFACE$/m);
      expect(out).toMatch(/No ARP entries found\./);
    });

    it('`arp static 10.0.0.99 aa:bb:cc:dd:ee:ff` pose une entrée ARP visible dans display arp', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      const setOut = await r.executeCommand('arp static 10.0.0.99 aa:bb:cc:dd:ee:ff');
      expect(setOut).toBe('');
      await r.executeCommand('return');
      const out = await r.executeCommand('display arp');
      // Rendu VRP exact (mêmes largeurs de colonnes que le legacy) : le
      // MAC (17 chars) colle avec la colonne EXPIRE quand pad 16.
      expect(out).toMatch(/^10\.0\.0\.99 +aa:bb:cc:dd:ee:ff\d+ +static/m);
    });

    it('`dhcp enable` active DHCP et apparaît dans display current-configuration', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('dhcp enable');
      await r.executeCommand('return');
      const cfg = await r.executeCommand('display current-configuration');
      expect(cfg).toMatch(/^dhcp enable$/m);
    });

    it('`undo dhcp enable` désactive DHCP et retire la ligne', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('dhcp enable');
      await r.executeCommand('undo dhcp enable');
      await r.executeCommand('return');
      const cfg = await r.executeCommand('display current-configuration');
      expect(cfg).not.toMatch(/^dhcp enable$/m);
    });

    it('`mtu 1400` (interface-view) ajuste le MTU via MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('mtu 1400');
      const cli = (r as unknown as { getCommandKernelCli(): { machine: { router: { interface(n: string): { mtu: number } | null } } } }).getCommandKernelCli();
      expect(cli.machine.router.interface('GE0/0/0')?.mtu).toBe(1400);
    });

    it('`ip pool MYPOOL` push dhcp-pool-view et crée le pool via MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('ip pool MYPOOL');
      expect(r.getPrompt()).toBe('[R2-ip-pool-MYPOOL]');
      const cli = (r as unknown as { getCommandKernelCli(): { machine: { dhcpPoolNames(): readonly string[] } } }).getCommandKernelCli();
      expect(cli.machine.dhcpPoolNames()).toContain('MYPOOL');
    });

    it('`undo ip pool MYPOOL` retire le pool', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('ip pool MYPOOL');
      await r.executeCommand('quit');
      await r.executeCommand('undo ip pool MYPOOL');
      const cli = (r as unknown as { getCommandKernelCli(): { machine: { dhcpPoolNames(): readonly string[] } } }).getCommandKernelCli();
      expect(cli.machine.dhcpPoolNames()).not.toContain('MYPOOL');
    });

    it('`ike proposal 10` push ike-proposal-view avec l\'id dans le prompt', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('ike proposal 10');
      expect(r.getPrompt()).toBe('[R2-ike-proposal-10]');
    });

    it('`ipsec proposal PROP1` push ipsec-proposal-view avec le nom dans le prompt', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('ipsec proposal PROP1');
      expect(r.getPrompt()).toBe('[R2-ipsec-proposal-PROP1]');
    });

    it('`router id 1.1.1.1` (system-view) est acceptée silencieusement', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      const out = await r.executeCommand('router id 1.1.1.1');
      expect(out).toBe('');
    });

    it('`display saved-configuration` retourne le même rendu que current-configuration (alias)', async () => {
      const r = new HuaweiRouter('R2');
      const [current, saved] = await Promise.all([
        r.executeCommand('display current-configuration'),
        r.executeCommand('display saved-configuration'),
      ]);
      expect(saved).toBe(current);
    });

    it('`undo arp 10.0.0.99` retire l\'entrée statique', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('arp static 10.0.0.99 aa:bb:cc:dd:ee:ff');
      await r.executeCommand('undo arp 10.0.0.99');
      await r.executeCommand('return');
      const out = await r.executeCommand('display arp');
      expect(out).not.toMatch(/10\.0\.0\.99/);
    });

    // ─── Vague display ip ────────────────────────────────────────────

    it('`display ip interface brief` produit la bannière VRP + colonnes fixes à partir de MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display ip interface brief');
      // Bannière VRP obligatoire.
      expect(out).toMatch(/^\*down: administratively down$/m);
      expect(out).toMatch(/^The number of interface that is UP in Physical is /m);
      // En-tête de colonnes exact.
      expect(out).toMatch(/^Interface {25}IP Address\/Mask {6}Physical {3}Protocol$/m);
      // `GE0/0/0` interne rendu comme `GigabitEthernet0/0/0` — les
      // 4 ports de démarrage sont admin-up mais pas connectés → `down`
      // (physique) / `down` (protocole).
      expect(out).toMatch(/^GigabitEthernet0\/0\/0 {14}unassigned {11}down {7}down$/m);
      expect(out).toMatch(/^GigabitEthernet0\/0\/3 /m);
    });

    it('abbreviation `dis ip int b` résout jusqu\'à la feuille (préfixe-unique)', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('dis ip int b');
      expect(out).toMatch(/^Interface {25}IP Address\/Mask /m);
      expect(out).toMatch(/GigabitEthernet0\/0\/0/);
    });

    it('`display ip` seul est incomplete (composite non exécutable, pas de fallback legacy)', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display ip');
      expect(out).toMatch(/Incomplete/i);
    });

    it('`display ip routing-table` produit la bannière Route Flags + colonnes VRP à partir de MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display ip routing-table');
      expect(out).toMatch(/^Route Flags: R - relay, D - download to fib$/m);
      expect(out).toMatch(/^Routing Tables: Public$/m);
      expect(out).toMatch(/^Destination\/Mask +Proto +Pre +Cost +Flags NextHop +Interface$/m);
    });

    // ─── Vague sysname + interface + config-if ────────────────────────

    it('`sysname R99` (system-view) met à jour le prompt à travers MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('sysname R99');
      expect(r.getPrompt()).toBe('[R99]');
    });

    it('`sysname` seul est incomplete', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      const out = await r.executeCommand('sysname');
      expect(out).toMatch(/manquant|missing|Incomplete|introuvable/i);
    });

    it('`interface GigabitEthernet0/0/0` push interface-view avec le nom d\'interface dans le prompt', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      const out = await r.executeCommand('interface GigabitEthernet0/0/0');
      expect(out).toBe('');
      expect(r.getPrompt()).toBe('[R2-GE0/0/0]');
    });

    it('`interface gi0/0/0` accepte l\'alias VRP (résolution préfixe)', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('sys');
      await r.executeCommand('interface gi0/0/0');
      expect(r.getPrompt()).toBe('[R2-GE0/0/0]');
    });

    it('`interface DoesNotExist` refuse la transition avec le message VRP et reste en system-view', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      const out = await r.executeCommand('interface DoesNotExist');
      expect(out).toMatch(/Wrong parameter/);
      expect(r.getPrompt()).toBe('[R2]');
    });

    it('`ip address 10.1.1.1 255.255.255.0` (interface-view) configure l\'IP, visible dans display ip interface brief', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      const out = await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      expect(out).toBe('');
      await r.executeCommand('end');
      const brief = await r.executeCommand('display ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\/0\s+10\.1\.1\.1\/24\s+/m);
    });

    it('`ip address 10.1.1.1 24` accepte la notation CIDR VRP', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('ip address 10.1.1.1 24');
      await r.executeCommand('end');
      const brief = await r.executeCommand('display ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\/0\s+10\.1\.1\.1\/24\s+/m);
    });

    it('`undo shutdown` puis IP → route Direct présente dans display ip routing-table', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('end');
      const routes = await r.executeCommand('display ip routing-table');
      // Une ligne pour la /24 Direct connectée sur GE0/0/0.
      expect(routes).toMatch(/10\.1\.1\.0\/24 +Direct/);
    });

    it('`shutdown` remet l\'interface admin-down (visible dans display ip int brief)', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('shutdown');
      await r.executeCommand('end');
      const brief = await r.executeCommand('display ip interface brief');
      expect(brief).toMatch(/GigabitEthernet0\/0\/0.*\*down/);
    });

    it('`undo ip address` (interface-view) retire l\'IP', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      await r.executeCommand('undo ip address');
      await r.executeCommand('end');
      const brief = await r.executeCommand('display ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\/0\s+unassigned\s+/m);
    });

    it('`quit` d\'interface-view efface `selectedInterface` (clearOnExit) et revient à system-view', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      expect(r.getPrompt()).toBe('[R2-GE0/0/0]');
      await r.executeCommand('quit');
      expect(r.getPrompt()).toBe('[R2]');
      await r.executeCommand('interface GigabitEthernet0/0/1');
      await r.executeCommand('ip address 10.2.2.2 255.255.255.0');
      await r.executeCommand('end');
      const brief = await r.executeCommand('display ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\/1\s+10\.2\.2\.2/m);
    });

    // ─── Vague routes statiques + description ─────────────────────────

    it('`ip route-static 10.9.9.0 255.255.255.0 192.168.0.2` ajoute une route Static visible dans display ip routing-table', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('ip address 192.168.0.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      const setOut = await r.executeCommand('ip route-static 10.9.9.0 255.255.255.0 192.168.0.2');
      expect(setOut).toBe('');
      await r.executeCommand('end');
      const routes = await r.executeCommand('display ip routing-table');
      expect(routes).toMatch(/10\.9\.9\.0\/24 +Static/);
    });

    it('`ip route-static 10.9.9.0 24 192.168.0.2` accepte la notation CIDR VRP', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('ip address 192.168.0.1 24');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      await r.executeCommand('ip route-static 10.9.9.0 24 192.168.0.2');
      await r.executeCommand('end');
      const routes = await r.executeCommand('display ip routing-table');
      expect(routes).toMatch(/10\.9\.9\.0\/24 +Static/);
    });

    it('`undo ip route-static 10.9.9.0 255.255.255.0 192.168.0.2` retire la route', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('ip address 192.168.0.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      await r.executeCommand('ip route-static 10.9.9.0 255.255.255.0 192.168.0.2');
      await r.executeCommand('undo ip route-static 10.9.9.0 255.255.255.0 192.168.0.2');
      await r.executeCommand('end');
      const routes = await r.executeCommand('display ip routing-table');
      expect(routes).not.toMatch(/10\.9\.9\.0/);
    });

    it('`description Uplink WAN` (interface-view) via MachineApi (lecture DTO)', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      const out = await r.executeCommand('description Uplink WAN');
      expect(out).toBe('');
      const cli = (r as unknown as { getCommandKernelCli(): { machine: { router: { interface(name: string): { description: string } | null } } } })
        .getCommandKernelCli();
      const info = cli.machine.router.interface('GE0/0/0');
      expect(info?.description).toBe('Uplink WAN');
    });

    it('`undo description` retire la description via MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet0/0/0');
      await r.executeCommand('description Temp');
      await r.executeCommand('undo description');
      const cli = (r as unknown as { getCommandKernelCli(): { machine: { router: { interface(name: string): { description: string } | null } } } })
        .getCommandKernelCli();
      const info = cli.machine.router.interface('GE0/0/0');
      expect(info?.description).toBe('');
    });

    it('`shutdown` en system-view est indisponible (mode isolation — règle 9)', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      const out = await r.executeCommand('shutdown');
      // `shutdown` n'est pas dans systemViewRegistry → not-found via le
      // nouveau pipeline. Signal explicite d'isolation des modes.
      expect(out).toMatch(/inconnu|Incomplete|not-found|introuvable|Invalid input|Unrecognized command/i);
    });

    it('an unmigrated command fails through the new pipeline (signal for migration)', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      // Une commande VRP pas encore migrée doit échouer via le nouveau
      // pipeline.
      const out = await r.executeCommand('multicast-suppression 10');
      expect(out).toMatch(/inconnu|Incomplete|not-found|introuvable|Invalid input|Unrecognized command/i);
    });
  });
});
