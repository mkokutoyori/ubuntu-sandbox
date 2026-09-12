import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface TestEtherChannelHost {
  testLoadBalance(words: readonly string[]): string;
}

const PRIVILEGIE = Object.freeze(['privileged']);

const GROUPE: ArgumentSpec = {
  name: 'groupe', type: 'INT', range: [1, 64],
  description: 'Port-channel group number',
};

const FLUX: ArgumentSpec = {
  name: 'flux', type: 'REST', literal: 'LINE', restMinWords: 1,
  description: 'Addresses of the flow, source then destination',
};

const CLES: ReadonlyArray<readonly [string, string]> = [
  ['ip', 'IPv4 addresses of the flow'],
  ['mac', 'MAC addresses of the flow'],
];

export function testEtherChannelSpecs(ctx: () => TestEtherChannelHost): CommandSpec[] {
  return CLES.map(([cle, description]): CommandSpec => ({
    id: `test-etherchannel-load-balance-${cle}`,
    path: ['test', 'etherchannel', 'load-balance', 'interface', 'port-channel',
      GROUPE, cle, FLUX],
    description,
    modes: PRIVILEGIE, minPrivilege: 15,
    run: (_session, args) => ctx().testLoadBalance(
      ['interface', 'port-channel', args.groupe, cle,
        ...args.flux.split(/\s+/).filter(Boolean)]),
  }));
}
