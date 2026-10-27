import type { EditorFsContext } from '../EditorFsContext';

export type StateDirectoryHost = Pick<EditorFsContext, 'identity' | 'kindOf' | 'homeDirectory' | 'environmentVariable' | 'makeDirectory'>;

export interface StateDirectory {
  readonly path: string | null;
  readonly errors: readonly string[];
}

export const STARTUP_PROBLEM = 'Problems with history file';
export const SEARCH_HISTORY_FILE = 'search_history';
export const POSITION_HISTORY_FILE = 'filepos_history';

const PRIVATE_DIRECTORY_MODE = 0o700;

export function nanoHomeDirectory(host: StateDirectoryHost): string | null {
  const fromEnvironment = host.environmentVariable?.('HOME') ?? null;
  const isRoot = host.identity?.().user === 'root';
  const home = fromEnvironment === null || isRoot ? (host.homeDirectory?.() ?? fromEnvironment) : fromEnvironment;
  return home !== null && home !== '' ? home : null;
}

function statKind(host: StateDirectoryHost, path: string) {
  const kind = host.kindOf?.(path) ?? 'missing';
  return kind === 'file' && path.endsWith('/') ? 'missing' : kind;
}

export function resolveStateDirectory(host: StateDirectoryHost): StateDirectory {
  const home = nanoHomeDirectory(host);
  if (home !== null) {
    const legacy = `${home}/.nano/`;
    if (statKind(host, legacy) === 'directory') return { path: legacy, errors: [] };
  }

  const dataHome = host.environmentVariable?.('XDG_DATA_HOME') ?? null;
  if (home === null && dataHome === null) return { path: null, errors: [] };

  const directory = dataHome !== null ? `${dataHome}/nano/` : `${home}/.local/share/nano/`;
  const kind = statKind(host, directory);
  if (kind === 'missing') {
    if (dataHome === null) {
      host.makeDirectory?.(`${home}/.local`, PRIVATE_DIRECTORY_MODE);
      host.makeDirectory?.(`${home}/.local/share`, PRIVATE_DIRECTORY_MODE);
    }
    const failure = host.makeDirectory === undefined ? 'Permission denied' : host.makeDirectory(directory, PRIVATE_DIRECTORY_MODE);
    if (failure !== null) {
      return {
        path: null,
        errors: [`Unable to create directory ${directory}: ${failure}\nIt is required for saving/loading search history or cursor positions.\n`],
      };
    }
  } else if (kind !== 'directory') {
    return {
      path: null,
      errors: [`Path ${directory} is not a directory and needs to be.\nNano will be unable to load or save search history or cursor positions.\n`],
    };
  }
  return { path: directory, errors: [] };
}
