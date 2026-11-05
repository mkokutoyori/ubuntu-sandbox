import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

export const SERVER_IP = '10.0.1.10';
export const PC_IP = '10.0.1.2';
export const PKI = '/etc/bind/tls';
export const NAME = 'ns1.banquehorizon.com';

export const ZONE = [
  '$TTL 3600',
  '@ IN SOA ns1 hostmaster ( 1 7200 900 1209600 3600 )',
  '@ IN NS ns1',
  'ns1 IN A 10.0.1.10',
  'www IN A 203.0.113.20', '',
].join('\n');

export function vfsOf(machine: LinuxServer | LinuxPC): VirtualFileSystem {
  return (machine as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

export function writeRoot(machine: LinuxServer | LinuxPC, path: string, content: string): void {
  vfsOf(machine).writeFile(path, content, 0, 0, 0o022);
}

export interface Lab {
  readonly server: LinuxServer;
  readonly pc: LinuxPC | LinuxServer;
  start(config: string): Promise<string>;
  dig(arguments_: string): Promise<string>;
}

export async function issueCertificate(server: LinuxServer, prefix: string, subjectName: string, issuer: string): Promise<void> {
  const sh = (command: string) => server.executeCommand(command);
  await sh(`openssl req -newkey rsa:2048 -nodes -keyout ${PKI}/${prefix}.key -out ${PKI}/${prefix}.csr -subj "/CN=${subjectName}"`);
  writeRoot(server, `${PKI}/${prefix}.ext`, `subjectAltName=DNS:${subjectName},IP:${SERVER_IP}\n`);
  await sh(`openssl x509 -req -in ${PKI}/${prefix}.csr -CA ${PKI}/${issuer}.pem -CAkey ${PKI}/${issuer}.key -CAcreateserial -out ${PKI}/${prefix}.pem -days 30 -extfile ${PKI}/${prefix}.ext`);
}

export async function lab(peer: 'pc' | 'server' = 'pc'): Promise<Lab> {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
  const server = new LinuxServer('linux-server', 'NS1');
  const pc = peer === 'pc' ? new LinuxPC('linux-pc', 'PC') : new LinuxServer('linux-server', 'NS2');
  const mask = new SubnetMask('255.255.255.0');
  new Cable('c1').connect(server.getPorts()[0], pc.getPorts()[0]);
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), mask);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), mask);

  await server.executeCommand(`mkdir -p ${PKI}`);
  for (const authority of ['ca', 'other']) {
    await server.executeCommand(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${PKI}/${authority}.key -out ${PKI}/${authority}.pem -days 30 -subj "/CN=${authority === 'ca' ? 'Test CA' : 'Other CA'}"`);
  }
  await issueCertificate(server, 'srv', NAME, 'ca');
  writeRoot(server, '/etc/bind/db.banquehorizon.com', ZONE);
  for (const authority of ['ca', 'other']) {
    writeRoot(pc, `/root/${authority}.pem`, vfsOf(server).readFile(`${PKI}/${authority}.pem`) ?? '');
  }

  return {
    server,
    pc,
    start: async (config) => {
      writeRoot(server, '/etc/bind/named.conf', [
        'tls local-tls { key-file "/etc/bind/tls/srv.key"; cert-file "/etc/bind/tls/srv.pem"; };',
        config,
        'zone "banquehorizon.com" { type primary; file "/etc/bind/db.banquehorizon.com"; };', '',
      ].join('\n'));
      return server.executeCommand('systemctl start named');
    },
    dig: (arguments_) => pc.executeCommand(`dig @${SERVER_IP} ${arguments_}`),
  };
}

