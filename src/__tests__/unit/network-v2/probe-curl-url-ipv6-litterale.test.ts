/**
 * curl et une adresse IPv6 litterale dans l'URL (`http://[2001:db8:1::2]/`), RFC 3986 §3.2.2.
 *
 * Mesure avant correction : `curl: (3) URL using bad/illegal format` (l'expression de l'URL excluait
 * les crochets et les deux-points de l'hote), puis, une fois l'URL acceptee, `curl: (6) Could not
 * resolve host` (le moteur ne savait resoudre qu'en IPv4), alors qu'un nom qui n'a qu'un AAAA — le
 * cas d'un client IPv6 seul derriere un DNS64 — ne se resolvait pas non plus. L'en-tete Host d'une
 * adresse IPv6 garde ses crochets.
 *
 * Avec src remis a HEAD, les trois cas tombent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { parseCurlUrl } from '@/network/http/curl/CurlTransfer';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('2').connect(srv.getPorts()[0], sw.getPorts()[1]);
  await pc.executeCommand('ip -6 addr add 2001:db8:1::1/64 dev eth0');
  await srv.executeCommand('ip -6 addr add 2001:db8:1::2/64 dev eth0');
  await srv.executeCommand('systemctl start nginx');
  return { pc, srv };
}

describe('curl with an IPv6 literal', () => {
  it('parses the bracketed host without its brackets, and keeps them in the effective URL', () => {
    const parsed = parseCurlUrl('http://[2001:db8:1::2]:8080/a?b=1');
    expect(parsed).toMatchObject({ ok: true, url: { host: '2001:db8:1::2', port: 8080, path: '/a?b=1' } });
    expect(parsed.ok && parsed.url.effective).toBe('http://[2001:db8:1::2]:8080/a?b=1');
  });

  it('fetches a page from an IPv6 literal over the wire', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand("curl -s -m 5 'http://[2001:db8:1::2]/'")).toMatch(/nginx/i);
  });

  it('resolves a name that has only an AAAA record', async () => {
    const { pc } = await lab();
    await pc.executeCommand("echo '2001:db8:1::2 v6only.example' >> /etc/hosts");
    expect(await pc.executeCommand("curl -s -m 5 http://v6only.example/")).toMatch(/nginx/i);
  });
});

describe('curl on a Windows host with an IPv6 literal', () => {
  it('fetches a page from an IPv6 literal and from a name that only has an AAAA record', async () => {
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
    new Cable('1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('2').connect(srv.getPorts()[0], sw.getPorts()[1]);
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet0" 2001:db8:1::1/64');
    await srv.executeCommand('ip -6 addr add 2001:db8:1::2/64 dev eth0');
    await srv.executeCommand('systemctl start nginx');
    expect(await pc.executeCommand('curl.exe -s -m 5 "http://[2001:db8:1::2]/"')).toMatch(/nginx/i);
    await pc.executeCommand('echo 2001:db8:1::2 v6only.example >> C:\\Windows\\System32\\drivers\\etc\\hosts');
    expect(await pc.executeCommand('curl.exe -s -m 5 http://v6only.example/')).toMatch(/nginx/i);
  });
});
