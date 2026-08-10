/**
 * Les trois points que `PRD-Sessions-Cisco.md` laissait ouverts, avec ce
 * que la mesure a trouve sur chacun — et l'un des trois n'etait pas ce
 * que j'avais annonce.
 *
 * 1. **Le journal de session.** J'avais ecrit que les messages
 *    « n'existent nulle part ». C'etait faux pour la moitie et pire pour
 *    l'autre : `%SEC_LOGIN-5-LOGIN_SUCCESS` et
 *    `%SEC_LOGIN-4-LOGIN_FAILED` EXISTAIENT, mais emis
 *    INCONDITIONNELLEMENT — alors qu'un vrai IOS ne les produit QUE si
 *    l'operateur a tape `login on-success log` / `login on-failure log`,
 *    commandes introduites en 12.3 pour cela. Les deux drapeaux
 *    existaient, etaient rendus dans la configuration, et n'etaient LUS
 *    par personne. La machine journalisait donc ce qu'une vraie tait, et
 *    la commande qui gouverne la trace ne gouvernait rien. Leur
 *    formulation etait fausse aussi (`[localport:]` absent, `Login
 *    Failed` au lieu de `Login failed`, motif entre parentheses au lieu
 *    de `[Reason: ...]`). **`%SYS-6-LOGOUT`, lui, n'existait vraiment
 *    nulle part** — c'est la moitie « fermeture » de « qui s'est
 *    connecte, quand, depuis ou ».
 *
 * 2. **L'epuisement des VTY** fonctionnait deja : la capacite vient de
 *    la plage `line vty` configuree (`lineCapacity`) et `hasFreeLine`
 *    garde l'admission. Ces cas le PINCENT plutot que le corrigent, et
 *    le fichier le dit au lieu de laisser croire a une correction.
 *
 * 3. **`show ssh` avait DEUX implementations**, donc deux reponses a une
 *    question : celle du socle rendait un en-tete et une phrase
 *    CONSTANTS (elle ne lisait aucun registre, donc ne pouvait annoncer
 *    aucune session, jamais), celle du routeur lisait le vrai registre
 *    mais ecrivait sa phrase SANS le `%`. Il n'en reste qu'une.
 *
 * Formulations relevees sur des transcriptions reelles :
 *   %SEC_LOGIN-5-LOGIN_SUCCESS: Login Success [user: X] [Source: Y] [localport: 22]
 *   %SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: X] [Source: Y] [localport: 22] [Reason: Z]
 *   %SYS-6-LOGOUT: User X has exited tty session N(Y)
 * Les supports de cours ajoutent souvent a la derniere un motif et une
 * duree (« with timeout after 00:15:00 ») qu'aucune vraie machine
 * n'ecrit sur cette ligne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

interface Store {
  recordLoginSuccess?: (n: string, f: string, m: string) => void;
  recordLoginFailure?: (n: string, f: string, r: string) => void;
}
interface Registre {
  list(): readonly { id: string; lineIndex: number; user: string }[];
  open(i: Record<string, unknown>): unknown;
  close(id: string, reason?: string): void;
  hasFreeLine(): boolean;
}
const store = (d: CiscoRouter): Store =>
  (d as unknown as { getCredentialStore(): Store }).getCredentialStore();
const registre = (d: CiscoRouter): Registre =>
  (d as unknown as { getSshSessionRegistry(): Registre }).getSshSessionRegistry();

async function routeur(...cfg: string[]): Promise<CiscoRouter> {
  const d = new CiscoRouter('R1', 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  if (cfg.length > 0) {
    await d.executeCommand('configure terminal');
    for (const c of cfg) await d.executeCommand(c);
    await d.executeCommand('end');
  }
  return d;
}
const journal = async (d: CiscoRouter): Promise<string> =>
  (await d.executeCommand('show logging')).split('Log Buffer')[1] ?? '';

// ── 1. Le journal de session ────────────────────────────────────────

describe('journal de session — la commande qui gouverne la trace gouverne', () => {
  it('SANS `login on-success log`, une connexion reussie ne journalise RIEN', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    store(d).recordLoginSuccess?.('admin', '192.168.1.55', 'password');
    expect(await journal(d)).not.toContain('LOGIN_SUCCESS');
  }, 30_000);

  it('SANS `login on-failure log`, un echec ne journalise RIEN', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    store(d).recordLoginFailure?.('attaquant', '45.123.67.89', 'Invalid login');
    expect(await journal(d)).not.toContain('LOGIN_FAILED');
  }, 30_000);

  it('AVEC `login on-success log`, le message parait — et dans les mots d\'IOS', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025', 'login on-success log');
    store(d).recordLoginSuccess?.('admin', '192.168.1.55', 'password');
    const j = await journal(d);
    expect(j).toContain('%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success'
      + ' [user: admin] [Source: 192.168.1.55] [localport: 22]');
  }, 30_000);

  it('AVEC `login on-failure log`, l\'echec porte son motif entre CROCHETS', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025', 'login on-failure log');
    store(d).recordLoginFailure?.('attaquant', '45.123.67.89', 'Invalid login');
    const j = await journal(d);
    // `Login failed` en minuscule, et `[Reason: ...]` — pas `(...)`.
    expect(j).toContain('%SEC_LOGIN-4-LOGIN_FAILED: Login failed'
      + ' [user: attaquant] [Source: 45.123.67.89] [localport: 22] [Reason: Invalid login]');
  }, 30_000);

  /**
   * Les deux commandes sont INDEPENDANTES : n'armer que les echecs ne
   * doit pas faire paraitre les reussites. Sans ce cas, un unique
   * drapeau lu pour les deux passerait inapercu.
   */
  it('les deux drapeaux sont independants', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025', 'login on-failure log');
    store(d).recordLoginSuccess?.('admin', '192.168.1.55', 'password');
    store(d).recordLoginFailure?.('attaquant', '45.123.67.89', 'Invalid login');
    const j = await journal(d);
    expect(j).not.toContain('LOGIN_SUCCESS');
    expect(j).toContain('LOGIN_FAILED');
  }, 30_000);

  it('`%SYS-6-LOGOUT` dit QUI est parti et depuis quelle ligne', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025', 'login on-success log');
    store(d).recordLoginSuccess?.('admin', '192.168.1.55', 'password');
    const s = registre(d).list()[0];
    expect(s, 'la connexion doit avoir ouvert une ligne').toBeTruthy();
    registre(d).close(s.id, 'exit');
    const j = await journal(d);
    expect(j).toContain(`%SYS-6-LOGOUT: User admin has exited tty session ${s.lineIndex}(192.168.1.55)`);
  }, 30_000);

  /**
   * `%SYS-6-LOGOUT` n'est PAS gouverne par `login on-success log` : ce
   * sont deux mecanismes distincts sur une vraie machine, et lier la
   * fermeture au drapeau d'ouverture ferait disparaitre la moitie de la
   * piste d'audit sans que rien ne le dise.
   */
  it('la deconnexion se journalise meme sans `login on-success log`', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    store(d).recordLoginSuccess?.('admin', '192.168.1.55', 'password');
    const s = registre(d).list()[0];
    registre(d).close(s.id, 'exit');
    const j = await journal(d);
    expect(j).not.toContain('LOGIN_SUCCESS');
    expect(j).toContain('%SYS-6-LOGOUT: User admin has exited tty session');
  }, 30_000);

  it('les deux commandes sont rendues dans la configuration', async () => {
    const d = await routeur('login on-success log', 'login on-failure log');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('login on-success log');
    expect(rc).toContain('login on-failure log');
  }, 30_000);

  it('`show logging | include LOGIN_SUCCESS` isole les connexions (§9.3)', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025', 'login on-success log');
    store(d).recordLoginSuccess?.('admin', '192.168.1.55', 'password');
    const filtre = await d.executeCommand('show logging | include LOGIN_SUCCESS');
    expect(filtre).toContain('LOGIN_SUCCESS');
    expect(filtre).not.toContain('CONFIG_I');
  }, 30_000);
});

