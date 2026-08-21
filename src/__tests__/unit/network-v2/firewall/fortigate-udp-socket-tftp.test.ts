import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TftpServer } from '@/network/tftp/TftpSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function laboratoire(options: { withServer?: boolean } = {}) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const srv = new LinuxServer('linux-server', 'TFTP1', -200, 0);
  new Cable('lan').connect(srv.getPort('eth0')!, fgt.getPort('port2')!);
  srv.configureInterface('eth0', new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  let server: TftpServer | null = null;
  if (options.withServer !== false) {
    server = new TftpServer(srv, {
      fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/tftp',
    });
    server.start();
  }

  await taper(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await fgt.executeCommand('execute ping 192.168.10.10');
  return { fgt, srv, vfs, server };
}

describe('le pare-feu ouvre un port UDP', () => {
  it('un port lie recoit un datagramme venu du fil', async () => {
    const { fgt, srv } = await laboratoire({ withServer: false });
    const recus: { port: number; charge: unknown }[] = [];
    fgt.getUdpEndpoint().udpBind(9999, (livraison) => {
      recus.push({ port: livraison.udp.sourcePort, charge: livraison.udp.payload });
    });

    srv.sendUdpDatagram(new IPAddress('192.168.10.1'), 9999, 4242,
      Uint8Array.from([1, 2, 3]), 3);

    expect(recus.length).toBe(1);
    expect(recus[0].port).toBe(4242);
  });

  it('un port ferme ne recoit plus rien', async () => {
    const { fgt, srv } = await laboratoire({ withServer: false });
    const recus: number[] = [];
    fgt.getUdpEndpoint().udpBind(9999, () => { recus.push(1); });
    fgt.getUdpEndpoint().udpClose(9999);

    srv.sendUdpDatagram(new IPAddress('192.168.10.1'), 9999, 4242,
      Uint8Array.from([1]), 1);

    expect(recus.length).toBe(0);
  });

  it('le pare-feu EMET un datagramme que le voisin recoit', async () => {
    const { fgt, srv } = await laboratoire({ withServer: false });
    const recus: { source: string; port: number }[] = [];
    srv.udpBind(7777, (dgram) => {
      recus.push({ source: dgram.udp.sourcePort.toString(), port: dgram.udp.destinationPort });
    });

    const parti = fgt.getUdpEndpoint().sendUdpDatagramTo(
      new IPAddress('192.168.10.10'), 7777, 5555, Uint8Array.from([9]));

    expect(parti).toBe(true);
    expect(recus.length).toBe(1);
    expect(recus[0].port).toBe(7777);
  });

  it('deux liaisons sur le meme port sont refusees', async () => {
    const { fgt } = await laboratoire({ withServer: false });

    expect(fgt.getUdpEndpoint().udpBind(6000, () => undefined)).toBe(true);
    expect(fgt.getUdpEndpoint().udpBind(6000, () => undefined)).toBe(false);
  });

  it('un port ephemere n est jamais un port deja lie', async () => {
    const { fgt } = await laboratoire({ withServer: false });
    const endpoint = fgt.getUdpEndpoint();
    const pris = new Set<number>();

    for (let i = 0; i < 20; i++) {
      const port = endpoint.allocateEphemeralPort();
      expect(pris.has(port)).toBe(false);
      endpoint.udpBind(port, () => undefined);
      pris.add(port);
    }

    expect(pris.size).toBe(20);
  });
});

describe('execute vpn certificate local export tftp — un vrai transfert', () => {
  it('le certificat ARRIVE sur le serveur, avec son PEM', async () => {
    const { fgt, vfs } = await laboratoire();

    const vu = await fgt.executeCommand(
      'execute vpn certificate local export tftp Fortinet_CA_SSL fortinet_ca.cer 192.168.10.10');

    expect(vu).not.toMatch(/Unknown action|command parse error|no UDP socket layer/i);
    const depose = vfs.readFile('/srv/tftp/fortinet_ca.cer');
    expect(depose).not.toBeNull();
    expect(depose).toContain('BEGIN CERTIFICATE');
  });

  it('ce qui arrive est CE certificat, pas un texte quelconque', async () => {
    const { fgt, vfs } = await laboratoire();
    const lu = await fgt.executeCommand('show vpn certificate local Fortinet_CA_SSL');

    await fgt.executeCommand(
      'execute vpn certificate local export tftp Fortinet_CA_SSL fortinet_ca.cer 192.168.10.10');

    const depose = vfs.readFile('/srv/tftp/fortinet_ca.cer');
    expect(depose).not.toBeNull();
    const corps = depose!.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    expect(corps.length).toBeGreaterThan(2);
    for (const ligne of corps) expect(lu).toContain(ligne);
  });

  it('un certificat absent est refuse avant tout transfert', async () => {
    const { fgt, vfs } = await laboratoire();

    const vu = await fgt.executeCommand(
      'execute vpn certificate local export tftp Absent fortinet_ca.cer 192.168.10.10');

    expect(vu).toMatch(/does not exist/i);
    expect(vfs.readFile('/srv/tftp/fortinet_ca.cer')).toBeNull();
  });

  it('sans serveur en face, la commande le DIT au lieu de reussir', async () => {
    const { fgt } = await laboratoire({ withServer: false });

    const vu = await fgt.executeCommand(
      'execute vpn certificate local export tftp Fortinet_CA_SSL fortinet_ca.cer 192.168.10.10');

    expect(vu).toMatch(/did not take/i);
  });

  it('une adresse de serveur malformee est refusee', async () => {
    const { fgt } = await laboratoire();

    const vu = await fgt.executeCommand(
      'execute vpn certificate local export tftp Fortinet_CA_SSL fortinet_ca.cer serveur-tftp');

    expect(vu).toMatch(/value parse error/i);
  });

  it('une destination que cette machine n a pas est refusee en le nommant', async () => {
    const { fgt } = await laboratoire();

    const vu = await fgt.executeCommand(
      'execute vpn certificate local export usb Fortinet_CA_SSL fortinet_ca.cer');

    expect(vu).toMatch(/no USB port/i);
  });
});
