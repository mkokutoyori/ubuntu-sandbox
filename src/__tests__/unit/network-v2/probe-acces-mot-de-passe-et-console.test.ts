/**
 * Deux portes d'acces qui se fermaient sur l'operateur qui venait de les
 * poser. Signalees comme deux bugs, elles n'en font qu'un et demi : la
 * premiere est une famille entiere, la seconde une consequence d'un
 * comportement par ailleurs juste.
 *
 * 1. **Le mot de passe tape etait compare a la FORME STOCKEE.** Juste
 *    tant que cette forme est le texte en clair, faux des qu'elle ne
 *    l'est plus — et trois gestes tres ordinaires suffisent :
 *    `service password-encryption` (que tout cours fait taper juste
 *    apres avoir pose un mot de passe), une forme a condense collee
 *    depuis une configuration existante (`enable secret 5 $1$...`,
 *    `password 7 0822...`), et surtout **l'aller-retour d'une
 *    topologie** : `show running-config` REND le condense, c'est son
 *    role, et l'import rejoue cette configuration. Donc meme un secret
 *    pose en clair devient un condense a la premiere sauvegarde, et la
 *    machine rouverte refuse pour toujours le mot de passe que
 *    l'apprenant vient de choisir. Un condense se VERIFIE en recalculant
 *    avec le meme sel, un chiffre reversible se DECHIFFRE — c'est ce que
 *    fait `ciscoPasswordMatches`, et ce que faisait deja, seul dans tout
 *    le depot, `NetworkOsAccount.authenticate` cote Huawei.
 *
 * 2. **`exit` depuis `#` fermait l'onglet.** Terminer la session est le
 *    vrai comportement d'IOS et reste verifie par
 *    `cisco-exec-mode-transitions.test.ts` ; ce qui manquait est ce
 *    qu'une vraie machine fait ENSUITE, la console etant une ligne
 *    soudee et non une connexion : `<nom> con0 is now available` puis
 *    `Press RETURN to get started.`, et la ligne attend. Ici l'onglet
 *    disparaissait, donc `exit` coupait l'acces a la machine entiere.
 *    Formulation verifiee sur des transcriptions reelles.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { ciscoPasswordMatches } from '@/network/devices/shells/cisco/ciscoPasswordVerify';
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

const tick = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

type Machine = CiscoRouter | CiscoSwitch;
const PLATEFORMES: Array<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
  ['switch', () => new CiscoSwitch('SW1')],
];

async function sessionSur(d: Machine): Promise<CiscoTerminalSession> {
  const s = new CiscoTerminalSession('t1', d as never);
  await s.init();
  for (let i = 0; i < 40 && s.isBooting; i++) await tick();
  await tick();
  return s;
}

async function tape(s: CiscoTerminalSession, texte: string): Promise<void> {
  s.setInput(texte);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 25; i++) await tick();
}

async function tapeMotDePasse(s: CiscoTerminalSession, texte: string): Promise<void> {
  s.setPasswordBuf(texte);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 25; i++) await tick();
}

const vu = (s: CiscoTerminalSession) => s.lines.map((l) => l.text).join('\n');

// ── 1. La verification elle-meme ────────────────────────────────────

describe('ciscoPasswordMatches — un condense se recalcule, un chiffre se dechiffre', () => {
  it('type 7 : le chiffre stocke ouvre avec le clair', () => {
    // `encryptType7('Motdepasse1', 6)` — la forme que `service
    // password-encryption` produit.
    expect(ciscoPasswordMatches('Motdepasse1', '062B0035484B19181604175A', 'type-7')).toBe(true);
    expect(ciscoPasswordMatches('AutreChose', '062B0035484B19181604175A', 'type-7')).toBe(false);
  });

  it('type 5 : le condense md5crypt se verifie avec son propre sel', () => {
    const stocke = '$1$a38effcc$3fSShOKFha.TXFAu34YEB/';
    expect(ciscoPasswordMatches('MonSecret1', stocke, 'md5')).toBe(true);
    expect(ciscoPasswordMatches('MonSecret2', stocke, 'md5')).toBe(false);
  });

  it("l'etiquette ne decide pas a la place de la valeur", () => {
    // Un `$1$` range sous `enable secret 5` reste un `$1$`, mais un
    // `$9$` colle sous la meme commande doit etre lu pour ce qu'il est.
    const stocke = '$1$a38effcc$3fSShOKFha.TXFAu34YEB/';
    expect(ciscoPasswordMatches('MonSecret1', stocke, 'scrypt')).toBe(true);
  });

  it('le clair reste compare par egalite — ce depot le range ainsi', () => {
    expect(ciscoPasswordMatches('abc', 'abc', 'plain')).toBe(true);
    expect(ciscoPasswordMatches('abc', 'abd', 'plain')).toBe(false);
  });

  it('un condense malforme refuse au lieu de laisser passer', () => {
    expect(ciscoPasswordMatches('', '$1$$', 'md5')).toBe(false);
    expect(ciscoPasswordMatches('x', '', 'plain')).toBe(false);
  });
});

// ── 2. `enable` sur les deux plateformes ────────────────────────────

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — le bon mot de passe d'activation ouvre`, () => {
    /**
     * Le cas exactement signale : on pose un `enable password`, on tape
     * `service password-encryption` comme le cours le demande, et le mode
     * privilegie devient inatteignable.
     */
    it('`enable password` survit a `service password-encryption`', async () => {
      const d = fabrique();
      d.powerOn();
      for (const c of ['enable', 'configure terminal', 'enable password Motdepasse1',
        'service password-encryption', 'end', 'disable']) {
        await d.executeCommand(c);
      }
      const s = await sessionSur(d);
      await tape(s, 'enable');
      expect(s.currentInputMode.type).toBe('password');
      await tapeMotDePasse(s, 'Motdepasse1');
      expect(vu(s)).not.toContain('% Access denied');
      await tape(s, 'show privilege');
      expect(vu(s)).toContain('level is 15');
    }, 30_000);

    it('la forme collee `enable password 7 <chiffre>` ouvre avec son clair', async () => {
      const d = fabrique();
      d.powerOn();
      for (const c of ['enable', 'configure terminal',
        'enable password 7 062B0035484B19181604175A', 'end', 'disable']) {
        await d.executeCommand(c);
      }
      const s = await sessionSur(d);
      await tape(s, 'enable');
      await tapeMotDePasse(s, 'Motdepasse1');
      await tape(s, 'show privilege');
      expect(vu(s)).toContain('level is 15');
    }, 30_000);

    /**
     * Le cas le plus couteux, parce qu'il frappe une machine que
     * PERSONNE n'a mal configuree : il suffit de sauvegarder la
     * topologie et de la rouvrir.
     */
    it("le secret survit a l'aller-retour d'une configuration", async () => {
      const source = fabrique();
      source.powerOn();
      for (const c of ['enable', 'configure terminal', 'enable secret MonSecret1', 'end']) {
        await source.executeCommand(c);
      }
      const rendu = (await source.executeCommand('show running-config'))
        .split('\n').filter((l) => /^\s*enable /.test(l));
      // La configuration rendue porte bien le CONDENSE et non le clair —
      // sans quoi ce cas ne prouverait rien.
      expect(rendu.join('\n')).toContain('$1$');
      expect(rendu.join('\n')).not.toContain('MonSecret1');

      const rechargee = fabrique();
      rechargee.powerOn();
      await rechargee.executeCommand('enable');
      await rechargee.executeCommand('configure terminal');
      for (const l of rendu) await rechargee.executeCommand(l.trim());
      await rechargee.executeCommand('end');
      await rechargee.executeCommand('disable');

      const s = await sessionSur(rechargee);
      await tape(s, 'enable');
      await tapeMotDePasse(s, 'MonSecret1');
      expect(vu(s)).not.toContain('% Access denied');
      await tape(s, 'show privilege');
      expect(vu(s)).toContain('level is 15');
    }, 30_000);

    it('un mauvais mot de passe reste refuse — la porte n\'est pas ouverte a tous', async () => {
      const d = fabrique();
      d.powerOn();
      for (const c of ['enable', 'configure terminal', 'enable password Motdepasse1',
        'service password-encryption', 'end', 'disable']) {
        await d.executeCommand(c);
      }
      const s = await sessionSur(d);
      await tape(s, 'enable');
      await tapeMotDePasse(s, 'MauvaisMot');
      expect(vu(s)).toContain('% Access denied');
    }, 30_000);
  });
}

