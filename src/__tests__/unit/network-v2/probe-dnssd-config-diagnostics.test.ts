/**
 * Probe — systemd-resolved reads a .dnssd as resolved-dnssd.c / resolved-conf.c (systemd 255.4) does: keys are case
 * sensitive (resolved-dnssd-gperf.gperf), `<name>.dnssd.d/*.conf` drop-ins are merged, an unknown key or section, a line
 * without '=' or an invalid value is reported in the journal of systemd-resolved with file:line, Name= expands the
 * specifiers (%H, %m, ...), Type= and Port= are validated, TxtText= is a whitespace separated list of key=value words,
 * TxtData= carries base64 values, an empty assignment resets, and every assignment becomes its own TXT record on the wire.
 *
 * Measured against the preceding commit (git stash push -- src/network): 12 of the 15 cases fall (readDnssdFile and the
 * journal did not exist, the old parser matched keys case-insensitively, ignored drop-ins and kept the raw TxtText). The
 * 3 that pass either way are WITNESSES, built on parseDnssdFile which both states export: a well formed file is read
 * (name, type, port, one TXT), a file without Name= or Type= is refused, and a stray file that does not end in .dnssd is
 * ignored.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { DnsSdRegistry } from '@/network/dnssd/DnsSdRegistry';
import { RRType } from '@/network/dns/wire/RRType';
import { parseDnssdFile, readDnssdFile } from '@/network/devices/linux/net/DnssdFiles';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const PATH = '/etc/systemd/dnssd/x.dnssd';
const head = '[Service]\nName=S\nType=_http._tcp\n';

function read(text: string, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { [PATH]: text, ...extra };
  return readDnssdFile({
    readFile: (path) => files[path] ?? null,
    listDirectory: (path) => Object.keys(files).filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')).map((file) => ({ name: file.slice(path.length + 1) })),
    hostName: () => 'alpha',
  }, PATH);
}

describe('.dnssd files', () => {
  it('witness: a well formed file is read', () => {
    expect(parseDnssdFile(PATH, `${head}Port=80\nTxtText=path=/\n`)?.service).toMatchObject({ instance: 'S', type: '_http._tcp', port: 80, txt: ['path=/'] });
  });

  it('witness: Name= and Type= are required', () => {
    expect(parseDnssdFile(PATH, '[Service]\nType=_http._tcp\n')).toBeNull();
    expect(parseDnssdFile(PATH, '[Service]\nName=S\n')).toBeNull();
  });

  it('says which of Name= and Type= is missing', () => {
    expect(read('[Service]\nType=_http._tcp\n').diagnostics.map((d) => d.message)).toEqual(["x doesn't define service instance name"]);
    expect(read('[Service]\nName=S\n').diagnostics.map((d) => d.message)).toEqual(["x doesn't define service type"]);
  });

  it('witness: a file that does not end in .dnssd is ignored', () => {
    expect(parseDnssdFile('/etc/systemd/dnssd/x.txt', `${head}Port=80\n`)).toBeNull();
  });

  it('keys are case sensitive and an unknown one is reported', () => {
    const { file, diagnostics } = read(`${head}port=80\nZorglub=1\n`);
    expect(diagnostics.map((d) => d.message)).toEqual([
      `${PATH}:4: Unknown key name 'port' in section 'Service', ignoring.`,
      `${PATH}:5: Unknown key name 'Zorglub' in section 'Service', ignoring.`,
    ]);
    expect(file?.service.port).toBe(0);
  });

  it('reports an unknown section, a line without equals sign and an assignment outside a section', () => {
    const { diagnostics } = read(`Name=early\n[Servcie]\nName=x\n${head}nonsense\n`);
    expect(diagnostics.map((d) => d.message)).toEqual([
      `${PATH}:1: Assignment outside of section. Ignoring.`,
      `${PATH}:2: Unknown section 'Servcie'. Ignoring.`,
      `${PATH}:7: Missing '=', ignoring line.`,
    ]);
  });

  it('merges the drop-ins of <name>.dnssd.d and names them in diagnostics', () => {
    const { file, diagnostics } = read(`${head}Port=80\n`, { '/etc/systemd/dnssd/x.dnssd.d/10-port.conf': '[Service]\nPort=8080\nBogus=1\n' });
    expect(file?.service.port).toBe(8080);
    expect(diagnostics.map((d) => d.message)).toEqual(["/etc/systemd/dnssd/x.dnssd.d/10-port.conf:3: Unknown key name 'Bogus' in section 'Service', ignoring."]);
  });

  it('validates Type= and Port=', () => {
    const { file, diagnostics } = read('[Service]\nName=S\nType=http\nType=_http._tcp\nPort=0\nPort=70000\nPort=abc\n');
    expect(diagnostics.map((d) => d.message)).toEqual([
      `${PATH}:3: Service type is invalid. Ignoring.`,
      `${PATH}:5: Failed to parse port '0'.`,
      `${PATH}:6: Failed to parse port '70000'.`,
      `${PATH}:7: Failed to parse port 'abc'.`,
    ]);
    expect(file?.service.type).toBe('_http._tcp');
  });

  it('expands the specifiers of Name=', () => {
    expect(read('[Service]\nName=web on %H\nType=_http._tcp\n').file?.service.instance).toBe('web on alpha');
    expect(read('[Service]\nName=100%%\nType=_http._tcp\n').file?.service.instance).toBe('100%');
    const bad = read('[Service]\nName=%Z\nType=_http._tcp\n');
    expect(bad.diagnostics[0].message).toBe(`${PATH}:2: Invalid service instance name template '%Z', ignoring assignment: Invalid slot`);
    expect(bad.file).toBeNull();
  });

  it('refuses an instance name longer than a DNS label', () => {
    const { diagnostics } = read(`[Service]\nName=${'n'.repeat(64)}\nType=_http._tcp\n`);
    expect(diagnostics[0].message).toContain('renders to invalid name');
  });

  it('splits TxtText= into key=value words and honours quotes and C escapes', () => {
    const { file } = read(`${head}TxtText=a=1 "b=two words" c d=\\x41\n`);
    expect(file?.service.txt).toEqual(['a=1', 'b=two words', 'c', 'd=A']);
  });

  it('decodes the base64 values of TxtData=', () => {
    const { file, diagnostics } = read(`${head}TxtData=data=YW55IGJpbmFyeQ== bad=@@@\n`);
    expect(file?.service.txt).toEqual(['data=any binary']);
    expect(diagnostics.map((d) => d.message)).toEqual([`${PATH}:4: Invalid base64 encoding, ignoring: @@@`]);
  });

  it('resets the TXT records on an empty assignment', () => {
    expect(read(`${head}TxtText=a=1\nTxtText=\nTxtText=b=2\n`).file?.service).toMatchObject({ txt: ['b=2'] });
  });

  it('answers one TXT record per assignment', () => {
    const { file } = read(`${head}TxtText=a=1\nTxtData=b=Mg==\n`);
    const registry = new DnsSdRegistry({ hostName: () => 'alpha.local', addresses: () => [] });
    registry.publish(file!.service);
    const answers = registry.answer('S._http._tcp.local', RRType.TXT).answers;
    expect(answers.map((record) => (record.data as unknown as { text: string[] }).text)).toEqual([['a=1'], ['b=2']]);
  });

  it('journals the diagnostics when systemd-resolved starts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
    vfs.mkdirp('/etc/systemd/dnssd', 0o755, 0, 0);
    vfs.writeFile('/etc/systemd/dnssd/web.dnssd', `${head}Zorglub=1\n`, 0, 0, 0o644);
    await pc.executeCommand('systemctl restart systemd-resolved');
    expect(await pc.executeCommand('journalctl --no-pager -t systemd-resolved')).toContain("/etc/systemd/dnssd/web.dnssd:4: Unknown key name 'Zorglub' in section 'Service', ignoring.");
  });
});
