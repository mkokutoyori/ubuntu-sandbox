/*
 * ASA : les commandes `ssh` etaient acceptees puis ignorees, et la configuration passee par une
 * session SSH disparaissait.
 *
 * Mesure de depart sur un ASA ou `ssh 10.0.0.0 255.255.255.0 inside` autorise le LAN :
 *  - `no ssh 10.0.0.0 ... / ssh 10.0.0.11 255.255.255.255 inside` laissait QUAND MEME entrer 10.0.0.12 :
 *    seule l'interface etait lue, jamais le reseau ni le masque ;
 *  - `ssh timeout`, `ssh version`, `ssh scopy enable` etaient avales sans effet, et
 *    `show running-config` n'affichait aucune ligne `ssh` ;
 *  - le serveur annoncait la banniere `SSH-2.0-OpenSSH_8.9p1 Ubuntu...` au lieu de celle de Cisco ;
 *  - une ACL tapee dans une session SSH vivait dans l'objet shell de la session et n'apparaissait pas
 *    dans `show running-config` de la console : deux vues d'une meme machine qui se contredisent.
 *
 * Corrige : le reseau et le masque decident (une source hors liste est ecartee en silence, comme tout
 * paquet jete, donc « Connection timed out »), `ssh timeout N` pilote le delai d'inactivite des
 * sessions d'administration, `ssh version` fixe la banniere (1 : SSH-1.5, 2 : SSH-2.0, non fixee :
 * SSH-1.99) et un client SSH 2 refuse une banniere 1.x, et l'etat de
 * configuration (ACL, NAT, journalisation, acces d'administration) vit sur l'equipement, partage par
 * la console et par chaque session.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network`) : 9 des 12 cas tombent. Les 3 qui
 * passent dans les deux etats sont nommes :
 *  - TEMOIN DU LABORATOIRE : le LAN entier est admis par la configuration de depart, ce qui prouve que
 *    le pare-feu, le cablage et les comptes sont sains et que les refus des autres cas viennent de la
 *    regle ;
 *  - « retirer la derniere entree ferme le service » : l'interface etait deja lue, c'est la NON-REGRESSION
 *    du seul comportement que l'ancien code avait ;
 *  - TEMOIN DU DELAI : une session inactive moins longtemps que le delai reste ouverte, ce qui designe le
 *    delai, et non une fermeture systematique, comme cause de la fermeture mesuree a cote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { buildMatrixLab, ADMIN, SECRET, Console } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

let pc: Cli;
let server: Cli;
let asa: Cli;

const ASA_IP = '10.0.0.13';
const ssh = `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 ${ADMIN}@${ASA_IP}`;

const configure = async (...lines: string[]) => {
  await asa.executeCommand('configure terminal');
  for (const line of lines) await asa.executeCommand(line);
  await asa.executeCommand('end');
};

beforeEach(async () => {
  const lab = await buildMatrixLab(['linux-pc', 'linux-server', 'firewall-cisco']);
  [pc, server, asa] = lab.nodes.map((n) => n.device as unknown as Cli);
});

describe('le reseau et le masque de `ssh` decident', () => {
  it('temoin : le LAN entier est admis par la configuration de depart', async () => {
    expect(await pc.executeCommand(`${ssh} "show version | include Version"`)).toMatch(/Adaptive Security/);
    expect(await server.executeCommand(`${ssh} "show version | include Version"`)).toMatch(/Adaptive Security/);
  });

  it('un seul poste est admis apres `ssh 10.0.0.11 255.255.255.255 inside`', async () => {
    await configure('no ssh 10.0.0.0 255.255.255.0 inside', 'ssh 10.0.0.11 255.255.255.255 inside');
    expect(await pc.executeCommand(`${ssh} "show version | include Version"`)).toMatch(/Adaptive Security/);
    expect(await server.executeCommand(`${ssh} "show version"`)).toMatch(/Connection timed out/);
  });

  it('retirer la derniere entree ferme le service sur l\'interface', async () => {
    await configure('no ssh 10.0.0.0 255.255.255.0 inside');
    expect(await pc.executeCommand(`${ssh} "show version"`)).toMatch(/Connection timed out/);
  });

  it('refuse un masque non contigu et un delai hors de 1 a 60 minutes', async () => {
    await asa.executeCommand('configure terminal');
    expect(await asa.executeCommand('ssh 10.0.0.0 255.0.255.0 inside')).toMatch(/Invalid input/);
    expect(await asa.executeCommand('ssh timeout 99')).toMatch(/Invalid input/);
    expect(await asa.executeCommand('ssh version 3')).toMatch(/Invalid input/);
  });
});

describe('les reglages sont rendus par la configuration', () => {
  it('`show running-config` affiche les entrees, le delai, la version et scopy', async () => {
    await configure('ssh 10.0.0.11 255.255.255.255 inside', 'ssh timeout 10', 'ssh version 2', 'ssh scopy enable');
    const config = await asa.executeCommand('show running-config | include ssh');
    expect(config).toContain('ssh 10.0.0.0 255.255.255.0 inside');
    expect(config).toContain('ssh 10.0.0.11 255.255.255.255 inside');
    expect(config).toContain('ssh timeout 10');
    expect(config).toContain('ssh version 2');
    expect(config).toContain('ssh scopy enable');
  });

  it('`no ssh timeout` et `no ssh version` reviennent aux valeurs d\'usine', async () => {
    await configure('ssh timeout 10', 'ssh version 1', 'no ssh timeout', 'no ssh version');
    const config = await asa.executeCommand('show running-config | include ssh');
    expect(config).toContain('ssh timeout 5');
    expect(config).not.toContain('ssh version');
  });
});

describe('la banniere suit `ssh version`', () => {
  const banner = async () => (await pc.executeCommand(`ssh-keyscan ${ASA_IP}`)).split('\n')[0];

  it('par defaut, la banniere est celle de Cisco et annonce 1.99', async () => {
    expect(await banner()).toContain('SSH-1.99-Cisco-1.25');
  });

  it('`ssh version 2` annonce SSH-2.0', async () => {
    await configure('ssh version 2');
    expect(await banner()).toContain('SSH-2.0-Cisco-1.25');
  });

  it('`ssh version 1` ecarte un client SSH 2', async () => {
    await configure('ssh version 1');
    expect(await pc.executeCommand(`${ssh} "show version"`)).not.toMatch(/Adaptive Security/);
  });
});

describe('`ssh timeout` borne l\'inactivite d\'une session d\'administration', () => {
  const idleThenType = async (minutes: number, idleSeconds: number): Promise<string> => {
    const clock = installSimulationClock(new SimulationClock({
      startPump: () => () => undefined, originMs: Date.UTC(2026, 9, 8, 9, 0, 0),
    }));
    await configure(`ssh timeout ${minutes}`);
    const session = await Console.open(pc as never);
    await session.login(`ssh ${ADMIN}@${ASA_IP}`, SECRET, ADMIN);
    await clock.advance(idleSeconds * 1000);
    await session.type('show version');
    return session.prompt;
  };

  afterEach(() => { __resetSimulationClock(); });

  it('une session inactive plus longtemps que le delai est fermee', async () => {
    expect(await idleThenType(1, 90)).toMatch(/lpc/);
  });

  it('temoin : une session inactive moins longtemps que le delai reste ouverte', async () => {
    expect(await idleThenType(10, 90)).toMatch(/asa/);
  });
});

describe('la configuration passee par une session SSH est celle de la machine', () => {
  it('une ACL tapee dans la session apparait dans la console', async () => {
    const console_ = await Console.open(pc as never);
    await console_.login(`ssh ${ADMIN}@${ASA_IP}`, SECRET, ADMIN);
    for (const line of ['configure terminal', 'access-list OUT extended permit tcp any any eq 80', 'end']) {
      await console_.type(line);
    }
    expect(await asa.executeCommand('show running-config | include access-list'))
      .toContain('access-list OUT extended permit tcp any any eq 80');
  });
});
