import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { pingOnSimulatedClock } from '../../support/fastPing';

function neuf(): HuaweiSwitch {
  return new HuaweiSwitch('switch-huawei', 'SW1', 4, 0, 0);
}

async function taper(sw: HuaweiSwitch, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await sw.executeCommand(c));
  return out;
}

async function enSysteme(sw: HuaweiSwitch, cmds: string[] = []): Promise<void> {
  await taper(sw, ['system-view', 'vlan 10', 'quit', ...cmds]);
}

async function config(sw: HuaweiSwitch): Promise<string[]> {
  await sw.executeCommand('return');
  const texte = await sw.executeCommand('display current-configuration');
  return texte.split('\n').filter(l => l.startsWith('mac-address'));
}

async function maquette() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 0, 0);
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4, 0, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/0')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  await pc1.executeCommand('ifconfig eth0 192.168.1.10');
  await pc2.executeCommand('ifconfig eth0 192.168.1.20');
  return { pc1, pc2, sw };
}

describe('la table d\'adresses MAC du commutateur VRP', () => {
  let sw: HuaweiSwitch;
  beforeEach(() => { sw = neuf(); });

  it('`mac-address static` atteint la table, dans les deux ecritures d\'interface', async () => {
    await enSysteme(sw, ['mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 10']);
    const e = sw.getMACTable().find(x => x.type === 'static');
    expect(e).toBeDefined();
    expect(e!.mac).toBe('00:11:22:33:44:55');
    expect(e!.port).toBe('GigabitEthernet0/0/1');
    expect(e!.vlan).toBe(10);

    await sw.executeCommand('mac-address static 00e0-fc00-0001 GigabitEthernet 0/0/2 vlan 10');
    expect(sw.getMACTable().filter(x => x.type === 'static')).toHaveLength(2);
  });

  it('un port, un VLAN ou une adresse qui n\'existe pas sont refuses en le DESIGNANT', async () => {
    await enSysteme(sw);
    const [absent] = await taper(sw, ['mac-address static 0011-2233-4455 GigabitEthernet0/0/9 vlan 10']);
    expect(absent.split('\n')[2].indexOf('^')).toBe('mac-address static 0011-2233-4455 '.length);

    const [vlan] = await taper(sw, ['mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 77']);
    expect(vlan).toBe('Error: The VLAN 77 does not exist.');

    const [mac] = await taper(sw, ['mac-address static zzz GigabitEthernet0/0/1 vlan 10']);
    expect(mac.split('\n')[2].indexOf('^')).toBe('mac-address static '.length);
    expect(sw.getMACTable()).toHaveLength(0);
  });

  it('une entree noire JETTE vraiment la trame, dans les deux sens', async () => {
    const { pc1, pc2, sw: commutateur } = await maquette();
    const temoin = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(temoin).toMatch(/1 received/);

    const macPc2 = pc2.getPort('eth0')!.getMAC().toString();
    commutateur.clearMACTable();
    await taper(commutateur, ['system-view', `mac-address blackhole ${macPc2.replace(/:/g, '').match(/.{4}/g)!.join('-')} vlan 1`]);

    const apres = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(apres).toMatch(/100% packet loss/);
  });

  it('une entree statique fait suivre vers le port nomme sans apprentissage', async () => {
    const { pc1, pc2, sw: commutateur } = await maquette();
    const macPc2 = pc2.getPort('eth0')!.getMAC().toString().toLowerCase();
    commutateur.clearMACTable();
    commutateur.addStaticMAC(macPc2, 1, 'GigabitEthernet0/0/1');
    const out = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(out).toMatch(/1 received/);
    expect(commutateur.getMACTable().find(e => e.mac === macPc2)!.type).toBe('static');
  });

  it('`mac-address aging-time` se rend, et son `undo` rend VRAIMENT le defaut', async () => {
    await enSysteme(sw, ['mac-address aging-time 500']);
    expect(sw.getMACAgingTime()).toBe(500);
    expect(await config(sw)).toEqual(['mac-address aging-time 500']);

    await taper(sw, ['system-view', 'undo mac-address aging-time']);
    expect(sw.getMACAgingTime()).toBe(300);
    expect(await config(sw)).toEqual([]);
  });

  it('la configuration rendue est REJOUABLE : relue, elle refait la meme table', async () => {
    await enSysteme(sw, [
      'mac-address aging-time 120',
      'mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 10',
      'mac-address blackhole 0011-2233-6666 vlan 10',
    ]);
    const lignes = await config(sw);
    expect(lignes).toEqual([
      'mac-address aging-time 120',
      'mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 10',
      'mac-address blackhole 0011-2233-6666 vlan 10',
    ]);

    const copie = neuf();
    await taper(copie, ['system-view', 'vlan 10', 'quit', ...lignes]);
    expect(copie.getMACAgingTime()).toBe(120);
    expect(copie.getMACTable().map(e => [e.mac, e.vlan, e.port, e.type]).sort())
      .toEqual(sw.getMACTable().map(e => [e.mac, e.vlan, e.port, e.type]).sort());
  });

  it('`display mac-address <critere>` FILTRE au lieu de tout rendre', async () => {
    await enSysteme(sw, [
      'vlan 20', 'quit',
      'mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 10',
      'mac-address static 0011-2233-7788 GigabitEthernet0/0/2 vlan 20',
      'mac-address blackhole 0011-2233-6666 vlan 10',
      'return',
    ]);
    const compte = (texte: string) => Number(texte.match(/Total items displayed = (\d+)/)![1]);
    expect(compte(await sw.executeCommand('display mac-address'))).toBe(3);
    expect(compte(await sw.executeCommand('display mac-address static'))).toBe(2);
    expect(compte(await sw.executeCommand('display mac-address blackhole'))).toBe(1);
    expect(compte(await sw.executeCommand('display mac-address dynamic'))).toBe(0);
    expect(compte(await sw.executeCommand('display mac-address vlan 20'))).toBe(1);
    expect(compte(await sw.executeCommand('display mac-address GigabitEthernet0/0/1'))).toBe(1);
    expect(await sw.executeCommand('display mac-address GigabitEthernet0/0/9'))
      .toContain('Unrecognized command');
  });

  it('`undo mac-address static|blackhole` retire l\'entree nommee, et elle seule', async () => {
    await enSysteme(sw, [
      'mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 10',
      'mac-address blackhole 0011-2233-6666 vlan 10',
      'undo mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 10',
    ]);
    expect(sw.getMACTable().map(e => e.type)).toEqual(['blackhole']);
    await taper(sw, ['undo mac-address blackhole 0011-2233-6666 vlan 10']);
    expect(sw.getMACTable()).toHaveLength(0);
    expect(await sw.executeCommand('undo mac-address static 0011-2233-4455 GigabitEthernet0/0/1 vlan 10'))
      .toBe('Error: The MAC address entry does not exist.');
  });

  it('une entree noire ne vieillit pas et ne part pas avec les dynamiques', async () => {
    await enSysteme(sw, ['mac-address blackhole 0011-2233-6666 vlan 10']);
    sw.clearDynamicMACEntries();
    expect(sw.getMACTable()).toHaveLength(1);
    expect(sw.getMACTable()[0].age).toBe(-1);
  });

  it('`mac-address learning disable` est REFUSE, faute de moteur derriere', async () => {
    await enSysteme(sw);
    const [sortie] = await taper(sw, ['mac-address learning disable']);
    expect(sortie).toContain('Unrecognized command');
    expect(sortie.split('\n')[2].indexOf('^')).toBe('mac-address '.length);
  });

  it('un commutateur neuf ne rend AUCUNE ligne mac-address', async () => {
    expect(await config(sw)).toEqual([]);
    expect(sw.getMACAgingTime()).toBe(300);
  });
});
