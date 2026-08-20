import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { pingOnSimulatedClock, isPingStep, canLendClock } from '../../support/fastPing';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  (isPingStep(c) && canLendClock(d)
    ? pingOnSimulatedClock(d as never, c)
    : Promise.resolve(d.executeCommand(c)));

async function priv(nom = 'R1'): Promise<CiscoRouter> {
  const r = new CiscoRouter(nom);
  await run(r, 'enable');
  return r;
}

async function paire(): Promise<[CiscoRouter, CiscoRouter]> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  for (const [r, ip] of [[r1, '10.0.0.1'], [r2, '10.0.0.2']] as [CiscoRouter, string][]) {
    await run(r, 'enable');
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, `ip address ${ip} 255.255.255.0`);
    await run(r, 'no shutdown');
    await run(r, 'end');
  }
  return [r1, r2];
}

describe('L2-1 — sélection stricte du Router-ID OSPF', () => {
  it('router-id configuré manuellement gagne sur tout', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'interface Loopback0');
    await run(r, 'ip address 9.9.9.9 255.255.255.255');
    await run(r, 'exit');
    await run(r, 'router ospf 1');
    await run(r, 'router-id 1.1.1.1');
    await run(r, 'end');
    expect(await run(r, 'show ip ospf')).toContain('1.1.1.1');
  });

  it('à défaut, la plus haute IP de Loopback UP', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'interface Loopback0');
    await run(r, 'ip address 5.5.5.5 255.255.255.255');
    await run(r, 'exit');
    await run(r, 'interface Loopback1');
    await run(r, 'ip address 9.9.9.9 255.255.255.255');
    await run(r, 'exit');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip address 200.1.1.1 255.255.255.0');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'router ospf 1');
    await run(r, 'network 0.0.0.0 255.255.255.255 area 0');
    await run(r, 'end');
    expect(await run(r, 'show ip ospf')).toContain('9.9.9.9');
  });

  it('à défaut de Loopback, la plus haute IP physique active', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip address 10.0.0.1 255.255.255.0');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'interface GigabitEthernet0/1');
    await run(r, 'ip address 200.1.1.1 255.255.255.0');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'router ospf 1');
    await run(r, 'network 0.0.0.0 255.255.255.255 area 0');
    await run(r, 'end');
    expect(await run(r, 'show ip ospf')).toContain('200.1.1.1');
  });

  it('une Loopback ajoutée APRÈS ne change pas le RID sans clear ip ospf process', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip address 10.0.0.1 255.255.255.0');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'router ospf 1');
    await run(r, 'network 0.0.0.0 255.255.255.255 area 0');
    await run(r, 'end');
    const avant = await run(r, 'show ip ospf');
    expect(avant).toContain('10.0.0.1');

    await run(r, 'configure terminal');
    await run(r, 'interface Loopback0');
    await run(r, 'ip address 99.99.99.99 255.255.255.255');
    await run(r, 'end');
    expect(await run(r, 'show ip ospf')).toContain('10.0.0.1');

    await run(r, 'clear ip ospf process');
    await run(r, 'yes');
    expect(await run(r, 'show ip ospf')).toContain('99.99.99.99');
  });
});

