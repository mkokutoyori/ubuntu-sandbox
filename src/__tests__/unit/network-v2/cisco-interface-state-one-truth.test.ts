/**
 * Revue itération 2, §3.1 — une interface, un état.
 *
 * Le même port, au même instant, se lisait `up/up` dans
 * `show ip ospf interface` et `down/down` dans `show ip interface brief`,
 * `show interfaces` et `show ip igmp interface`. OSPF annonçait même
 * `State DR` sur un lien mort.
 *
 * Ces vues ne devinent plus : elles lisent `iosInterfaceStatus`, la même
 * source pour tout le monde. Une vue qui répond de son imagination est
 * pire qu'une vue absente — c'est celle que l'opérateur croit.
 *
 * Le test n'énumère pas des chaînes attendues : il compare les vues
 * entre elles. Il tient donc même si le format change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const IFACE = 'GigabitEthernet0/0';

async function router(name: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(name);
  r.powerOn?.();
  for (const c of [
    'enable', 'configure terminal',
    `interface ${IFACE}`, 'ip address 10.0.12.1 255.255.255.0', 'no shutdown',
    'ip igmp version 2', 'exit',
    'router ospf 1', 'network 10.0.12.0 0.0.0.255 area 0', 'exit',
    'end',
  ]) await r.executeCommand(c);
  return r;
}

/** `<nom> is X, line protocol is Y` → `X/Y`, quelle que soit la vue. */
function verdict(out: string): string | null {
  const m = new RegExp(`${IFACE} is ([a-z ]+), line protocol is ([a-z]+)`).exec(out);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function verdicts(r: CiscoRouter): Promise<Record<string, string | null>> {
  const brief = await r.executeCommand('show ip interface brief');
  const briefRow = brief.split('\n').find((l) => l.startsWith(IFACE)) ?? '';
  // Interface / IP / OK? / Method / Status / Protocol. Status peut valoir
  // « administratively down », qui contient une espace : on le prend
  // jusqu'à la séparation en deux espaces qui précède Protocol.
  const m = /^\S+\s+\S+\s+(?:YES|NO)\s+\S+\s+(.+?)\s{2,}(\S+)\s*$/.exec(briefRow);
  return {
    interfaces: verdict(await r.executeCommand(`show interfaces ${IFACE}`)),
    ospf: verdict(await r.executeCommand(`show ip ospf interface ${IFACE}`)),
    igmp: verdict(await r.executeCommand('show ip igmp interface')),
    brief: m ? `${m[1]}/${m[2]}` : null,
  };
}

describe('une interface, un seul état, quelle que soit la vue', () => {
  it("sans câble : toutes les vues disent down", async () => {
    const r = await router('R1');
    const v = await verdicts(r);
    expect(v.ospf).toBe(v.interfaces);
    expect(v.igmp).toBe(v.interfaces);
    expect(v.brief).toBe(v.interfaces);
    expect(v.interfaces).toBe('down/down');
  });

  it('câblée et active : toutes les vues disent up', async () => {
    const r = await router('R1');
    const peer = new CiscoRouter('R2');
    peer.powerOn?.();
    for (const c of ['enable', 'configure terminal', `interface ${IFACE}`,
      'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'end']) {
      await peer.executeCommand(c);
    }
    new Cable('c1').connect(r.getPort(IFACE)!, peer.getPort(IFACE)!);

    const v = await verdicts(r);
    expect(v.ospf).toBe(v.interfaces);
    expect(v.igmp).toBe(v.interfaces);
    expect(v.brief).toBe(v.interfaces);
    expect(v.interfaces).toBe('up/up');
  });

  it("administrativement éteinte : toutes les vues le disent", async () => {
    const r = await router('R1');
    const peer = new CiscoRouter('R2');
    peer.powerOn?.();
    new Cable('c1').connect(r.getPort(IFACE)!, peer.getPort(IFACE)!);
    await r.executeCommand('configure terminal');
    await r.executeCommand(`interface ${IFACE}`);
    await r.executeCommand('shutdown');
    await r.executeCommand('end');

    const v = await verdicts(r);
    expect(v.interfaces).toContain('administratively down');
    expect(v.ospf).toBe(v.interfaces);
  });

  it("OSPF n'élit personne sur un lien mort", async () => {
    const r = await router('R1');
    const out = await r.executeCommand(`show ip ospf interface ${IFACE}`);
    // `State DR` sur une interface down/down était le symptôme le plus
    // trompeur : il donne à croire à une adjacence.
    expect(out).toContain('State DOWN');
    expect(out).not.toContain('State DR');
  });
});
