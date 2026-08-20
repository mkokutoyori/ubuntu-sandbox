import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

function neuf(): HuaweiSwitch {
  return new HuaweiSwitch('switch-huawei', 'SW1', 4, 0, 0);
}

async function taper(sw: HuaweiSwitch, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await sw.executeCommand(c));
  return out;
}

async function config(sw: HuaweiSwitch): Promise<string> {
  await sw.executeCommand('return');
  return sw.executeCommand('display current-configuration');
}

function lignesStp(texte: string): string[] {
  return texte.split('\n').filter(l => /^\s*(stp |region-name|revision-level|instance |active region)/.test(l));
}

describe('la famille stp du commutateur VRP', () => {
  let sw: HuaweiSwitch;
  beforeEach(() => { sw = neuf(); });

  it('`stp bpdu-protection` arme la protection sur le MOTEUR', async () => {
    await taper(sw, ['system-view', 'stp bpdu-protection']);
    expect(sw.getStpAgent().getGlobalStp().bpduGuardGlobal).toBe(true);
    await taper(sw, ['undo stp bpdu-protection']);
    expect(sw.getStpAgent().getGlobalStp().bpduGuardGlobal).toBe(false);
  });

  it('`stp edged-port default` pose le port de bord par defaut sur le MOTEUR', async () => {
    await taper(sw, ['system-view', 'stp edged-port default']);
    expect(sw.getStpAgent().getGlobalStp().portfastDefault).toBe(true);
    await taper(sw, ['undo stp edged-port default']);
    expect(sw.getStpAgent().getGlobalStp().portfastDefault).toBe(false);
  });

  it('`stp instance 0 root primary` — la forme de l\'exemple Huawei — est acceptee', async () => {
    const [, sortie] = await taper(sw, ['system-view', 'stp instance 0 root primary']);
    expect(sortie).toBe('');
    expect(sw.getStpAgent().getRootRole(0)).toBe('primary');
    expect(sw.getStpAgent().getVlanPriority(1)).toBe(0);
  });

  it('`root secondary` vaut 4096, et `undo stp root` rend la priorite par defaut', async () => {
    await taper(sw, ['system-view', 'stp root secondary']);
    expect(sw.getStpAgent().getVlanPriority(1)).toBe(4096);
    await taper(sw, ['undo stp root']);
    expect(sw.getStpAgent().getRootRole(0)).toBeNull();
    expect(sw.getStpAgent().getVlanPriority(1)).toBe(32768);
  });

  it('une priorite explicite retire le role de racine plutot que de coexister avec lui', async () => {
    await taper(sw, ['system-view', 'stp root primary', 'stp priority 8192']);
    expect(sw.getStpAgent().getRootRole(0)).toBeNull();
    expect(sw.getStpAgent().getVlanPriority(1)).toBe(8192);
    expect(lignesStp(await config(sw))).toEqual(['stp priority 8192']);
  });

  it('la configuration rendue porte toute la famille', async () => {
    await taper(sw, [
      'system-view',
      'stp mode rstp',
      'stp instance 0 root primary',
      'stp instance 2 priority 8192',
      'stp bpdu-protection',
      'stp edged-port default',
      'stp pathcost-standard dot1d-1998',
      'stp timer hello 300',
      'stp timer forward-delay 2000',
      'stp timer max-age 2400',
      'stp disable',
    ]);
    expect(lignesStp(await config(sw))).toEqual([
      'stp mode rstp',
      'stp instance 0 root primary',
      'stp instance 2 priority 8192',
      'stp bpdu-protection',
      'stp edged-port default',
      'stp pathcost-standard dot1d-1998',
      'stp timer hello 300',
      'stp timer forward-delay 2000',
      'stp timer max-age 2400',
      'stp disable',
    ]);
  });

  it('la configuration rendue est REJOUABLE : relue, elle refait le meme etat', async () => {
    await taper(sw, [
      'system-view',
      'stp mode rstp',
      'stp instance 0 root secondary',
      'stp bpdu-protection',
      'stp edged-port default',
      'stp timer hello 300',
      'stp region-configuration',
      'region-name REGION',
      'revision-level 7',
      'instance 1 vlan 10',
      'quit',
    ]);
    const texte = await config(sw);

    const copie = neuf();
    await copie.executeCommand('system-view');
    for (const l of texte.split('\n')) {
      const nue = l.trim();
      if (!nue || nue === '#' || nue === 'return') continue;
      await copie.executeCommand(nue);
    }
    const a = sw.getStpAgent();
    const b = copie.getStpAgent();
    expect(b.getMode()).toBe(a.getMode());
    expect(b.getRootRole(0)).toBe(a.getRootRole(0));
    expect(b.getVlanPriority(1)).toBe(a.getVlanPriority(1));
    expect(b.getGlobalStp()).toEqual(a.getGlobalStp());
    expect(b.getVlanHelloSec(1)).toBe(a.getVlanHelloSec(1));
    expect(b.getMstRegion().name).toBe('REGION');
    expect(b.getMstRegion().revision).toBe(7);
    expect([...b.getMstRegion().instances]).toEqual([[1, '10']]);
  });

  it('le bloc de region porte son `revision-level`, dans les DEUX vues', async () => {
    await taper(sw, [
      'system-view', 'stp region-configuration',
      'region-name REGION', 'revision-level 3', 'instance 1 vlan 10',
    ]);
    const vueLocale = await sw.executeCommand('display this');
    expect(vueLocale).toContain(' revision-level 3');

    await sw.executeCommand('quit');
    const texte = await config(sw);
    const bloc = texte.split('\n');
    const debut = bloc.indexOf('stp region-configuration');
    expect(debut).toBeGreaterThanOrEqual(0);
    const fin = bloc.indexOf('#', debut);
    expect(bloc.slice(debut, fin).join('\n')).toBe(
      vueLocale.split('\n').filter(l => l !== '#').join('\n'));
  });

  it('`display stp mode` lit le moteur, non un miroir', async () => {
    expect(await sw.executeCommand('display stp mode')).toBe('STP mode: MSTP');
    await taper(sw, ['system-view', 'stp mode stp']);
    await sw.executeCommand('return');
    expect(await sw.executeCommand('display stp mode')).toBe('STP mode: STP');
    expect(sw.getStpAgent().getMode()).toBe('stp');
  });

  it('`display stp` suit le moteur pour la protection BPDU et l\'etat', async () => {
    await taper(sw, ['system-view', 'stp bpdu-protection', 'stp disable']);
    await sw.executeCommand('return');
    const vue = await sw.executeCommand('display stp');
    expect(vue).toContain('BPDU-Protection     :Enabled');
    expect(vue).toContain('STP Status          :Disabled');
  });

  it('`undo stp` d\'un mot inconnu est refuse plutot que rendu en silence', async () => {
    const [, sortie] = await taper(sw, ['system-view', 'undo stp zzz']);
    expect(sortie).toContain('Unrecognized command');
  });

  it('le curseur d\'un refus designe le mot faux de la branche la plus longue', async () => {
    const [, sortie] = await taper(sw, ['system-view', 'stp instance 0 root zzz']);
    const curseur = sortie.split('\n')[2] ?? '';
    expect(curseur.indexOf('^')).toBe('stp instance 0 root '.length);
  });

  it('un commutateur neuf ne rend AUCUNE ligne stp', async () => {
    expect(lignesStp(await sw.executeCommand('display current-configuration'))).toEqual([]);
  });

  it('le mode par defaut est MSTP, comme sur une S-series', () => {
    expect(sw.getStpAgent().getMode()).toBe('mstp');
    expect(sw.getStpAgent().getPathcostMethod()).toBe('long');
  });
});

