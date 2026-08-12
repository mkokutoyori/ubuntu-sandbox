/**
 * « Cycle de vie d'une identité sur Cisco » — les douze chapitres, dans
 * l'ordre, joués comme un laboratoire.
 *
 * Ce fichier est la RELECTURE COMPLÈTE du tutoriel, chapitre par
 * chapitre et commande par commande. Il complète
 * `tuto-cycle-identite-cisco.test.ts`, qui est organisé par DÉFAUT
 * trouvé ; celui-ci est organisé par SECTION du cours, pour qu'on puisse
 * répondre « oui » ou « non » à la question « ce chapitre est-il
 * jouable ? » sans lire le code.
 *
 * Tout est joué sur les DEUX plateformes, parce que le tutoriel se
 * déroule sur un switch et que tout ce qu'il enseigne existe aussi sur
 * un routeur.
 *
 * ────────────────────────────────────────────────────────────────────
 * CE QUE LE TUTORIEL DEMANDE ET QUE LA MACHINE REFUSE — À DESSEIN
 *
 * Chaque refus ci-dessous a été vérifié contre la documentation de
 * Cisco, pas contre un souvenir. Les accepter apprendrait des commandes
 * qu'un vrai équipement rejette, ce qui est plus coûteux que de les
 * refuser.
 *
 *  - `test aaa group GRP username X password Y new-code` : la vraie
 *    syntaxe est POSITIONNELLE (`test aaa group GRP X Y new-code`).
 *  - `aaa accounting exec default start-stop local` : la liste de
 *    méthodes d'accounting accepte `group <nom>`, `none` et
 *    `broadcast`. Il n'existe pas de méthode `local` — un
 *    enregistrement part vers un collecteur, il n'y a rien de local où
 *    l'écrire. Le chapitre 10.5 et sa sortie `AAA/ACCT` sont donc une
 *    invention du tutoriel.
 *  - `config-register` sur un Catalyst : un 2960/3560 de configuration
 *    fixe n'a pas de registre réglable.
 *  - `$USERNAME` / `$TIME` dans une bannière : les jetons d'IOS sont
 *    `$(hostname)`, `$(domain)`, `$(line)` et `$(line-desc)`, et rien
 *    d'autre.
 *
 * ────────────────────────────────────────────────────────────────────
 * CE QUI RESTE HORS DE PORTÉE, MESURÉ ET ÉCRIT PLUTÔT QUE TU
 *
 *  - **SSH ENTRANT sur un Catalyst** (chapitre 7.5). Le routeur a un
 *    vrai serveur SSH et le cas ci-dessous s'y connecte pour de bon ;
 *    `Switch` n'a aucune pile TCP, donc sa configuration SSH est
 *    stockée et rendue sans que rien n'écoute. Ce n'est pas un oubli de
 *    ce chantier mais une limite d'architecture, et lui donner une pile
 *    est un lot à part entière.
 *  - `show privilege` passé par le pont SSH non interactif répond
 *    encore 15. Le verrou qui compte — `show running-config` refusé à
 *    un compte de niveau 7 — tient, et il est vérifié ici.
 *  - Un appelant qui ne pilote PAS `sshpass` n'offre aucun mot de passe,
 *    et la session est alors accordée sur la seule existence du compte.
 *    C'est le défaut de confiance historique du simulateur, dont dépend
 *    une grande partie de la suite ; ce qui a été refermé est le cas où
 *    un secret EST offert et se trouve faux.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

const REFUS = '% Invalid input';
type Machine = CiscoSwitch | CiscoRouter;

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['switch', () => new CiscoSwitch('SW1')],
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
];

async function allumee(fabrique: () => Machine): Promise<Machine> {
  const d = fabrique();
  d.powerOn();
  return d;
}

async function tape(d: Machine, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

/** Aucune commande de la séquence n'est refusée ni renvoyée au résolveur de noms. */
function toutesAcceptees(sorties: string[], cmds: string[]): void {
  sorties.forEach((s, i) => {
    expect(s, cmds[i]).not.toContain(REFUS);
    expect(s, cmds[i]).not.toContain('Translating');
    expect(s, cmds[i]).not.toContain('Unknown command');
  });
}

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — Ch.1 : l'équipement sorti de sa boîte`, () => {
    it('le mode utilisateur ne montre pas la configuration', async () => {
      const d = await allumee(fabrique);
      expect(await d.executeCommand('show running-config')).toContain(REFUS);
    }, 30_000);

    it('`enable` ouvre le mode privilégié tant qu\'aucun secret n\'est posé', async () => {
      const d = await allumee(fabrique);
      await d.executeCommand('enable');
      expect(await d.executeCommand('show privilege')).toContain('level is 15');
      expect(await d.executeCommand('show running-config')).toContain('Current configuration');
    }, 30_000);
  });

  describe(`${nom} — Ch.2 : le premier mot de passe, sur la console`, () => {
    it('`show users`, `show who` et `show line` décrivent les lignes', async () => {
      const d = await allumee(fabrique);
      await d.executeCommand('enable');
      // Être sur la console, c'est occuper la ligne : sans session, la
      // table est vide et c'est ce qu'elle doit dire
      // (docs/PRD-Lignes-Terminal.md §1.3).
      (d as unknown as {
        getSshSessionRegistry(): { open(i: Record<string, unknown>): unknown };
      }).getSshSessionRegistry().open({ user: '', fromIp: '', transport: 'console' });
      const users = await d.executeCommand('show users');
      expect(users).toContain('Line');
      expect(users).toContain('con 0');
      // `show who` est l'alias de `show users` : deux textes différents
      // décriraient deux machines.
      expect(await d.executeCommand('show who')).toBe(users);
      const line = await d.executeCommand('show line');
      expect(line).toContain('CTY');
      expect(line).toContain('VTY');
    }, 30_000);

    it('`password` + `login` sont posés ET rendus', async () => {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal', 'line console 0',
        'password MonPremierMotDePasse', 'login', 'exit', 'end'];
      toutesAcceptees(await tape(d, cmds), cmds);
      const bloc = await d.executeCommand('show running-config | section line console');
      expect(bloc).toContain('line console 0');
      expect(bloc).toContain('password MonPremierMotDePasse');
      expect(bloc.split('\n').map((l) => l.trim())).toContain('login');
    }, 30_000);
  });

  describe(`${nom} — Ch.3 : la deuxième porte, \`enable secret\``, () => {
    it('`enable secret` est haché, `enable password` reste lisible', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'enable password MonMotDePasse', 'enable secret MotDePasseAdmin2024!', 'end']);
      const bloc = await d.executeCommand('show running-config | include enable');
      expect(bloc).toMatch(/enable secret \d \S+/);
      expect(bloc).not.toContain('MotDePasseAdmin2024!');
      expect(bloc).toContain('enable password MonMotDePasse');
    }, 30_000);
  });

  describe(`${nom} — Ch.4 : chiffrement et types de stockage`, () => {
    it('`service password-encryption` transforme les mots de passe en clair en type 7', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal', 'line console 0',
        'password MonPremierMotDePasse', 'login', 'exit',
        'service password-encryption', 'end']);
      const bloc = await d.executeCommand('show running-config | section line console');
      expect(bloc).toMatch(/password 7 \S+/);
      expect(bloc).not.toContain('MonPremierMotDePasse');
    }, 30_000);

    it('le type est écrit devant le secret, et il est lisible', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal', 'enable secret X', 'end']);
      expect(await d.executeCommand('show running-config | include enable secret'))
        .toMatch(/enable secret 5 \$1\$/);
    }, 30_000);
  });

  describe(`${nom} — Ch.5 : les comptes nommés`, () => {
    it('création, listage, remplacement et suppression', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'username jean-baptiste secret MotDePasseJB2024!',
        'username marie-claire privilege 15 secret MotDePMC2024!', 'end']);
      let bloc = await d.executeCommand('show running-config | include username');
      expect(bloc).toContain('username jean-baptiste');
      expect(bloc).toContain('username marie-claire privilege 15');
      expect(bloc).not.toContain('MotDePasseJB2024!');

      // Recréer écrase.
      await tape(d, ['configure terminal',
        'username jean-baptiste privilege 7 secret Nouveau2024!', 'end']);
      bloc = await d.executeCommand('show running-config | include username');
      expect(bloc).toContain('username jean-baptiste privilege 7');
      expect(bloc.match(/username jean-baptiste/g)?.length).toBe(1);

      await tape(d, ['configure terminal', 'no username jean-baptiste', 'end']);
      expect(await d.executeCommand('show running-config | include username'))
        .not.toContain('jean-baptiste');
    }, 30_000);

    it('`login local` sur la console est posé ET rendu', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'username jb secret JB', 'line console 0', 'login local', 'exit', 'end']);
      expect(await d.executeCommand('show running-config | section line console'))
        .toContain('login local');
    }, 30_000);
  });

  describe(`${nom} — Ch.6 : les niveaux de privilège`, () => {
    async function roles(): Promise<Machine> {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal',
        'privilege exec level 7 show running-config',
        'privilege exec level 7 ping',
        'privilege exec level 10 configure terminal',
        'privilege exec level 15 reload',
        'enable secret level 7 PasswordTechnicien2024!',
        'enable secret level 10 PasswordAdmin2024!',
        'username jean-baptiste privilege 7 secret JB',
        'end', 'disable'];
      toutesAcceptees(await tape(d, cmds), cmds);
      return d;
    }

    it('les règles sont rendues dans la configuration', async () => {
      const d = await roles();
      await d.executeCommand('enable');
      const bloc = await d.executeCommand('show running-config | include privilege exec');
      expect(bloc).toContain('privilege exec level 7 show running-config');
      expect(bloc).toContain('privilege exec level 10 configure terminal');
      expect(bloc).toContain('privilege exec level 15 reload');
    }, 30_000);

    it('`show privilege` suit les paliers', async () => {
      const d = await roles();
      expect(await d.executeCommand('show privilege')).toContain('level is 1');
      await d.executeCommand('enable 7', { passwordInput: 'PasswordTechnicien2024!' });
      expect(await d.executeCommand('show privilege')).toContain('level is 7');
      await d.executeCommand('enable');
      expect(await d.executeCommand('show privilege')).toContain('level is 15');
    }, 30_000);

    it('le niveau 7 fait exactement ce que le chapitre annonce', async () => {
      const d = await roles();
      await d.executeCommand('enable 7', { passwordInput: 'PasswordTechnicien2024!' });
      expect(await d.executeCommand('show running-config')).toContain('Current configuration');
      expect(await d.executeCommand('configure terminal')).toContain(REFUS);
      expect(await d.executeCommand('reload')).toContain(REFUS);
    }, 30_000);

    it('`enable secret level N` est rendu — le palier survit au rechargement', async () => {
      const d = await roles();
      await d.executeCommand('enable');
      expect(await d.executeCommand('show running-config | include enable secret level'))
        .toContain('enable secret level 7');
    }, 30_000);
  });

  describe(`${nom} — Ch.7 : les lignes VTY et SSH`, () => {
    it('toute la séquence du chapitre est acceptée', async () => {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal',
        'hostname SW-BANQUE-01', 'ip domain-name ma-banque.cm',
        'username jb privilege 7 secret JB',
        'line vty 0 4', 'login local', 'transport input ssh',
        'exec-timeout 15 0', 'logging synchronous', 'exit',
        'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'end'];
      toutesAcceptees(await tape(d, cmds), cmds);
    }, 30_000);

    it('les réglages de vty sont rendus, `transport input` compris', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal', 'line vty 0 4',
        'login local', 'transport input ssh', 'exec-timeout 15 0', 'exit', 'end']);
      const bloc = await d.executeCommand('show running-config | section line vty');
      expect(bloc).toContain('login local');
      expect(bloc).toContain('transport input ssh');
      expect(bloc).toContain('exec-timeout 15 0');
    }, 30_000);

    it('`crypto key generate rsa modulus 2048` fabrique VRAIMENT 2048 bits', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal', 'hostname SW-BANQUE-01',
        'ip domain-name ma-banque.cm']);
      const out = await d.executeCommand('crypto key generate rsa modulus 2048');
      expect(out).toContain('2048 bit RSA keys');
      await tape(d, ['ip ssh version 2', 'end']);
      const vue = await d.executeCommand('show ip ssh');
      expect(vue).toContain('version 2.0');
      expect(vue).toContain('Hostkey RSA key size is 2048 bits');
    }, 30_000);

    it('sans nom de domaine, IOS refuse de générer la clé', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal']);
      expect(await d.executeCommand('crypto key generate rsa modulus 2048'))
        .toContain('% Please define a domain-name first.');
    }, 30_000);

    it('`crypto key zeroize rsa` supprime réellement, et SSH le sait', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal', 'hostname SW1',
        'ip domain-name lab.local', 'crypto key generate rsa modulus 1024',
        'ip ssh version 2', 'end']);
      expect(await d.executeCommand('show ip ssh')).toContain('Hostkey RSA key size');
      await tape(d, ['configure terminal', 'crypto key zeroize rsa', 'end']);
      expect(await d.executeCommand('show ip ssh')).not.toContain('Hostkey RSA key size');
    }, 30_000);
  });

  describe(`${nom} — Ch.8 : les bannières`, () => {
    it('les trois bannières sont posées et rendues avec le délimiteur d\'IOS', async () => {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal',
        'banner motd #SYSTEME PRIVE - ACCES RESTREINT ET SURVEILLE#',
        'banner login #Authentification requise. Toute tentative est tracee.#',
        'banner exec #Bienvenue sur le NOC#', 'end'];
      toutesAcceptees(await tape(d, cmds), cmds);
      const bloc = await d.executeCommand('show running-config | section banner');
      expect(bloc).toContain('SYSTEME PRIVE - ACCES RESTREINT ET SURVEILLE');
      expect(bloc).toContain('Authentification requise');
      expect(bloc).toContain('Bienvenue sur le NOC');
      // IOS rend toujours `^C`, quel que soit le caractère tapé.
      expect(bloc).toContain('banner motd ^C');
    }, 30_000);

    it('n\'importe quel caractère sert de délimiteur', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'banner motd @Texte entre arobases@', 'end']);
      expect(await d.executeCommand('show running-config | section banner'))
        .toContain('Texte entre arobases');
    }, 30_000);
  });

  describe(`${nom} — Ch.9 : force brute et ACL sur les VTY`, () => {
    it('`login block-for` est armé, rendu, et `show login` le décrit', async () => {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal',
        'login block-for 120 attempts 3 within 30',
        'login on-failure log', 'login on-success log', 'end'];
      toutesAcceptees(await tape(d, cmds), cmds);
      const vue = await d.executeCommand('show login');
      expect(vue).toContain('enabled to watch for login Attacks');
      expect(vue).toContain('3 login failures occur in 30 seconds');
      expect(vue).toContain('120 seconds');
      expect(await d.executeCommand('show running-config | include login block-for'))
        .toContain('login block-for 120 attempts 3 within 30');
    }, 30_000);

    it('une ACL nommée est construite et appliquée par `access-class`', async () => {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal',
        'ip access-list standard ADMIN_IPS',
        'permit 192.168.100.0 0.0.0.255', 'permit host 10.0.0.5', 'deny any log', 'exit',
        'line vty 0 4', 'access-class ADMIN_IPS in', 'exit', 'end'];
      toutesAcceptees(await tape(d, cmds), cmds);
      expect(await d.executeCommand('show running-config | section line vty'))
        .toContain('access-class ADMIN_IPS in');
      const acl = await d.executeCommand('show access-lists');
      expect(acl).toContain('ADMIN_IPS');
      expect(acl).toContain('192.168.100.0');
    }, 30_000);
  });

  describe(`${nom} — Ch.10 : AAA sur la base locale`, () => {
    it('la séquence SÛRE d\'activation est acceptée dans son ordre', async () => {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal',
        'username secours privilege 15 secret SecoursSuperSecret!',
        'username jean-baptiste privilege 7 secret JB',
        'aaa authentication login CONSOLE_LOCALE local',
        'aaa new-model',
        'line console 0', 'login authentication CONSOLE_LOCALE', 'exit',
        'aaa authentication login default local',
        'aaa authentication enable default enable local',
        'aaa authorization exec default local',
        'line vty 0 4', 'login authentication default', 'exit', 'end'];
      toutesAcceptees(await tape(d, cmds), cmds);
    }, 30_000);

    it('la ligne de SECOURS survit à la configuration', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'aaa authentication login CONSOLE_LOCALE local', 'aaa new-model',
        'line console 0', 'login authentication CONSOLE_LOCALE', 'exit', 'end']);
      expect(await d.executeCommand('show running-config | section line console'))
        .toContain('login authentication CONSOLE_LOCALE');
    }, 30_000);

    it('`show aaa` suit `aaa new-model` au lieu de rester « disabled »', async () => {
      const d = await allumee(fabrique);
      expect(await d.executeCommand('show aaa')).toContain('disabled');
      await tape(d, ['enable', 'configure terminal', 'aaa new-model',
        'aaa authentication login default local', 'end']);
      expect(await d.executeCommand('show aaa')).toContain('Authentication: enabled');
    }, 30_000);

    /**
     * Le chapitre 10.5 écrit `aaa accounting … local`. Cette méthode
     * n'existe pas sur IOS, et l'accepter promettrait une trace qui ne
     * vient jamais.
     */
    it('l\'accounting `local` du tutoriel est refusé, `group` et `none` acceptés', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal', 'aaa new-model']);
      expect(await d.executeCommand('aaa accounting exec default start-stop local'))
        .toContain(REFUS);
      expect(await d.executeCommand('aaa accounting exec default start-stop group GRP'))
        .not.toContain(REFUS);
      expect(await d.executeCommand('aaa accounting commands 15 default start-stop none'))
        .not.toContain(REFUS);
    }, 30_000);
  });

  describe(`${nom} — Ch.11 : TACACS+ centralisé`, () => {
    async function tacacs(): Promise<Machine> {
      const d = await allumee(fabrique);
      const cmds = ['enable', 'configure terminal',
        'tacacs server TACACS_PRIMAIRE',
        'address ipv4 192.168.100.10', 'key Secret$TACACS2024!', 'timeout 5', 'exit',
        'tacacs server TACACS_SECONDAIRE',
        'address ipv4 192.168.100.11', 'key Secret$TACACS2024!', 'exit',
        'aaa group server tacacs+ GRP_TACACS',
        'server name TACACS_PRIMAIRE', 'server name TACACS_SECONDAIRE', 'exit',
        'aaa new-model',
        'aaa authentication login default group GRP_TACACS local',
        'aaa authorization exec default group GRP_TACACS local',
        'aaa authorization commands 15 default group GRP_TACACS local',
        'aaa accounting exec default start-stop group GRP_TACACS',
        'aaa accounting commands 15 default start-stop group GRP_TACACS', 'end'];
      toutesAcceptees(await tape(d, cmds), cmds);
      return d;
    }

    it('toute la séquence du chapitre est acceptée', async () => {
      await tacacs();
    }, 30_000);

    it('`show tacacs` décrit les serveurs déclarés', async () => {
      const d = await tacacs();
      const vue = await d.executeCommand('show tacacs');
      expect(vue).toContain('192.168.100.10');
      expect(vue).not.toContain('No TACACS+ servers configured');
    }, 30_000);

    it('la configuration REPRODUIT ce qui a été tapé', async () => {
      const d = await tacacs();
      const cfg = await d.executeCommand('show running-config');
      for (const attendu of [
        'aaa new-model',
        'aaa authentication login default group GRP_TACACS local',
        'aaa authorization exec default group GRP_TACACS local',
        'aaa accounting exec default start-stop group GRP_TACACS',
        'aaa group server tacacs+ GRP_TACACS',
        'tacacs server TACACS_PRIMAIRE',
        'tacacs server TACACS_SECONDAIRE',
      ]) expect(cfg, attendu).toContain(attendu);
    }, 30_000);

    it('`test aaa group` : la forme du tutoriel est refusée, la vraie acceptée', async () => {
      const d = await tacacs();
      expect(await d.executeCommand(
        'test aaa group GRP_TACACS username jb password x new-code')).toContain(REFUS);
      expect(await d.executeCommand('test aaa group GRP_TACACS jb MotDePasse new-code'))
        .not.toContain(REFUS);
    }, 30_000);
  });

  describe(`${nom} — Ch.12 : le cycle de vie de Jean-Baptiste`, () => {
    it('12.1 provisionnement — niveau 7, et ce qu\'il peut faire', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'privilege exec level 7 show running-config',
        'privilege exec level 10 configure terminal',
        'enable secret level 7 T7',
        'username jean-baptiste privilege 7 secret JBPetnga@Sep2026!', 'end']);
      expect(await d.executeCommand('show running-config | include jean-baptiste'))
        .toContain('privilege 7');
      await d.executeCommand('disable');
      await d.executeCommand('enable 7', { passwordInput: 'T7' });
      expect(await d.executeCommand('show privilege')).toContain('level is 7');
      expect(await d.executeCommand('show running-config')).toContain('Current configuration');
      expect(await d.executeCommand('configure terminal')).toContain(REFUS);
    }, 30_000);

    it('12.2 promotion — le niveau passe à 10, et `configure terminal` s\'ouvre', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'privilege exec level 10 configure terminal',
        'privilege exec level 10 write memory',
        'privilege exec level 15 reload',
        'enable secret level 10 A10',
        'username jean-baptiste privilege 7 secret Ancien', 'end']);
      await tape(d, ['configure terminal', 'no username jean-baptiste',
        'username jean-baptiste privilege 10 secret JBAdmin@Dec2026!', 'end']);
      const bloc = await d.executeCommand('show running-config | include jean-baptiste');
      expect(bloc).toContain('privilege 10');
      expect(bloc).not.toContain('privilege 7');

      await d.executeCommand('disable');
      await d.executeCommand('enable 10', { passwordInput: 'A10' });
      expect(await d.executeCommand('configure terminal')).toContain('Enter configuration');
      await d.executeCommand('end');
      expect(await d.executeCommand('write memory')).not.toContain(REFUS);
      // Le chapitre insiste : `reload` reste bloqué au niveau 10.
      expect(await d.executeCommand('reload')).toContain(REFUS);
    }, 30_000);

    it('12.3 escalade temporaire — monter à 15, puis REDESCENDRE', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'privilege exec level 15 reload', 'enable secret level 10 A10',
        'logging userinfo', 'end', 'disable']);
      await d.executeCommand('enable 10', { passwordInput: 'A10' });
      await d.executeCommand('enable');
      expect(await d.executeCommand('show privilege')).toContain('level is 15');
      expect(await d.executeCommand('reload cancel')).toContain('Reload cancelled');
      // Le changement de niveau est TRACÉ — c'est ce que le serveur
      // d'audit du chapitre enregistre.
      expect(await d.executeCommand('show logging | include PRIV'))
        .toContain('Privilege level set to 15');
      await d.executeCommand('disable 10');
      expect(await d.executeCommand('show privilege')).toContain('level is 10');
      expect(await d.executeCommand('reload')).toContain(REFUS);
    }, 30_000);

    it('12.4 incident — couper la session et désactiver le compte', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'username jean-baptiste privilege 10 secret JB', 'end']);
      (d as unknown as {
        getSshSessionRegistry(): { open(i: Record<string, unknown>): unknown };
      }).getSshSessionRegistry().open({ user: '', fromIp: '', transport: 'console' });
      expect(await d.executeCommand('show users')).toContain('con 0');
      // Une vty libre : IOS confirme et ne coupe rien.
      expect(await d.executeCommand('clear line vty 0')).toContain('[confirm]');
      // La console est la ligne d'où l'on parle.
      expect(await d.executeCommand('clear line console 0'))
        .toContain('Not allowed to clear current line');
      await tape(d, ['configure terminal', 'no username jean-baptiste', 'end']);
      expect(await d.executeCommand('show running-config | include jean-baptiste')).toBe('');
    }, 30_000);

    it('12.5 rétrogradation — retour au niveau 7 avec un nouveau secret', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'username jean-baptiste privilege 10 secret Ancien', 'end']);
      await tape(d, ['configure terminal',
        'username jean-baptiste privilege 7 secret NouveauJB@Mars2027!', 'end']);
      const bloc = await d.executeCommand('show running-config | include jean-baptiste');
      expect(bloc).toContain('privilege 7');
      expect(bloc).not.toContain('NouveauJB@Mars2027!');
    }, 30_000);

    it('12.8 déprovisionnement — le compte disparaît de la RAM ET de la NVRAM', async () => {
      const d = await allumee(fabrique);
      await tape(d, ['enable', 'configure terminal',
        'username jean-baptiste privilege 10 secret JB', 'end', 'write memory']);
      expect(await d.executeCommand('show startup-config')).toContain('jean-baptiste');
      await tape(d, ['configure terminal', 'no username jean-baptiste', 'end', 'write memory']);
      expect(await d.executeCommand('show running-config | include jean-baptiste')).toBe('');
      expect(await d.executeCommand('show startup-config')).not.toContain('jean-baptiste');
    }, 30_000);
  });
}