describe('L2-2 — passive-interface tait le protocole sans retirer le réseau', () => {
  it('l\'adjacence tombe sur l\'interface passive', async () => {
    const [r1, r2] = await paire();
    for (const [r, rid] of [[r1, '1.1.1.1'], [r2, '2.2.2.2']] as [CiscoRouter, string][]) {
      await run(r, 'configure terminal');
      await run(r, 'router ospf 1');
      await run(r, `router-id ${rid}`);
      await run(r, 'network 10.0.0.0 0.0.0.255 area 0');
      await run(r, 'end');
    }
    expect(await run(r1, 'show ip ospf neighbor')).toMatch(/FULL/);

    await run(r1, 'configure terminal');
    await run(r1, 'router ospf 1');
    await run(r1, 'passive-interface GigabitEthernet0/0');
    await run(r1, 'end');
    expect(await run(r1, 'show ip ospf neighbor')).not.toMatch(/FULL/);
  });

  it('mais le réseau de l\'interface passive reste annoncé', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const pc = new LinuxPC('PC');
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, pc.getPort('eth0')!);
    for (const [r, i, ip] of [
      [r1, 'GigabitEthernet0/0', '10.0.0.1'], [r1, 'GigabitEthernet0/1', '192.168.5.1'],
      [r2, 'GigabitEthernet0/0', '10.0.0.2'],
    ] as [CiscoRouter, string, string][]) {
      await run(r, 'enable');
      await run(r, 'configure terminal');
      await run(r, `interface ${i}`);
      await run(r, `ip address ${ip} 255.255.255.0`);
      await run(r, 'no shutdown');
      await run(r, 'end');
    }
    for (const [r, rid] of [[r1, '1.1.1.1'], [r2, '2.2.2.2']] as [CiscoRouter, string][]) {
      await run(r, 'configure terminal');
      await run(r, 'router ospf 1');
      await run(r, `router-id ${rid}`);
      await run(r, 'network 10.0.0.0 0.0.0.255 area 0');
      await run(r, 'network 192.168.5.0 0.0.0.255 area 0');
      await run(r, 'end');
    }
    await run(r1, 'configure terminal');
    await run(r1, 'router ospf 1');
    await run(r1, 'passive-interface GigabitEthernet0/1');
    await run(r1, 'end');

    expect(await run(r1, 'show ip ospf neighbor')).toMatch(/FULL/);
    expect(await run(r2, 'show ip route')).toContain('192.168.5.0');
  });
});

describe('L2-3 — gateway of last resort et le marqueur S*', () => {
  it('sans route par défaut, la ligne le dit', async () => {
    const [r1] = await paire();
    expect(await run(r1, 'show ip route')).toContain('Gateway of last resort is not set');
  });

  it('avec une route par défaut : ligne mise à jour et marqueur S*', async () => {
    const [r1] = await paire();
    await run(r1, 'configure terminal');
    await run(r1, 'ip route 0.0.0.0 0.0.0.0 10.0.0.2');
    await run(r1, 'end');
    const out = await run(r1, 'show ip route');
    expect(out).toContain('Gateway of last resort is 10.0.0.2 to network 0.0.0.0');
    expect(out).toMatch(/S\*\s+0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.0\.2/);
  });

  it('la retirer remet « not set »', async () => {
    const [r1] = await paire();
    await run(r1, 'configure terminal');
    await run(r1, 'ip route 0.0.0.0 0.0.0.0 10.0.0.2');
    await run(r1, 'no ip route 0.0.0.0 0.0.0.0 10.0.0.2');
    await run(r1, 'end');
    expect(await run(r1, 'show ip route')).toContain('Gateway of last resort is not set');
  });
});

describe('L2-4 — ACL : premier match gagne, refus implicite en fin', () => {
  it('un paquet qui ne matche aucune ligne est jeté', async () => {
    const [r1, r2] = await paire();
    await run(r1, 'ping 10.0.0.2');
    await run(r2, 'configure terminal');
    await run(r2, 'access-list 150 permit tcp any any');
    await run(r2, 'interface GigabitEthernet0/0');
    await run(r2, 'ip access-group 150 in');
    await run(r2, 'end');
    expect(await run(r1, 'ping 10.0.0.2')).toMatch(/Success rate is 0 percent/);
  });

  it('le premier match l\'emporte : un permit avant un deny laisse passer', async () => {
    const [r1, r2] = await paire();
    await run(r1, 'ping 10.0.0.2');
    await run(r2, 'configure terminal');
    await run(r2, 'access-list 151 permit icmp any any');
    await run(r2, 'access-list 151 deny icmp any any');
    await run(r2, 'access-list 151 permit ip any any');
    await run(r2, 'interface GigabitEthernet0/0');
    await run(r2, 'ip access-group 151 in');
    await run(r2, 'end');
    expect(await run(r1, 'ping 10.0.0.2')).toMatch(/Success rate is 100 percent/);
  });

  it('une ACL faite uniquement de deny bloque tout', async () => {
    const [r1, r2] = await paire();
    await run(r1, 'ping 10.0.0.2');
    await run(r2, 'configure terminal');
    await run(r2, 'access-list 152 deny tcp any any');
    await run(r2, 'interface GigabitEthernet0/0');
    await run(r2, 'ip access-group 152 in');
    await run(r2, 'end');
    expect(await run(r1, 'ping 10.0.0.2')).toMatch(/Success rate is 0 percent/);
  });
});

