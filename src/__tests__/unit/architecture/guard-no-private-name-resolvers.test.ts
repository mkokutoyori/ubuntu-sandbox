/*
 * A host name typed into any command must be resolved by the machine's own resolver (LinuxMachine/WindowsPC resolveHostname, Router/Switch resolveHostname,
 * resolveHostnameFor), never by a private lookup that reads /etc/hosts or the topology by itself: a private lookup does not see what only the DNS knows, which
 * is the defect the DNS lab found in telnet, arping, wget, openssl, logger, chronyc, Windows telnet, ssh-keyscan, the Cisco switch, Huawei and FortiGate.
 *
 * This guard is a ratchet. It lists, by file, the production sources that still call findHostByAddress or read /etc/hosts directly (each is a measured legacy
 * site, or a legitimate use: findHostByAddress locates a DEVICE from an address already resolved, the NSS files source IS the /etc/hosts reader). A file that
 * is not in the lists fails the test: either delegate to the resolver, or add the file here with the reason in the commit message. Removing a site and
 * leaving it listed also fails, so the lists only shrink. Discriminated by adding a throwaway source calling findHostByAddress: the first case fails, and passes
 * again once it is removed; the two cases pass on the current tree, there being no code at the base that the guard would have flagged differently.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '../../..');

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (entry === '__tests__' || entry === 'node_modules') continue;
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

const FILES = sources(ROOT).map((path) => ({ name: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
const containing = (pattern: RegExp) => FILES.filter((file) => pattern.test(file.text)).map((file) => file.name).sort();

const FIND_HOST_BY_ADDRESS_SITES = [
  'network/devices/LinuxMachine.ts',
  'network/devices/linux/LinuxCommandExecutor.ts',
  'network/devices/linux/LinuxIpCommand.ts',
  'network/devices/linux/network/HostLookup.ts',
  'network/devices/shells/HuaweiVRPShell.ts',
  'network/scan/nmap/NmapProbes.ts',
  'powershell/providers/WindowsPSProviders.ts',
  'terminal/sessions/LinuxTerminalSession.ts',
  'terminal/subshells/NetkitTelnetSubShell.ts',
  'terminal/subshells/telnetLaunch.ts',
];

const HOSTS_FILE_READERS = [
  'network/devices/LinuxMachine.ts',
  'network/devices/linux/LinuxCommandExecutor.ts',
  'network/devices/linux/VirtualFileSystem.ts',
  'network/devices/linux/commands/system/Chronyc.ts',
  'network/devices/linux/network/HostLookup.ts',
  'network/devices/linux/nss/FilesNssSource.ts',
  'network/devices/linux/nss/NameServiceSwitch.ts',
];

describe('no private name resolver appears', () => {
  it('findHostByAddress is called only from the listed sites', () => {
    expect(containing(/findHostByAddress\(/)).toEqual([...FIND_HOST_BY_ADDRESS_SITES].sort());
  });

  it('/etc/hosts is read directly only from the listed sites', () => {
    expect(containing(/'\/etc\/hosts'/)).toEqual([...HOSTS_FILE_READERS].sort());
  });
});
