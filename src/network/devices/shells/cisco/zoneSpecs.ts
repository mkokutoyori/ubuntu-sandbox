import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface ZoneHost {
  declareZone(name: string): void;
  declareZonePair(name: string, source: string, destination: string): void;
  removeZone(name: string): void;
  removeZonePair(name: string): void;
  setZoneMember(zone: string | null): void;
}

const CONFIG = Object.freeze(['config']);
const INTERFACE = Object.freeze(['config-if', 'config-subif']);

const NOM_DE_ZONE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Zone name',
};

const NOM_DE_ZONE_MEMBRE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Name of the security zone',
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
      undo: (_session, args) => { ctx().removeZone(args.nom); return ''; },
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
      undo: (_session, args) => { ctx().removeZonePair(args.nom); return ''; },
    },
    {
      id: 'zone-member-security',
      path: ['zone-member', 'security', NOM_DE_ZONE_MEMBRE],
      description: 'Attach the interface to a security zone',
      undoDescription: 'Detach the interface from its security zone',
      modes: INTERFACE, minPrivilege: 15,
      run: (_session, args) => { ctx().setZoneMember(args.nom); return ''; },
      undo: () => { ctx().setZoneMember(null); return ''; },
      undoOmitsArguments: true,
    },
  ];
}
