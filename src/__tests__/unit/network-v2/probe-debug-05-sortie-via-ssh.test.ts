/**
 * Probes — la sortie asynchrone d'un routeur atteint la session SSH.
 *
 * Un routeur parle sans qu'on lui demande : les traces de `debug`, et le
 * syslog dès que la ligne a dit `terminal monitor`. Sur une console cette
 * sortie arrive au moment de l'évènement. Via SSH elle n'arrivait pas du
 * tout — le tampon du shell l'attendait jusqu'à la prochaine touche
 * Entrée, et côté Huawei rien ne la collectait.
 *
 * Ce que ces probes fixent :
 *   1  une VTY est muette tant qu'on ne lui a rien demandé
 *   2  `terminal monitor` ouvre la ligne, et les traces sont poussées
 *   3  ce qui a été poussé n'est pas redonné à la touche Entrée suivante
 *   4  le syslog emprunte le même chemin que le debug
 *   5  `terminal no monitor` la referme
 *   6  deux sessions SSH sont indépendantes
 *   7  VRP demande `terminal debugging` en plus de `terminal monitor`
 *   8  la fermeture du canal rend son abonnement
 *
 * Ces probes restent dans l'arbre : elles décrivent le contrat, pas un
 * incident ponctuel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { installDefaultShells } from '@/shell/registerDefaults';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 30_000;
const MASK = new SubnetMask('255.255.255.0');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Laisse la trace traverser le câble puis la pile SSH avant de lire. */
const laisserPasser = () => pause(300);

async function ouvrirCanal(
  poste: LinuxPC, ip: string, user: string, motDePasse: string,
): Promise<ISshShellChannel> {
  const dev = poste as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: {
      readFile: () => null, writeFile: () => undefined,
      resolveInode: () => null, mkdirp: () => undefined,
    } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host(ip).user(user).password(motDePasse).strictHostKeyChecking('no').build();
  const connecte = await session.connect(opts);
  if (!isOk(connecte)) throw new Error('connexion SSH refusée');
  const canal = session.openShellChannel();
  if (!isOk(canal)) throw new Error('canal shell refusé');
  return canal.value;
}

interface LabCisco {
  routeur: CiscoRouter;
  poste: LinuxPC;
  /** Second LAN, pour secouer une interface qui ne porte pas la session. */
  gLibre: string;
}

/**
 * PC1 est le client SSH et la source du ping ; PC2 n'existe que pour que
 * la seconde interface du routeur soit câblée — sans câble, un
 * `no shutdown` ne produit aucun évènement de lien à observer.
 */
async function labCisco(): Promise<LabCisco> {
  const routeur = new CiscoRouter('router-cisco', 'R1');
  const poste = new LinuxPC('linux-pc', 'PC1');
  const distant = new LinuxPC('linux-pc', 'PC2');
  const [g0, g1] = routeur.getPortNames();

  poste.getPorts()[0].configureIP(new IPAddress('10.0.4.1'), MASK);
  routeur.getPort(g0)!.configureIP(new IPAddress('10.0.4.2'), MASK);
  distant.getPorts()[0].configureIP(new IPAddress('10.0.6.1'), MASK);
  new Cable('c1').connect(poste.getPorts()[0], routeur.getPort(g0)!);
  new Cable('c2').connect(distant.getPorts()[0], routeur.getPort(g1)!);

  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    'username admin privilege 15 secret adminpw',
    // IOS ne fait tourner aucun serveur SSH sans clés RSA, et refuse de
    // les générer sans nom de domaine : c'est la configuration réelle qui
    // rend le routeur joignable en ssh.
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048',
    'end',
  ]) await routeur.executeCommand(c);

  return { routeur, poste, gLibre: g1 };
}

