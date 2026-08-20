/**
 * `sh ver` et `show version` sont LA MEME commande.
 *
 * L'autorisation de la CLI comparait la chaine TAPEE a la chaine de la
 * regle : `privilege exec level 15 show version` refusait donc
 * `show version` au niveau 1 et laissait passer `sh ver`, et
 * symetriquement une commande DELEGUEE au niveau 5 refusait son
 * abreviation. IOS resout l'abreviation vers la commande canonique AVANT
 * d'autoriser ; ce module est cette resolution, isolee pour que
 * l'autorisation, l'aide et la completion ne puissent pas en avoir trois
 * versions.
 *
 * Ce que ces cas fixent, et qui n'allait pas de soi :
 *
 * - une abreviation AMBIGUE n'est pas une commande, donc n'est pas
 *   canonicalisable — la resoudre arbitrairement ferait decider
 *   l'autorisation sur une commande que l'operateur n'a pas designee ;
 * - les ARGUMENTS sont conserves tels quels : une regle est un PREFIXE
 *   (`privilege exec level 5 ping` couvre `ping 10.0.0.1`), donc les
 *   effacer changerait la portee des regles existantes ;
 * - une commande INCOMPLETE se canonicalise quand meme, parce que l'aide
 *   (`show ?`) juge des lignes incompletes par construction ;
 * - la casse est rendue par l'ARBRE et non par la saisie, sans quoi une
 *   regle ecrite `SHOW VERSION` resterait sans effet.
 */
import { describe, it, expect } from 'vitest';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';
import { CommandCanonicalizer } from '@/network/devices/shells/cli/CommandCanonicalizer';
import type { AuthScope } from '@/network/devices/shells/cli/CliAuthorization';

function execTrie(): CommandTrie {
  const t = new CommandTrie();
  t.register('show version', 'Display version', () => '');
  t.register('show running-config', 'Display running config', () => '');
  t.register('show ip route', 'Display routes', () => '');
  t.register('show ip interface brief', 'Brief', () => '');
  t.register('reload', 'Reload', () => '');
  t.registerGreedy('ping', 'Ping', () => '');
  return t;
}

function configTrie(): CommandTrie {
  const t = new CommandTrie();
  t.register('hostname', 'Set hostname', () => '');
  t.registerGreedy('interface', 'Select interface', () => '');
  return t;
}

function canon(): CommandCanonicalizer {
  const exec = execTrie();
  const cfg = configTrie();
  return new CommandCanonicalizer({
    triesFor: (scope: AuthScope) => (scope === 'exec' ? [exec] : [cfg]),
  });
}

describe('CommandCanonicalizer', () => {
  it('resout une abreviation vers la commande canonique', () => {
    const c = canon();
    expect(c.canonical('exec', 'sh ver')).toBe('show version');
    expect(c.canonical('exec', 'sh run')).toBe('show running-config');
    expect(c.canonical('exec', 'sh ip ro')).toBe('show ip route');
    expect(c.canonical('exec', 'rel')).toBe('reload');
  });

  it('rend la forme complete inchangee', () => {
    const c = canon();
    expect(c.canonical('exec', 'show version')).toBe('show version');
    expect(c.canonical('exec', 'show ip interface brief')).toBe('show ip interface brief');
  });

  it('rend la casse de l ARBRE, pas celle de la saisie', () => {
    const c = canon();
    expect(c.canonical('exec', 'SHOW VERSION')).toBe('show version');
    expect(c.canonical('exec', 'Show Ip Route')).toBe('show ip route');
  });

  it('conserve les arguments, parce qu une regle est un prefixe', () => {
    const c = canon();
    expect(c.canonical('exec', 'ping 10.0.0.1')).toBe('ping 10.0.0.1');
    expect(c.canonical('exec', 'pin 10.0.0.1')).toBe('ping 10.0.0.1');
  });

  it('reduit les espaces surnumeraires', () => {
    const c = canon();
    expect(c.canonical('exec', '  sh    ver  ')).toBe('show version');
  });

  it('rend null pour une commande inconnue', () => {
    const c = canon();
    expect(c.canonical('exec', 'shwo verison')).toBeNull();
    expect(c.canonical('exec', 'nexistepas')).toBeNull();
  });

  it('rend null pour une abreviation AMBIGUE', () => {
    const t = new CommandTrie();
    t.register('show clock', 'Clock', () => '');
    t.register('show cdp', 'CDP', () => '');
    const c = new CommandCanonicalizer({ triesFor: () => [t] });
    expect(c.canonical('exec', 'show c')).toBeNull();
    expect(c.canonical('exec', 'show cl')).toBe('show clock');
  });

  it('canonicalise une commande INCOMPLETE, dont l aide a besoin', () => {
    const c = canon();
    expect(c.canonical('exec', 'sh')).toBe('show');
    expect(c.canonical('exec', 'sh ip')).toBe('show ip');
  });

  it('choisit l arbre selon l espace de nommage', () => {
    const c = canon();
    expect(c.canonical('configure', 'host')).toBe('hostname');
    expect(c.canonical('exec', 'host')).toBeNull();
    expect(c.canonical('configure', 'sh ver')).toBeNull();
  });

  it('consulte les arbres dans l ordre donne et s arrete au premier qui sait', () => {
    const user = new CommandTrie();
    user.register('show version', 'v', () => '');
    const priv = new CommandTrie();
    priv.register('show version', 'v', () => '');
    priv.register('show running-config', 'r', () => '');
    const c = new CommandCanonicalizer({ triesFor: () => [user, priv] });
    expect(c.canonical('exec', 'sh ver')).toBe('show version');
    expect(c.canonical('exec', 'sh run')).toBe('show running-config');
  });

  it('canonicalOrSelf retombe sur la saisie normalisee', () => {
    const c = canon();
    expect(c.canonicalOrSelf('exec', 'sh ver')).toBe('show version');
    expect(c.canonicalOrSelf('exec', '  SHWO   VERISON ')).toBe('shwo verison');
  });

  it('une chaine vide n est pas une commande', () => {
    const c = canon();
    expect(c.canonical('exec', '')).toBeNull();
    expect(c.canonical('exec', '   ')).toBeNull();
    expect(c.canonicalOrSelf('exec', '')).toBe('');
  });

  it('sans arbre pour cet espace, rien n est canonicalisable', () => {
    const c = new CommandCanonicalizer({ triesFor: () => [] });
    expect(c.canonical('exec', 'sh ver')).toBeNull();
    expect(c.canonicalOrSelf('exec', 'sh ver')).toBe('sh ver');
  });
});
