import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function laboratoire() {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8, 0, 0);
  const temoin = new LinuxPC('linux-pc', 'B', 200, 0);
  const voisin = new LinuxPC('linux-pc', 'A', -200, 0);
  new Cable('b').connect(temoin.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);
  new Cable('a').connect(voisin.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  const entree = sw.getPort('GigabitEthernet0/0/1')!;
  return { sw, temoin, entree };
}

const DIFFUSION = 'FF:FF:FF:FF:FF:FF';

function trame(destination: string) {
  return {
    srcMAC: new MACAddress('AA:BB:CC:DD:EE:01'),
    dstMAC: new MACAddress(destination),
    etherType: 0x0800,
    payload: null,
  } as unknown as Parameters<ReturnType<HuaweiSwitch['getPort']>['receiveFrame']>[0];
}

function recuesPar(pc: LinuxPC): number {
  return pc.getPort('eth0')!.getCounters().framesIn;
}

function injecter(
  entree: ReturnType<HuaweiSwitch['getPort']>, destination: string, combien: number,
): void {
  for (let i = 0; i < combien; i++) entree!.receiveFrame(trame(destination));
}

describe('`broadcast-suppression` ecarte vraiment des trames', () => {
  it('la commande est acceptee et rendue', async () => {
    const { sw } = await laboratoire();
    for (const c of ['system-view', 'interface GigabitEthernet0/0/1',
      'broadcast-suppression 10']) await run(sw, c);
    expect(await run(sw, 'display this')).toContain('broadcast-suppression 10');
  });

  it('sans limite, la diffusion traverse', async () => {
    const { temoin, entree } = await laboratoire();
    const avant = recuesPar(temoin);
    injecter(entree, DIFFUSION, 6);
    expect(recuesPar(temoin)).toBe(avant + 6);
  });

  it('une limite a 0 pour cent ecarte la diffusion', async () => {
    const { sw, temoin, entree } = await laboratoire();
    for (const c of ['system-view', 'interface GigabitEthernet0/0/1',
      'broadcast-suppression 0', 'quit', 'quit']) await run(sw, c);

    const avant = recuesPar(temoin);
    injecter(entree, DIFFUSION, 6);
    expect(recuesPar(temoin)).toBe(avant);
  });

  it('la limite ne touche PAS le trafic unicast', async () => {
    const { sw, temoin, entree } = await laboratoire();
    for (const c of ['system-view', 'interface GigabitEthernet0/0/1',
      'broadcast-suppression 0', 'quit', 'quit']) await run(sw, c);

    const avant = recuesPar(temoin);
    injecter(entree, 'AA:BB:CC:DD:EE:02', 4);
    expect(recuesPar(temoin)).toBe(avant + 4);
  });

  it('`undo broadcast-suppression` rend le passage', async () => {
    const { sw, temoin, entree } = await laboratoire();
    for (const c of ['system-view', 'interface GigabitEthernet0/0/1',
      'broadcast-suppression 0', 'undo broadcast-suppression',
      'quit', 'quit']) await run(sw, c);

    const avant = recuesPar(temoin);
    injecter(entree, DIFFUSION, 6);
    expect(recuesPar(temoin)).toBe(avant + 6);
  });

  it('un pourcentage hors bornes est refuse, pas range', async () => {
    const { sw } = await laboratoire();
    for (const c of ['system-view', 'interface GigabitEthernet0/0/1']) await run(sw, c);
    const vu = await run(sw, 'broadcast-suppression 300');
    expect(vu.length).toBeGreaterThan(0);
    expect(await run(sw, 'display this')).not.toContain('broadcast-suppression 300');
  });
});

describe('`qos car` police sur un commutateur comme sur un routeur', () => {
  it('la commande est acceptee et rendue', async () => {
    const { sw } = await laboratoire();
    for (const c of ['system-view', 'interface GigabitEthernet0/0/1',
      'qos car inbound cir 64 cbs 2000 pbs 4000']) await run(sw, c);
    expect(await run(sw, 'display this')).toContain('qos car inbound cir 64');
  });

  it('un debit minuscule ecarte le trafic', async () => {
    const { sw, temoin, entree } = await laboratoire();
    for (const c of ['system-view', 'interface GigabitEthernet0/0/1',
      'qos car inbound cir 1 cbs 1 pbs 1', 'quit', 'quit']) await run(sw, c);

    const avant = recuesPar(temoin);
    injecter(entree, DIFFUSION, 3);
    expect(recuesPar(temoin)).toBe(avant);
  });
});