describe('l\'arbre commun traverse les modes', () => {
  it('un MSTP Huawei et un PVST Cisco elisent la MEME racine', async () => {
    const cisco = new CiscoSwitch('switch-cisco', 'CSCO1', 4);
    const huawei = new HuaweiSwitch('switch-huawei', 'HW1', 4);
    await cisco.executeCommand('enable');
    await cisco.executeCommand('configure terminal');
    await cisco.executeCommand('spanning-tree vlan 1 priority 4096');
    await cisco.executeCommand('end');
    new Cable('w').connect(cisco.getPort('FastEthernet0/1')!,
      huawei.getPort('GigabitEthernet0/0/0')!);
    expect(huawei.getStpAgent().getMode()).toBe('mstp');
    expect(cisco.getStpAgent().isRoot()).toBe(true);
    expect(huawei.getStpAgent().isRoot()).toBe(false);
    expect(huawei.getStpAgent().getPortRole('GigabitEthernet0/0/0')).toBe('root');
  });

  it('changer de mode ne laisse pas le voisin sur l\'ancien arbre', async () => {
    const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 25);
    const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 25);
    new Cable('c1').connect(sw1.getPort('GigabitEthernet0/0/23')!,
      sw2.getPort('GigabitEthernet0/0/23')!);
    new Cable('c2').connect(sw1.getPort('GigabitEthernet0/0/24')!,
      sw2.getPort('GigabitEthernet0/0/24')!);
    for (const [sw, role] of [[sw1, 'primary'], [sw2, 'secondary']] as const) {
      await sw.executeCommand('system-view');
      await sw.executeCommand('stp mode rstp');
      await sw.executeCommand(`stp root ${role}`);
      await sw.executeCommand('return');
    }
    expect(sw1.getStpAgent().isRoot()).toBe(true);
    expect(sw2.getStpAgent().isRoot()).toBe(false);
    const roles = ['GigabitEthernet0/0/23', 'GigabitEthernet0/0/24']
      .map(p => sw2.getStpAgent().getPortRole(p));
    expect(roles).toContain('root');
    expect(roles).toContain('alternate');
  });
});
