/**
 * PRD-Routage-Fidelite.md §1.11 / lot R7 — les commandes manquantes,
 * au cas par cas.
 *
 * Le horizon partage se regle PAR INTERFACE sur les deux constructeurs,
 * et le moteur RIP ne lisait que le reglage du processus. Cote Cisco la
 * commande n'existait pas ; cote Huawei elle existait, ecrivait dans une
 * table que personne ne lisait, et n'avait donc aucun effet non plus.
 *
 * Ce qui est verifie ici n'est pas qu'une commande soit ACCEPTEE — une
 * commande acceptee qui ne fait rien est precisement le defaut d'avant —
 * mais ce que le routeur ANNONCE sur le fil, capture a la couture d'emission
 * du moteur, et le fait que le reglage survive a un enregistrement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

async function run(dev: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<void> {
  for (const c of cmds) await dev.executeCommand(c);
}

interface Lab {
  a: CiscoRouter;
  /** Les reseaux annonces par A sur Gi0/0 au prochain envoi periodique. */
  annonces(): string[];
}

/**
 * A —— B, RIP des deux cotes, chacun avec une Loopback a lui. La route
 * vers 10.0.12.0 est apprise SUR Gi0/0 : c'est exactement celle que le
 * horizon partage retient, donc la seule dont la presence distingue les
 * deux reglages.
 */
async function labo(): Promise<Lab> {
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
  const n = ++serie;
  const a = new CiscoRouter(`SA${n}`);
  const b = new CiscoRouter(`SB${n}`);
  new Cable(`sc${n}`).connect(a.getPorts()[0], b.getPorts()[0]);
  for (const [d, i] of [[a, '1'], [b, '2']] as const) {
    await run(d, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address 10.0.12.${i} 255.255.255.0`, 'no shutdown', 'exit',
      'interface Loopback0', `ip address ${i}.${i}.${i}.${i} 255.255.255.0`, 'end']);
  }

  const vus: string[] = [];
  const vrai = a.sendFrame.bind(a);
  (a as unknown as { sendFrame: (i: string, f: unknown) => void }).sendFrame = (iface, frame) => {
    const rip = (frame as {
      payload?: { payload?: { payload?: { command?: number; entries?: Array<{ ipAddress?: unknown }> } } };
    })?.payload?.payload?.payload;
    if (iface === 'GigabitEthernet0/0' && rip?.command === 2) {
      for (const e of rip.entries ?? []) vus.push(String(e.ipAddress));
    }
    return vrai(iface, frame as never);
  };

  for (const [d, i] of [[a, '1'], [b, '2']] as const) {
    await run(d, ['configure terminal', 'router rip', 'version 2', 'no auto-summary',
      'network 10.0.0.0', `network ${i}.0.0.0`, 'end']);
  }

  return {
    a,
    annonces() {
      vus.length = 0;
      horloge.advance(31000);
      return [...vus];
    },
  };
}

describe('le horizon partage se regle par interface, et cela change le fil', () => {
  it('par defaut, A ne renvoie pas sur Gi0/0 ce qu\'il y a appris', async () => {
    const { annonces } = await labo();
    const vus = annonces();
    expect(vus, 'la Loopback doit sortir').toContain('1.1.1.0');
    expect(vus, 'le reseau appris sur Gi0/0 doit etre retenu').not.toContain('10.0.12.0');
  });

  it('`no ip split-horizon` le lui fait renvoyer', async () => {
    const { a, annonces } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/0',
      'no ip split-horizon', 'end']);
    const vus = annonces();
    expect(vus).toContain('10.0.12.0');
    expect(vus).toContain('1.1.1.0');
  });

  it('`ip split-horizon` le remet, et le fil suit', async () => {
    const { a, annonces } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/0',
      'no ip split-horizon', 'end']);
    expect(annonces()).toContain('10.0.12.0');

    await run(a, ['configure terminal', 'interface GigabitEthernet0/0',
      'ip split-horizon', 'end']);
    expect(annonces()).not.toContain('10.0.12.0');
  });

  it('le reglage est propre a l\'interface, pas au processus', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/0',
      'no ip split-horizon', 'end']);
    expect(a.ripSplitHorizonOn('GigabitEthernet0/0')).toBe(false);
    expect(a.ripSplitHorizonOn('GigabitEthernet0/1'), 'une autre interface suit le processus').toBe(true);
  });
});

describe('le reglage survit a un enregistrement', () => {
  it('`no ip split-horizon` est rendu dans la configuration, le defaut non', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('show running-config')).not.toContain('split-horizon');

    await run(a, ['configure terminal', 'interface GigabitEthernet0/0',
      'no ip split-horizon', 'end']);
    const bloc = await a.executeCommand('show running-config | section interface GigabitEthernet0/0');
    expect(bloc).toContain(' no ip split-horizon');
  });

  it('un routeur qui rejoue cette ligne retient le meme reglage', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/0',
      'no ip split-horizon', 'end']);

    const neuf = new CiscoRouter(`SR${++serie}`);
    await run(neuf, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.9 255.255.255.0', 'no shutdown', 'exit',
      'router rip', 'network 10.0.0.0', 'exit',
      'interface GigabitEthernet0/0', 'no ip split-horizon', 'end']);
    expect(neuf.ripSplitHorizonOn('GigabitEthernet0/0')).toBe(false);
  });
});

describe('la meme fonction, sur les deux constructeurs', () => {
  it('`undo rip split-horizon` de VRP fait ce que fait `no ip split-horizon`', async () => {
    const h = new HuaweiRouter(`SH${++serie}`);
    const iface = [...h._getPortsInternal().keys()][0];
    await run(h, ['system-view', `interface ${iface}`,
      'ip address 10.0.12.1 255.255.255.0', 'quit',
      'rip 1', 'version 2', 'network 10.0.0.0', 'quit']);

    expect(h.ripSplitHorizonOn(iface), 'par defaut, actif').toBe(true);
    await run(h, [`interface ${iface}`, 'undo rip split-horizon', 'quit']);
    expect(h.ripSplitHorizonOn(iface)).toBe(false);
    await run(h, [`interface ${iface}`, 'rip split-horizon', 'quit']);
    expect(h.ripSplitHorizonOn(iface)).toBe(true);
  });

  it('le reglage est range sous le nom de port que le moteur parcourt', async () => {
    const h = new HuaweiRouter(`SK${++serie}`);
    const iface = [...h._getPortsInternal().keys()][0];
    await run(h, ['system-view', `interface ${iface}`, 'undo rip split-horizon', 'quit']);
    expect(h.ripSplitHorizonOn(iface)).toBe(false);
  });
});

describe('une commande sans effet sur le materiel est acceptee sans effet ici', () => {
  it('`ip classless` et `ip subnet-zero` ne sont plus refusees', async () => {
    const { a } = await labo();
    for (const c of ['ip classless', 'no ip classless', 'ip subnet-zero', 'no ip subnet-zero']) {
      await a.executeCommand('configure terminal');
      expect(await a.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
      await a.executeCommand('end');
    }
  });

  it('elles ne sont pas rendues dans la configuration, etant le defaut', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'ip classless', 'ip subnet-zero', 'end']);
    const conf = await a.executeCommand('show running-config');
    expect(conf).not.toContain('ip classless');
    expect(conf).not.toContain('ip subnet-zero');
  });
});
