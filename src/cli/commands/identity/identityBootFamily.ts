import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';
import { CliInvalidInput } from '../../../network/devices/shells/cli/CliDiagnostic';

export interface LineKind {
  readonly keyword: 'console' | 'vty' | 'aux' | 'tty';
  readonly max: number;
  readonly description: string;
}

export interface IdentityBootHost {
  addBootSystem(image: string): void;
  removeBootSystem(image: string | undefined): void;
  hasConfigRegister(): boolean;
  setEnableBreak(on: boolean): void;
  setManualBoot(on: boolean): void;
  setConfigRegister(value: string): boolean;
  setHostname(name: string): void;
  resetHostname(): void;
  enterLine(kind: LineKind['keyword'], first: number, last: number): void;
  removeLine(kind: LineKind['keyword'], first: number, last: number): string;
}

const stripFlash = (image: string | undefined): string =>
  (image ?? '').trim().replace(/^flash:\/?/i, '');

export function identityBootFamily(
  host: () => IdentityBootHost, lineKinds: readonly LineKind[],
): CommandSpec[] {
  const base = { modes: ['config'], minPrivilege: 15 };
  const image: ArgumentSpec = {
    name: 'image', type: 'REST', description: 'System image file', literal: 'WORD',
  };
  const specs: CommandSpec[] = [
    {
      ...base, id: 'boot-system', path: ['boot', 'system', image],
      description: 'Specify system image to load',
      run: (_session, args) => { host().addBootSystem(stripFlash(args.image)); return ''; },
      undo: (_session, args) => {
        host().removeBootSystem(stripFlash(args.image) || undefined);
        return '';
      },
    },
    {
      ...base, id: 'boot-system-undo', path: ['boot', 'system'],
      description: 'Remove a system image from the boot list', existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { host().removeBootSystem(undefined); return ''; },
    },
    {
      ...base, id: 'hostname',
      path: ['hostname', { name: 'name', type: 'WORD', description: 'This system\'s network name' }],
      description: 'Set system hostname',
      run: (_session, args) => { host().setHostname(args.name); return ''; },
    },
    {
      ...base, id: 'hostname-undo', path: ['hostname'], description: 'Reset hostname',
      existsOnlyNegated: true, run: () => '% Incomplete command.',
      undo: () => { host().resetHostname(); return ''; },
    },
  ];

  if (host().hasConfigRegister()) {
    specs.push({
      ...base, id: 'config-register',
      path: ['config-register', {
        name: 'value', type: 'WORD', description: 'Config register value, in hex',
      }],
      description: 'Set configuration register',
      run: (_session, args) =>
        host().setConfigRegister(args.value) ? '' : '% Invalid config register value',
    });
  } else {
    specs.push(
      {
        ...base, id: 'boot-enable-break', path: ['boot', 'enable-break'],
        description: 'Enable the Break key during boot',
        undoDescription: 'Disable the Break key during boot',
        run: () => { host().setEnableBreak(true); return ''; },
        undo: () => { host().setEnableBreak(false); return ''; },
      },
      {
        ...base, id: 'boot-manual', path: ['boot', 'manual'],
        description: 'Boot into the boot loader instead of the image',
        undoDescription: 'Boot the image automatically',
        run: () => { host().setManualBoot(true); return ''; },
        undo: () => { host().setManualBoot(false); return ''; },
      },
    );
  }

  const lineBase = { modes: ['config', 'config-line'], minPrivilege: 15 };
  for (const kind of lineKinds) {
    const first: ArgumentSpec = {
      name: 'first', type: 'INT', range: [0, kind.max], description: 'First Line number',
    };
    const last: ArgumentSpec = {
      name: 'last', type: 'INT', range: [0, kind.max], optional: true,
      description: 'Last Line number',
    };
    const span = (args: Record<string, string>): [number, number] => {
      const from = Number(args.first);
      const to = args.last === undefined ? from : Number(args.last);
      if (to < from) throw new CliInvalidInput({ token: args.last });
      return [from, to];
    };
    specs.push({
      ...lineBase, id: `line-${kind.keyword}`, path: ['line', kind.keyword, first, last],
      description: kind.description,
      undoDescription: 'Remove line configuration',
      run: (_session, args) => {
        const [from, to] = span(args);
        host().enterLine(kind.keyword, from, to);
        return '';
      },
      undo: (_session, args) => {
        const [from, to] = span(args);
        return host().removeLine(kind.keyword, from, to);
      },
    });
  }
  return specs;
}
