import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';

export interface FileSystemHandlers {
  list(words: readonly string[]): string;
  more(words: readonly string[]): string;
  verify(words: readonly string[]): string;
  remove(words: readonly string[]): string;
  makeDirectory(words: readonly string[]): string;
  removeDirectory(words: readonly string[]): string;
  squeeze(words: readonly string[]): string;
  workingDirectory(): string;
}

const words = (value: string | undefined): string[] =>
  (value ?? '').trim().split(/\s+/).filter(Boolean);

function place(name: string, description: string, optional = false): ArgumentSpec {
  return {
    name, type: 'REST', literal: 'WORD', description, ...(optional ? { optional } : {}),
  };
}

export function fileSystemFamily(handlers: FileSystemHandlers): CommandSpec[] {
  const base = { modes: ['user', 'privileged'], minPrivilege: 1 };
  const verb = (
    keyword: string, argument: ArgumentSpec, description: string,
    run: (words: readonly string[]) => string,
  ): CommandSpec => ({
    ...base, id: keyword, path: [keyword, argument], description,
    run: (_session, args) => run(words(args[argument.name])),
  });
  return [
    verb('dir', place('filesystem', 'Filesystem or directory to list', true),
      'List files on a filesystem', handlers.list),
    verb('more', place('file', 'File to display'), 'Display a file', handlers.more),
    verb('verify', place('file', 'File to verify'), 'Verify a file', handlers.verify),
    verb('delete', place('file', 'File to be deleted'), 'Delete a file', handlers.remove),
    verb('mkdir', place('directory', 'Directory to create'), 'Create a directory',
      handlers.makeDirectory),
    verb('rmdir', place('directory', 'Directory to remove'), 'Remove a directory',
      handlers.removeDirectory),
    verb('squeeze', place('filesystem', 'Filesystem to squeeze'), 'Squeeze a filesystem',
      handlers.squeeze),
    {
      ...base, id: 'pwd', path: ['pwd'], description: 'Display current working directory',
      run: () => handlers.workingDirectory(),
    },
  ];
}