async function labHuawei(): Promise<{ routeur: HuaweiRouter; poste: LinuxPC }> {
  const routeur = new HuaweiRouter('router-huawei', 'AR1');
  const poste = new LinuxPC('linux-pc', 'PC1');
  poste.getPorts()[0].configureIP(new IPAddress('10.0.5.1'), MASK);
  routeur.getPorts()[0].configureIP(new IPAddress('10.0.5.2'), MASK);
  new Cable('c1').connect(poste.getPorts()[0], routeur.getPorts()[0]);

  for (const c of [
    'system-view', 'aaa',
    'local-user admin password irreversible-cipher adminpw',
    'local-user admin privilege level 15',
    'local-user admin service-type ssh terminal',
    'quit',
    // VRP ne fait tourner aucun serveur STelnet sans paire de clés
    // locale : la créer fait partie de la configuration réelle.
    'rsa local-key-pair create',
    'quit',
  ]) await routeur.executeCommand(c);

  return { routeur, poste };
}

describe('Scénario 1 — une VTY reste muette tant qu\'on ne lui a rien demandé', () => {
  it('le debug est actif mais la session SSH ne reçoit rien', async () => {
    const { routeur, poste } = await labCisco();
    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('enable');
    expect((await canal.runLine('debug ip icmp')).stdout).toContain('debugging is on');

    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    expect(
      routeur.getDebugService().subscriberCount(),
      'la session est bien abonnée : ce qui suit mesure le filtre, pas un fil absent',
    ).toBeGreaterThan(0);
    expect(
      recu,
      'sur un vrai IOS une VTY ne voit le debug qu\'après `terminal monitor`',
    ).toEqual([]);
  }, LONG);
});

describe('Scénario 2 — `terminal monitor` ouvre la ligne', () => {
  it('les traces arrivent sans qu\'aucune commande ne les demande', async () => {
    const { poste } = await labCisco();
    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('enable');
    await canal.runLine('debug ip icmp');
    await canal.runLine('terminal monitor');

    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    const texte = recu.join('');
    expect(texte).toContain('ICMP: echo request rcvd');
    expect(texte).toContain('ICMP: echo reply sent');
    expect(texte, 'la trace porte les adresses du paquet réel').toContain('10.0.4.1');
  }, LONG);

  it('elles arrivent alors que le prompt est libre, pas en réponse à une ligne', async () => {
    const { poste } = await labCisco();
    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('enable');
    await canal.runLine('debug ip icmp');
    await canal.runLine('terminal monitor');
    recu.length = 0;

    // Aucun runLine entre le ping et la lecture : si quelque chose arrive,
    // c'est bien une poussée du serveur et non la réponse d'une commande.
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    expect(recu.length).toBeGreaterThan(0);
  }, LONG);
});

describe('Scénario 3 — ce qui est poussé n\'est pas redonné ensuite', () => {
  it('la touche Entrée suivante ne rejoue pas les traces déjà lues', async () => {
    const { poste } = await labCisco();
    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('enable');
    await canal.runLine('debug ip icmp');
    await canal.runLine('terminal monitor');
    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();
    expect(recu.join('')).toContain('ICMP: echo request rcvd');

    const surEntree = await canal.runLine('');
    expect(
      surEntree.stdout,
      'le tampon du shell doit se taire quand quelqu\'un livre déjà en direct',
    ).not.toContain('ICMP:');
  }, LONG);
});

describe('Scénario 4 — le syslog emprunte le même chemin', () => {
  it('un changement d\'état de lien remonte dans la session SSH', async () => {
    const { poste, gLibre } = await labCisco();
    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('enable');
    await canal.runLine('terminal monitor');

    recu.length = 0;
    await canal.runLine('configure terminal');
    await canal.runLine(`interface ${gLibre}`);
    await canal.runLine('shutdown');
    await pause(200);
    await canal.runLine('no shutdown');
    await laisserPasser();

    const texte = recu.join('');
    expect(texte).toContain('%LINK-5-CHANGED');
    expect(texte).toContain('administratively down');
    expect(texte).toContain('%LINK-3-UPDOWN');
    expect(texte).toContain('%LINEPROTO-5-UPDOWN');
    expect(texte, 'le message nomme l\'interface concernée').toContain(gLibre);
  }, LONG);

  it('sans `terminal monitor`, le syslog ne remonte pas non plus', async () => {
    const { poste, gLibre } = await labCisco();
    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('enable');
    await canal.runLine('configure terminal');
    await canal.runLine(`interface ${gLibre}`);
    recu.length = 0;
    await canal.runLine('shutdown');
    await laisserPasser();

    expect(recu.join('')).not.toContain('%LINK');
  }, LONG);
});

