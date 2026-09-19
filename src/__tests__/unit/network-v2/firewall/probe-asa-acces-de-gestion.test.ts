/**
 * Sonde — l'ASA ecoutait sur 22 et 23 sans qu'on puisse jamais y entrer.
 *
 * Mesure AVANT, sur un `AsaFirewall` cable a un `LinuxPC` :
 *
 *   listListeners()                          -> [22, 23, 80, 443]
 *   telnet 192.168.1.1                       -> "Connected to …",
 *                                               "FW1 login:" puis
 *                                               "% Login invalid"
 *   ssh admin@192.168.1.1 "show version"     -> "Connection refused"
 *
 *   username admin password … privilege 15   -> "% Invalid input …"
 *   ssh 192.168.1.0 255.255.255.0 inside     -> "% Invalid input …"
 *   telnet 192.168.1.0 255.255.255.0 inside  -> "% Invalid input …"
 *   aaa authentication ssh console LOCAL     -> "% Invalid input …"
 *
 * Les portes sont ouvertes et il n'existe AUCUNE commande pour se
 * declarer un compte ni pour autoriser une source : le vocabulaire de
 * l'ASA (`AsaVocabulary.ts`) ne contient ni `username', ni `ssh', ni
 * `telnet', ni `aaa'. Le pare-feu FortiGate, lui, a tout cela depuis un
 * lot precedent -- c'est l'ASA qui restait muet.
 *
 * Autorite : une configuration ASA REELLE capturee, `sample_01.asa` des
 * fixtures de `ciscoconfparse`, qui porte mot pour mot
 *
 *   aaa authentication ssh console LOCAL                    (l. 319)
 *   ssh 192.0.2.0 255.255.255.0 INSIDE                      (l. 341)
 *   ssh timeout 60                                          (l. 343)
 *   ssh version 2                                           (l. 344)
 *   username mpenning password … encrypted privilege 15     (l. 379)
 *
 * (cisco.com est inaccessible depuis cet environnement -- 403 a travers
 * le mandataire -- d'ou le recours a une capture plutot qu'au guide.)
 *
 * SIX cas sur huit tombent avant la correction. Les DEUX autres sont
 * NOMMES :
 *
 *   - le ping vers le pare-feu repond : TEMOIN. Il prouve que le
 *     laboratoire est cable et adresse, donc qu'un SSH refuse est une
 *     absence de compte et non un cable mort.
 *   - un mauvais mot de passe est refuse : il passait DEJA, mais pour la
 *     mauvaise raison -- personne ne pouvait entrer. Il est ecrit ici
 *     pour qu'il reste vrai APRES, quand la bonne combinaison, elle,
 *     entrera.
 *
 * Deux precisions sur ce que les cas affirment, plutot que de les
 * laisser deviner. En SSH a UN COUP, la session s'ouvre au niveau EXEC
 * utilisateur et `show version` y est un mot du niveau privilegie : la
 * reponse attendue est donc le refus de l'ASA LUI-MEME
 * (`% Invalid input detected at '^' marker.`), qui ne peut venir que de
 * sa CLI -- c'est ce qui prouve que la session a abouti. En telnet, la
 * session etant interactive, `enable` precede `show version` comme sur
 * un vrai boitier, et la sortie complete revient.
 *
 * Limite mesuree et NON fermee ici : `ssh <hote>' SANS commande distante
 * ne passe pas par le fil. `wireExecTarget' exige au moins deux
 * positionnels, donc une session SSH interactive vers un equipement non
 * Linux retombe sur le chemin en memoire et se fait refuser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const FW_IP = '192.168.1.1';
const PC_IP = '192.168.1.10';

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function lab(withAccess = true): Promise<{ pc: LinuxPC; fw: AsaFirewall }> {
  const fw = new AsaFirewall('firewall-cisco', 'FW1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.getPort('eth0')!.configureIP(new IPAddress(PC_IP), MASK);
  new Cable('c1').connect(pc.getPort('eth0')!, fw.getPorts()[0]);

  const lines = [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'nameif inside', 'security-level 100',
    `ip address ${FW_IP} 255.255.255.0`, 'no shutdown', 'exit',
  ];
  if (withAccess) {
    lines.push(
      'username admin password Secret123 privilege 15',
      'aaa authentication ssh console LOCAL',
      'ssh 192.168.1.0 255.255.255.0 inside',
      'telnet 192.168.1.0 255.255.255.0 inside',
    );
  }
  lines.push('end');
  for (const l of lines) await fw.executeCommand(l);
  await settle();
  return { pc, fw };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('l\'ASA a un acces de gestion', () => {
  it('temoin : le pare-feu repond au ping', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`ping -c 1 ${FW_IP}`)).toMatch(/1 (packets )?received|bytes from/);
  }, 30000);

  it('`username … password … privilege 15` est accepte', async () => {
    const { fw } = await lab(false);
    await fw.executeCommand('enable');
    await fw.executeCommand('configure terminal');
    expect(await fw.executeCommand('username admin password Secret123 privilege 15'))
      .not.toContain('Invalid input');
  }, 30000);

  it('`ssh <reseau> <masque> <interface>` est accepte', async () => {
    const { fw } = await lab(false);
    await fw.executeCommand('enable');
    await fw.executeCommand('configure terminal');
    expect(await fw.executeCommand('ssh 192.168.1.0 255.255.255.0 inside'))
      .not.toContain('Invalid input');
  }, 30000);

  it('`telnet <reseau> <masque> <interface>` est accepte', async () => {
    const { fw } = await lab(false);
    await fw.executeCommand('enable');
    await fw.executeCommand('configure terminal');
    expect(await fw.executeCommand('telnet 192.168.1.0 255.255.255.0 inside'))
      .not.toContain('Invalid input');
  }, 30000);

  it('`aaa authentication ssh console LOCAL` est accepte', async () => {
    const { fw } = await lab(false);
    await fw.executeCommand('enable');
    await fw.executeCommand('configure terminal');
    expect(await fw.executeCommand('aaa authentication ssh console LOCAL'))
      .not.toContain('Invalid input');
  }, 30000);

  it('ssh atteint la CLI de l\'ASA, qui repond de ses propres mots', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`ssh admin@${FW_IP} "show version"`, 'Secret123\n');
    expect(out).not.toContain('Connection refused');
    expect(out).toContain("% Invalid input detected at '^' marker.");
  }, 30000);

  it('telnet ouvre la meme CLI, et `enable` y donne la sortie complete', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(
      `telnet ${FW_IP}`, 'admin\nSecret123\nenable\n\nshow version\nexit\n');
    expect(out).toContain('Cisco Adaptive Security Appliance');
  }, 30000);

  it('un mauvais mot de passe reste refuse', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`ssh admin@${FW_IP} "show version"`, 'WRONG\n');
    expect(out).not.toContain('Cisco Adaptive Security Appliance');
  }, 30000);
});