// ── 2. L'epuisement des VTY ─────────────────────────────────────────

/**
 * Ces cas PINCENT un mecanisme qui fonctionnait deja — la capacite vient
 * de la plage `line vty` configuree et `hasFreeLine` garde l'admission.
 * Ils ne corrigent rien, et le dire vaut mieux que de les presenter
 * comme une correction.
 */
describe('epuisement des VTY — le mecanisme existait, il est pince', () => {
  it('la capacite est celle de la plage configuree, pas un nombre fixe', async () => {
    const d = await routeur();
    const r = registre(d);
    let ouvertes = 0;
    for (let i = 0; i < 12; i++) {
      if (r.open({ user: `u${i}`, fromIp: `10.0.0.${i}`, localPort: 22, peerPort: 5000 + i })) ouvertes += 1;
    }
    expect(ouvertes, 'line vty 0 4 = 5 lignes').toBe(5);
    expect(r.hasFreeLine()).toBe(false);
  }, 30_000);

  it('`line vty 5 15` ouvre vraiment onze lignes de plus', async () => {
    const d = await routeur('line vty 5 15');
    const r = registre(d);
    let ouvertes = 0;
    for (let i = 0; i < 30; i++) {
      if (r.open({ user: `u${i}`, fromIp: `10.0.0.${i}`, localPort: 22, peerPort: 5000 + i })) ouvertes += 1;
    }
    expect(ouvertes).toBe(16);
  }, 30_000);

  it('scenario 1 — `clear line` libere, et une connexion repasse', async () => {
    const d = await routeur();
    const r = registre(d);
    for (let i = 0; i < 5; i++) {
      r.open({ user: `u${i}`, fromIp: `10.0.0.${i}`, localPort: 22, peerPort: 5000 + i });
    }
    expect(r.hasFreeLine()).toBe(false);
    await d.executeCommand('clear line vty 2');
    expect(r.hasFreeLine(), 'la ligne coupee est libre').toBe(true);
  }, 30_000);
});

