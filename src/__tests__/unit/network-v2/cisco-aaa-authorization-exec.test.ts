/**
 * `aaa authorization exec` decide si l'on obtient un shell, et a quel
 * niveau.
 *
 * Defaut mesure (audit §2.6, seconde moitie de C8) : la commande etait
 * ACCEPTEE par l'analyseur (`CiscoSecurityCommands` connait le mot-cle
 * `exec`), STOCKEE dans les methodes AAA, RENDUE dans la configuration —
 * et `AaaAuthenticator` n'exposait AUCUNE methode correspondante. C'est
 * la commande par laquelle un serveur TACACS+ attribue le niveau de
 * privilege a l'ouverture de session ; la moitie « autorisation » du
 * chapitre AAA etait donc decorative.
 *
 * Ce que ces cas fixent, et qui n'allait pas de soi :
 *
 * - le niveau vient du SERVEUR (`priv-lvl` dans la reponse
 *   d'autorisation), pas du compte local, quand le groupe repond ;
 * - un REFUS du serveur refuse la session, il ne la degrade pas, et la
 *   methode suivante n'est PAS tentee — c'est la regle d'IOS, que le
 *   premier jet de ce fichier avait a l'envers ;
 * - `local` en repli rend le niveau du compte local quand le serveur est
 *   INJOIGNABLE, ce qui est tout l'interet d'ecrire `group X local` ;
 * - sans `aaa authorization exec`, rien ne change — c'est le cas de
 *   toutes les topologies deja enregistrees.
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

async function jouer(d: CiscoRouter | CiscoSwitch, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await d.executeCommand(c);
  return derniere;
}

interface Options {
  /** Niveau que le serveur TACACS+ attribue au compte. */
  niveauServeur?: number;
  /** Le serveur connait-il ce compte ? Sinon il REFUSE (verdict definitif). */
  compteSurServeur?: boolean;
  /** Le serveur repond-il ? Sinon il est INJOIGNABLE (on passe a la methode suivante). */
  serveurJoignable?: boolean;
  /** Les methodes de `aaa authorization exec default …`. */
  methodesExec?: string | null;
  /** Niveau du compte LOCAL sur le NAS. */
  niveauLocal?: number;
}

async function lab(o: Options = {}): Promise<{ nas: CiscoRouter; srv: CiscoRouter }> {
  const nas = new CiscoRouter('NAS', 0, 0);
  const srv = new CiscoRouter('AAA', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4, 0, 0);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(NAS_IP), new SubnetMask(MASK));
  srv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(AAA_IP), new SubnetMask(MASK));

  srv.getTacacsServer().setEnabled(o.serveurJoignable !== false);
  srv.getTacacsServer().setSharedSecret(CLE);
  if (o.compteSurServeur !== false) {
    srv.getTacacsServer().addUser(COMPTE, SECRET, o.niveauServeur ?? 15, []);
  }

  await jouer(nas, [
    'enable', 'configure terminal',
    'aaa new-model',
    'tacacs server SRV', `address ipv4 ${AAA_IP}`, 'port 49', `key ${CLE}`, 'exit',
    'aaa group server tacacs+ GRP', 'server name SRV', 'exit',
    'aaa authentication login default group GRP local',
    ...(o.methodesExec ? [`aaa authorization exec default ${o.methodesExec}`] : []),
    `username ${COMPTE} privilege ${o.niveauLocal ?? 1} secret ${SECRET}`,
    'line console 0', 'login local', 'exit',
    'end', 'exit',
  ]);
  return { nas, srv };
}

const niveau = async (r: CiscoRouter) => r.executeCommand('show privilege');

describe('C8 (2/2) — `aaa authorization exec` decide reellement', () => {
  it('le niveau vient du SERVEUR, pas du compte local', async () => {
    const { nas } = await lab({
      methodesExec: 'group GRP local', niveauServeur: 7, niveauLocal: 1,
    });
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(true);
    expect(await niveau(nas)).toContain('level is 7');
  });

  it('un REFUS du serveur refuse la session, il ne la degrade pas', async () => {
    const { nas } = await lab({
      methodesExec: 'group GRP', compteSurServeur: false, niveauLocal: 15,
    });
    // L'authentification passe par le repli local ; l'AUTORISATION, elle,
    // n'a pas de repli et le serveur ne connait pas le compte.
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(false);
  });

  /**
   * La regle qui separe les deux, et que le premier jet de ce fichier
   * avait a l'envers : un REFUS du serveur est DEFINITIF — la methode
   * suivante n'est pas tentee — tandis qu'un serveur INJOIGNABLE fait
   * passer a la suivante. C'est la meme regle que pour
   * l'authentification, et l'inverse ferait de `local` un contournement
   * de toute decision du serveur.
   */
  it('un REFUS est definitif : `local` n est PAS tente derriere', async () => {
    const { nas } = await lab({
      methodesExec: 'group GRP local', compteSurServeur: false, niveauLocal: 12,
    });
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(false);
  });

  it('`local` en repli rend le niveau du compte local quand le serveur est INJOIGNABLE', async () => {
    const { nas } = await lab({
      methodesExec: 'group GRP local', serveurJoignable: false, niveauLocal: 12,
    });
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(true);
    expect(await niveau(nas)).toContain('level is 12');
  });

  it('`if-authenticated` accorde sans rien demander de plus', async () => {
    const { nas } = await lab({
      methodesExec: 'if-authenticated', serveurJoignable: false, niveauLocal: 9,
    });
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(true);
    expect(await niveau(nas)).toContain('level is 9');
  });

  it('`none` accorde, meme sans serveur joignable', async () => {
    const { nas } = await lab({ methodesExec: 'none', serveurJoignable: false, niveauLocal: 3 });
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(true);
    expect(await niveau(nas)).toContain('level is 3');
  });

  it('la commande est rendue dans la configuration', async () => {
    const { nas } = await lab({ methodesExec: 'group GRP local' });
    await jouer(nas, ['enable']);
    expect(await nas.executeCommand('show running-config'))
      .toContain('aaa authorization exec default group GRP local');
  });

  // ── Non-régression : sans la commande, rien ne change ──────────────
  it('sans `aaa authorization exec`, le compte local decide', async () => {
    const { nas } = await lab({ methodesExec: null, niveauServeur: 15, niveauLocal: 4 });
    expect(await nas.loginAs(COMPTE, SECRET)).toBe(true);
    expect(await niveau(nas)).toContain('level is 4');
  });

  it('sans `aaa new-model`, la session s ouvre comme avant', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal',
      'username zoe privilege 11 secret zoe',
      'line console 0', 'login local', 'exit', 'end', 'exit',
    ]);
    expect(await r.loginAs('zoe', 'zoe')).toBe(true);
    expect(await niveau(r)).toContain('level is 11');
  });
});
