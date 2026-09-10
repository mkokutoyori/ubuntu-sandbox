import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import {
  parseDottedMac, type MacAce, type MacMatch,
} from '../../switch/MacAccessList';

const CONFIG = ['config'] as const;
export const MAC_ACL_MODE = 'config-ext-macl';
const LISTE = [MAC_ACL_MODE] as const;
const INTERFACE = ['config-if'] as const;

export interface MacAclHost {
  enterList(nom: string): string;
  removeList(nom: string): string;
  addEntry(ace: MacAce): string;
  removeEntry(ace: MacAce): string;
  bind(nom: string): string;
  unbind(nom: string): string;
}

const NOM: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Access list name',
};

/**
 * `any` ou `host <mac>`, et rien d'autre.
 *
 * La reference ne donne que ces deux formes pour la source comme pour
 * la destination : `{permit | deny} {any | host <src-mac>} {any | host
 * <dst-mac>}`. Une place libre y ferait entrer une adresse nue, qu'IOS
 * n'accepte pas a cette position.
 */
const PLACE = (quoi: 'source' | 'destination') => ({
  keyword: {
    name: `${quoi}-forme`, type: 'ENUM' as const,
    description: `${quoi === 'source' ? 'Source' : 'Destination'} MAC address`,
    values: [
      { keyword: 'any', description: `Any ${quoi} MAC address` },
      { keyword: 'host', description: `A single ${quoi} MAC address` },
    ],
  },
  adresse: {
    name: `${quoi}-mac`, type: 'WORD' as const, literal: 'H.H.H',
    description: `48-bit ${quoi} MAC address`,
  },
});

const SRC = PLACE('source');
const DST = PLACE('destination');

function adresse(brut: string): MacMatch {
  const mac = parseDottedMac(brut);
  if (!mac) throw new CliInvalidInput({ token: brut });
  return { kind: 'host', mac };
}

export function macAclSpecs(ctx: () => MacAclHost): CommandSpec[] {
  /*
   * Les quatre combinaisons de `any`/`host` sont declarees, parce que
   * `host` prend une adresse et `any` n'en prend pas : une seule
   * declaration ferait de la place suivante un argument facultatif, et
   * `permit host any` — qui n'est pas une commande — deviendrait
   * acceptable.
   */
  const entree = (
    action: 'permit' | 'deny', srcHost: boolean, dstHost: boolean,
  ): CommandSpec => {
    const chemin: Array<string | ArgumentSpec> = [action];
    chemin.push(srcHost ? 'host' : 'any');
    if (srcHost) chemin.push(SRC.adresse);
    chemin.push(dstHost ? 'host' : 'any');
    if (dstHost) chemin.push(DST.adresse);

    const lire = (args: Record<string, string>): MacAce => ({
      action,
      src: srcHost ? adresse(args[SRC.adresse.name]) : { kind: 'any' },
      dst: dstHost ? adresse(args[DST.adresse.name]) : { kind: 'any' },
    });

    return {
      id: `mac-acl-${action}-${srcHost ? 'host' : 'any'}-${dstHost ? 'host' : 'any'}`,
      path: chemin,
      description: action === 'permit'
        ? 'Specify packets to forward' : 'Specify packets to reject',
      modes: LISTE, minPrivilege: 15,
      run: (_s, args) => ctx().addEntry(lire(args)),
      undo: (_s, args) => ctx().removeEntry(lire(args)),
    };
  };

  const entrees = (['permit', 'deny'] as const).flatMap(action =>
    [false, true].flatMap(srcHost =>
      [false, true].map(dstHost => entree(action, srcHost, dstHost))));

  return [
    {
      id: 'mac-access-list-extended',
      path: ['mac', 'access-list', 'extended', NOM],
      description: 'Extended MAC access list',
      undoDescription: 'Remove an extended MAC access list',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => ctx().enterList(args.nom),
      undo: (_s, args) => ctx().removeList(args.nom),
    },
    {
      /*
       * Le sens est declare, et il n'y en a qu'UN : « The device applies
       * MAC ACLs only to inbound traffic. » Declarer `out` le ferait
       * accepter puis ignorer — un port qu'on croit filtre dans les deux
       * sens et qui ne l'est que dans un.
       */
      id: 'mac-access-group',
      path: ['mac', 'access-group', NOM, {
        name: 'sens', type: 'ENUM', description: 'Direction the list filters',
        values: [{ keyword: 'in', description: 'Inbound packets' }],
      }],
      description: 'Apply a MAC access list to the interface',
      modes: INTERFACE, minPrivilege: 15,
      run: (_s, args) => ctx().bind(args.nom),
      undo: (_s, args) => ctx().unbind(args.nom),
    },
    ...entrees,
  ];
}
