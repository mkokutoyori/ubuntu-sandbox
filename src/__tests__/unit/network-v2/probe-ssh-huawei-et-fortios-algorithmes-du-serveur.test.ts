/**
 * Mesure de depart (etape 4b) : ni un VRP, ni un FortiGate, ni un ASA ne savait regler les
 * algorithmes de son serveur SSH. `ssh server key-exchange|cipher|hmac|publickey` et
 * `ssh client ...` (VRP), `set ssh-kex-algo|ssh-enc-algo|ssh-mac-algo|ssh-hostkey-algo`
 * (`config system global`, FortiOS) et `ssh key-exchange group` / `ssh cipher encryption|integrity
 * custom` (ASA) etaient refuses ou ignores, de sorte qu'un client en liste ancienne (un IOS 15, ou
 * `ssh -o KexAlgorithms=...`) ne pouvait jamais etre servi. Les listes sont maintenant gardees,
 * affichees dans la configuration, evaluees par la negociation, et une cle d'hote RSA est offerte
 * quand un algorithme RSA est permis (celle de l'ASA l'est toujours : sa cle est RSA).
 *
 * Laboratoire : un poste Linux (10.0.0.1) et, selon le cas, un routeur Huawei, un FortiGate ou un
 * ASA (10.0.0.2) sur un commutateur. Sur les douze cas, sept tombent avant la correction (liste
 * absente de la configuration courante — serveur Huawei, client Huawei, ASA —, client en liste
 * ancienne refuse apres reglage — Huawei, FortiOS, ASA —, valeur inconnue acceptee cote FortiOS) ;
 * cinq passent des deux cotes et sont nommes : les trois temoins « sans reglage, le client en liste
 * ancienne est refuse a la negociation » (un par constructeur) et « un algorithme / un groupe
 * inconnu est refuse » cote Huawei et cote ASA (ces sous-commandes etaient deja refusees comme
 * inconnues).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { allowLegacyIosSshServerOnFortiOs } from '@/__tests__/unit/network-v2/iosLegacySsh';

let client: LinuxPC;
const mask = new SubnetMask('255.255.255.0');

const LEGACY_CLIENT =
  '-o KexAlgorithms=diffie-hellman-group14-sha1 -o HostKeyAlgorithms=ssh-rsa -o Ciphers=aes128-cbc -o MACs=hmac-sha1';
const ssh = (command: string): string =>
  `sshpass -p Admin@123 ssh -o StrictHostKeyChecking=no ${LEGACY_CLIENT} admin@10.0.0.2 ${command}`;

async function plug(device: { getPorts(): ReturnType<LinuxPC['getPorts']> }): Promise<void> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c0').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(device.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
}

async function huaweiRouter(): Promise<HuaweiRouter> {
  const router = new HuaweiRouter('R9', 0, 0);
  await plug(router);
  for (const command of [
    'system-view', 'sysname R9',
    `interface ${router.getPortNames()[0]}`, 'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'quit',
    'aaa', 'local-user admin password irreversible-cipher Admin@123',
    'local-user admin privilege level 15', 'local-user admin service-type ssh terminal', 'quit',
    'rsa local-key-pair create', 'stelnet server enable',
    'ssh user admin authentication-type password', 'ssh user admin service-type stelnet',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit', 'quit',
  ]) await router.executeCommand(command);
  return router;
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  client = new LinuxPC('linux-pc', 'A', 0, 0);
});

describe('un routeur Huawei regle les algorithmes de son serveur SSH', () => {
  it('temoin : sans reglage, le client en liste ancienne est refuse a la negociation', async () => {
    await huaweiRouter();
    expect(await client.executeCommand(ssh('display clock'))).toMatch(/no matching key exchange method found/);
  });

  it('un algorithme inconnu est refuse', async () => {
    const router = await huaweiRouter();
    await router.executeCommand('system-view');
    expect(await router.executeCommand('ssh server key-exchange dh_group_inconnu')).toMatch(/Error/);
  });

  it('la liste reglee figure dans la configuration courante', async () => {
    const router = await huaweiRouter();
    await router.executeCommand('system-view');
    await router.executeCommand('ssh server key-exchange dh_group14_sha1');
    await router.executeCommand('quit');
    expect(await router.executeCommand('display current-configuration')).toContain('ssh server key-exchange dh_group14_sha1');
  });

  it('une fois la liste ancienne permise, le client en liste ancienne est servi', async () => {
    const router = await huaweiRouter();
    for (const command of [
      'system-view',
      'ssh server key-exchange dh_group14_sha1',
      'ssh server publickey rsa',
      'ssh server cipher aes128_cbc',
      'ssh server hmac sha1',
      'quit',
    ]) await router.executeCommand(command);
    expect(await client.executeCommand(ssh('display clock'))).not.toMatch(/Unable to negotiate|Permission denied/);
  });
});

describe('un FortiGate regle les algorithmes de son serveur SSH', () => {
  it('temoin : sans reglage, le client en liste ancienne est refuse a la negociation', async () => {
    const gate = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await plugFirewall(gate);
    expect(await client.executeCommand(ssh('get system status'))).toMatch(/no matching key exchange method found/);
  });

  it('un algorithme inconnu est refuse', () => {
    const shell = new FortiGate('firewall-fortinet', 'FGT', 0, 0).getShell();
    shell.execute('config system global');
    expect(shell.execute('set ssh-kex-algo algorithme-inconnu')).toMatch(/value parse error/);
  });

  it('une fois la liste ancienne permise, le client en liste ancienne est servi', async () => {
    const gate = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await plugFirewall(gate);
    allowLegacyIosSshServerOnFortiOs(gate.getShell());
    expect(await client.executeCommand(ssh('get system status'))).not.toMatch(/Unable to negotiate|Permission denied/);
  });
});

async function plugFirewall(gate: FortiGate): Promise<void> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c0').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(gate.getPort('port1')!, sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  const shell = gate.getShell();
  for (const line of [
    'config system interface', 'edit "port1"', 'set mode static',
    'set ip 10.0.0.2 255.255.255.0', 'set allowaccess ping ssh', 'next', 'end',
    'config system admin', 'edit "admin"', 'set password "Admin@123"',
    'set accprofile "super_admin"', 'next', 'end',
  ]) shell.execute(line);
}

describe('un routeur Huawei regle les algorithmes de son client SSH', () => {
  it('la liste du client figure dans la configuration courante', async () => {
    const router = new HuaweiRouter('R9', 0, 0);
    await router.executeCommand('system-view');
    await router.executeCommand('ssh client key-exchange dh_group14_sha1');
    await router.executeCommand('quit');
    expect(await router.executeCommand('display current-configuration')).toContain('ssh client key-exchange dh_group14_sha1');
  });
});

describe('un ASA regle le groupe d\'echange de son serveur SSH', () => {
  async function asa(): Promise<AsaFirewall> {
    const gate = new AsaFirewall('firewall-cisco', 'ASA', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c0').connect(client.getPorts()[0], sw.getPorts()[0]);
    const port = gate.getPorts()[0];
    new Cable('c1').connect(port, sw.getPorts()[1]);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
    for (const command of [
      'enable', 'configure terminal', `interface ${port.getName()}`, 'nameif inside', 'security-level 100',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'username admin password Admin@123 privilege 15',
      'ssh 10.0.0.0 255.255.255.0 inside', 'crypto key generate rsa modulus 2048',
    ]) await gate.executeCommand(command);
    return gate;
  }

  it('temoin : sans reglage, le client en liste ancienne est refuse a la negociation', async () => {
    await asa();
    expect(await client.executeCommand(ssh('show version'))).toMatch(/no matching key exchange method found/);
  });

  it('un groupe inconnu est refuse', async () => {
    const gate = await asa();
    expect(await gate.executeCommand('ssh key-exchange group dh-group-inconnu')).toMatch(/Invalid input/);
  });

  it('le groupe regle figure dans la configuration courante', async () => {
    const gate = await asa();
    await gate.executeCommand('ssh key-exchange group dh-group14-sha1');
    expect(await gate.executeCommand('show running-config')).toContain('ssh key-exchange group dh-group14-sha1');
  });

  it('une fois le groupe ancien regle, le client en liste ancienne est servi', async () => {
    const gate = await asa();
    await gate.executeCommand('ssh key-exchange group dh-group14-sha1');
    await gate.executeCommand('ssh cipher encryption custom aes128-cbc');
    await gate.executeCommand('ssh cipher integrity custom hmac-sha1');
    expect(await client.executeCommand(ssh('show version'))).not.toMatch(/Unable to negotiate|Permission denied/);
  });
});