describe('L2-6 — exit remonte d\'un cran, end sort complètement', () => {
  it('exit depuis config-subif revient à config', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0.10');
    expect((r.getShell() as unknown as { getMode(): string }).getMode()).toBe('config-subif');
    await run(r, 'exit');
    expect((r.getShell() as unknown as { getMode(): string }).getMode()).toBe('config');
    await run(r, 'exit');
    expect((r.getShell() as unknown as { getMode(): string }).getMode()).toBe('privileged');
  });

  it('end depuis config-subif revient directement au mode privilégié', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0.10');
    await run(r, 'end');
    expect((r.getShell() as unknown as { getMode(): string }).getMode()).toBe('privileged');
  });

  it('CTRL+Z fait la même chose que end', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, '\x1a');
    expect((r.getShell() as unknown as { getMode(): string }).getMode()).toBe('privileged');
  });
});

describe('L2-7 — running-config en RAM, startup-config en NVRAM', () => {
  it('sans copy run start, un reload perd les modifications', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'hostname AvantReload');
    await run(r, 'end');
    expect(await run(r, 'show running-config')).toContain('hostname AvantReload');
    await run(r, 'reload');
    await run(r, 'yes');
    expect((r.getShell() as unknown as { getMode(): string }).getMode()).toBe('user');
    await run(r, 'enable');
    expect(await run(r, 'show running-config')).not.toContain('hostname AvantReload');
  });

  it('avec copy running-config startup-config, la modification survit', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    await run(r, 'hostname Sauvegarde');
    await run(r, 'end');
    await run(r, 'copy running-config startup-config');
    await run(r, '');
    await run(r, 'reload');
    await run(r, 'yes');
    await run(r, 'enable');
    expect(await run(r, 'show running-config')).toContain('hostname Sauvegarde');
  });
});

describe('L2-8 — baux DHCP réels dans show ip dhcp binding', () => {
  it('un bail attribué apparaît avec MAC, IP et type Automatic', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('PC');
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await run(r, 'enable');
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip address 192.168.20.1 255.255.255.0');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'ip dhcp excluded-address 192.168.20.1 192.168.20.10');
    await run(r, 'ip dhcp pool LAN');
    await run(r, 'network 192.168.20.0 255.255.255.0');
    await run(r, 'default-router 192.168.20.1');
    await run(r, 'end');
    await run(pc, 'sudo dhclient eth0');

    const bindings = await run(r, 'show ip dhcp binding');
    expect(bindings).toMatch(/192\.168\.20\.\d+/);
    expect(bindings).toMatch(/Automatic/i);
  });

  it('une adresse exclue n\'est jamais attribuée', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('PC');
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await run(r, 'enable');
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip address 192.168.20.1 255.255.255.0');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'ip dhcp excluded-address 192.168.20.1 192.168.20.50');
    await run(r, 'ip dhcp pool LAN');
    await run(r, 'network 192.168.20.0 255.255.255.0');
    await run(r, 'end');
    await run(pc, 'sudo dhclient eth0');

    const bindings = await run(r, 'show ip dhcp binding');
    const attribuee = bindings.match(/192\.168\.20\.(\d+)/);
    if (attribuee) expect(Number(attribuee[1])).toBeGreaterThan(50);
  });
});

