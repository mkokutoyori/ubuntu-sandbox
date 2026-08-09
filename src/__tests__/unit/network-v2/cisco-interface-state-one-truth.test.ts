/**
 * PRD-Routage-Fidelite.md §4.2 / §6.5 — OSPF et IGMP lisent la meme vue
 * d'interface que `show ip interface brief`.
 *
 * La regle : une adjacence OSPF et une interface IGMP existent si et
 * seulement si `iosInterfaceStatus(port).protocol === 'up'`. Ce qui est
 * verifie ici n'est donc pas un libelle mais un ACCORD : les vues sont
 * comparees entre elles, jamais a une chaine ecrite a la main, et le
 * balayage passe par les trois facons dont une interface tombe — arret
 * administratif local, arret a l'autre bout, cable absent — parce que ce
 * sont precisement celles que les predicats maison confondaient.
 */
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

async function run(dev: CiscoRouter, cmds: string[]): Promise<void> {
  for (const c of cmds) await dev.executeCommand(c);
}

interface Vues {
  brief(iface: string): { status: string; protocol: string };
  ospf(iface: string): { status: string; protocol: string } | null;
  igmp(iface: string): { status: string; protocol: string } | null;
  ospfBriefState(iface: string): string | null;
  ospfBloc(iface: string): string | null;
  igmpBloc(iface: string): string | null;
}

function abrege(iface: string): string {
  return iface.replace(/^GigabitEthernet/, 'Gi').replace(/^Loopback/, 'Lo');
}

/** `<nom> is <status>, line protocol is <protocol>` — la ligne d'etat. */
function ligneEtat(texte: string, iface: string): { status: string; protocol: string } | null {
  const re = new RegExp(`^${iface} is ([^,]+), line protocol is (\\S+)`, 'm');
  const m = re.exec(texte);
  return m ? { status: m[1].trim(), protocol: m[2].trim() } : null;
}

/** Le bloc d'une interface, de sa ligne d'etat a la ligne vide suivante. */
function bloc(texte: string, iface: string): string | null {
  const lignes = texte.split('\n');
  const i = lignes.findIndex((l) => l.startsWith(`${iface} is `));
  if (i < 0) return null;
  const out: string[] = [];
  for (let k = i; k < lignes.length && lignes[k].trim() !== ''; k++) out.push(lignes[k]);
  return out.join('\n');
}

async function vues(r: CiscoRouter): Promise<Vues> {
  const brief = await r.executeCommand('show ip interface brief');
  const ospf = await r.executeCommand('show ip ospf interface');
  const ospfBrief = await r.executeCommand('show ip ospf interface brief');
  const igmp = await r.executeCommand('show ip igmp interface');
  return {
    brief(iface) {
      const l = brief.split('\n').find((x) => x.startsWith(iface + ' '));
      if (!l) throw new Error(`${iface} absente de show ip interface brief`);
      const m = /\s(administratively down|up|down)\s+(up|down)\s*$/.exec(l);
      if (!m) throw new Error(`ligne illisible : ${l}`);
      return { status: m[1], protocol: m[2] };
    },
    ospf: (iface) => ligneEtat(ospf, iface),
    igmp: (iface) => ligneEtat(igmp, iface),
    ospfBriefState(iface) {
      const l = ospfBrief.split('\n').find((x) => x.startsWith(abrege(iface) + ' '));
      return l ? (l.trim().split(/\s+/).slice(-2)[0] ?? null) : null;
    },
    ospfBloc: (iface) => bloc(ospf, iface),
    igmpBloc: (iface) => bloc(igmp, iface),
  };
}

/**
 * A —— B, OSPF et IGMP actifs des deux cotes, plus une Loopback qui n'a
 * pas de porteuse du tout : elle est la reference « virtuelle », celle
 * qu'un predicat fonde sur le cablage declare morte a tort.
 */
