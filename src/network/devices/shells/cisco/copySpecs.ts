import type { ArgumentSpec, EnumValue } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface CopyHost {
  copyFile(words: readonly string[]): string;
}

const PRIVILEGIE = Object.freeze(['privileged']);

const FICHIERS: readonly EnumValue[] = [
  { keyword: 'flash:', description: 'Local flash filesystem' },
  { keyword: 'scp:', description: 'Secure Copy' },
  { keyword: 'tftp:', description: 'Trivial File Transfer Protocol' },
];

const TOUT: readonly EnumValue[] = [
  ...FICHIERS,
  { keyword: 'running-config', description: 'Current running configuration' },
  { keyword: 'startup-config', description: 'Saved startup configuration' },
];

const DEPUIS_LA_COURANTE: readonly EnumValue[] = [
  { keyword: 'flash:', description: 'Save to flash filesystem' },
  { keyword: 'scp:', description: 'Upload over SCP' },
  { keyword: 'startup-config', description: 'Save to NVRAM startup-config' },
  { keyword: 'tftp:', description: 'Upload to TFTP server' },
];

const DEPUIS_LE_DEMARRAGE: readonly EnumValue[] = [
  { keyword: 'flash:', description: 'Save to flash filesystem' },
  { keyword: 'running-config', description: 'Merge into the running configuration' },
  { keyword: 'scp:', description: 'Upload over SCP' },
  { keyword: 'tftp:', description: 'Upload to TFTP server' },
];

const SOURCE: ArgumentSpec = {
  name: 'source', type: 'WORD', description: 'Source file or filesystem',
  alternatives: FICHIERS, formsAreExhaustive: true,
};

const DESTINATION: ArgumentSpec = {
  name: 'destination', type: 'WORD', description: 'Destination file or filesystem',
  alternatives: TOUT, formsAreExhaustive: true,
};

const place = (formes: readonly EnumValue[], description: string): ArgumentSpec =>
  ({ name: 'destination', type: 'WORD', description, alternatives: formes,
    formsAreExhaustive: true });

/*
 * Les deux configurations sont des MOTS-CLES et non des formes de la
 * place source, pour deux raisons mesurees. Leurs destinations se
 * DECRIVENT autrement — « Save to flash filesystem » plutot que « Local
 * flash filesystem » — et surtout une configuration ne se copie pas sur
 * elle-meme : declarees comme formes d'une place, elles se
 * reproposaient a la destination, si bien que `copy startup-config ?`
 * offrait `startup-config`. Un mot-cle porte sa propre suite, donc sa
 * propre liste.
 */
const CONFIGURATIONS: ReadonlyArray<readonly [string, string, readonly EnumValue[]]> = [
  ['running-config', 'Current running configuration', DEPUIS_LA_COURANTE],
  ['startup-config', 'Saved startup configuration', DEPUIS_LE_DEMARRAGE],
];

export function copySpecs(ctx: () => CopyHost): CommandSpec[] {
  return [
    {
      id: 'copy',
      path: ['copy', SOURCE, DESTINATION],
      description: 'Copy a file',
      modes: PRIVILEGIE, minPrivilege: 15,
      run: (_session, args) => ctx().copyFile([args.source, args.destination]),
    },
    ...CONFIGURATIONS.map(([mot, description, formes]): CommandSpec => ({
      id: `copy-${mot}`,
      path: ['copy', mot, place(formes, `Where to copy the ${mot}`)],
      description,
      modes: PRIVILEGIE, minPrivilege: 15,
      run: (_session, args) => ctx().copyFile([mot, args.destination]),
    })),
  ];
}
