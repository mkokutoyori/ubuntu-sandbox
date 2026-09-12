import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface ZoneHost {
  declareZone(name: string): void;
  declareZonePair(name: string, source: string, destination: string): void;
}

const CONFIG = Object.freeze(['config']);

const NOM_DE_ZONE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Zone name',
};

const NOM_DE_PAIRE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Zone-pair name',
};

const SOURCE: ArgumentSpec = {
  name: 'source', type: 'WORD', description: 'Source zone',
};

const DESTINATION: ArgumentSpec = {
  name: 'destination', type: 'WORD', description: 'Destination zone',
};

export function zoneSpecs(ctx: () => ZoneHost): CommandSpec[] {
  return [
    {
      id: 'zone-security',
      path: ['zone', 'security', NOM_DE_ZONE],
      description: 'Define security zone',
      modes: CONFIG, minPrivilege: 15,
      enters: 'config-zone',
      run: (_session, args) => { ctx().declareZone(args.nom); return ''; },
    },
    {
      id: 'zone-pair-security',
      path: ['zone-pair', 'security', NOM_DE_PAIRE,
        'source', SOURCE, 'destination', DESTINATION],
      description: 'Define zone-pair',
      modes: CONFIG, minPrivilege: 15,
      enters: 'config-zone-pair',
      run: (_session, args) => {
        ctx().declareZonePair(args.nom, args.source, args.destination);
        return '';
      },
    },
  ];
}
