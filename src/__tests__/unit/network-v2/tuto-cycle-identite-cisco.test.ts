/**
 * Le tutoriel « Cycle de vie d'une identité sur Cisco », joué comme un
 * laboratoire — sur les DEUX plateformes, parce que le tutoriel se joue
 * sur un switch et que tout ce qu'il enseigne existe aussi sur un
 * routeur.
 *
 * Mesuré avant d'écrire une ligne, en rejouant les douze chapitres. Le
 * routeur savait déjà presque tout ; le commutateur, presque rien. Cinq
 * défauts, tous de la même famille — un mécanisme écrit UNE fois, dans
 * le module du routeur :
 *
 * 1. **Toute la famille identité manquait au Catalyst.** `aaa new-model`,
 *    `tacacs server`, `aaa group server tacacs+`, `login block-for`,
 *    `show tacacs`, `show login` tombaient dans la résolution de nom
 *    d'hôte (`Translating "aaa"...`) — un vrai 2960 les connaît toutes.
 *    Elles vivaient dans `buildSecurityConfigCommands`, que seul le
 *    shell du routeur appelle et qui enregistre aussi ce qu'un
 *    commutateur n'a pas (`zone security`, `class-map type inspect`).
 * 2. **Les trois sous-modes n'étaient pas dans la hiérarchie du switch**,
 *    donc `exit` depuis `config-tacacs-server` ne remontait nulle part :
 *    tout ce qui suivait était jugé dans un mode où seules
 *    `address`/`key`/`timeout` existent, et se faisait refuser.
 * 3. **`line console 0` n'était rendue nulle part** sur un Catalyst —
 *    le tout premier verrou du cours, configuré, honoré, et absent de la
 *    configuration. Ce n'est pas un défaut d'affichage : la
 *    configuration rendue est ce qui REFAIT la machine à l'import.
 * 4. **`enable secret level N`** de même : le magasin vit sur
 *    `Equipment`, donc le switch le portait et ouvrait bien le niveau,
 *    mais seul le routeur le rendait.
 * 5. **`clear line` confondait deux situations** :
 *    `% Not allowed to clear that line` est ce qu'IOS répond quand on
 *    demande à couper SA PROPRE ligne, pas quand la ligne est libre. Une
 *    ligne vty inoccupée recevait un refus, ce qui fait chercher un
 *    droit manquant là où il n'y a personne.
 *
 * Deux formes du tutoriel sont REFUSÉES, et c'est la fidélité :
 * `test aaa group GRP username X password Y new-code` (la vraie syntaxe
 * est positionnelle, vérifiée contre le command reference d'IOS), et
 * `config-register` sur un Catalyst, qui n'a pas de registre réglable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
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

type Machine = CiscoSwitch | CiscoRouter;

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['switch', () => new CiscoSwitch('SW1')],
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
];

async function machine(fabrique: () => Machine): Promise<Machine> {
  const d = fabrique();
  d.powerOn();
  await d.executeCommand('enable');
  return d;
}

async function tape(d: Machine, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — chapitres 2 à 4 : les deux portes et le chiffrement`, () => {
    it('le mot de passe de console est RENDU dans la configuration', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal', 'line console 0',
        'password MonPremierMotDePasse', 'login', 'exit', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | section line console');
      expect(bloc).toContain('line console 0');
      expect(bloc).toContain('password MonPremierMotDePasse');
      expect(bloc).toContain('login');
    }, 30_000);

    it('`service password-encryption` transforme ce mot de passe en type 7', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal', 'line console 0', 'password MonPremierMotDePasse',
        'login', 'exit', 'service password-encryption', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | section line console');
      expect(bloc).toMatch(/password 7 \S+/);
      expect(bloc).not.toContain('MonPremierMotDePasse');
    }, 30_000);

    it('`enable secret` est haché, `enable password` reste lisible', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal', 'enable secret MotDePasseAdmin2024!',
        'enable password MonMotDePasse', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | include enable');
      expect(bloc).toMatch(/enable secret \d \S+/);
      expect(bloc).not.toContain('MotDePasseAdmin2024!');
      expect(bloc).toContain('enable password');
    }, 30_000);
  });

  describe(`${nom} — chapitres 5 et 6 : comptes nommés et niveaux`, () => {
    it('un compte nommé est créé, listé et supprimable', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'username jean-baptiste privilege 7 secret MotDePasseJB2024!',
        'username marie-claire privilege 15 secret MotDePMC2024!', 'end',
      ]);
      let bloc = await d.executeCommand('show running-config | include username');
      expect(bloc).toContain('username jean-baptiste privilege 7');
      expect(bloc).toContain('username marie-claire privilege 15');
      expect(bloc).not.toContain('MotDePasseJB2024!');

      await tape(d, ['configure terminal', 'no username jean-baptiste', 'end']);
      bloc = await d.executeCommand('show running-config | include username');
      expect(bloc).not.toContain('jean-baptiste');
      expect(bloc).toContain('marie-claire');
    }, 30_000);

    /**
     * Le cœur du chapitre 6, et ce qu'un affichage seul ne prouverait
     * pas : le niveau doit BLOQUER. On monte au niveau 7 et on vérifie
     * que ce qui y a été autorisé passe et que le reste est absent —
     * IOS répondant `% Invalid input`, pas « refusé », parce qu'une
     * commande hors du niveau n'existe simplement pas pour lui.
     */
    it('`privilege exec level N` autorise ET bloque vraiment', async () => {
      const d = await machine(fabrique);
      // Hisser `show running-config` hisse `show` avec elle — c'est la
      // promotion des parentes d'IOS. Sans redescendre `show`, le
      // niveau 1 perdrait `show privilege` elle-meme, et le laboratoire
      // decrirait une machine qui n'existe pas.
      await tape(d, [
        'configure terminal',
        'privilege exec level 7 show running-config',
        'privilege exec level 1 show',
        'privilege exec level 10 configure terminal',
        'privilege exec level 15 reload',
        'enable secret level 7 PasswordTechnicien2024!',
        'end', 'disable',
      ]);
      expect(await d.executeCommand('show privilege')).toContain('level is 1');
      await d.executeCommand('enable 7', { passwordInput: 'PasswordTechnicien2024!' });
      expect(await d.executeCommand('show privilege')).toContain('level is 7');
      expect(await d.executeCommand('show running-config')).toContain('Current configuration');
      expect(await d.executeCommand('configure terminal')).toContain('% Invalid input');
      expect(await d.executeCommand('reload')).toContain('% Invalid input');
    }, 30_000);

    /**
     * `enable secret level 15` N'EST PAS rendu comme tel, et c'est juste :
     * le niveau 15 EST le secret `enable` ordinaire sur un vrai IOS, qui
     * l'ecrit donc `enable secret …`. Ma premiere version de ce cas
     * attendait une ligne `level 15` — elle aurait figé une invention.
     */
    it('`enable secret level N` est RENDU — sans quoi le niveau se perd au rechargement', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'enable secret level 7 PasswordTechnicien2024!',
        'enable secret level 15 PasswordAdmin2024!', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | include enable');
      expect(bloc).toContain('enable secret level 7');
      expect(bloc).toMatch(/^enable secret \d/m);
      expect(bloc).not.toContain('PasswordTechnicien2024!');
    }, 30_000);
  });

  describe(`${nom} — chapitres 7 à 9 : vty, bannières, force brute`, () => {
    it('les réglages de vty sont rendus, `transport input` compris', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal', 'line vty 0 4', 'login local',
        'transport input ssh', 'exec-timeout 15 0', 'exit', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | section line vty');
      expect(bloc).toContain('line vty 0 4');
      expect(bloc).toContain('login local');
      expect(bloc).toContain('transport input ssh');
      expect(bloc).toContain('exec-timeout 15 0');
    }, 30_000);

    it('les trois bannières sont posées et rendues', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'banner motd #SYSTEME PRIVE - ACCES RESTREINT#',
        'banner login #Authentification requise#',
        'banner exec #Bienvenue sur le NOC#', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | section banner');
      expect(bloc).toContain('SYSTEME PRIVE - ACCES RESTREINT');
      expect(bloc).toContain('Authentification requise');
      expect(bloc).toContain('Bienvenue sur le NOC');
    }, 30_000);

    it('`login block-for` est armé, et `show login` le DÉCRIT', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'login block-for 120 attempts 3 within 30',
        'login on-failure log', 'login on-success log', 'end',
      ]);
      const vue = await d.executeCommand('show login');
      expect(vue).toContain('enabled to watch for login Attacks');
      expect(vue).toContain('3 login failures occur in 30 seconds');
      expect(vue).toContain('120 seconds');
      expect(await d.executeCommand('show running-config | include login block-for'))
        .toContain('login block-for 120 attempts 3 within 30');
    }, 30_000);

    it('une ACL nommée est appliquée sur les vty par `access-class`', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal', 'ip access-list standard ADMIN_IPS',
        'permit 192.168.100.0 0.0.0.255', 'permit host 10.0.0.5', 'deny any log', 'exit',
        'line vty 0 4', 'access-class ADMIN_IPS in', 'exit', 'end',
      ]);
      expect(await d.executeCommand('show running-config | section line vty'))
        .toContain('access-class ADMIN_IPS in');
    }, 30_000);
  });

  describe(`${nom} — chapitres 10 et 11 : AAA et TACACS+`, () => {
    async function tacacs(): Promise<Machine> {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'username secours privilege 15 secret SecoursSuperSecret!',
        'tacacs server TACACS_PRIMAIRE',
        'address ipv4 192.168.100.10', 'key Secret2024', 'timeout 5', 'exit',
        'aaa group server tacacs+ GRP_TACACS',
        'server name TACACS_PRIMAIRE', 'exit',
        'aaa new-model',
        'aaa authentication login default group GRP_TACACS local',
        'aaa authorization exec default group GRP_TACACS local',
        'aaa accounting exec default start-stop group GRP_TACACS',
        'end',
      ]);
      return d;
    }

    it('toute la séquence est ACCEPTÉE — aucune commande ne tombe dans la résolution de nom', async () => {
      const d = await machine(fabrique);
      const sorties = await tape(d, [
        'configure terminal', 'aaa new-model',
        'tacacs server TAC1', 'address ipv4 10.0.0.9', 'key K', 'exit',
        'aaa group server tacacs+ G1', 'server name TAC1', 'exit',
        'aaa authentication login default group G1 local', 'end',
      ]);
      for (const s of sorties) {
        expect(s).not.toContain('% Invalid input');
        expect(s).not.toContain('Translating');
      }
    }, 30_000);

    it('`show tacacs` décrit le serveur déclaré', async () => {
      const d = await tacacs();
      const vue = await d.executeCommand('show tacacs');
      expect(vue).toContain('192.168.100.10');
      expect(vue).not.toContain('No TACACS+ servers configured');
    }, 30_000);

    it('`show aaa` suit `aaa new-model` au lieu de rester « disabled »', async () => {
      const d = await tacacs();
      expect(await d.executeCommand('show aaa')).toContain('Authentication: enabled');
    }, 30_000);

    it('la configuration REPRODUIT ce qui a été tapé — sinon tout est perdu à l\'import', async () => {
      const d = await tacacs();
      const cfg = await d.executeCommand('show running-config');
      for (const attendu of [
        'aaa new-model',
        'aaa authentication login default group GRP_TACACS local',
        'aaa authorization exec default group GRP_TACACS local',
        'aaa accounting exec default start-stop group GRP_TACACS',
        'aaa group server tacacs+ GRP_TACACS',
        'tacacs server TACACS_PRIMAIRE',
      ]) expect(cfg, attendu).toContain(attendu);
    }, 30_000);

    /**
     * La forme du tutoriel n'est pas celle d'IOS : la syntaxe réelle est
     * positionnelle (`test aaa group GRP utilisateur motdepasse
     * new-code`), vérifiée contre le command reference. Accepter la
     * forme à mots-clés apprendrait une commande que la machine réelle
     * refuse.
     */
    it('`test aaa group` refuse la forme à mots-clés et accepte la positionnelle', async () => {
      const d = await tacacs();
      expect(await d.executeCommand(
        'test aaa group GRP_TACACS username jb password x new-code'))
        .toContain('% Invalid input');
      expect(await d.executeCommand('test aaa group GRP_TACACS jb secret new-code'))
        .not.toContain('% Invalid input');
    }, 30_000);
  });

  describe(`${nom} — chapitre 12 : le cycle de vie`, () => {
    it('`clear line` distingue « ligne libre » de « votre propre ligne »', async () => {
      const d = await machine(fabrique);
      // Une vty libre : IOS demande confirmation et ne coupe rien.
      expect(await d.executeCommand('clear line vty 0')).toContain('[confirm]');
      expect(await d.executeCommand('clear line vty 0')).not.toContain('Not allowed');
      // La ligne d'où l'on parle est celle que le registre tient pour
      // courante, et c'est elle — et elle seule — qu'IOS refuse de couper.
      const registre = (d as unknown as {
        getSshSessionRegistry(): { open(i: Record<string, unknown>): { id: string } | null };
      }).getSshSessionRegistry();
      registre.open({ user: 'jean-baptiste', fromIp: '', transport: 'console' });
      expect(await d.executeCommand('clear line console 0'))
        .toContain('Not allowed to clear current line');
    }, 30_000);

    it('promotion : changer le niveau d\'un compte le change vraiment', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'username jean-baptiste privilege 7 secret JBPetnga@Sep2026!', 'end',
      ]);
      expect(await d.executeCommand('show running-config | include jean-baptiste'))
        .toContain('privilege 7');
      await tape(d, [
        'configure terminal', 'no username jean-baptiste',
        'username jean-baptiste privilege 10 secret JBAdmin@Dec2026!', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | include jean-baptiste');
      expect(bloc).toContain('privilege 10');
      expect(bloc).not.toContain('privilege 7');
    }, 30_000);

    it('déprovisionnement : le compte supprimé ne figure plus nulle part', async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'username jean-baptiste privilege 10 secret JB!', 'end', 'write memory',
      ]);
      await tape(d, ['configure terminal', 'no username jean-baptiste', 'end', 'write memory']);
      expect(await d.executeCommand('show running-config | include jean-baptiste')).toBe('');
      expect(await d.executeCommand('show startup-config')).not.toContain('jean-baptiste');
    }, 30_000);
  });
}

