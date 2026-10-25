/**
 * Une interface qui apparait apres la construction de la machine (`ip link add ... type dummy|veth|vlan|bond`) a, comme toutes les autres,
 * son repertoire /proc/sys/net/ipv4/conf/<nom> : `inetdev_init` (net/ipv4/devinet.c) copie la configuration de `default` dans la configuration
 * de l'interface au moment ou elle est enregistree, `devinet_sysctl_register` cree le repertoire, `devinet_copy_dflt_conf` porte ensuite chaque
 * ecriture de `default` aux interfaces auxquelles personne n'a ecrit, et `inetdev_destroy` retire le repertoire quand l'interface disparait.
 *
 * Mesure de depart (arbre portant les lots precedents ; un LinuxServer, ip link add dummy0 type dummy) :
 *     sysctl net.ipv4.conf.dummy0.send_redirects  ->  « cannot stat /proc/sys/net/ipv4/conf/dummy0/send_redirects » : la machine ne cree les
 *                                                     portees qu'une fois, a sa construction, pour les interfaces qui existent alors
 *     ls /proc/sys/net/ipv4/conf  ->  all, default, eth0 : ni dummy0, ni veth0, ni eth0.10, ni bond0
 *     sysctl -w net.ipv4.conf.dummy0.accept_redirects=0 puis sysctl net.ipv4.conf.dummy0.accept_redirects  ->  « cannot stat » : le parametre
 *                                                     d'une interface apparue ensuite ne se regle pas
 *
 * Discrimination : contre l'arbre sans le lot (sonde et tests conserves), 12 des 18 cas tombent et 6 passent des deux cotes : le TEMOIN (une
 * interface presente des le depart a ses quatre parametres a 1 : le laboratoire est sain), deux absences (une portee retiree n'est plus lisible
 * ni listee, et une ecriture dans default ne la ramene pas : la base ne l'avait jamais creee), une non-regression (les autres portees restent
 * en place apres un retrait) et les deux interfaces qui portent le nom d'une portee de la machine, `all` et `default` (la base ne retirait rien,
 * si bien que la portee reste lisible des deux cotes). Le fichier voisin ipv4-device-conf compte six nouveaux cas, qui tombent tous contre la
 * base : addInterface ne disait pas si l'interface etait nouvelle et removeInterface n'existait pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxServer } from '@/network/devices/LinuxServer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const KNOBS = ['accept_redirects', 'send_redirects', 'secure_redirects', 'shared_media'];

const sudo = (host: LinuxServer, command: string): Promise<string> => host.executeCommand(`sudo ${command}`);
const read = (host: LinuxServer, scope: string, knob: string): Promise<string> => sudo(host, `sysctl net.ipv4.conf.${scope}.${knob}`);
const cat = (host: LinuxServer, scope: string, knob: string): Promise<string> => sudo(host, `cat /proc/sys/net/ipv4/conf/${scope}/${knob}`);
const write = (host: LinuxServer, scope: string, knob: string, value: number): Promise<string> =>
  sudo(host, `sysctl -w net.ipv4.conf.${scope}.${knob}=${value}`);
const valueOf = (scope: string, knob: string, value: number): string => `net.ipv4.conf.${scope}.${knob} = ${value}`;
const scopesListed = async (host: LinuxServer): Promise<string[]> => (await sudo(host, 'ls -1 /proc/sys/net/ipv4/conf')).split(/\s+/).filter(Boolean);

const CREATIONS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['a dummy interface', 'ip link add dummy0 type dummy', ['dummy0']],
  ['a veth pair', 'ip link add veth0 type veth peer name veth1', ['veth0', 'veth1']],
  ['a vlan sub-interface', 'ip link add link eth0 name eth0.10 type vlan id 10', ['eth0.10']],
  ['a bond', 'ip link add bond0 type bond', ['bond0']],
];

describe('an interface that appears after the machine is built gets its own scope, copied from default', () => {
  it('TEMOIN : an interface present from the start has all four knobs at 1', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    for (const knob of KNOBS) expect(await read(host, 'eth0', knob)).toBe(valueOf('eth0', knob, 1));
  });

  it.each(CREATIONS)('%s : every interface it creates has all four knobs at 1', async (_, command, names) => {
    const host = new LinuxServer('linux-server', 'R1');
    expect(await sudo(host, command)).toBe('');
    for (const name of names) {
      for (const knob of KNOBS) expect(await cat(host, name, knob)).toBe('1');
    }
  });

  it('sysctl and /proc/sys read the same value for a new interface', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    await write(host, 'dummy0', 'secure_redirects', 0);
    expect(await read(host, 'dummy0', 'secure_redirects')).toBe(valueOf('dummy0', 'secure_redirects', 0));
    expect(await cat(host, 'dummy0', 'secure_redirects')).toBe('0');
  });

  it('the scope is listed beside the others', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    expect(await scopesListed(host)).toEqual(expect.arrayContaining(['all', 'default', 'lo', 'eth0', 'dummy0']));
  });

  it('it starts from the value default had when it was created, and an older interface somebody wrote to keeps its own', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await write(host, 'eth0', 'send_redirects', 1);
    await write(host, 'default', 'send_redirects', 0);
    await sudo(host, 'ip link add dummy0 type dummy');
    expect(await read(host, 'dummy0', 'send_redirects')).toBe(valueOf('dummy0', 'send_redirects', 0));
    expect(await read(host, 'eth0', 'send_redirects')).toBe(valueOf('eth0', 'send_redirects', 1));
  });

  it('a later write to default reaches it while nobody has written to it', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    await write(host, 'default', 'shared_media', 0);
    expect(await read(host, 'dummy0', 'shared_media')).toBe(valueOf('dummy0', 'shared_media', 0));
  });

  it('a later write to default leaves alone the knob somebody wrote to, and only that one', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    await write(host, 'dummy0', 'shared_media', 1);
    await write(host, 'default', 'shared_media', 0);
    await write(host, 'default', 'send_redirects', 0);
    expect(await read(host, 'dummy0', 'shared_media')).toBe(valueOf('dummy0', 'shared_media', 1));
    expect(await read(host, 'dummy0', 'send_redirects')).toBe(valueOf('dummy0', 'send_redirects', 0));
  });

  it('a write to its own scope is kept', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    await write(host, 'dummy0', 'accept_redirects', 0);
    expect(await read(host, 'dummy0', 'accept_redirects')).toBe(valueOf('dummy0', 'accept_redirects', 0));
    expect(await read(host, 'eth0', 'accept_redirects')).toBe(valueOf('eth0', 'accept_redirects', 1));
  });
});

describe('an interface that goes away takes its scope with it', () => {
  const missing = (scope: string, knob: string): string => `sysctl: cannot stat /proc/sys/net/ipv4/conf/${scope}/${knob}: No such file or directory`;
  const missingFile = (scope: string, knob: string): string => `cat: /proc/sys/net/ipv4/conf/${scope}/${knob}: No such file or directory`;

  it('the knobs are no longer readable and the scope is no longer listed', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    expect(await sudo(host, 'ip link del dummy0')).toBe('');
    expect(await read(host, 'dummy0', 'send_redirects')).toBe(missing('dummy0', 'send_redirects'));
    expect(await scopesListed(host)).not.toContain('dummy0');
  });

  it('the other scopes are untouched', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    await sudo(host, 'ip link del dummy0');
    expect(await scopesListed(host)).toEqual(expect.arrayContaining(['all', 'default', 'lo', 'eth0']));
    expect(await read(host, 'eth0', 'send_redirects')).toBe(valueOf('eth0', 'send_redirects', 1));
  });

  it('a device created again under the same name starts from default, not from what the old one held', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    await write(host, 'dummy0', 'send_redirects', 0);
    await sudo(host, 'ip link del dummy0');
    await sudo(host, 'ip link add dummy0 type dummy');
    expect(await read(host, 'dummy0', 'send_redirects')).toBe(valueOf('dummy0', 'send_redirects', 1));
  });

  it('a vlan sub-interface takes its scope with it too', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add link eth0 name eth0.10 type vlan id 10');
    expect(await cat(host, 'eth0.10', 'send_redirects')).toBe('1');
    await sudo(host, 'ip link del eth0.10');
    expect(await cat(host, 'eth0.10', 'send_redirects')).toBe(missingFile('eth0.10', 'send_redirects'));
    expect(await scopesListed(host)).not.toContain('eth0.10');
  });

  it.each(['all', 'default'])('an interface that carries the name of the machine-wide scope %s does not take that scope with it', async (name) => {
    const host = new LinuxServer('linux-server', 'R1');
    expect(await sudo(host, `ip link add ${name} type dummy`)).toBe('');
    expect(await sudo(host, `ip link del ${name}`)).toBe('');
    expect(await read(host, name, 'send_redirects')).toBe(valueOf(name, 'send_redirects', 1));
    expect(await scopesListed(host)).toEqual(expect.arrayContaining(['all', 'default']));
  });

  it('a write to default after the departure does not bring the scope back', async () => {
    const host = new LinuxServer('linux-server', 'R1');
    await sudo(host, 'ip link add dummy0 type dummy');
    await sudo(host, 'ip link del dummy0');
    await write(host, 'default', 'send_redirects', 0);
    expect(await scopesListed(host)).not.toContain('dummy0');
  });
});
