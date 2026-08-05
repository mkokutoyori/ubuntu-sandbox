/**
 * L'aide contextuelle ne s'effondre plus derrière un argument.
 *
 * `CommandTrie.getCompletions()` cherchait un mot-clé enfant à chaque
 * token et abandonnait (`return []`) dès qu'elle en rencontrait un qui
 * n'en était pas un — une adresse, un nombre, un nom. L'exécution, elle,
 * consomme ces valeurs comme arguments. Aide et exécution divergeaient
 * donc par construction, et `ip address 192.168.10.1 ?` restait sans
 * réponse pour une commande qui s'exécute très bien
 * (docs/PRD-CLI-Fidelite-IOS.md §1.1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function inConfig(): Promise<CiscoRouter> {
  const router = new CiscoRouter('R1');
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  return router;
}

async function inInterface(): Promise<CiscoRouter> {
  const router = await inConfig();
  await router.executeCommand('interface GigabitEthernet0/0');
  return router;
}

describe('Un argument consommé ne casse plus l\'aide', () => {
  it.each([
    'ip address 192.168.10.1 ?',
    'mtu ?',
    'bandwidth ?',
  ])('%s répond quelque chose', async (command) => {
    const router = await inInterface();
    const help = await router.executeCommand(command);
    expect(help).not.toContain('Unrecognized');
    expect(help.trim().length).toBeGreaterThan(0);
  });

  it.each([
    'access-list 10 ?',
    'ntp server ?',
    'snmp-server community ?',
    'ip route ?',
    'router ospf ?',
    'ip dhcp excluded-address ?',
    'ip ssh time-out ?',
  ])('%s répond quelque chose', async (command) => {
    const router = await inConfig();
    const help = await router.executeCommand(command);
    expect(help).not.toContain('Unrecognized');
    expect(help.trim().length).toBeGreaterThan(0);
  });

  it('« % Unrecognized command » n\'est plus émis par la CLI Cisco', async () => {
    const router = await inInterface();
    const probes = [
      'ip address 192.168.10.1 ?',
      'ip address 192.168.10.1 255.255.255.0 ?',
      'encapsulation dot1Q ?',
      'nimportequoi ?',
      'show nimportequoi ?',
    ];
    for (const probe of probes) {
      expect(await router.executeCommand(probe)).not.toContain('Unrecognized');
    }
  });

  it('une saisie sans correspondance rend le refus d\'IOS', async () => {
    const router = await inConfig();
    expect(await router.executeCommand('zzzz ?'))
      .toMatch(/% Invalid input detected at '\^' marker\./);
  });
});

describe('L\'aide annonce le TYPE de l\'argument, comme IOS', () => {
  it('ip address <adresse> ? annonce le masque', async () => {
    const router = await inInterface();
    const help = await router.executeCommand('ip address 192.168.10.1 ?');
    expect(help).toContain('A.B.C.D');
    expect(help).toContain('IP subnet mask');
    // Une alternative au premier argument n'a plus de sens une fois
    // celui-ci saisi.
    expect(help).not.toContain('dhcp');
  });

  it('encapsulation dot1Q ? annonce la plage de VLAN', async () => {
    const router = await inInterface();
    expect(await router.executeCommand('encapsulation dot1Q ?')).toContain('<1-4094>');
  });

  it('mtu ? et bandwidth ? annoncent leurs plages', async () => {
    const router = await inInterface();
    expect(await router.executeCommand('mtu ?')).toContain('<64-1500>');
    expect(await router.executeCommand('bandwidth ?')).toContain('<1-10000000>');
  });

  it.each([
    ['ntp server ?', 'A.B.C.D'],
    ['ip route ?', 'A.B.C.D'],
    ['ip dhcp excluded-address ?', 'A.B.C.D'],
    ['router ospf ?', '<1-65535>'],
    ['access-list ?', '<1-2699>'],
    ['ip ssh time-out ?', '<1-120>'],
  ])('%s annonce %s', async (command, expected) => {
    const router = await inConfig();
    expect(await router.executeCommand(command)).toContain(expected);
  });

  it('snmp-server community ? annonce WORD et sa description', async () => {
    const router = await inConfig();
    const help = await router.executeCommand('snmp-server community ?');
    expect(help).toContain('WORD');
    expect(help).toContain('SNMP community string');
  });

  it('un mot-clé qui SUIT l\'argument reste proposé', async () => {
    const router = await inConfig();
    // `access-list` n'attend qu'un numéro ; une fois donné, les actions
    // redeviennent des candidats — contrairement au cas `ip address`.
    const help = await router.executeCommand('access-list 10 ?');
    expect(help).toContain('permit');
    expect(help).toContain('deny');
  });
});

describe('L\'exécution n\'a pas changé', () => {
  it('les commandes dont l\'aide a été déclarée s\'exécutent toujours', async () => {
    const router = await inInterface();
    expect(await router.executeCommand('ip address 192.168.10.1 255.255.255.0')).toBe('');
    expect(await router.executeCommand('mtu 1400')).toBe('');
    await router.executeCommand('exit');
    expect(await router.executeCommand('ip route 10.0.0.0 255.0.0.0 192.168.10.2')).toBe('');
    expect(await router.executeCommand('ntp server 192.168.10.9')).toBe('');
    expect(router.getPort('GigabitEthernet0/0')!.getIPAddress()!.toString())
      .toBe('192.168.10.1');
  });

  it('un nœud purement indicatif ne devient pas exécutable', async () => {
    const router = await inInterface();
    // `dot1Q` n'existe comme nœud que pour porter l'aide ; la commande
    // reste servie par le handler greedy d'`encapsulation`.
    expect(await router.executeCommand('encapsulation dot1Q 10')).not.toMatch(/Invalid input/);
  });
});

describe('L\'aide n\'invente pas de commandes', () => {
  it('un nœud purement indicatif n\'est pas proposé comme commande', async () => {
    const router = await inInterface();
    const aide = await router.executeCommand('?');
    // `ip helper-address`, `ip ospf cost`… sont déclarés pour porter leurs
    // arguments : leurs nœuds intermédiaires ne sont pas des commandes du
    // mode interface et ne doivent pas y figurer.
    expect(aide).not.toMatch(/^\s+helper-address\b/m);
    expect(aide).not.toMatch(/^\s+cost\b/m);
  });

  it('aucun mot-clé proposé n\'est sans description', async () => {
    const router = await inInterface();
    await router.executeCommand('exit');
    await router.executeCommand('line vty 0 4');
    const aide = await router.executeCommand('password ?');

    const sansDescription = aide.split('\n')
      .filter((l) => l.trim().length > 0 && !l.includes('<cr>'))
      .filter((l) => /^\s+\S+\s*$/.test(l));
    expect(sansDescription).toEqual([]);
  });

  it('mais un mot-clé réel que le gestionnaire accepte reste proposé', async () => {
    const router = await inConfig();
    const aide = await router.executeCommand('access-list 10 ?');
    expect(aide).toContain('permit');
    expect(aide).toContain('deny');
    expect(aide).toMatch(/permit\s+\S+/);
  });
});