// ── 3. Le mot de passe de ligne ─────────────────────────────────────

describe('le mot de passe de ligne suit la meme regle', () => {
  it('`password 7 <chiffre>` sur une vty n\'est plus rechiffre par le rendu', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    for (const c of ['enable', 'configure terminal', 'line vty 0 4',
      'password 7 062B0035484B19181604175A', 'login', 'exit',
      'service password-encryption', 'end']) {
      await d.executeCommand(c);
    }
    const rc = await d.executeCommand('show running-config');
    // Le chiffre ressort TEL QUEL : un second passage produirait une
    // autre chaine, que plus personne ne saurait dechiffrer.
    expect(rc).toContain('password 7 062B0035484B19181604175A');
  }, 30_000);

  it('un mot de passe de ligne a plusieurs mots garde son premier mot', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    for (const c of ['enable', 'configure terminal', 'line vty 0 4',
      'password mon mot de passe', 'end']) {
      await d.executeCommand(c);
    }
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('password mon mot de passe');
  }, 30_000);

  it('la console demande le mot de passe et l\'accepte apres chiffrement', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    for (const c of ['enable', 'configure terminal', 'line console 0',
      'password Consolemdp1', 'login', 'exit', 'end']) {
      await d.executeCommand(c);
    }
    const s = await sessionSur(d);
    for (let i = 0; i < 20 && s.currentInputMode.type !== 'password'; i++) await tick();
    expect(s.currentInputMode.type).toBe('password');
    await tapeMotDePasse(s, 'Consolemdp1');
    await tape(s, 'show privilege');
    expect(vu(s)).toMatch(/level is 1$/m);
  }, 30_000);
});

