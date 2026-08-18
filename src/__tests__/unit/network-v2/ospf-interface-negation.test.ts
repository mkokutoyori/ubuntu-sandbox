import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Configurable { executeCommand(cmd: string): Promise<string> }
const cfg = async (d: Configurable, cmds: string[]) => {
  const outputs: string[] = [];
  for (const c of cmds) outputs.push(await d.executeCommand(c));
  return outputs;
};

async function router() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 200, 0);
  new Cable('link').connect(
    r1.getPort('GigabitEthernet0/1')!,
    r2.getPort('GigabitEthernet0/1')!,
  );
  await cfg(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.3 area 0', 'end',
  ]);
  await cfg(r2, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.0.0 0.0.0.3 area 0', 'end',
  ]);
  return r1;
}

const iface = (r: CiscoRouter) =>
  (r as unknown as { _getOSPFEngineInternal(): { getInterface(n: string): Record<string, unknown> } })
    ._getOSPFEngineInternal().getInterface('GigabitEthernet0/1');

describe('CLI Cisco — formes négatives de `ip ospf` sur interface', () => {
  it('accepte chaque négation sans diagnostic', async () => {
    const r1 = await router();
    const outputs = await cfg(r1, [
      'configure terminal', 'interface GigabitEthernet0/1',
      'no ip ospf cost', 'no ip ospf priority', 'no ip ospf hello-interval',
      'no ip ospf dead-interval', 'no ip ospf network', 'no ip ospf authentication',
      'no ip ospf authentication-key', 'no ip ospf message-digest-key',
      'no ip ospf retransmit-interval', 'no ip ospf transmit-delay',
      'no ip ospf mtu-ignore', 'no ip ospf demand-circuit',
      'no ip ospf bfd', 'no ip ospf flood-reduction',
      'end',
    ]);
    for (const out of outputs) {
      expect(out).not.toContain('% Incomplete command.');
      expect(out).not.toContain('% Invalid input');
    }
  });

  it('ramène chaque réglage à son défaut IOS', async () => {
    const r1 = await router();
    await cfg(r1, [
      'configure terminal', 'interface GigabitEthernet0/1',
      'ip ospf cost 100', 'ip ospf priority 42', 'ip ospf hello-interval 5',
      'ip ospf dead-interval 20', 'ip ospf network point-to-point',
      'ip ospf authentication', 'ip ospf retransmit-interval 9', 'ip ospf transmit-delay 9',
      'end',
    ]);
    const modifie = iface(r1);
    expect(modifie.cost).toBe(100);
    expect(modifie.priority).toBe(42);
    expect(modifie.networkType).toBe('point-to-point');

    await cfg(r1, [
      'configure terminal', 'interface GigabitEthernet0/1',
      'no ip ospf cost', 'no ip ospf priority', 'no ip ospf hello-interval',
      'no ip ospf dead-interval', 'no ip ospf network', 'no ip ospf authentication',
      'no ip ospf retransmit-interval', 'no ip ospf transmit-delay',
      'end',
    ]);
    const remis = iface(r1);
    expect(remis.cost).toBe(1);
    expect(remis.costExplicit).toBe(false);
    expect(remis.priority).toBe(1);
    expect(remis.helloInterval).toBe(10);
    expect(remis.deadInterval).toBe(40);
    expect(remis.networkType).toBe('broadcast');
    expect(remis.retransmitInterval).toBe(5);
    expect(remis.transmitDelay).toBe(1);
    expect(remis.authType).toBe(0);
  });

  it('rend la main au SPF, qui recalcule sur le coût restauré', async () => {
    const r1 = await router();
    await cfg(r1, [
      'configure terminal', 'interface GigabitEthernet0/1', 'ip ospf cost 250', 'end',
    ]);
    expect(await r1.executeCommand('show ip ospf interface brief')).toContain('250');

    await cfg(r1, [
      'configure terminal', 'interface GigabitEthernet0/1', 'no ip ospf cost', 'end',
    ]);
    const brief = await r1.executeCommand('show ip ospf interface brief');
    expect(brief).not.toContain('250');
    expect(iface(r1).cost).toBe(1);
  });

  it('laisse la forme positive refuser un argument manquant', async () => {
    const r1 = await router();
    const [, , sansValeur] = await cfg(r1, [
      'configure terminal', 'interface GigabitEthernet0/1', 'ip ospf cost',
    ]);
    expect(sansValeur).toContain('% Incomplete command.');
  });
});