describe('un Catalyst n\'a pas de registre de configuration', () => {
  it('`config-register` est refusée, et `show version` ne se contredit pas', async () => {
    const sw = await machine(() => new CiscoSwitch('SW1'));
    await sw.executeCommand('configure terminal');
    expect(await sw.executeCommand('config-register 0x2142')).toContain('% Invalid input');
    await sw.executeCommand('end');
    const version = await sw.executeCommand('show version | include Configuration register');
    const boot = await sw.executeCommand('show boot');
    expect(version).toContain('0xF');
    // La contradiction d'avant : `show boot` annonçait un registre
    // réglable que `show version` démentait au même instant.
    expect(boot).not.toContain('Configuration register');
    expect(boot).toContain('Config file');
  }, 30_000);
});

/**
 * Chapitre 8 — les jetons d'une bannière.
 *
 * IOS substitue `$(hostname)`, `$(domain)`, `$(line)` et `$(line-desc)`
 * depuis la 12.0(3)T, vérifié contre la documentation de Cisco et non de
 * mémoire. Ils sortaient littéralement : une bannière écrite d'après
 * cette même documentation affichait `$(hostname)`.
 *
 * Les variables que le tutoriel emploie — `$USERNAME`, `$TIME` — ne sont
 * PAS des jetons IOS. Ne pas les remplacer est la fidélité, comme pour
 * `| head` et `show archive log config last N` : un vrai routeur les
 * affiche telles quelles.
 */
