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

interface Lab {
  r: CiscoRouter;
  pc: LinuxPC;
  srv: LinuxServer;
  vues: string[];
}

async function lab(): Promise<Lab> {
  const r = new CiscoRouter('Router');
  const pc = new LinuxPC('PC-Linux');
  const srv = new LinuxServer('SRV-Oracle');
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);

  await run(r, 'enable');
  await run(r, 'configure terminal');
  await run(r, 'interface GigabitEthernet0/0');
  await run(r, 'ip address 192.168.10.254 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'exit');
  await run(r, 'interface GigabitEthernet0/1');
  await run(r, 'ip address 192.168.20.254 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'end');

  pc.configureInterface('eth0', new IPAddress('192.168.10.105'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('192.168.20.20'), new SubnetMask('255.255.255.0'));
  await run(pc, 'ip route add default via 192.168.10.254');
  await run(srv, 'ip route add default via 192.168.20.254');

  const vues: string[] = [];
  r.getDebugService().subscribe((l: string) => vues.push(l));
  return { r, pc, srv, vues };
}

async function filtreTcp(r: CiscoRouter): Promise<void> {
  await run(r, 'configure terminal');
  await run(r, 'ip access-list extended FILTRE-TCP');
  await run(r, '10 permit tcp host 192.168.10.105 host 192.168.20.20 eq 1521');
  await run(r, '20 permit tcp host 192.168.20.20 eq 1521 host 192.168.10.105');
  await run(r, 'exit');
  await run(r, 'end');
}

const tcp = (vues: string[]) => vues.filter(l => l.startsWith('TCP:'));
const pause = () => new Promise((res) => setTimeout(res, 300));

/**
 * Le 1521 est désormais RÉELLEMENT servi dès l'amorçage d'un
 * `LinuxServer` (docs/PRD-Manquements.md §M1) : y poser une seconde
 * écoute lève EADDRINUSE. Ce test posait la sienne parce que rien ne le
 * faisait — même correctif qu'à `scenario-debug-s07-filtres-precis`.
 */
function ecouter(srv: LinuxServer, port: number): void {
  const dejaServi = srv.getTcpStack().listListeners().some((l) => l.localPort === port);
  if (!dejaServi) srv.getTcpStack().listen(port, { onAccept: () => {} });
}

/**
 * Un port que RIEN ne sert, pour le cas du refus. Il ne peut plus être le
 * 1521 : c'est justement celui qu'un serveur Oracle ouvre, et un test du
 * RST posé dessus ne mesurerait plus qu'une coïncidence.
 */
const PORT_FERME = 9999;

describe('Scénario 5 — debug ip tcp suit les connexions', () => {
  it('la confirmation parle d\'évènements TCP et nomme l\'ACL', async () => {
    const { r } = await lab();
    await filtreTcp(r);
    const out = await run(r, 'debug ip tcp transactions FILTRE-TCP');
    expect(out).toContain('TCP special event debugging is on');
    expect(out).toContain('FILTRE-TCP');
  });

  it('le trois-temps SYN, SYN-ACK, ACK est tracé dans l\'ordre', async () => {
    const { r, pc, srv, vues } = await lab();
    ecouter(srv, 1521);
    await run(r, 'debug ip tcp');

    pc.getTcpStack().connect('192.168.20.20', 1521);
    await pause();

    const lignes = tcp(vues);
    const iSyn = lignes.findIndex(l => /^TCP: sending SYN, seq \d+, ack \d+$/.test(l));
    const iSynAck = lignes.findIndex(l => /^TCP: received SYN-ACK, seq \d+, ack \d+$/.test(l));
    const iAck = lignes.findIndex(l => /^TCP: sending ACK, seq \d+, ack \d+$/.test(l));
    expect(iSyn).toBeGreaterThanOrEqual(0);
    expect(iSynAck).toBeGreaterThan(iSyn);
    expect(iAck).toBeGreaterThan(iSynAck);
  });

  it('la connexion établie est annoncée avec sa cible et son port', async () => {
    const { r, pc, srv, vues } = await lab();
    ecouter(srv, 1521);
    await run(r, 'debug ip tcp');

    pc.getTcpStack().connect('192.168.20.20', 1521);
    await pause();

    expect(tcp(vues).some(l => l === 'TCP: Connection to 192.168.20.20:1521 ESTABLISHED')).toBe(true);
  });

  it('une fermeture propre passe par FIN', async () => {
    const { r, pc, srv, vues } = await lab();
    ecouter(srv, 1521);
    await run(r, 'debug ip tcp');

    const s = pc.getTcpStack().connect('192.168.20.20', 1521);
    await pause();
    s?.close();
    await pause();

    expect(tcp(vues).some(l => /^TCP: (sending|received) FIN(-ACK)?, seq \d+, ack \d+$/.test(l))).toBe(true);
  });

  it('un port fermé répond RST immédiatement après le SYN', async () => {
    const { r, pc, vues } = await lab();
    await run(r, 'debug ip tcp');

    pc.getTcpStack().connect('192.168.20.20', PORT_FERME);
    await pause();

    const lignes = tcp(vues);
    const iSyn = lignes.findIndex(l => /sending SYN/.test(l));
    const iRst = lignes.findIndex(l => l === 'TCP: received RST');
    expect(iSyn).toBeGreaterThanOrEqual(0);
    expect(iRst).toBeGreaterThan(iSyn);
    expect(lignes.some(l => /SYN-ACK/.test(l))).toBe(false);
  });

  it('sans debug, aucune ligne TCP n\'est émise', async () => {
    const { pc, srv, vues } = await lab();
    ecouter(srv, 1521);
    pc.getTcpStack().connect('192.168.20.20', 1521);
    await pause();
    expect(tcp(vues)).toEqual([]);
  });

  it('undebug all arrête la trace', async () => {
    const { r, pc, srv, vues } = await lab();
    ecouter(srv, 1521);
    await run(r, 'debug ip tcp');
    pc.getTcpStack().connect('192.168.20.20', 1521);
    await pause();
    const avant = tcp(vues).length;
    expect(avant).toBeGreaterThan(0);

    await run(r, 'undebug all');
    pc.getTcpStack().connect('192.168.20.20', 1521);
    await pause();
    expect(tcp(vues).length).toBe(avant);
  });
});