// ── 4. `exit` depuis `#` : la console se libere, elle ne disparait pas ─

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — la console se repropose apres \`exit\``, () => {
    it('l\'onglet n\'est pas ferme, et la ligne s\'annonce disponible', async () => {
      const d = fabrique();
      d.powerOn();
      const s = await sessionSur(d);
      let ferme = false;
      s.onRequestClose(() => { ferme = true; });

      await tape(s, 'enable');
      await tape(s, 'exit');

      expect(ferme, 'l\'onglet ne doit pas se fermer').toBe(false);
      expect(vu(s)).toContain('con0 is now available');
      expect(vu(s)).toContain('Press RETURN to get started.');
    }, 30_000);

    it('RETURN rouvre une session — au niveau UTILISATEUR', async () => {
      const d = fabrique();
      d.powerOn();
      const s = await sessionSur(d);
      await tape(s, 'enable');
      await tape(s, 'exit');

      s.handleKey(key('Enter'));
      for (let i = 0; i < 20; i++) await tick();

      await tape(s, 'show privilege');
      // Le point qui compte : la session precedente etait au niveau 15 et
      // la nouvelle ne l'herite pas. Sans cela, `exit` rendrait les
      // droits d'administration a qui appuie sur une touche.
      //
      // L'assertion est ANCREE en fin de ligne : `level is 1` est un
      // prefixe de `level is 15`, donc la formulation courte passait des
      // deux cotes et ne prouvait rien — le meme piege que
      // `0% packet loss` dans `100% packet loss`.
      expect(vu(s)).toMatch(/level is 1$/m);
      expect(vu(s)).not.toMatch(/level is 15$/m);
    }, 30_000);

    it('une frappe autre que RETURN ne rouvre rien', async () => {
      const d = fabrique();
      d.powerOn();
      const s = await sessionSur(d);
      await tape(s, 'exit');
      s.handleKey(key('a'));
      await tick();
      expect(s.input).toBe('');
    }, 30_000);

    /**
     * La contrepartie : si la ligne console porte un `login`, la session
     * rouverte repasse par la porte. Sans ce cas, on aurait pu « corriger »
     * le bug en offrant une session gratuite juste apres avoir annonce
     * qu'on en fermait une.
     */
    it('avec un `login` sur la console, RETURN redemande le mot de passe', async () => {
      const d = fabrique();
      d.powerOn();
      for (const c of ['enable', 'configure terminal', 'line console 0',
        'password Consolemdp1', 'login', 'exit', 'end']) {
        await d.executeCommand(c);
      }
      const s = await sessionSur(d);
      for (let i = 0; i < 20 && s.currentInputMode.type !== 'password'; i++) await tick();
      await tapeMotDePasse(s, 'Consolemdp1');
      await tape(s, 'exit');
      expect(vu(s)).toContain('con0 is now available');

      s.handleKey(key('Enter'));
      for (let i = 0; i < 25; i++) await tick();
      expect(s.currentInputMode.type, `${nom} : la porte doit se reposer`).toBe('password');
    }, 30_000);
  });
}