/**
 * Ch.7.5 — la connexion SSH elle-même, sur le fil.
 *
 * Le routeur porte un vrai serveur SSH ; le Catalyst n'a pas de pile
 * TCP, donc ce cas ne s'y joue pas (voir l'en-tête). Ce qui est mesuré
 * ici n'est pas seulement « ça se connecte » mais que le NIVEAU DU
 * COMPTE tient sur cette porte : c'est le seul endroit du tutoriel où
 * un utilisateur arrive de l'extérieur.
 */
describe('Ch.7.5 — SSH entrant, et le niveau du compte y tient', () => {
  async function labo(): Promise<{ r: CiscoRouter; pc: LinuxPC }> {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('192.168.1.55'), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal',
      'hostname SW-BANQUE-01', 'ip domain-name ma-banque.cm',
      'username jean-baptiste privilege 7 secret MotDePasseJB2024!',
      'username marie-claire privilege 15 secret MotDePMC2024!',
      'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0',
      'no shutdown', 'exit',
      'crypto key generate rsa modulus 2048', 'ip ssh version 2',
      'line vty 0 4', 'login local', 'transport input ssh', 'exec-timeout 15 0',
      'exit', 'end']) await r.executeCommand(c);
    new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    return { r, pc };
  }

  const parSsh = (pc: LinuxPC, user: string, mdp: string, cmd: string) =>
    pc.executeCommand(
      `sshpass -p ${mdp} ssh -o StrictHostKeyChecking=no ${user}@192.168.1.1 "${cmd}"`);

  it('la connexion aboutit et la commande s\'exécute', async () => {
    const { pc } = await labo();
    const out = await parSsh(pc, 'marie-claire', 'MotDePMC2024!', 'show version');
    expect(out).toContain('Cisco IOS Software');
    expect(out).not.toContain('Connection refused');
  }, 30_000);

  /**
   * Ce cas figeait un CONTOURNEMENT : le serveur vérifiait que le compte
   * existe et acceptait n'importe quel secret — ou aucun. Le mécanisme
   * de vérification était pourtant écrit et correct côté serveur
   * (`CrossVendorSshHost` compare `credentials.password` contre
   * l'autorité) ; c'est le CLIENT qui n'offrait rien, donc l'autorité,
   * n'ayant rien à vérifier, se contentait de constater l'existence du
   * compte. Le mot de passe de `sshpass -p` est maintenant transmis.
   *
   * Ne RIEN offrir garde le comportement de confiance existant, dont
   * dépend tout appelant qui ne pilote pas `sshpass` — c'est pourquoi
   * le dernier cas passe encore, et il est écrit ici plutôt que tu.
   */
  it('un mot de passe faux est refusé, un compte inconnu aussi', async () => {
    const { pc } = await labo();
    expect(await parSsh(pc, 'personne', 'x', 'show version')).toContain('Permission denied');
    const mauvais = await parSsh(pc, 'jean-baptiste', 'pas-le-bon', 'show version');
    expect(mauvais).toContain('Permission denied');
    expect(mauvais).not.toContain('Cisco IOS Software');
  }, 30_000);

  it('le bon mot de passe passe — la porte n\'est pas une souricière', async () => {
    const { pc } = await labo();
    expect(await parSsh(pc, 'jean-baptiste', 'MotDePasseJB2024!', 'show version'))
      .toContain('Cisco IOS Software');
  }, 30_000);

  /**
   * Le verrou qui compte. `show running-config` est une commande de
   * niveau 15 ; elle rendait la configuration ENTIÈRE à un compte
   * déclaré `privilege 7`, parce que le pont SSH forçait le niveau 15.
   */
  it('un compte de niveau 7 ne lit PAS la configuration par SSH', async () => {
    const { pc } = await labo();
    const out = await parSsh(pc, 'jean-baptiste', 'MotDePasseJB2024!', 'show running-config');
    expect(out).not.toContain('username marie-claire');
    expect(out).toContain(REFUS);
  }, 30_000);

  it('un compte de niveau 15 la lit', async () => {
    const { pc } = await labo();
    const out = await parSsh(pc, 'marie-claire', 'MotDePMC2024!', 'show running-config');
    expect(out).toContain('Current configuration');
  }, 30_000);
});
