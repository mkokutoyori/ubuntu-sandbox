import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface TestAaaHost {
  testAaaGroup(words: readonly string[]): string;
}

const PRIVILEGIE = Object.freeze(['privileged']);

const GROUPE: ArgumentSpec = {
  name: 'groupe', type: 'WORD', description: 'AAA server-group name',
};

const UTILISATEUR: ArgumentSpec = {
  name: 'utilisateur', type: 'WORD', description: 'User name to authenticate',
};

const MOT_DE_PASSE: ArgumentSpec = {
  name: 'motDePasse', type: 'WORD', description: 'Password of that user',
};

/*
 * `legacy` et `new-code` designent deux versions du code d'appel interne
 * d'IOS, pas deux protocoles : le dialogue sur le fil est le meme.
 */
const CODE: ArgumentSpec = {
  name: 'code', type: 'ENUM', description: 'Which AAA call path to exercise',
  values: [
    { keyword: 'legacy', description: 'Use the legacy AAA call path' },
    { keyword: 'new-code', description: 'Use the new AAA call path' },
  ],
};

export function testAaaSpecs(ctx: () => TestAaaHost): CommandSpec[] {
  return [{
    id: 'test-aaa-group',
    path: ['test', 'aaa', 'group', GROUPE, UTILISATEUR, MOT_DE_PASSE, CODE],
    description: 'Test AAA server-group authentication',
    modes: PRIVILEGIE, minPrivilege: 15,
    run: (_session, args) => ctx().testAaaGroup(
      [args.groupe, args.utilisateur, args.motDePasse, args.code]),
  }];
}
