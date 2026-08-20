import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';

async function taper(sw: CiscoSwitch | HuaweiSwitch, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await sw.executeCommand(c));
  return out;
}

function bloc(texte: string, nom: string, fin: string): string[] {
  const lignes = texte.split('\n');
  const debut = lignes.indexOf(`interface ${nom}`);
  if (debut < 0) return [];
  return lignes.slice(debut + 1, lignes.indexOf(fin, debut)).map(l => l.trim());
}

describe('`interface range` sur un commutateur Cisco', () => {
  let sw: CiscoSwitch;
  beforeEach(async () => {
    sw = new CiscoSwitch('switch-cisco', 'CS1', 8, 0, 0);
    await taper(sw, ['enable', 'configure terminal', 'vlan 10', 'exit', 'vlan 20', 'exit']);
  });

  async function blocs(): Promise<Record<string, string[]>> {
    await sw.executeCommand('end');
    const texte = await sw.executeCommand('show running-config');
    const out: Record<string, string[]> = {};
    for (const n of sw.getPortNames()) out[n] = bloc(texte, n, '!');
    return out;
  }

  it('les commandes que personne n\'avait cablees a la plage l\'atteignent maintenant', async () => {
    await taper(sw, [
      'interface range FastEthernet0/1 - 3',
      'spanning-tree portfast',
      'spanning-tree bpduguard enable',
      'spanning-tree cost 100',
      'speed 10', 'duplex full', 'mtu 1600',
      'storm-control broadcast level 30',
      'load-interval 60',
    ]);
    const b = await blocs();
    for (const n of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3']) {
      expect(b[n]).toContain('spanning-tree portfast');
      expect(b[n]).toContain('spanning-tree bpduguard enable');
      expect(b[n]).toContain('spanning-tree cost 100');
      expect(b[n]).toContain('speed 10');
      expect(b[n]).toContain('duplex full');
      expect(b[n]).toContain('mtu 1600');
      expect(b[n]).toContain('storm-control broadcast level 30');
      expect(b[n]).toContain('load-interval 60');
    }
    expect(b['FastEthernet0/4']).toEqual([]);
  });

  it('la commande atteint le vrai port, pas seulement sa configuration rendue', async () => {
    await taper(sw, ['interface range FastEthernet0/1 - 3', 'shutdown']);
    for (const n of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3']) {
      expect(sw.getPort(n)!.getIsUp()).toBe(false);
    }
    expect(sw.getPort('FastEthernet0/4')!.getIsUp()).toBe(true);

    await sw.executeCommand('no shutdown');
    expect(sw.getPort('FastEthernet0/3')!.getIsUp()).toBe(true);
  });

  it('les commandes deja cablees a la plage ne s\'appliquent pas DEUX fois', async () => {
    await taper(sw, [
      'interface range FastEthernet0/1 - 2',
      'switchport mode trunk',
      'switchport trunk allowed vlan 10',
      'switchport trunk allowed vlan add 20',
    ]);
    for (const n of ['FastEthernet0/1', 'FastEthernet0/2']) {
      const cfg = sw.getSwitchportConfig(n)!;
      expect(cfg.mode).toBe('trunk');
      expect([...cfg.trunkAllowedVlans].sort((a, b) => a - b)).toEqual([10, 20]);
    }
  });

  it('la liste separee par des virgules est acceptee, seule ou melee a des plages', async () => {
    expect(await sw.executeCommand('interface range FastEthernet0/5 , FastEthernet0/7')).toBe('');
    expect(sw.getShell().getSelectedInterfaceRange!())
      .toEqual(['FastEthernet0/5', 'FastEthernet0/7']);

    await sw.executeCommand('exit');
    expect(await sw.executeCommand('interface range FastEthernet0/1 - 3 , FastEthernet0/6 - 7')).toBe('');
    expect(sw.getShell().getSelectedInterfaceRange!()).toEqual([
      'FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3',
      'FastEthernet0/6', 'FastEthernet0/7',
    ]);
  });

  it('une borne qui n\'existe pas est refusee au lieu d\'etre rognee en silence', async () => {
    expect(await sw.executeCommand('interface range FastEthernet0/1 - 99'))
      .toBe('% Invalid interface range.');
    expect(await sw.executeCommand('interface range GigabitEthernet0/1 - 2'))
      .toBe('% Invalid interface range.');
    expect(await sw.executeCommand('interface range FastEthernet0/3 - 1'))
      .toBe('% No valid interfaces in range.');
    expect(sw.getShell().getSelectedInterfaceRange!()).toEqual([]);
  });

  it('un refus remonte UNE fois et la plage reste selectionnee', async () => {
    await sw.executeCommand('interface range FastEthernet0/1 - 3');
    const sortie = await sw.executeCommand('speed 999');
    expect(sortie.split('\n').filter(l => l.includes('%'))).toHaveLength(1);
    expect(sw.getShell().getSelectedInterfaceRange!()).toHaveLength(3);
  });

  it('`exit` quitte une seule fois, et une plage d\'un seul port reste une interface', async () => {
    await taper(sw, ['interface range FastEthernet0/1 - 3', 'exit']);
    expect(await sw.executeCommand('interface FastEthernet0/5')).toBe('');
    await sw.executeCommand('shutdown');
    expect(sw.getPort('FastEthernet0/5')!.getIsUp()).toBe(false);
    expect(sw.getPort('FastEthernet0/6')!.getIsUp()).toBe(true);
  });
});

describe('`interface range` sur un commutateur Huawei', () => {
  let sw: HuaweiSwitch;
  beforeEach(async () => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 8, 0, 0);
    await taper(sw, ['system-view', 'vlan 10', 'quit']);
  });

  it('la plage est un groupe de ports TEMPORAIRE, et configure chaque membre', async () => {
    await taper(sw, [
      'interface range GigabitEthernet0/0/1 to GigabitEthernet0/0/3',
      'port link-type access', 'port default vlan 10', 'shutdown',
    ]);
    expect(sw.getPrompt()).toBe('[SW1-port-group]');
    for (const n of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3']) {
      expect(sw.getSwitchportConfig(n)!.accessVlan).toBe(10);
      expect(sw.getPort(n)!.getIsUp()).toBe(false);
    }
    expect(sw.getSwitchportConfig('GigabitEthernet0/0/4')!.accessVlan).toBe(1);

    await sw.executeCommand('quit');
    expect(sw.getPortGroups()).toEqual([]);
  });

  it('l\'abreviation et la liste separee par des virgules sont admises', async () => {
    await sw.executeCommand('interface range GE0/0/1 to GE0/0/2 , GE0/0/5');
    await sw.executeCommand('shutdown');
    for (const n of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/5']) {
      expect(sw.getPort(n)!.getIsUp()).toBe(false);
    }
    expect(sw.getPort('GigabitEthernet0/0/3')!.getIsUp()).toBe(true);
  });

  it('une plage a l\'envers, une borne absente ou une plage vide sont refusees', async () => {
    for (const forme of [
      'interface range GigabitEthernet0/0/3 to GigabitEthernet0/0/1',
      'interface range GigabitEthernet0/0/1 to GigabitEthernet0/0/99',
    ]) {
      expect(await sw.executeCommand(forme)).toContain('Unrecognized command');
      expect(sw.getPrompt()).toBe('[SW1]');
    }
    expect(await sw.executeCommand('interface range')).toContain('Incomplete command');
    expect(sw.getPrompt()).toBe('[SW1]');
  });
});