// ── 3. `show ssh` : une commande, une reponse ───────────────────────

describe('`show ssh` — une seule implementation pour les deux plateformes', () => {
  it('le routeur annonce ses sessions REELLES', async () => {
    const d = await routeur();
    registre(d).open({ user: 'jean-baptiste', fromIp: '192.168.1.55', localPort: 22, peerPort: 52341 });
    const out = await d.executeCommand('show ssh');
    expect(out).toContain('Connection Version Mode Encryption');
    expect(out).toContain('jean-baptiste');
    expect(out).toContain('Session started');
  }, 30_000);

  /**
   * La ligne SSHv1 est TOUJOURS ecrite, session ou pas : une vraie
   * machine rend les deux sections, et c'est elle qui dit qu'une version
   * qu'on veut voir absente l'est bien.
   */
  it('la ligne SSHv1 est toujours ecrite, et porte le `%`', async () => {
    const d = await routeur();
    expect(await d.executeCommand('show ssh')).toContain('%No SSHv1 server connections running.');
    registre(d).open({ user: 'admin', fromIp: '10.0.0.1', localPort: 22, peerPort: 40000 });
    expect(await d.executeCommand('show ssh')).toContain('%No SSHv1 server connections running.');
  }, 30_000);

  it('sans session, les deux versions sont annoncees absentes', async () => {
    const d = await routeur();
    const out = await d.executeCommand('show ssh');
    expect(out).toContain('%No SSHv2 server connections running.');
    expect(out).toContain('%No SSHv1 server connections running.');
  }, 30_000);

  /**
   * Le commutateur n'a pas de registre de sessions parce qu'il n'a pas
   * de pile TCP : « aucune connexion » est la verite, pas un repli. Ce
   * qui compte est qu'il le dise avec les MEMES mots que le routeur.
   */
  it('le commutateur repond dans les memes mots que le routeur', async () => {
    const sw = new CiscoSwitch('SW1');
    sw.powerOn();
    await sw.executeCommand('enable');
    const d = await routeur();
    expect(await sw.executeCommand('show ssh')).toBe(await d.executeCommand('show ssh'));
  }, 30_000);

  it('`show ssh sessions` rend la meme chose', async () => {
    const d = await routeur();
    expect(await d.executeCommand('show ssh sessions')).toBe(await d.executeCommand('show ssh'));
  }, 30_000);
});