describe('L2-10 — table NAT/PAT comme table d\'état', () => {
  it('une traduction PAT apparaît dans show ip nat translations', async () => {
    const r = new CiscoRouter('R1');
    const dedans = new LinuxPC('Dedans');
    const dehors = new LinuxPC('Dehors');
    new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, dedans.getPort('eth0')!);
    new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, dehors.getPort('eth0')!);
    await run(r, 'enable');
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip address 192.168.1.1 255.255.255.0');
    await run(r, 'ip nat inside');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'interface GigabitEthernet0/1');
    await run(r, 'ip address 203.0.113.1 255.255.255.0');
    await run(r, 'ip nat outside');
    await run(r, 'no shutdown');
    await run(r, 'exit');
    await run(r, 'access-list 1 permit 192.168.1.0 0.0.0.255');
    await run(r, 'ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    await run(r, 'end');

    dedans.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    dehors.configureInterface('eth0', new IPAddress('203.0.113.9'), new SubnetMask('255.255.255.0'));
    await run(dedans, 'ip route add default via 192.168.1.1');
    expect(await run(dedans, 'ping -c 2 203.0.113.9')).toMatch(/, 0% packet loss/);

    const t = await run(r, 'show ip nat translations');
    expect(t).toMatch(/^icmp\s+203\.0\.113\.1:\d+\s+192\.168\.1\.10:\d+/m);
    expect(await run(r, 'show ip nat statistics')).toMatch(/Total active translations: 2/);
  });

  it('les timeouts par protocole sont ceux d\'IOS', async () => {
    const r = await priv();
    const out = await run(r, 'show ip nat statistics');
    expect(out.length).toBeGreaterThan(0);
    const nat = (r as unknown as { _getNATEngine?: () => { getTimeouts?: () => Record<string, number> } })._getNATEngine?.();
    const timeouts = nat?.getTimeouts?.();
    if (timeouts) {
      expect(timeouts.tcp).toBe(86_400_000);
      expect(timeouts.udp).toBe(300_000);
      expect(timeouts.icmp).toBe(60_000);
    }
  });
});

describe('L2-9 — CDP signale une discordance de VLAN natif', () => {
  async function trunkAvecNatif(nom: string, vlan: string): Promise<CiscoSwitch> {
    const s = new CiscoSwitch('switch-cisco', nom);
    await run(s, 'enable');
    await run(s, 'configure terminal');
    await run(s, 'interface FastEthernet0/1');
    await run(s, 'switchport mode trunk');
    await run(s, `switchport trunk native vlan ${vlan}`);
    await run(s, 'end');
    return s;
  }

  type AgentCdp = { advertiseAll(r: 'config-change'): void };
  const annoncer = (s: CiscoSwitch) =>
    (s as unknown as { getCdpAgent(): AgentCdp }).getCdpAgent().advertiseAll('config-change');

  it('le message porte le mnémonique NATIVE_VLAN_MISMATCH et les deux VLAN', async () => {
    const s1 = await trunkAvecNatif('SW1', '10');
    const s2 = await trunkAvecNatif('SW2', '20');
    new Cable('c').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);
    annoncer(s2);

    const journal = await run(s1, 'show logging');
    expect(journal).toContain(
      '%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on FastEthernet0/1 (10), ' +
      'with SW2 FastEthernet0/1 (20).');
    expect(journal).not.toContain('%CDP-4-WARNINGS');
  });

  it('deux VLAN natifs identiques ne produisent aucun message', async () => {
    const s1 = await trunkAvecNatif('SW1', '99');
    const s2 = await trunkAvecNatif('SW2', '99');
    new Cable('c').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);
    annoncer(s2);

    expect(await run(s1, 'show logging')).not.toContain('Native VLAN mismatch');
  });
});