async function labo(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
  const a = new CiscoRouter('RA');
  const b = new CiscoRouter('RB');
  new Cable('cab').connect(a.getPorts()[0], b.getPorts()[0]);
  for (const [d, n] of [[a, '1'], [b, '2']] as const) {
    await run(d, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address 10.0.12.${n} 255.255.255.0`, 'no shutdown', 'exit',
      'interface Loopback0', `ip address 1.1.1.${n} 255.255.255.255`, 'exit',
      'ip multicast-routing',
      'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'exit',
      'interface GigabitEthernet0/0', 'ip pim sparse-mode', 'ip igmp version 2', 'exit',
      'interface Loopback0', 'ip pim sparse-mode', 'ip igmp version 2', 'end',
    ]);
  }
  return { a, b };
}

const CHUTES = [
  ['un arret administratif local', async (a: CiscoRouter) =>
    run(a, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end'])],
  ['un arret a l\'autre bout', async (_a: CiscoRouter, b: CiscoRouter) =>
    run(b, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end'])],
  ['un cable debranche', async (_a: CiscoRouter, _b: CiscoRouter, c: Cable) => { c.disconnect(); }],
] as const;

describe('les vues d\'interface s\'accordent, quelle que soit la facon de tomber', () => {
  it('OSPF, IGMP et `show ip interface brief` disent le meme etat sur un lien vivant', async () => {
    const { a } = await labo();
    const v = await vues(a);
    for (const iface of ['GigabitEthernet0/0', 'Loopback0']) {
      const b = v.brief(iface);
      expect(b, iface).toEqual({ status: 'up', protocol: 'up' });
      expect(v.ospf(iface), `OSPF/${iface}`).toEqual(b);
      expect(v.igmp(iface), `IGMP/${iface}`).toEqual(b);
    }
  });

  it.each(CHUTES)('apres %s, les trois vues tombent ensemble', async (_nom, faire) => {
    const { a, b } = await labo();
    const cable = a.getPorts()[0].getCable()!;
    await faire(a, b, cable);

    const v = await vues(a);
    const attendu = v.brief('GigabitEthernet0/0');
    expect(attendu.protocol).toBe('down');
    expect(v.ospf('GigabitEthernet0/0'), 'OSPF doit dire ce que dit brief').toEqual(attendu);
    expect(v.igmp('GigabitEthernet0/0'), 'IGMP doit dire ce que dit brief').toEqual(attendu);
  });

  it('la Loopback reste vue vivante par les trois, sans porteuse ni cable', async () => {
    const { a, b } = await labo();
    await run(b, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    const v = await vues(a);
    const attendu = v.brief('Loopback0');
    expect(attendu).toEqual({ status: 'up', protocol: 'up' });
    expect(v.ospf('Loopback0')).toEqual(attendu);
    expect(v.igmp('Loopback0')).toEqual(attendu);
  });

  it('`administratively down` n\'est pas aplati en `down`', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    const v = await vues(a);
    for (const vue of [v.brief('GigabitEthernet0/0'), v.ospf('GigabitEthernet0/0'), v.igmp('GigabitEthernet0/0')]) {
      expect(vue!.status).toBe('administratively down');
    }
  });
});

describe('un lien mort n\'elit personne', () => {
  it.each(CHUTES)('apres %s, OSPF ne se declare plus DR', async (_nom, faire) => {
    const { a, b } = await labo();
    expect((await vues(a)).ospfBloc('GigabitEthernet0/0')).toMatch(/State DR,/);

    await faire(a, b, a.getPorts()[0].getCable()!);
    const bloc = (await vues(a)).ospfBloc('GigabitEthernet0/0')!;
    expect(bloc).toMatch(/State DOWN,/);
    expect(bloc).toMatch(/^ {2}DR: 0\.0\.0\.0$/m);
    expect(bloc).toMatch(/^ {2}BDR: 0\.0\.0\.0$/m);
  });

  it('IGMP ne se declare plus routeur interrogateur', async () => {
    const { a, b } = await labo();
    expect((await vues(a)).igmpBloc('GigabitEthernet0/0')).toMatch(/IGMP querying router is 10\.0\.12\.1 \(this system\)/);

    await run(b, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    expect((await vues(a)).igmpBloc('GigabitEthernet0/0')).not.toMatch(/querying router/);
  });

  it('les deux vues OSPF s\'accordent sur l\'etat de la meme interface', async () => {
    const { a, b } = await labo();
    expect((await vues(a)).ospfBriefState('GigabitEthernet0/0')).toBe('DR');

    await run(b, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    const v = await vues(a);
    expect(v.ospfBriefState('GigabitEthernet0/0')).toBe('DOWN');
    expect(v.ospfBloc('GigabitEthernet0/0')).toMatch(/State DOWN/);
  });

  it('l\'adjacence disparait en meme temps que le lien', async () => {
    const { a, b } = await labo();
    expect(await a.executeCommand('show ip ospf neighbor')).toMatch(/1\.1\.1\.2/);
    await run(b, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    expect(await a.executeCommand('show ip ospf neighbor')).not.toMatch(/1\.1\.1\.2/);
  });
});

describe('un lien qui revient est vu revenir par les trois', () => {
  it('apres `no shutdown` a l\'autre bout, tout remonte ensemble', async () => {
    const { a, b } = await labo();
    await run(b, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    expect((await vues(a)).brief('GigabitEthernet0/0').protocol).toBe('down');

    await run(b, ['configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']);
    const v = await vues(a);
    const attendu = v.brief('GigabitEthernet0/0');
    expect(attendu).toEqual({ status: 'up', protocol: 'up' });
    expect(v.ospf('GigabitEthernet0/0')).toEqual(attendu);
    expect(v.igmp('GigabitEthernet0/0')).toEqual(attendu);
    const bloc = v.ospfBloc('GigabitEthernet0/0')!;
    expect(bloc).toMatch(/State (DR|Backup|DROther),/);
    expect(bloc).toMatch(/^ {2}DR: 10\.0\.12\.[12]$/m);
  });
});
