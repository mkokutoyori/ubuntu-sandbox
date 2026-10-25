/**
 * vsftpd + curl, mode actif et directives du canal de donnees, rejoues contre les vrais binaires.
 *
 * Les transcriptions de src/__tests__/support/oracle/vsftpd-curl-3.0.5.json viennent de vsftpd 3.0.5 (paquet Ubuntu noble) et de curl 8.5.0
 * lances par scripts/oracle/record_vsftpd_curl.py : chaque cas redemarre vsftpd avec ses lignes de configuration, puis lance curl -v (les
 * lignes « > » et « < ») ou parle au port 21 en brut. Le simulateur rejoue les memes cas sur deux machines reliees par un cable (PC 10.0.0.1,
 * serveur 10.0.0.2, adresse annexe 10.0.0.3) ; adresses et ports, tires au hasard des deux cotes, sont normalises avant comparaison.
 * connect_from_port_20 (port source 20 ou ephemere) a ete mesure a part sur le vrai vsftpd avec un port d'ecoute python.
 *
 * Mesure avant correction (git stash de src/network) : 30 cas sur 31 tombent. curl -P etait refuse (« option -P: is not implemented in this
 * simulator »), port_enable, pasv_enable, download_enable, dirlist_enable, port_promiscuous, pasv_promiscuous, pasv_min_port, pasv_max_port et
 * pasv_address etaient refuses au chargement de la configuration, connect_from_port_20 etait accepte sans effet, les commandes pipelinees dans
 * un meme segment n'etaient pas separees, et les reponses PWD, TYPE, SIZE, RETR, STOR, EPSV, EPRT et « Use PORT or PASV first » ne portaient
 * pas les textes de vsftpd.
 * Passe avant comme apres : le temoin « the lab serves a passive download », qui prouve que le banc (deux machines, apt install vsftpd, curl
 * passif) est sain.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import '../new_firewall/fortigateBatteryHarness';

interface RecordedCase {
  readonly conf: string;
  readonly args: readonly string[];
  readonly path: string;
  readonly exit: number;
  readonly lines: readonly string[];
}

interface RawCase {
  readonly conf: string;
  readonly commands: readonly string[];
  readonly lines: readonly string[];
}

interface Fixture {
  readonly client: string;
  readonly other: string;
  readonly cases: Readonly<Record<string, RecordedCase>>;
  readonly raw: Readonly<Record<string, RawCase>>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/vsftpd-curl-3.0.5.json', import.meta.url), 'utf8')) as Fixture;

const SIM_CLIENT = '10.0.0.1';
const SIM_SERVER = '10.0.0.2';
const SIM_OTHER = '10.0.0.3';

function normalise(lines: readonly string[], client: string, other: string): string[] {
  const escape = (text: string): string => text.replace(/\./g, '\\.');
  const comma = (text: string): string => escape(text.replace(/\./g, ','));
  return lines.map((line) => line
    .replace(new RegExp(`\\|1\\|${escape(client)}\\|\\d+\\|`), '|1|<CLIENT>|<PORT>|')
    .replace(new RegExp(`\\|1\\|${escape(other)}\\|\\d+\\|`), '|1|<OTHER>|<PORT>|')
    .replace(new RegExp(`PORT ${comma(client)},\\d+,\\d+`), 'PORT <CLIENT>,<PORT>')
    .replace(new RegExp(`PORT ${comma(other)},\\d+,\\d+`), 'PORT <OTHER>,<PORT>')
    .replace(/\(\|\|\|\d+\|\)/, '(|||<PORT>|)')
    .replace(/\((\d+,){5}\d+\)/, '(<PASV>)'));
}

async function lab(extraConf: string): Promise<{ pc: LinuxPC }> {
  const server = new LinuxServer('linux-server', 'ftp1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  server.powerOn();
  pc.powerOn();
  new Cable('c').connect(server.getPort('eth0') as never, pc.getPort('eth0') as never);
  for (const line of ['ip link set eth0 up', `ip addr add ${SIM_SERVER}/24 dev eth0`]) await server.executeCommand(line);
  for (const line of ['ip link set eth0 up', `ip addr add ${SIM_CLIENT}/24 dev eth0`, `ip addr add ${SIM_OTHER}/24 dev eth0`]) await pc.executeCommand(line);
  await server.executeCommand('apt install -y vsftpd');
  await server.executeCommand('echo HELLO_FTP > /srv/ftp/test.txt');
  await server.executeCommand('mkdir /srv/ftp/up');
  await server.executeCommand('chmod 777 /srv/ftp/up');
  await pc.executeCommand('echo hi > /tmp/upload.txt');
  if (extraConf !== '') {
    for (const line of extraConf.split('\n')) await server.executeCommand(`echo '${line}' >> /etc/vsftpd.conf`);
    await server.executeCommand('systemctl restart vsftpd');
  }
  return { pc };
}

function argumentsFor(args: readonly string[]): string {
  return args.map((a) => a
    .replace(fixture.client, SIM_CLIENT).replace(fixture.other, SIM_OTHER).replace('UPLOAD', '/tmp/upload.txt')).join(' ');
}

describe('vsftpd and curl against the recorded vsftpd 3.0.5 / curl 8.5.0 transcripts', () => {
  it('witness: the lab serves a passive download', async () => {
    const { pc } = await lab('');
    expect(await pc.executeCommand(`curl -s -m 8 ftp://${SIM_SERVER}/test.txt`)).toContain('HELLO_FTP');
  });

  for (const [name, recorded] of Object.entries(fixture.cases)) {
    it(`${name}: same commands, same replies, same exit status`, async () => {
      const { pc } = await lab(recorded.conf);
      const out = await pc.executeCommand(`curl -sv -m 8 ${argumentsFor(recorded.args)} ftp://${SIM_SERVER}${recorded.path} 2>&1; echo exit=$?`);
      const lines = out.split('\n').filter((l) => l.startsWith('> ') || l.startsWith('< '));
      expect(normalise(lines, SIM_CLIENT, SIM_OTHER)).toEqual(normalise(recorded.lines, fixture.client, fixture.other));
      expect(Number(/exit=(\d+)/.exec(out)?.[1])).toBe(recorded.exit);
    });
  }
});

function rawLines(out: string, commands: readonly string[]): string[] {
  const replies = out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => /^\d{3}[ -]/.test(l));
  const lines = [`< ${replies[0]}`];
  commands.forEach((command, index) => {
    if (replies[index + 1] === undefined) return;
    lines.push(`> ${command}`, `< ${replies[index + 1]}`);
  });
  return lines;
}

const portsIn = (lines: readonly string[]): number[] =>
  lines.map((l) => /\(\|\|\|(\d+)\|\)/.exec(l)?.[1]).filter((p): p is string => p !== undefined).map(Number);

const anyPasv = (lines: readonly string[]): string[] => lines.map((l) => l
  .replace(/\((\d+,\d+,\d+,\d+),\d+,\d+\)/, '($1,<P1>,<P2>)').replace(/\(\|\|\|\d+\|\)/, '(|||<PORT>|)'));

describe('vsftpd control-connection replies against the recorded vsftpd 3.0.5 sessions', () => {
  for (const [name, recorded] of Object.entries(fixture.raw)) {
    it(`${name}: same replies to the same commands`, async () => {
      const { pc } = await lab(recorded.conf);
      const script = recorded.commands.map((c) => `${c}\\r\\n`).join('');
      const out = await pc.executeCommand(`printf '${script}' | nc -w 2 ${SIM_SERVER} 21`);
      const simulated = rawLines(out, recorded.commands);
      const expected = recorded.lines;
      expect(anyPasv(simulated).map((l) => l.replace('127,0,0,1', SIM_SERVER.replace(/\./g, ',')))).toEqual(
        anyPasv(expected).map((l) => l.replace('127,0,0,1', SIM_SERVER.replace(/\./g, ','))));
      if (name === 'pasv-port-range') {
        const ports = portsIn(simulated.length > 0 ? simulated : []);
        expect(ports).toHaveLength(3);
        for (const port of ports) {
          expect(port).toBeGreaterThanOrEqual(40000);
          expect(port).toBeLessThanOrEqual(40010);
        }
      }
    });
  }
});

describe('vsftpd data connection directives measured on the wire', () => {
  it('connect_from_port_20=YES makes the server open the active data connection from port 20 (real vsftpd: peer port 20)', async () => {
    const server = new LinuxServer('linux-server', 'ftp1', 0, 0);
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    server.powerOn();
    pc.powerOn();
    new Cable('c').connect(server.getPort('eth0') as never, pc.getPort('eth0') as never);
    for (const line of ['ip link set eth0 up', `ip addr add ${SIM_SERVER}/24 dev eth0`]) await server.executeCommand(line);
    for (const line of ['ip link set eth0 up', `ip addr add ${SIM_CLIENT}/24 dev eth0`]) await pc.executeCommand(line);
    await server.executeCommand('apt install -y vsftpd');
    await server.executeCommand('echo HELLO_FTP > /srv/ftp/test.txt');
    await server.executeCommand('echo connect_from_port_20=YES >> /etc/vsftpd.conf');
    await server.executeCommand('systemctl restart vsftpd');
    await pc.executeCommand(`curl -s -m 5 -P - ftp://${SIM_SERVER}/test.txt`);
    expect(await server.executeCommand('ss -tan')).toContain(`${SIM_SERVER}:20`);
  });

  it('connect_from_port_20=NO leaves the source port of the active data connection to the kernel (real vsftpd: ephemeral)', async () => {
    const server = new LinuxServer('linux-server', 'ftp1', 0, 0);
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    server.powerOn();
    pc.powerOn();
    new Cable('c').connect(server.getPort('eth0') as never, pc.getPort('eth0') as never);
    for (const line of ['ip link set eth0 up', `ip addr add ${SIM_SERVER}/24 dev eth0`]) await server.executeCommand(line);
    for (const line of ['ip link set eth0 up', `ip addr add ${SIM_CLIENT}/24 dev eth0`]) await pc.executeCommand(line);
    await server.executeCommand('apt install -y vsftpd');
    await server.executeCommand('echo HELLO_FTP > /srv/ftp/test.txt');
    await server.executeCommand('sed -i s/connect_from_port_20=YES/connect_from_port_20=NO/ /etc/vsftpd.conf');
    await server.executeCommand('systemctl restart vsftpd');
    expect(await pc.executeCommand(`curl -s -m 5 -P - ftp://${SIM_SERVER}/test.txt`)).toContain('HELLO_FTP');
    expect(await server.executeCommand('ss -tan')).not.toContain(`${SIM_SERVER}:20 `);
  });

  for (const promiscuous of [false, true]) {
    it(`pasv_promiscuous=${promiscuous ? 'YES' : 'NO'}: a passive data connection from another address is ${promiscuous ? 'kept' : 'dropped'}`, async () => {
      const { pc } = await lab(promiscuous ? 'pasv_promiscuous=YES' : '');
      const stack = pc.getTcpStack();
      const replies: string[] = [];
      const control = stack.connect(SIM_SERVER, 21, { localIp: SIM_CLIENT, onData: (d) => replies.push(String(d)) });
      control!.write('USER anonymous\r\nPASS x\r\nEPSV\r\n');
      const port = Number(/\(\|\|\|(\d+)\|\)/.exec(replies.join(''))?.[1]);
      expect(port).toBeGreaterThan(0);
      const intruder = stack.connect(SIM_SERVER, port, { localIp: SIM_OTHER });
      expect(intruder?.state === 'established').toBe(promiscuous);
    });
  }
});