describe('Scénario 5 — `terminal no monitor` referme la ligne', () => {
  it('plus rien n\'arrive après, alors que le debug reste actif', async () => {
    const { poste } = await labCisco();
    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('enable');
    await canal.runLine('debug ip icmp');
    await canal.runLine('terminal monitor');
    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();
    expect(recu.length, 'la ligne recevait bien avant qu\'on la referme').toBeGreaterThan(0);

    await canal.runLine('terminal no monitor');
    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    expect(recu, 'la ligne est muette').toEqual([]);
    expect(
      (await canal.runLine('show debugging')).stdout,
      'l\'opérateur a coupé la sortie, pas l\'instrumentation',
    ).toContain('debugging is on');
  }, LONG);
});

describe('Scénario 6 — deux sessions SSH sont indépendantes', () => {
  it('celle qui a demandé le moniteur reçoit, l\'autre non', async () => {
    const { poste } = await labCisco();
    const canalA = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const canalB = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    const recuA: string[] = [];
    const recuB: string[] = [];
    canalA.onData((d) => recuA.push(d));
    canalB.onData((d) => recuB.push(d));

    await canalA.runLine('enable');
    await canalA.runLine('debug ip icmp');
    await canalA.runLine('terminal monitor');

    recuA.length = 0;
    recuB.length = 0;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    expect(recuA.join(''), 'A a demandé le moniteur').toContain('ICMP:');
    expect(
      recuB,
      'le choix d\'une ligne ne déborde jamais sur une autre',
    ).toEqual([]);
  }, LONG);
});

