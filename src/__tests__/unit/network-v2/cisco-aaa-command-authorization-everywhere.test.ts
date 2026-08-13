/**
 * `aaa authorization commands` garde TOUTES les portes, pas une seule.
 *
 * Defaut mesure (audit §2.6, C8) : `AaaAuthenticator.authorizeCommand()`
 * etait correcte et reellement branchee sur TACACS+, mais elle n'avait
 * qu'UN appelant de production — `CiscoTerminalSession`. Toute session
 * SSH, telnet ou scriptee echappait donc a l'autorisation par commande,
 * qui etait pourtant configuree et rendue dans la configuration.
 *
 * C'est litteralement le defaut que ce depot a deja referme pour
 * `test aaa group` (« la commande existait dans `CiscoTerminalSession`,
 * donc dans le terminal graphique et NULLE PART ailleurs »), reproduit
 * sur le mecanisme d'autorisation lui-meme.
 *
 * Un second defaut, de SEMANTIQUE, est corrige ici : la liste consultee
 * etait choisie sur le niveau de la SESSION, alors qu'IOS la choisit sur
 * le niveau de la COMMANDE. Avec la seule liste `commands 15`, une
 * session de niveau 15 tapant `show version` — commande de niveau 1 —
 * etait soumise a la liste 15 ; sur IOS elle releve de la liste 1, non
 * configuree, donc non autorisee. Les deux defauts se voyaient l'un
 * l'autre : corriger le branchement sans la semantique aurait fait
 * refuser des commandes de niveau 1 sur toute machine portant
 * `aaa authorization commands 15`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const NAS_IP = '10.0.0.1';
const AAA_IP = '10.0.0.2';
const MASK = '255.255.255.0';
const CLE = 'Tacacs@2025';
const COMPTE = 'netadmin';
const SECRET = 'Admin@2025';
const REFUS_AAA = 'Command authorization failed.';

async function jouer(d: CiscoRouter, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await d.executeCommand(c);
  return derniere;
}

/**
 * Un NAS cable a un serveur TACACS+ qui n'autorise que `permises`.
 * `niveaux` dit quelles listes `aaa authorization commands N` poser.
 */
async function lab(permises: string[], niveaux: number[] = [15]): Promise<{ nas: CiscoRouter; srv: CiscoRouter }> {
  const nas = new CiscoRouter('NAS', 0, 0);
  const srv = new CiscoRouter('AAA', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4, 0, 0);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(NAS_IP), new SubnetMask(MASK));
  srv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(AAA_IP), new SubnetMask(MASK));

  srv.getTacacsServer().setEnabled(true);
  srv.getTacacsServer().setSharedSecret(CLE);
  srv.getTacacsServer().addUser(COMPTE, SECRET, 15, permises);

  await jouer(nas, [
    'enable', 'configure terminal',
    'aaa new-model',
    'tacacs server SRV', `address ipv4 ${AAA_IP}`, 'port 49', `key ${CLE}`, 'exit',
    'aaa group server tacacs+ GRP', 'server name SRV', 'exit',
    'aaa authentication login default group GRP local',
    ...niveaux.map((n) => `aaa authorization commands ${n} default group GRP local`),
    `username ${COMPTE} privilege 15 secret ${SECRET}`,
    'line console 0', 'login local', 'exit',
    'end', 'exit',
  ]);
  return { nas, srv };
}

describe('C8 — l autorisation par commande garde le chemin scripte', () => {
  it('une commande HORS liste est refusee hors du terminal graphique', async () => {
    const { nas } = await lab(['show version']);
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(true);
    const out = await nas.executeCommand('show running-config');
    expect(out).toContain(REFUS_AAA);
    expect(out).not.toContain('hostname');
  });

  it('une commande AUTORISEE passe, et la session reste utilisable', async () => {
    const { nas } = await lab(['show version', 'show running-config']);
    await nas.loginAs(COMPTE, SECRET);
    expect(await nas.executeCommand('show running-config')).toContain('hostname');
    expect(await nas.executeCommand('show version')).toContain('Cisco IOS Software');
  });

  it('l abreviation ne contourne pas l autorisation', async () => {
    const { nas } = await lab(['show version']);
    await nas.loginAs(COMPTE, SECRET);
    expect(await nas.executeCommand('sh run')).toContain(REFUS_AAA);
  });

  it('la liste consultee est celle du niveau de la COMMANDE', async () => {
    // Seule `commands 15` est posee. `show version` est une commande de
    // NIVEAU 1 : elle releve de la liste 1, qui n'existe pas, donc elle
    // n'est pas soumise au serveur — meme si celui-ci ne la permet pas.
    const { nas, srv } = await lab([]);
    await nas.loginAs(COMPTE, SECRET);
    srv.getTacacsServer().addUser(COMPTE, SECRET, 15, ['rien-du-tout']);
    expect(await nas.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await nas.executeCommand('show running-config')).toContain(REFUS_AAA);
  });

  it('une liste posee au niveau 1 gouverne bien les commandes de niveau 1', async () => {
    const { nas } = await lab(['show clock'], [1, 15]);
    await nas.loginAs(COMPTE, SECRET);
    expect(await nas.executeCommand('show clock')).not.toContain(REFUS_AAA);
    expect(await nas.executeCommand('show version')).toContain(REFUS_AAA);
  });

  it('une commande DESCENDUE par `privilege` change de liste avec son niveau', async () => {
    const { nas } = await lab(['show clock'], [1, 15]);
    await jouer(nas, [
      'enable', 'configure terminal',
      'privilege exec level 1 show running-config',
      'end', 'exit',
    ]);
    await nas.loginAs(COMPTE, SECRET);
    // Descendue au niveau 1, elle releve desormais de la liste 1.
    expect(await nas.executeCommand('show running-config')).toContain(REFUS_AAA);
  });

  // ── Non-régression : sans AAA, rien ne change ─────────────────────
  it('sans `aaa authorization commands`, aucune commande n est soumise', async () => {
    const nas = new CiscoRouter('R1', MACAddress.generate());
    await jouer(nas, ['enable', 'configure terminal', 'aaa new-model', 'end']);
    expect(await nas.executeCommand('show running-config')).toContain('hostname');
    expect(await nas.executeCommand('show version')).toContain('Cisco IOS Software');
  });

  /**
   * Trouve par la non-regression, et ce n'etait pas l'autorisation qui
   * etait en cause mais le MOMENT.
   *
   * La porte est posee sur le chemin que TOUTE commande emprunte. Un
   * `await` inconditionnel y differait l'execution d'un tour de
   * micro-taches, donc changeait l'instant ou une commande prend effet —
   * y compris sur une machine sans le moindre AAA. Un appelant qui
   * n'attend pas `executeCommand` voyait son changement de mode arriver
   * trop tard. La porte rend donc `null` SYNCHRONEMENT quand il n'y a
   * rien a autoriser.
   */
  it('sans AAA, une commande prend effet SANS attendre le tour suivant', async () => {
    const nas = new CiscoRouter('R1', MACAddress.generate());
    await jouer(nas, ['enable']);
    // Volontairement non attendu : c'est le cas mesure.
    void nas.executeCommand('configure terminal');
    expect(await nas.executeCommand('hostname SansAttendre')).toBe('');
    expect(await nas.executeCommand('do show running-config')).toContain('hostname SansAttendre');
  });

  it('sans utilisateur authentifie, la porte ne se ferme pas sur la console', async () => {
    const { nas } = await lab([]);
    // Aucun `loginAs` : la console anonyme n'a pas d'identite a soumettre.
    expect(await nas.executeCommand('show version')).toContain('Cisco IOS Software');
  });
});
