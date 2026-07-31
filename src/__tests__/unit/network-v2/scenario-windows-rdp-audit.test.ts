/**
 * PRD-Winlogon.md §2.1 P4 — fidélité de l'audit RDP : LogonType 10 réel
 * (aucun double 4624), corrélation 4634 par TargetLogonId comme SSH, et
 * la distinction Terminal Services entre une déconnexion de transport
 * sans logoff explicite (4779, session laissée `Disconnected`) et une
 * reconnexion à cette session existante (4778, sans nouveau 4624).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { RDP_PORT } from '@/network/devices/windows/server/rdp/RdpSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

function securityEvents(pc: WindowsServer) {
  return pc.eventLog.getEntriesStructured('Security', { newest: 100 }) ?? [];
}
function eventIds(pc: WindowsServer): number[] {
  return securityEvents(pc).map((e) => e.eventId);
}

async function buildLan() {
  const server = new WindowsServer('SRV1');
  const client = new WindowsServer('CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.96.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.96.20'), mask);
  server.setCurrentUser('Administrator');
  await run(ps(server), 'Enable-RemoteDesktop');
  // "Other Logon/Logoff Events" (4778/4779, like 4800-4803) is not in
  // the default audit baseline for any profile — matching real Windows,
  // it's an optional advanced subcategory — enabled directly on the
  // policy object rather than via `auditpol` to avoid an admin-rights
  // detour unrelated to what these tests assert on.
  server.auditPolicy.set('Other Logon/Logoff Events', { success: true, failure: true });
  return { server, client };
}

function verifierFor(server: WindowsServer): CertificateVerifier {
  return new CertificateVerifier({ trustAnchors: [server.getRdpTlsCertificate()] });
}

describe('PRD-Winlogon.md P4 — fidélité audit RDP', () => {
  it('une connexion RDP réussie journalise un seul 4624 avec Logon Type 10, pas deux', async () => {
    const { server, client } = await buildLan();
    const result = client.dialRdp('192.168.96.10', 'bob', 'bob', verifierFor(server));
    expect(result.ok).toBe(true);

    // Filtre sur `bob` : le journal contient déjà des 4624/4625 de
    // démonstration pré-amorcés au démarrage de l'équipement, sans
    // rapport avec cette connexion.
    const logons = securityEvents(server).filter((e) => e.eventId === 4624 && e.data?.TargetUserName === 'bob');
    expect(logons).toHaveLength(1);
    expect(logons[0].data?.LogonType).toBe('10');
  });

  it('des identifiants invalides journalisent 4625 et aucune session n\'est créée', async () => {
    const { server, client } = await buildLan();
    const result = client.dialRdp('192.168.96.10', 'bob', 'wrongpassword', verifierFor(server));
    expect(result.ok).toBe(false);

    const bobEvents = securityEvents(server).filter((e) => e.data?.TargetUserName === 'bob');
    expect(bobEvents.map((e) => e.eventId)).toEqual([4625]);
  });

  it('logoff/rwinsta journalise 4634 corrélé au 4624 d\'origine par TargetLogonId', async () => {
    const { server, client } = await buildLan();
    const result = client.dialRdp('192.168.96.10', 'bob', 'bob', verifierFor(server));
    expect(result.ok).toBe(true);

    const logonId = securityEvents(server).find((e) => e.eventId === 4624)?.data?.TargetLogonId;
    expect(logonId).toBeDefined();

    const out = await server.executeCmdCommand(`logoff ${result.sessionId}`);
    expect(out).toBe('');

    const logoffEvent = securityEvents(server).find((e) => e.eventId === 4634);
    expect(logoffEvent?.data?.TargetLogonId).toBe(logonId);
    expect(logoffEvent?.data?.TargetUserName).toBe('bob');
  });

  it('un client qui décroche sans logoff (câble coupé) journalise 4779 et laisse la session Disconnected, pas 4634', async () => {
    const { server, client } = await buildLan();
    const result = client.dialRdp('192.168.96.10', 'bob', 'bob', verifierFor(server));
    expect(result.ok).toBe(true);

    const clientSocket = client.getTcpStack()
      .listSockets()
      .find((s) => s.remoteIp === '192.168.96.10' && s.remotePort === RDP_PORT);
    expect(clientSocket).toBeDefined();
    clientSocket!.abort();

    expect(eventIds(server)).toContain(4779);
    expect(eventIds(server)).not.toContain(4634);

    const query = await server.executeCmdCommand('query session');
    expect(query).toMatch(/bob.*Disc/);
  });

  it('une reconnexion à une session Disconnected journalise 4778, pas un nouveau 4624', async () => {
    const { server, client } = await buildLan();
    const first = client.dialRdp('192.168.96.10', 'bob', 'bob', verifierFor(server));
    expect(first.ok).toBe(true);

    const clientSocket = client.getTcpStack()
      .listSockets()
      .find((s) => s.remoteIp === '192.168.96.10' && s.remotePort === RDP_PORT);
    clientSocket!.abort();
    expect(eventIds(server)).toContain(4779);

    const before4624 = eventIds(server).filter((id) => id === 4624).length;

    const second = client.dialRdp('192.168.96.10', 'bob', 'bob', verifierFor(server));
    expect(second.ok).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);

    expect(eventIds(server)).toContain(4778);
    const after4624 = eventIds(server).filter((id) => id === 4624).length;
    expect(after4624).toBe(before4624);

    const query = await server.executeCmdCommand('query session');
    expect(query).toMatch(/bob.*Acti/);
  });
});
