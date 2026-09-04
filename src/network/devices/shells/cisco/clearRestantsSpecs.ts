import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import { clearLine, type LinePool } from './CiscoLineCommands';

export interface ClearRestantsHost {
  linePool(): LinePool | undefined;
  clearPersistentLog(): string;
}

const EXEC = ['privileged'] as const;
/* `clear crypto …` est declaree dans les DEUX vues EXEC par le trie ;
 * la migration ne restreint pas ce qu'elle deplace. */
const EXEC_ET_UTILISATEUR = ['user', 'privileged'] as const;

/**
 * La ligne designee par `clear line`, dans les DEUX ecritures d'IOS.
 *
 * `clear line 5` compte les lignes en ABSOLU — console 0, aux 1, puis
 * les vty — tandis que `clear line vty 3` nomme la sorte et son rang.
 * Une seule place porte les deux, comme `logging console` porte une
 * severite ecrite `errors` ou `3` : la declarer deux fois donnerait deux
 * places a un meme rang, et la premiere gagnerait en silence.
 *
 * La borne haute n'est pas inventee : elle se DEDUIT du nombre de vty
 * que `line vty` declare deja (`SORTES_DE_LIGNE`), par la meme
 * numerotation absolue que `matchesTarget` applique. Deux bornes pour un
 * meme fait finiraient par se contredire — `clear line 17` refuse sur
 * une machine ou `line vty 15` existe.
 */
export function lineTargetPlace(maxAbsolute: number): ArgumentSpec {
  return {
    name: 'cible', type: 'ENUM', range: [0, maxAbsolute],
    description: 'First Line number',
    values: [
      { keyword: 'aux', description: 'Auxiliary line' },
      { keyword: 'console', description: 'Primary terminal line' },
      { keyword: 'tty', description: 'Terminal controller' },
      { keyword: 'vty', description: 'Virtual terminal' },
    ],
  };
}

const LINE_INDEX: ArgumentSpec = {
  name: 'index', type: 'INT', optional: true, range: [0, 15],
  description: 'Line number',
};

export function clearLineSpecs(
  ctx: () => ClearRestantsHost, maxAbsolute: number,
): CommandSpec[] {
  const cible = lineTargetPlace(maxAbsolute);
  return [
    {
      id: 'clear-line',
      path: ['clear', 'line', cible, LINE_INDEX],
      description: 'Reset a terminal line',
      modes: EXEC, minPrivilege: 15,
      run: (_session, args) => {
        const mots = args.index === undefined
          ? [args.cible] : [args.cible, args.index];
        return clearLine(ctx().linePool(), mots);
      },
    },
    {
      id: 'clear-logging-persistent',
      path: ['clear', 'logging', 'persistent'],
      description: 'Clear the persistent log files',
      modes: EXEC, minPrivilege: 15,
      run: () => ctx().clearPersistentLog(),
    },
  ];
}

export interface ClearAclHost {
  clearAclCounters(ref?: string): string;
}

const ACL_REF: ArgumentSpec = {
  name: 'liste', type: 'WORD', optional: true,
  description: 'Access list name or number',
};

export function clearAclSpecs(ctx: () => ClearAclHost): CommandSpec[] {
  const corps = (id: string, mots: readonly string[], description: string): CommandSpec => ({
    id,
    path: [...mots, ACL_REF],
    description,
    modes: EXEC, minPrivilege: 15,
    run: (_session, args) => ctx().clearAclCounters(args.liste),
  });
  return [
    corps('clear-access-list-counters',
      ['clear', 'access-list', 'counters'], 'Clear access list counters'),
    corps('clear-ip-access-list-counters',
      ['clear', 'ip', 'access-list', 'counters'], 'Clear IP access list counters'),
  ];
}

export interface ClearCryptoHost {
  clearIpsecSas(peer?: string): string;
  clearIsakmpSas(peer?: string): string;
}

/**
 * `clear crypto sa [peer <A.B.C.D>]` — le pair se nomme ou se tait.
 *
 * Le gestionnaire acceptait n'importe quel mot et n'en retenait que le
 * premier qui ressemblait a une adresse, donc `clear crypto sa zorglub`
 * effacait TOUTES les associations sans un mot. Le sac d'options le dit
 * en une declaration, et l'adresse est typee.
 */
const PEER_OPTION: readonly OptionSpec[] = [{
  keyword: 'peer',
  description: 'Clear the SAs of one peer',
  argument: { name: 'peer', type: 'IP_ADDR', description: 'Peer IP address' },
}];

export function clearCryptoSpecs(ctx: () => ClearCryptoHost): CommandSpec[] {
  return [
    {
      id: 'clear-crypto-sa',
      path: ['clear', 'crypto', 'sa'],
      description: 'Clear IPSec SAs',
      modes: EXEC_ET_UTILISATEUR, minPrivilege: 1,
      options: PEER_OPTION,
      run: (_session, args) => ctx().clearIpsecSas(args.peer),
    },
    {
      id: 'clear-crypto-isakmp',
      path: ['clear', 'crypto', 'isakmp'],
      description: 'Clear ISAKMP SAs',
      modes: EXEC_ET_UTILISATEUR, minPrivilege: 1,
      options: PEER_OPTION,
      run: (_session, args) => ctx().clearIsakmpSas(args.peer),
    },
  ];
}

export interface ClearSwitchHost {
  resolveInterface(name: string): string | null;
  recoverErrDisable(port: string): void;
}

const INTERFACE_PLACE: ArgumentSpec = {
  name: 'iface', type: 'INTERFACE', description: 'Interface to recover',
};

/**
 * Les trois `clear` que seul un Catalyst porte.
 *
 * `clear spanning-tree detected-protocols` et `clear spanning-tree
 * counters` etaient GLOUTONNES et ne faisaient rien : elles prenaient
 * donc le mot de trop en silence, et `clear errdisable interface
 * zorglub` acceptait un nom d'interface que la machine n'a pas — la
 * commande la plus consequente des trois, puisqu'elle promet de
 * remettre un port en service.
 *
 * Elles ne font toujours rien de plus qu'avant : ce simulateur ne tient
 * pas de compteur STP par port et n'a pas de migration de protocole a
 * relancer, donc leur declarer un effet serait le decor que ce depot
 * refuse. Ce qui change est qu'elles refusent ce qu'elles ne lisent pas.
 */
export function clearSwitchSpecs(ctx: () => ClearSwitchHost): CommandSpec[] {
  return [
    {
      id: 'clear-spanning-tree-detected-protocols',
      path: ['clear', 'spanning-tree', 'detected-protocols'],
      description: 'Restart protocol migration',
      modes: EXEC, minPrivilege: 15,
      run: () => '',
    },
    {
      id: 'clear-spanning-tree-counters',
      path: ['clear', 'spanning-tree', 'counters'],
      description: 'Clear spanning-tree counters',
      modes: EXEC, minPrivilege: 15,
      run: () => '',
    },
    {
      id: 'clear-errdisable-interface',
      path: ['clear', 'errdisable', 'interface', INTERFACE_PLACE],
      description: 'Recover an err-disabled port',
      modes: EXEC, minPrivilege: 15,
      run: (_session, args) => {
        const host = ctx();
        const port = host.resolveInterface(args.iface);
        if (!port) return `% Invalid interface ${args.iface}`;
        host.recoverErrDisable(port);
        return '';
      },
    },
  ];
}