describe('les jetons de bannière sont ceux d\'IOS, et seulement ceux-là', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const touche = (k: string) =>
    ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });

  async function consoleAvecBanniere(texte: string): Promise<string> {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    for (const c of [
      'enable', 'configure terminal', 'hostname SW-BANQUE-01',
      'ip domain-name ma-banque.cm',
      'username jb privilege 15 secret JB',
      'line console 0', 'login local', 'exit',
      `banner exec #${texte}#`, 'end',
    ]) await d.executeCommand(c);

    const { CiscoTerminalSession } = await import('@/terminal/sessions');
    const s = new CiscoTerminalSession('t1', d as never);
    await s.init();
    for (let i = 0; i < 40 && s.isBooting; i++) await tick();
    await tick();
    s.setInputBuf('jb');
    s.handleKey(touche('Enter') as never);
    for (let i = 0; i < 20; i++) await tick();
    s.setPasswordBuf('JB');
    s.handleKey(touche('Enter') as never);
    for (let i = 0; i < 30; i++) await tick();
    return s.lines.map((l) => l.text).join('\n');
  }

  it('`$(hostname)` et `$(domain)` sont remplacés à l\'affichage', async () => {
    const vu = await consoleAvecBanniere('Bienvenue sur $(hostname).$(domain)');
    expect(vu).toContain('Bienvenue sur SW-BANQUE-01.ma-banque.cm');
    expect(vu).not.toContain('$(hostname)');
  }, 30_000);

  it('`$(line)` donne le numéro de ligne', async () => {
    const vu = await consoleAvecBanniere('Vous etes sur la ligne $(line)');
    expect(vu).toContain('Vous etes sur la ligne 0');
  }, 30_000);

  it('`$USERNAME` et `$TIME` restent littéraux — IOS ne les connaît pas', async () => {
    const vu = await consoleAvecBanniere('Bienvenue, $USERNAME, a $TIME');
    expect(vu).toContain('Bienvenue, $USERNAME, a $TIME');
  }, 30_000);
});

