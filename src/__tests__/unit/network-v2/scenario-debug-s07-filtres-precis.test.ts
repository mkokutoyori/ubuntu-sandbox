import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

const PC = '192.168.10.105';
const ORACLE = '192.168.20.20';
const WEB = '192.168.30.30';

interface Lab {
  r: CiscoRouter;
  pc: LinuxPC;
  oracle: LinuxServer;
  web: LinuxServer;
  vues: string[];
}

async function lab(): Promise<Lab> {
  const r = new CiscoRouter('Router');
  const pc = new LinuxPC('PC-Client');
  const oracle = new LinuxServer('SRV-Oracle');
  const web = new LinuxServer('SRV-Web');
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, oracle.getPort('eth0')!);
  new Cable('c').connect(r.getPort('GigabitEthernet0/2')!, web.getPort('eth0')!);

  await run(r, 'enable');
  await run(r, 'configure terminal');
  await run(r, 'interface GigabitEthernet0/0');
  await run(r, 'ip address 192.168.10.254 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'exit');
  await run(r, 'interface GigabitEthernet0/1');
  await run(r, 'ip address 192.168.20.254 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'exit');
  await run(r, 'interface GigabitEthernet0/2');
  await run(r, 'ip address 192.168.30.254 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'end');

  pc.configureInterface('eth0', new IPAddress(PC), new SubnetMask('255.255.255.0'));
  oracle.configureInterface('eth0', new IPAddress(ORACLE), new SubnetMask('255.255.255.0'));
  web.configureInterface('eth0', new IPAddress(WEB), new SubnetMask('255.255.255.0'));
  await run(pc, 'ip route add default via 192.168.10.254');
  await run(oracle, 'ip route add default via 192.168.20.254');
  await run(web, 'ip route add default via 192.168.30.254');

  const vues: string[] = [];
  r.getDebugService().subscribe((l: string) => vues.push(l));
  return { r, pc, oracle, web, vues };
}

async function acl(r: CiscoRouter, nom: string, regles: string[]): Promise<string[]> {
  const sorties: string[] = [];
  await run(r, 'configure terminal');
  sorties.push(await run(r, `ip access-list extended ${nom}`));
  let n = 10;
  for (const regle of regles) {
    sorties.push(await run(r, `${n} ${regle}`));
    n += 10;
  }
  await run(r, 'exit');
  await run(r, 'end');
  return sorties;
}

const pause = () => new Promise((res) => setTimeout(res, 300));

const paquets = (vues: string[]) => vues.filter(l => l.startsWith('IP: '));
const proto = (vues: string[], n: number) => paquets(vues).filter(l => l.includes(`(proto ${n})`));
const transport = (vues: string[]) => vues.filter(l => l.startsWith('TCP src=') || l.startsWith('UDP src='));

async function connecter(pc: LinuxPC, srv: LinuxServer, ip: string, port: number): Promise<void> {
  // Le 1521 est désormais RÉELLEMENT servi dès l'amorçage d'un
  // `LinuxServer` (docs/PRD-Manquements.md §M1) : ouvrir une seconde
  // écoute dessus lève EADDRINUSE. Ce test posait la sienne parce que
  // rien ne le faisait — le même contournement que §P2a a retiré de
  // `scenario-listen-vs-filtered.test.ts`. On ne pose donc une écoute
  // que si personne ne sert déjà ce port ; les autres ports du scénario
  // (80, 443) en ont toujours besoin.
  const dejaServi = srv.getTcpStack().listListeners().some((l) => l.localPort === port);
  if (!dejaServi) srv.getTcpStack().listen(port, { onAccept: () => {} });
  pc.getTcpStack().connect(ip, port);
  await pause();
}

async function troisProtocoles(pc: LinuxPC, oracle: LinuxServer): Promise<void> {
  await run(pc, `ping -c 1 ${ORACLE}`);
  await pause();
  pc.sendUdpDatagram(new IPAddress(ORACLE), 53, 45231, { type: 'dns' } as never);
  await pause();
  await connecter(pc, oracle, ORACLE, 1521);
}

describe('Scénario 7 — filtrage précis, du plus large au plus fin', () => {
  it('les quatre niveaux de filtre sont acceptés par la CLI', async () => {
    const { r } = await lab();
    const sorties = [
      ...await acl(r, 'N1', [`permit ip host ${PC} any`]),
      ...await acl(r, 'N2', [`permit tcp host ${PC} any`]),
      ...await acl(r, 'N3', [`permit tcp host ${PC} host ${ORACLE}`]),
      ...await acl(r, 'N4', [`permit tcp host ${PC} host ${ORACLE} eq 1521`]),
    ];
    for (const s of sorties) expect(s).not.toContain('Invalid input');

    const vue = await run(r, 'show ip access-lists N4');
    expect(vue).toMatch(/permit tcp host 192\.168\.10\.105 host 192\.168\.20\.20 eq 1521/);
  });

  it('niveau 1 — l\'hôte seul laisse passer ICMP, UDP et TCP', async () => {
    const { r, pc, oracle, vues } = await lab();
    await acl(r, 'N1', [`permit ip host ${PC} any`]);
    await run(r, 'debug ip packet N1');

    await troisProtocoles(pc, oracle);

    expect(proto(vues, 1).length).toBeGreaterThan(0);
    expect(proto(vues, 17).length).toBeGreaterThan(0);
    expect(proto(vues, 6).length).toBeGreaterThan(0);
  });

  it('niveau 2 — restreindre au protocole écarte ICMP et UDP', async () => {
    const { r, pc, oracle, vues } = await lab();
    await acl(r, 'N2', [`permit tcp host ${PC} any`]);
    await run(r, 'debug ip packet N2');

    await troisProtocoles(pc, oracle);

    expect(proto(vues, 6).length).toBeGreaterThan(0);
    expect(proto(vues, 1)).toEqual([]);
    expect(proto(vues, 17)).toEqual([]);
  });

  it('niveau 3 — désigner le serveur écarte les autres destinations', async () => {
    const { r, pc, oracle, web, vues } = await lab();
    await acl(r, 'N3', [`permit tcp host ${PC} host ${ORACLE}`]);
    await run(r, 'debug ip packet N3');

    await connecter(pc, oracle, ORACLE, 1521);
    await connecter(pc, web, WEB, 8080);

    expect(paquets(vues).some(l => l.includes(`d=${ORACLE}`))).toBe(true);
    expect(paquets(vues).some(l => l.includes(`d=${WEB}`))).toBe(false);
  });

  it('niveau 4 — le port ne retient que le service visé', async () => {
    const { r, pc, oracle, vues } = await lab();
    await acl(r, 'N4', [`permit tcp host ${PC} host ${ORACLE} eq 1521`]);
    await run(r, 'debug ip packet N4 detail');

    await connecter(pc, oracle, ORACLE, 1521);
    await connecter(pc, oracle, ORACLE, 8080);

    const detail = transport(vues);
    expect(detail.some(l => l.startsWith('TCP src=') && /dst=1521,/.test(l))).toBe(true);
    expect(detail.some(l => /dst=8080,/.test(l))).toBe(false);
  });

  it('un filtre de service pris seul suit ce service depuis n\'importe quel hôte', async () => {
    const { r, pc, oracle, vues } = await lab();
    await acl(r, 'RDP', ['permit tcp any any eq 3389']);
    await run(r, 'debug ip packet RDP detail');

    await connecter(pc, oracle, ORACLE, 3389);
    await connecter(pc, oracle, ORACLE, 1521);

    const detail = transport(vues);
    expect(detail.some(l => /dst=3389,/.test(l))).toBe(true);
    expect(detail.some(l => /dst=1521,/.test(l))).toBe(false);
  });

  it('le filtre le plus fin ne coupe pas les autres debugs', async () => {
    const { r, pc, oracle, vues } = await lab();
    await acl(r, 'N4', [`permit tcp host ${PC} host ${ORACLE} eq 1521`]);
    await run(r, 'debug ip packet N4');
    await run(r, 'debug ip icmp');

    await run(pc, `ping -c 1 ${ORACLE}`);
    await pause();

    expect(proto(vues, 1)).toEqual([]);
    expect(vues.some(l => l.startsWith('ICMP:'))).toBe(true);
  });

  it('undebug all arrête le filtre le plus fin comme les autres', async () => {
    const { r, pc, oracle, vues } = await lab();
    await acl(r, 'N4', [`permit tcp host ${PC} host ${ORACLE} eq 1521`]);
    await run(r, 'debug ip packet N4');

    await connecter(pc, oracle, ORACLE, 1521);
    const avant = paquets(vues).length;
    expect(avant).toBeGreaterThan(0);

    await run(r, 'undebug all');
    pc.getTcpStack().connect(ORACLE, 1521);
    await pause();
    expect(paquets(vues).length).toBe(avant);
  });
});
