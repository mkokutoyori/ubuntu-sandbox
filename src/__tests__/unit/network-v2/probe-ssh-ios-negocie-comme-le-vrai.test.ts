/*
 * Sonde -- le serveur SSH d'IOS 15 negocie ce qu'IOS 15 negocie.
 *
 * MESURE DE DEPART (base `origin/mandeng'). Un LinuxPC (OpenSSH 8.9p1)
 * cable a un routeur Cisco 15.7(3)M5 ou a un Catalyst 12.2(55)SE12 :
 *   - `ssh admin@10.0.0.1 "show ip ssh"' reussit avec les options par
 *     defaut : le serveur parlait les algorithmes d'OpenSSH (curve25519,
 *     chacha20-poly1305, cle d'hote ed25519) alors que l'IOS annonce
 *     `SSH-1.99-Cisco-1.25' ;
 *   - les `-o KexAlgorithms=... / HostKeyAlgorithms=... / Ciphers=... /
 *     MACs=...' du client etaient acceptes et sans effet ;
 *   - `ip ssh server algorithm encryption ...' etait stocke et rendu, mais
 *     la session retenait `aes256-ctr' / `hmac-sha2-256' quoi qu'il arrive ;
 *   - `show ip ssh' n'ecrivait les listes que si l'operateur les avait
 *     restreintes, jamais les valeurs par defaut ;
 *   - `show ssh' n'ecrivait qu'une ligne IN par connexion.
 *
 * AUTORITES. Page Cisco « SSH Algorithms for Common Criteria
 * Certification » (releases 15.5(2)T / 15.5(2)S) : chiffrement
 * aes128-ctr, aes192-ctr, aes256-ctr, aes128-cbc, 3des-cbc, aes192-cbc,
 * aes256-cbc ; MAC hmac-sha1, hmac-sha1-96 ; cles d'hote x509v3-ssh-rsa,
 * ssh-rsa ; messages « % SSH command rejected: All <famille> algorithms
 * cannot be disabled ». Echanges de cles releves sur des transcriptions
 * publiees : IOS 15.2(7)E9 offre diffie-hellman-group-exchange-sha1 et
 * diffie-hellman-group14-sha1 (Wireshark #19594), IOS 15.2(4)E10
 * diffie-hellman-group-exchange-sha1 et diffie-hellman-group1-sha1. Le
 * 12.2(55)SE12 est cale sur diffie-hellman-group1-sha1 SEUL et un chiffrement
 * CBC SEUL : INFERE, aucune capture de cette release n'a pu etre jointe.
 * RFC 4419 (echange de groupe), RFC 4253. OpenSSH 8.9p1 readconf.c pour
 * les refus de `-o' (« Bad SSH2 cipher spec ») et kex.c pour
 * « Unable to negotiate ... Their offer: ».
 *
 * L'implantation a en outre ete eprouvee HORS DEPOT contre l'`ssh' 8.9p1
 * REEL compile depuis les sources, sur une vraie socket : chaque
 * combinaison kex (group-exchange-sha1, group14-sha1, group1-sha1),
 * chiffrement (aes-ctr, aes-cbc, 3des-cbc), MAC (hmac-sha1, hmac-sha1-96)
 * et la signature ssh-rsa SHA-1 aboutissent a SSH2_MSG_SERVICE_ACCEPT, et
 * contre asyncssh 2.24 dans l'autre sens.
 *
 * DISCRIMINATION (`git stash' des fichiers suivis) : 18 des 19 cas tombent
 * avant le correctif. Passe des deux cotes le TEMOIN : avec
 * `-oKexAlgorithms=+diffie-hellman-group14-sha1 -oHostKeyAlgorithms=+ssh-rsa'
 * la session s'ouvre et `show ip ssh' repond -- il prouve que le
 * laboratoire joint bien le routeur et que les refus plus bas ne sont pas
 * un cable debranche.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { assembleAlgorithmList } from '@/network/protocols/ssh/transport/SshAlgorithms';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const MASK = new SubnetMask('255.255.255.0');
const KEX14 = '-oKexAlgorithms=+diffie-hellman-group14-sha1';
const GEX1 = '-oKexAlgorithms=+diffie-hellman-group-exchange-sha1';
const GROUP1 = '-oKexAlgorithms=+diffie-hellman-group1-sha1';
const SSH_RSA = '-oHostKeyAlgorithms=+ssh-rsa';
const NEGOTIATION_PREFIX = 'Unable to negotiate with 10.0.0.1 port 22: no matching';

interface Lab { client: LinuxPC; router: CiscoRouter; catalyst: CiscoSwitch }

async function lab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'PC', 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const catalyst = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const ports = sw.getPorts();
  [client.getPort('eth0')!, router.getPorts()[0], catalyst.getPort('FastEthernet0/1')!]
    .forEach((port, i) => new Cable(`c${i}`).connect(port, ports[i]));
  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret Cisco123', 'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'end',
  ]) await router.executeCommand(c);
  for (const c of ['enable', 'configure terminal', 'ip domain-name lab.local',
    'interface Vlan1', 'ip address 10.0.0.3 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret Cisco123',
    'crypto key generate rsa modulus 2048', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'end',
  ]) await catalyst.executeCommand(c);
  await settle();
  return { client, router, catalyst };
}

function ssh(client: LinuxPC, address: string, options: string, command = 'show ip ssh'): Promise<string> {
  return client.executeCommand(
    `ssh -o StrictHostKeyChecking=no ${options} admin@${address} "${command}"`, 'Cisco123\n');
}

function lastSession(device: CiscoRouter | CiscoSwitch): { cipher: string; hmac: string } {
  const registry = (device as unknown as {
    getSshSessionRegistry(): {
      history(): ReadonlyArray<{ cipher: string; hmac: string }>;
      list(): ReadonlyArray<{ cipher: string; hmac: string }>;
    };
  }).getSshSessionRegistry();
  return [...registry.history(), ...registry.list()].at(-1)!;
}

async function configure(device: CiscoRouter, ...lines: string[]): Promise<string> {
  let out = '';
  for (const l of ['enable', 'configure terminal', ...lines, 'end']) out += await device.executeCommand(l);
  return out;
}

describe('IOS negocie SSH comme IOS', () => {
  it('TEMOIN -- avec les deux options de compatibilite, la session s ouvre', async () => {
    const { client } = await lab();

    expect(await ssh(client, '10.0.0.1', `${KEX14} ${SSH_RSA}`)).toContain('SSH Enabled - version 1.99');
  }, 30000);

  it('par defaut, OpenSSH 8.9 est refuse sur l echange de cles, avec l offre de l IOS', async () => {
    const { client } = await lab();

    expect(await ssh(client, '10.0.0.1', '')).toContain(
      `${NEGOTIATION_PREFIX} key exchange method found. Their offer: diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1`);
  }, 30000);

  it('avec le kex accepte, il est refuse sur le type de cle d hote : ssh-rsa seul', async () => {
    const { client } = await lab();

    expect(await ssh(client, '10.0.0.1', KEX14)).toContain(
      `${NEGOTIATION_PREFIX} host key type found. Their offer: ssh-rsa`);
  }, 30000);

  it('la session retient aes128-ctr et hmac-sha1, premiers de l IOS qu OpenSSH sait aussi', async () => {
    const { client, router } = await lab();
    await ssh(client, '10.0.0.1', `${KEX14} ${SSH_RSA}`);

    expect(lastSession(router)).toMatchObject({ cipher: 'aes128-ctr', hmac: 'hmac-sha1' });
  }, 30000);

  it('l echange de groupe SHA-1 (RFC 4419) avec aes256-cbc et hmac-sha1-96 aboutit', async () => {
    const { client, router } = await lab();
    const output = await ssh(client, '10.0.0.1', `${GEX1} ${SSH_RSA} -oCiphers=aes256-cbc -oMACs=hmac-sha1-96`);

    expect(output).toContain('SSH Enabled - version 1.99');
    expect(lastSession(router)).toMatchObject({ cipher: 'aes256-cbc', hmac: 'hmac-sha1-96' });
  }, 30000);

  it('3des-cbc est negocie quand le client ne propose que lui', async () => {
    const { client, router } = await lab();
    await ssh(client, '10.0.0.1', `${KEX14} ${SSH_RSA} -oCiphers=3des-cbc`);

    expect(lastSession(router).cipher).toBe('3des-cbc');
  }, 30000);

  it('la cle d hote ecrite dans known_hosts est la cle RSA du routeur', async () => {
    const { client } = await lab();
    await ssh(client, '10.0.0.1', `${KEX14} ${SSH_RSA}`);

    expect(await client.executeCommand('cat ~/.ssh/known_hosts')).toContain(' ssh-rsa ');
  }, 30000);

  it('`ip ssh server algorithm encryption aes256-ctr` restreint ce que le serveur offre', async () => {
    const { client, router } = await lab();
    await configure(router, 'ip ssh server algorithm encryption aes256-ctr');

    expect(await ssh(client, '10.0.0.1', `${KEX14} ${SSH_RSA} -oCiphers=aes128-ctr`)).toContain(
      `${NEGOTIATION_PREFIX} cipher found. Their offer: aes256-ctr`);
  }, 30000);

  it('`no ip ssh server algorithm encryption` retire un nom, et refuse de retirer le dernier', async () => {
    const { router } = await lab();
    const names = ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc', 'aes192-cbc'];
    for (const name of names) await configure(router, `no ip ssh server algorithm encryption ${name}`);

    expect(await configure(router, 'no ip ssh server algorithm encryption aes256-cbc'))
      .toContain('% SSH command rejected: All encryption algorithms cannot be disabled');
    expect(await router.executeCommand('show ip ssh')).toContain('Encryption Algorithms:aes256-cbc\n');
  }, 30000);

  it('`show ip ssh` ecrit les listes par defaut de la page Cisco', async () => {
    const { router } = await lab();
    const shown = await router.executeCommand('show ip ssh');

    expect(shown).toContain('Hostkey Algorithms:x509v3-ssh-rsa,ssh-rsa');
    expect(shown).toContain('Encryption Algorithms:aes128-ctr,aes192-ctr,aes256-ctr,aes128-cbc,3des-cbc,aes192-cbc,aes256-cbc');
    expect(shown).toContain('MAC Algorithms:hmac-sha1,hmac-sha1-96');
    expect(shown).toContain('KEX Algorithms:diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1');
  }, 30000);

  it('un mot hors de la liste est refuse a la saisie', async () => {
    const { router } = await lab();

    expect(await configure(router, 'ip ssh server algorithm mac hmac-md5')).toContain('% Invalid input detected');
  }, 30000);

  it('le Catalyst 12.2(55)SE12 n offre que group1-sha1 et des chiffrements CBC', async () => {
    const { client } = await lab();

    expect(await ssh(client, '10.0.0.3', '')).toContain(
      'Unable to negotiate with 10.0.0.3 port 22: no matching key exchange method found. Their offer: diffie-hellman-group1-sha1');
    expect(await ssh(client, '10.0.0.3', `${GROUP1} ${SSH_RSA}`)).toContain(
      'no matching cipher found. Their offer: aes128-cbc,3des-cbc,aes192-cbc,aes256-cbc');
  }, 30000);

  it('le Catalyst s ouvre avec group1-sha1, ssh-rsa et aes128-cbc', async () => {
    const { client, catalyst } = await lab();
    const output = await ssh(client, '10.0.0.3', `${GROUP1} ${SSH_RSA} -oCiphers=+aes128-cbc`, 'show version');

    expect(output).toContain('Cisco IOS Software');
    expect(lastSession(catalyst).cipher).toBe('aes128-cbc');
  }, 30000);

  it('`~/.ssh/config` porte les memes directives que `-o`, et elles sont appliquees', async () => {
    const { client, router } = await lab();
    await client.executeCommand('mkdir -p ~/.ssh');
    await client.executeCommand(
      `printf 'Host *\\n  KexAlgorithms +diffie-hellman-group14-sha1\\n  HostKeyAlgorithms +ssh-rsa\\n' > ~/.ssh/config`);

    expect(await ssh(client, '10.0.0.1', '')).toContain('SSH Enabled - version 1.99');
    expect(lastSession(router).hmac).toBe('hmac-sha1');
  }, 30000);

  it('un `-o Ciphers=` inconnu est refuse par le client, comme readconf.c', async () => {
    const { client } = await lab();

    expect(await ssh(client, '10.0.0.1', '-oCiphers=foo'))
      .toContain("command-line line 0: Bad SSH2 cipher spec 'foo'.");
  }, 30000);
});

describe('listes d algorithmes de ssh_config (kex_assemble_names)', () => {
  const defaults = ['a', 'b', 'c'];

  it('+ ajoute en queue sans doublon', () => {
    expect(assembleAlgorithmList(defaults, '+d,b')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('- retire, jokers compris', () => {
    expect(assembleAlgorithmList(['aes128-ctr', 'aes128-cbc', 'x'], '-aes*')).toEqual(['x']);
  });

  it('^ place en tete', () => {
    expect(assembleAlgorithmList(defaults, '^c,z')).toEqual(['c', 'z', 'a', 'b']);
  });

  it('sans prefixe, remplace', () => {
    expect(assembleAlgorithmList(defaults, 'z')).toEqual(['z']);
  });
});