/**
 * Chapitre 10.3 — la séquence sûre d'activation d'AAA.
 *
 * `login authentication CONSOLE_LOCALE` sur `line console 0` est ce qui
 * garde la console sur la base LOCALE : sans elle, un serveur TACACS+
 * injoignable ferme la porte de l'équipement. Elle était acceptée,
 * comprise comme un `login` nu, et rendue nulle part — donc perdue au
 * rechargement de la topologie, ce qui est précisément le cas dangereux.
 */
describe('la ligne de secours d\'AAA survit à la configuration', () => {
  for (const [nom, fabrique] of PLATEFORMES) {
    it(`${nom} : \`login authentication <liste>\` est stockée ET rendue`, async () => {
      const d = await machine(fabrique);
      await tape(d, [
        'configure terminal',
        'username secours privilege 15 secret SecoursSuperSecret!',
        'aaa authentication login CONSOLE_LOCALE local',
        'aaa new-model',
        'line console 0', 'login authentication CONSOLE_LOCALE', 'exit', 'end',
      ]);
      const bloc = await d.executeCommand('show running-config | section line console');
      expect(bloc).toContain('login authentication CONSOLE_LOCALE');
      // La forme nue ne doit PAS être rendue à sa place : les deux
      // n'authentifient pas contre la même chose.
      expect(bloc.split('\n').map((l) => l.trim())).not.toContain('login');
    }, 30_000);
  }
});
