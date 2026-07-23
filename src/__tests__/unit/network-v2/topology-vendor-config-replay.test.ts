/**
 * Rapport d'audit 04 §5.9 (« Sérialisation de topologie partielle ») + top-10
 * item 6 : topologySerializer ne capturait que interfaces/routes/VLANs —
 * toute la config routeur (ACL/NAT/OSPF/BGP/etc.), la startup-config, les
 * trunks allowed lists, port-security et le VFS Linux hors 3 fichiers
 * disparaissaient au round-trip export → import.
 *
 * Fix: `getRunningConfig()`/`getStartupConfigSnapshot()` (déjà branchés pour
 * `reload`/`copy start run`) sont capturés à l'export, et réappliqués à
 * l'import via un vrai replay CLI (`enable`/`configure terminal`/…/`end` ou
 * `system-view`/…/`return`) plutôt qu'un re-parseur maison à périmètre
 * limité — ce qui fait survivre exactement ce que la CLI sait déjà
 * configurer, sans liste de directives à maintenir séparément.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('topology round-trip: vendor config (ACL/NAT/OSPF/…) survives via CLI replay', () => {
  beforeEach(() => EquipmentRegistry.resetInstance());

  it('a Cisco ACL and NAT overload binding survive router round-trip', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('ip nat inside');
    await r.executeCommand('interface GigabitEthernet0/1');
    await r.executeCommand('ip address 203.0.113.1 255.255.255.252');
    await r.executeCommand('ip nat outside');
    await r.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
    await r.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    await r.executeCommand('end');

    const exp = exportTopology('t', new Map([[r.getId(), r]]), []);
    const imported = await importTopology(exp);
    const restored = Array.from(imported.deviceInstances.values())[0] as CiscoRouter;

    await restored.executeCommand('enable');
    const running = await restored.executeCommand('show running-config');
    expect(running).toContain('access-list 1 permit 192.168.1.0 0.0.0.255');
    expect(running).toContain('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
  });

  it('an OSPF process configured on a router survives round-trip', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('exit');
    await r.executeCommand('router ospf 1');
    await r.executeCommand('network 10.0.0.0 0.0.0.255 area 0');
    await r.executeCommand('end');

    const exp = exportTopology('t', new Map([[r.getId(), r]]), []);
    const imported = await importTopology(exp);
    const restored = Array.from(imported.deviceInstances.values())[0] as CiscoRouter;

    await restored.executeCommand('enable');
    const running = await restored.executeCommand('show running-config');
    expect(running).toContain('router ospf 1');
    expect(running).toContain('network 10.0.0.0 0.0.0.255 area 0');
  });

  it('a saved startup-config survives round-trip (write memory before export)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('end');
    await r.executeCommand('write memory');

    const exp = exportTopology('t', new Map([[r.getId(), r]]), []);
    const imported = await importTopology(exp);
    const restored = Array.from(imported.deviceInstances.values())[0] as CiscoRouter;

    await restored.executeCommand('enable');
    const startup = await restored.executeCommand('show startup-config');
    expect(startup).toContain('ip address 10.0.0.1 255.255.255.0');
  });

  it('Huawei ACL rules survive router round-trip', async () => {
    const r = new HuaweiRouter('R1', 0, 0);
    await r.executeCommand('system-view');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('quit');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('quit');

    const exp = exportTopology('t', new Map([[r.getId(), r]]), []);
    const imported = await importTopology(exp);
    const restored = Array.from(imported.deviceInstances.values())[0] as HuaweiRouter;

    const running = await restored.executeCommand('display current-configuration');
    expect(running).toContain('acl number 2000');
    expect(running).toContain('rule');
    expect(running).toContain('permit source 10.0.0.0 0.0.0.255');
  });

  it('switch trunk allowed-vlan list and port-security survive round-trip', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('name Engineering');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('name Sales');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('switchport port-security');
    await sw.executeCommand('switchport port-security maximum 2');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10,20');
    await sw.executeCommand('end');

    const exp = exportTopology('t', new Map([[sw.getId(), sw]]), []);
    const imported = await importTopology(exp);
    const restored = Array.from(imported.deviceInstances.values())[0] as CiscoSwitch;

    await restored.executeCommand('enable');
    const running = await restored.executeCommand('show running-config');
    expect(running).toContain('switchport trunk allowed vlan 10,20');
    expect(running).toContain('switchport port-security');
    expect(running).toContain('switchport port-security maximum 2');
  });

  it('does not duplicate static routes carried by both the narrow field and the CLI replay', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('exit');
    await r.executeCommand('ip route 192.168.50.0 255.255.255.0 10.0.0.2');
    await r.executeCommand('end');

    const exp = exportTopology('t', new Map([[r.getId(), r]]), []);
    const imported = await importTopology(exp);
    const restored = Array.from(imported.deviceInstances.values())[0] as CiscoRouter;

    const matching = restored.getRoutingTable().filter(
      (route) => route.type === 'static' && route.network.toString() === '192.168.50.0',
    );
    expect(matching).toHaveLength(1);
  });

  it('Linux files beyond the original 3-file allowlist survive round-trip', async () => {
    const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
    await srv.executeCommand('bash -c "echo \'export FOO=bar\' >> /etc/environment"');
    await srv.executeCommand('bash -c "mkdir -p /home/scripts && echo \'echo hi\' > /home/scripts/greet.sh"');

    const exp = exportTopology('t', new Map([[srv.getId(), srv]]), []);
    const imported = await importTopology(exp);
    const restored = Array.from(imported.deviceInstances.values())[0] as LinuxServer;

    const env = await restored.executeCommand('cat /etc/environment');
    expect(env).toContain('export FOO=bar');
    const script = await restored.executeCommand('cat /home/scripts/greet.sh');
    expect(script).toContain('echo hi');
  });

  it('unmodified default files are not captured in the export (keeps it minimal)', async () => {
    const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();

    const exp = exportTopology('t', new Map([[srv.getId(), srv]]), []);
    const entry = exp.devices[0];
    const paths = (entry.files ?? []).map((f) => f.path);
    expect(paths).not.toContain('/bin/bash');
    expect(paths.some((p) => p.startsWith('/proc'))).toBe(false);
  });
});
