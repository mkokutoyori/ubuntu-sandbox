import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { replayVendorConfig } from '@/store/topologySerializer';

function neuf(nom = 'SW1'): HuaweiSwitch {
  return new HuaweiSwitch('switch-huawei', nom, 6, 0, 0);
}

async function taper(sw: HuaweiSwitch, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await sw.executeCommand(c));
  return out;
}

function blocInterface(texte: string, nom: string): string[] {
  const lignes = texte.split('\n');
  const debut = lignes.indexOf(`interface ${nom}`);
  if (debut < 0) return [];
  return lignes.slice(debut + 1, lignes.indexOf('#', debut)).map(l => l.trim());
}

describe('la vue port-group du commutateur VRP', () => {
  let sw: HuaweiSwitch;
  beforeEach(async () => {
    sw = neuf();
    await taper(sw, ['system-view', 'vlan 10', 'quit', 'vlan 20', 'quit']);
  });

  it('un groupe temporaire applique VRAIMENT la commande a chaque membre', async () => {
    await taper(sw, [
      'port-group group-member GigabitEthernet0/0/1 to GigabitEthernet0/0/3',
      'port link-type trunk',
      'port trunk allow-pass vlan 10 20',
      'description LIEN-MONTANT',
      'return',
    ]);
    const texte = await sw.executeCommand('display current-configuration');
    for (const n of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3']) {
      const bloc = blocInterface(texte, n);
      expect(bloc).toContain('port link-type trunk');
      expect(bloc).toContain('description LIEN-MONTANT');
      expect(sw.getSwitchportConfig(n)!.mode).toBe('trunk');
      expect(sw.getSwitchportConfig(n)!.trunkAllowedVlans.has(20)).toBe(true);
    }
    expect(blocInterface(texte, 'GigabitEthernet0/0/0')).not.toContain('port link-type trunk');
  });

  it('la commande atteint le vrai port, pas seulement sa configuration rendue', async () => {
    await taper(sw, [
      'port-group group-member GigabitEthernet0/0/1 to GigabitEthernet0/0/2',
      'shutdown',
    ]);
    expect(sw.getPort('GigabitEthernet0/0/1')!.getIsUp()).toBe(false);
    expect(sw.getPort('GigabitEthernet0/0/2')!.getIsUp()).toBe(false);
    expect(sw.getPort('GigabitEthernet0/0/3')!.getIsUp()).toBe(true);

    await taper(sw, ['undo shutdown']);
    expect(sw.getPort('GigabitEthernet0/0/1')!.getIsUp()).toBe(true);
  });

  it('un groupe temporaire disparait en quittant la vue, un groupe nomme reste', async () => {
    await taper(sw, [
      'port-group group-member GigabitEthernet0/0/1', 'quit',
      'port-group GP1', 'group-member GigabitEthernet0/0/4', 'quit',
    ]);
    expect(sw.getPortGroups()).toEqual([['GP1', ['GigabitEthernet0/0/4']]]);
  });

  it('l\'invite nomme la vue, et le groupe quand il en a un', async () => {
    await taper(sw, ['port-group group-member GigabitEthernet0/0/1']);
    expect(sw.getPrompt()).toBe('[SW1-port-group]');
    await taper(sw, ['quit', 'port-group GP1']);
    expect(sw.getPrompt()).toBe('[SW1-port-group-GP1]');
    await taper(sw, ['quit']);
    expect(sw.getPrompt()).toBe('[SW1]');
  });

  it('`group-member` accepte une plage, refuse un port absent, et n\'existe pas dans un groupe temporaire', async () => {
    await taper(sw, ['port-group GP1']);
    expect(await sw.executeCommand('group-member GigabitEthernet0/0/2 to GigabitEthernet0/0/4')).toBe('');
    expect(sw.getPortGroupMembers('GP1')).toEqual([
      'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3', 'GigabitEthernet0/0/4',
    ]);

    const absent = await sw.executeCommand('group-member GigabitEthernet0/0/9');
    expect(absent).toContain('Unrecognized command');
    expect(absent.split('\n')[1]).toBe('group-member GigabitEthernet0/0/9');

    expect(await sw.executeCommand('undo group-member GigabitEthernet0/0/3')).toBe('');
    expect(sw.getPortGroupMembers('GP1')).toEqual([
      'GigabitEthernet0/0/2', 'GigabitEthernet0/0/4',
    ]);

    await taper(sw, ['quit', 'port-group group-member GigabitEthernet0/0/1']);
    expect(await sw.executeCommand('group-member GigabitEthernet0/0/2'))
      .toBe('Error: The temporary port-group does not support this command.');
  });

  it('une plage a l\'envers est refusee plutot que silencieusement vide', async () => {
    await taper(sw, ['port-group GP1']);
    expect(await sw.executeCommand('group-member GigabitEthernet0/0/4 to GigabitEthernet0/0/1'))
      .toContain('Unrecognized command');
    expect(sw.getPortGroupMembers('GP1')).toEqual([]);
  });

  it('un refus de la vue interface remonte UNE fois, et rien n\'est applique', async () => {
    await taper(sw, ['port-group group-member GigabitEthernet0/0/1 to GigabitEthernet0/0/3']);
    const sortie = await sw.executeCommand('port link-type zzz');
    expect(sortie.split('\n').filter(l => l.startsWith('Error:'))).toHaveLength(1);
    for (const n of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3']) {
      expect(sw.getSwitchportConfig(n)!.mode).toBe('access');
    }
  });

  it('`display this` rend la vue courante, et les deux formes different', async () => {
    await taper(sw, ['port-group group-member GigabitEthernet0/0/1 to GigabitEthernet0/0/2']);
    expect(await sw.executeCommand('display this')).toBe(
      'port-group group-member GigabitEthernet0/0/1 GigabitEthernet0/0/2\n#');

    await taper(sw, ['quit', 'port-group GP1', 'group-member GigabitEthernet0/0/4']);
    expect(await sw.executeCommand('display this')).toBe(
      'port-group GP1\n group-member GigabitEthernet0/0/4\n#');
  });

  it('`display port-group` nomme, `all` detaille, un groupe inconnu est refuse', async () => {
    expect(await sw.executeCommand('display port-group')).toBe('Info: No port-group is configured.');
    await taper(sw, [
      'port-group GP1', 'group-member GigabitEthernet0/0/4 to GigabitEthernet0/0/5', 'quit',
      'port-group GP2', 'quit',
    ]);
    expect(await sw.executeCommand('display port-group')).toBe('Port-group: GP1\nPort-group: GP2');
    expect(await sw.executeCommand('display port-group all')).toBe([
      'Port-group: GP1',
      '  Member interfaces: 2',
      '    GigabitEthernet0/0/4',
      '    GigabitEthernet0/0/5',
      'Port-group: GP2',
      '  Member interfaces: 0',
    ].join('\n'));
    expect(await sw.executeCommand('display port-group GP1')).toContain('GigabitEthernet0/0/4');
    expect(await sw.executeCommand('display port-group GP9'))
      .toBe('Error: The port-group GP9 does not exist.');
  });

  it('`undo port-group` supprime le groupe sans toucher aux ports', async () => {
    await taper(sw, [
      'port-group GP1', 'group-member GigabitEthernet0/0/4',
      'port link-type trunk', 'quit',
      'undo port-group GP1',
    ]);
    expect(sw.getPortGroups()).toEqual([]);
    expect(sw.getSwitchportConfig('GigabitEthernet0/0/4')!.mode).toBe('trunk');
    expect(await sw.executeCommand('undo port-group GP1'))
      .toBe('Error: The port-group GP1 does not exist.');
  });

  it('la configuration rendue porte le groupe nomme et se rejoue', async () => {
    await taper(sw, [
      'port-group GP1', 'group-member GigabitEthernet0/0/4 to GigabitEthernet0/0/5',
      'port link-type access', 'port default vlan 20', 'return',
    ]);
    const texte = await sw.executeCommand('display current-configuration');
    expect(texte).toContain('port-group GP1\n group-member GigabitEthernet0/0/4\n group-member GigabitEthernet0/0/5');

    const copie = neuf('SW2');
    await replayVendorConfig(copie, texte);
    expect(copie.getPortGroups()).toEqual([[
      'GP1', ['GigabitEthernet0/0/4', 'GigabitEthernet0/0/5'],
    ]]);
    expect(copie.getSwitchportConfig('GigabitEthernet0/0/5')!.accessVlan).toBe(20);
  });

  it('les plafonds du systeme sont ceux de VRP : 32 groupes, 48 membres', async () => {
    for (let i = 1; i <= 32; i++) {
      expect(await sw.executeCommand(`port-group G${i}`)).toBe('');
      await sw.executeCommand('quit');
    }
    expect(await sw.executeCommand('port-group G33'))
      .toBe('Error: The number of port-groups reaches the upper limit.');
    expect(sw.getPortGroups()).toHaveLength(32);
  });

  it('un commutateur neuf ne rend AUCUN bloc port-group', async () => {
    await sw.executeCommand('return');
    expect(await sw.executeCommand('display current-configuration')).not.toContain('port-group');
  });
});
