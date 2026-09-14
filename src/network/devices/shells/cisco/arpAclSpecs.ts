import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';

const CONFIG = ['config'] as const;
const SOUS_MODE = ['config-acl'] as const;

export interface ArpAclHost {
  ouvrirListe(nom: string): string;
  ajouterEntree(
    action: 'permit' | 'deny',
    senderIp: string | null,
    senderMac: string | null,
    ligne: string,
  ): string;
  retirerEntree(ligne: string): string;
}

const NOM: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Name of the ARP access list',
};

const JOURNAL: readonly OptionSpec[] = [
  { keyword: 'log', description: 'Log matches against this entry' },
];

interface FormeCritere {
  readonly nom: string;
  readonly pas: ReadonlyArray<string | ArgumentSpec>;
  valeur(args: Record<string, string>): string | null;
  mots(args: Record<string, string>): string[];
}

const ADRESSES: readonly FormeCritere[] = [
  {
    nom: 'any',
    pas: ['any'],
    valeur: () => null,
    mots: () => ['any'],
  },
  {
    nom: 'host',
    pas: ['host', {
      name: 'adresse', type: 'IP_ADDR', description: 'Sender IP address',
    }],
    valeur: (args) => args.adresse,
    mots: (args) => ['host', args.adresse],
  },
];

const MATERIELLES: readonly FormeCritere[] = [
  {
    nom: 'any',
    pas: ['any'],
    valeur: () => null,
    mots: () => ['any'],
  },
  {
    nom: 'host',
    pas: ['host', {
      name: 'mac', type: 'MAC_ADDR', description: 'Sender MAC address',
    }],
    valeur: (args) => args.mac.toLowerCase(),
    mots: (args) => ['host', args.mac.toLowerCase()],
  },
];

export function arpAclSpecs(ctx: () => ArpAclHost): CommandSpec[] {
  const specs: CommandSpec[] = [{
    id: 'arp-access-list',
    path: ['arp', 'access-list', NOM],
    description: 'Define an ARP access list',
    modes: CONFIG, minPrivilege: 15,
    enters: 'config-acl',
    run: (_s, args) => ctx().ouvrirListe(args.nom),
  }];

  for (const action of ['permit', 'deny'] as const) {
    for (const sens of [[], ['request']] as ReadonlyArray<readonly string[]>) {
      for (const ip of ADRESSES) {
        for (const mac of MATERIELLES) {
          const ligne = (args: Record<string, string>): string => [
            action, ...sens, 'ip', ...ip.mots(args), 'mac', ...mac.mots(args),
            ...(args.log === undefined ? [] : ['log']),
          ].join(' ');
          specs.push({
            id: `arp-acl-${action}-${sens.length ? 'request' : 'tout'}-${ip.nom}-${mac.nom}`,
            path: [action, ...sens, 'ip', ...ip.pas, 'mac', ...mac.pas],
            description: action === 'permit'
              ? 'Permit matching ARP packets' : 'Deny matching ARP packets',
            modes: SOUS_MODE, minPrivilege: 15,
            options: JOURNAL,
            run: (_s, args) => ctx().ajouterEntree(
              action, ip.valeur(args), mac.valeur(args), ligne(args)),
            undo: (_s, args) => ctx().retirerEntree(ligne(args)),
          });
        }
      }
    }
  }
  return specs;
}
