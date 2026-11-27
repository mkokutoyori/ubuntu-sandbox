/*
 * Probe: the `clients = <name>` setting of a listener. It was read as nothing: every listener answered every client of the global list. Source of truth: FreeRADIUS v3.2.x
 * src/main/listen.c common_socket_parse (a listener with a `clients` item uses ONLY that list, the section `clients <name> { client ... }`; a name that matches no section is the
 * error "Failed to find clients <name> {...}"; without the item the list of the virtual server, else the global list) and src/main/client.c client_list_init / client_add.
 * A request from a source outside the list of the listener it reaches is ignored: no reply. The clients of such a section are known to the machine with their own secret.
 *
 * Limit kept in TODO.md: the same address in two lists is stored twice, but the secret and the policies are looked up on the first match, not on the list of the listener.
 *
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix (the dedicated list is not applied, its client does not know its own secret, the missing list is not an
 * error). Only the witness (no `clients` item, the global client answers) passes either way: it proves the lab itself is sound.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';

async function lab(listenerList: string | null, restrictedHolds: string | null, globalAddress = '10.0.0.1') {
  const radius = new LinuxServer('linux-server', 'AAA', 0, 0);
  const client = new LinuxServer('linux-server', 'CLIENT', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(radius.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  radius.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  const restricted = restrictedHolds === null ? '' : `clients restricted {\n  client member {\n    ipaddr = ${restrictedHolds}\n    secret = listsecret\n  }\n}\n`;
  write(radius, CLIENTS_CONF_PATH, `client lab {\n  ipaddr = ${globalAddress}\n  secret = shared\n}\n${restricted}`);
  write(radius, USERS_FILE_PATH, 'alice Cleartext-Password := "pw"\n');
  if (listenerList !== null) {
    write(radius, SITE, (vfsOf(radius).readFile(SITE) ?? '').replace('\t\ttype = auth\n\t\tipaddr = *\n', `\t\ttype = auth\n\t\tclients = ${listenerList}\n\t\tipaddr = *\n`));
  }
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { client, started };
}

const ask = (client: LinuxServer, secret: string) => client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "pw"\\n' | radclient -x 10.0.0.3 auth ${secret}`);
const accepted = (output: string) => output.includes('Received Access-Accept');

describe('listener clients list', () => {
  it('witness: without a clients item the global client answers', async () => {
    const { client } = await lab(null, '10.0.0.9');
    expect(accepted(await ask(client, 'shared'))).toBe(true);
  });

  it('a listener with a clients list ignores a client that is only in the global list', async () => {
    const { client } = await lab('restricted', '10.0.0.9');
    expect(accepted(await ask(client, 'shared'))).toBe(false);
  });

  it('a client of the dedicated list answers with its own secret', async () => {
    const { client } = await lab('restricted', '10.0.0.1', '10.0.0.8');
    expect(accepted(await ask(client, 'listsecret'))).toBe(true);
  });

  it('a clients list that matches no section is a load error', async () => {
    const { started } = await lab('nosuch', null);
    expect(started).toContain('Failed to find clients nosuch {...}');
  });
});
