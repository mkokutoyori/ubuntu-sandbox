/**
 * RDP connection negotiation — PRD-Windows-Server-Advanced.md §5 P17,
 * §2.1.16, MS-RDPBCGR. TPKT/X.224 Connection Request/Confirm, a real TLS
 * 1.3 handshake standing in for the CredSSP/NLA security channel (zero
 * new crypto primitive — `TlsClientSession`/`TlsServerSession` reused
 * exactly as SSH/HTTPS/FTPS already do), then one credential PDU. A
 * resulting session is a real session-table entry (`query session`/
 * `Get-RDUserSession`, torn down by `logoff`) — no graphical content is
 * ever asserted on, per the PRD's explicit scope boundary.
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

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan() {
  const server = new WindowsServer('SRV1');
  const client = new WindowsServer('CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.95.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.95.20'), mask);
  server.setCurrentUser('Administrator');
  // `bob` is one of the pre-seeded standard-cast local accounts (password = username).
  return { server, client };
}

function verifierFor(server: WindowsServer): CertificateVerifier {
  return new CertificateVerifier({ trustAnchors: [server.getRdpTlsCertificate()] });
}

describe('RDP negotiation (§5 P17)', () => {
  it('a client dial is refused before Enable-RemoteDesktop', async () => {
    const { server, client } = await buildLan();
    const result = client.dialRdp('192.168.95.10', 'bob', 'bob', verifierFor(server));
    expect(result.ok).toBe(false);
  });

  it('a valid TPKT/X.224 + CredSSP negotiation establishes a real session listed by query session', async () => {
    const { server, client } = await buildLan();
    await run(ps(server), 'Enable-RemoteDesktop');

    const result = client.dialRdp('192.168.95.10', 'bob', 'bob', verifierFor(server));
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const cmdOut = await server.executeCmdCommand('query session');
    expect(cmdOut).toContain('bob');

    const psOut = await run(ps(server), 'Get-RDUserSession | Select-Object -ExpandProperty UserName');
    expect(psOut.trim()).toBe('bob');
  });

  it('invalid credentials fail at the CredSSP/NLA step, before any session is created', async () => {
    const { server, client } = await buildLan();
    await run(ps(server), 'Enable-RemoteDesktop');

    const result = client.dialRdp('192.168.95.10', 'bob', 'wrongpassword', verifierFor(server));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Logon failure/);

    const psOut = await run(ps(server), 'Get-RDUserSession');
    expect(psOut).not.toContain('bob');
  });

  it('logoff closes the session cleanly', async () => {
    const { server, client } = await buildLan();
    await run(ps(server), 'Enable-RemoteDesktop');
    const result = client.dialRdp('192.168.95.10', 'bob', 'bob', verifierFor(server));
    expect(result.ok).toBe(true);

    const before = await server.executeCmdCommand('query session');
    expect(before).toContain('bob');

    const logoffOut = await server.executeCmdCommand(`logoff ${result.sessionId}`);
    expect(logoffOut).toBe('');

    const after = await server.executeCmdCommand('query session');
    expect(after).not.toContain('bob');
  });

  it('Disable-RemoteDesktop stops accepting new connections', async () => {
    const { server, client } = await buildLan();
    await run(ps(server), 'Enable-RemoteDesktop');
    await run(ps(server), 'Disable-RemoteDesktop');

    const result = client.dialRdp('192.168.95.10', 'bob', 'bob', verifierFor(server));
    expect(result.ok).toBe(false);
  });
});