describe('Scénario 7 — VRP demande son propre interrupteur', () => {
  it('`terminal monitor` seul ne suffit pas pour les traces de debugging', async () => {
    const { routeur, poste } = await labHuawei();
    const canal = await ouvrirCanal(poste, '10.0.5.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('debugging icmp');
    await canal.runLine('terminal monitor');

    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.5.2');
    await laisserPasser();

    expect(
      routeur.getHuaweiDebugService().subscriberCount(),
      'la session est abonnée au registre VRP, pas au registre Cisco hérité',
    ).toBeGreaterThan(0);
    expect(recu, 'il manque `terminal debugging`').toEqual([]);
  }, LONG);

  it('avec `terminal debugging` en plus, les traces VRP arrivent', async () => {
    const { poste } = await labHuawei();
    const canal = await ouvrirCanal(poste, '10.0.5.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('debugging icmp');
    await canal.runLine('terminal monitor');
    await canal.runLine('terminal debugging');

    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.5.2');
    await laisserPasser();

    const texte = recu.join('');
    expect(texte).toContain('ICMP: Echo Request received');
    expect(texte).toContain('ICMP: Echo Reply sent');
    expect(texte, 'la trace porte les adresses du paquet réel').toContain('10.0.5.1');
  }, LONG);

  it('`undo terminal monitor` referme les deux d\'un coup, comme sur VRP', async () => {
    const { poste } = await labHuawei();
    const canal = await ouvrirCanal(poste, '10.0.5.2', 'admin', 'adminpw');
    const recu: string[] = [];
    canal.onData((d) => recu.push(d));

    await canal.runLine('debugging icmp');
    await canal.runLine('terminal monitor');
    await canal.runLine('terminal debugging');
    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.5.2');
    await laisserPasser();
    expect(recu.length).toBeGreaterThan(0);

    await canal.runLine('undo terminal monitor');
    recu.length = 0;
    await poste.executeCommand('ping -c 1 10.0.5.2');
    await laisserPasser();

    expect(recu).toEqual([]);
  }, LONG);
});

describe('Scénario 9 — le terminal interactif, pas seulement le canal brut', () => {
  const touche = (k: string, ctrl = false) =>
    ({ key: k, ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false }) as never;

  /** Ouvre une vraie session terminal Linux et y tape `ssh` jusqu'au prompt. */
  async function terminalConnecte(poste: LinuxPC): Promise<LinuxTerminalSession> {
    const term = new LinuxTerminalSession('t1', poste);
    await term.init?.();
    term.setInput('ssh admin@10.0.4.2');
    term.handleKey(touche('Enter'));
    for (let i = 0; i < 40 && term.currentInputMode.type !== 'password'; i++) await pause(25);
    term.setPasswordBuf('adminpw');
    term.handleKey(touche('Enter'));
    for (let i = 0; i < 40; i++) await pause(25);
    expect(
      term.foreground.getPrompt(),
      'la session doit être établie, sinon la suite ne mesure rien',
    ).toMatch(/R1/);
    return term;
  }

  const taper = async (term: LinuxTerminalSession, ligne: string) => {
    term.setInputBuf(ligne);
    term.handleKey(touche('Enter'));
    for (let i = 0; i < 20; i++) await pause(25);
  };

  it('les traces s\'affichent dans le terminal du client, sans qu\'il tape quoi que ce soit', async () => {
    const { poste } = await labCisco();
    const term = await terminalConnecte(poste);

    await taper(term, 'enable');
    await taper(term, 'debug ip icmp');
    await taper(term, 'terminal monitor');

    const avant = term.lines.length;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    const nouvelles = term.lines.slice(avant).map((l) => l.text).join('\n');
    expect(
      nouvelles,
      'c\'est exactement le symptôme rapporté : rien ne s\'affichait côté client',
    ).toContain('ICMP: echo request rcvd');
    expect(nouvelles).toContain('ICMP: echo reply sent');
  }, LONG);

  it('sans `terminal monitor`, le terminal du client reste propre', async () => {
    const { poste } = await labCisco();
    const term = await terminalConnecte(poste);

    await taper(term, 'enable');
    await taper(term, 'debug ip icmp');

    const avant = term.lines.length;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    expect(term.lines.slice(avant).map((l) => l.text).join('\n')).not.toContain('ICMP:');
  }, LONG);

  it('chaque trace occupe sa propre ligne du terminal', async () => {
    const { poste } = await labCisco();
    const term = await terminalConnecte(poste);

    await taper(term, 'enable');
    await taper(term, 'debug ip icmp');
    await taper(term, 'terminal monitor');

    const avant = term.lines.length;
    await poste.executeCommand('ping -c 1 10.0.4.2');
    await laisserPasser();

    const traces = term.lines.slice(avant).map((l) => l.text).filter((t) => t.includes('ICMP:'));
    expect(
      traces.length,
      'la requête et la réponse sont deux évènements, donc deux lignes',
    ).toBe(2);
    for (const t of traces) {
      expect(t, 'aucune ligne ne doit en contenir deux collées').not.toMatch(/ICMP:.*ICMP:/);
    }
  }, LONG);
});

describe('Scénario 8 — la fermeture du canal rend son abonnement', () => {
  it('le compte des abonnés revient à son point de départ', async () => {
    const { routeur, poste } = await labCisco();
    const service = routeur.getDebugService();
    const avant = service.subscriberCount();

    const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
    await canal.runLine('enable');
    await canal.runLine('terminal monitor');
    expect(
      service.subscriberCount(),
      'la session ouverte tient un abonnement',
    ).toBeGreaterThan(avant);

    canal.close();
    await laisserPasser();

    expect(
      service.subscriberCount(),
      'une session qui se ferme sans rendre son fil fait fuir le routeur',
    ).toBe(avant);
  }, LONG);

  it('ouvrir et fermer plusieurs sessions n\'accumule rien', async () => {
    const { routeur, poste } = await labCisco();
    const service = routeur.getDebugService();
    const avant = service.subscriberCount();

    for (let i = 0; i < 3; i++) {
      const canal = await ouvrirCanal(poste, '10.0.4.2', 'admin', 'adminpw');
      await canal.runLine('enable');
      await canal.runLine('terminal monitor');
      canal.close();
      await pause(50);
    }
    await laisserPasser();

    expect(service.subscriberCount()).toBe(avant);
  }, LONG);
});
