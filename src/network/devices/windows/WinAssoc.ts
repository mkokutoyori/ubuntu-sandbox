import type { RegistryAddress } from './PSRegistryProvider';
import type { RegResult, WinRegistry } from './WinRegCommand';

export interface AssocHost {
  readonly registry: WinRegistry;
  readonly isAdmin: boolean;
}

const ASSOC_HELP = [
  'Displays or modifies file extension associations',
  '',
  'ASSOC [.ext[=[fileType]]]',
  '',
  '  .ext      Specifies the file extension to associate the file type with',
  '  fileType  Specifies the file type to associate with the file extension',
  '',
  'Type ASSOC without parameters to display the current file associations.',
  'If ASSOC is invoked with just a file extension, it displays the current',
  'file association for that file extension.  Specify nothing for the file',
  'type and the command will delete the association for the file extension.',
].join('\n');

const FTYPE_HELP = [
  'Displays or modifies file types used in file extension associations',
  '',
  'FTYPE [fileType[=[openCommandString]]]',
  '',
  '  fileType  Specifies the file type to examine or change',
  '  openCommandString Specifies the open command to use when launching files',
  '                    of this type.',
  '',
  'Type FTYPE without parameters to display the current file types that',
  'have open command strings defined.  FTYPE is invoked with just a file',
  'type, it displays the current open command string for that file type.',
  'Specify nothing for the open command string and the FTYPE command will',
  'delete the open command string for the file type.  Within an open',
  'command string %0 or %1 are substituted with the file name being',
  'launched through the association.  %* gets all the parameters and %2',
  'gets the 1st parameter, %3 the second, etc.  %~n gets all the remaining',
  'parameters starting with the nth parameter, where n may be between 2 and 9,',
  'inclusive.  For example:',
  '',
  '    ASSOC .pl=PerlScript',
  '    FTYPE PerlScript=perl.exe %1 %*',
  '',
  'would allow you to invoke a Perl script as follows:',
  '',
  '    script.pl 1 2 3',
  '',
  'If you want to eliminate the need to type the extensions, then do the',
  'following:',
  '',
  '    set PATHEXT=.pl;%PATHEXT%',
  '',
  'and the script could be invoked as follows:',
  '',
  '    script 1 2 3',
].join('\n');

const DENIED = 'Access is denied.';

const classes = (...segments: string[]): RegistryAddress => ({ root: 'HKCR', segments, machine: null });
const OPEN_COMMAND = ['shell', 'open', 'command'];

function defaultOf(host: AssocHost, address: RegistryAddress): string | null {
  const value = host.registry.keyView(address)?.values.find(entry => entry.name === '');
  return value === undefined ? null : String(value.value);
}

function sortedKeys(host: AssocHost, wanted: (name: string) => boolean): string[] {
  return (host.registry.keyView(classes())?.subkeys ?? []).filter(wanted);
}

export function cmdAssoc(host: AssocHost, argument: string): RegResult {
  const text = argument.trim();
  if (text === '/?') return { output: ASSOC_HELP, exitCode: 0 };
  if (text === '') {
    const lines = sortedKeys(host, name => name.startsWith('.'))
      .flatMap(name => {
        const progId = defaultOf(host, classes(name));
        return progId === null ? [] : [`${name}=${progId}`];
      });
    return { output: lines.join('\n'), exitCode: 0 };
  }
  const equals = text.indexOf('=');
  if (equals < 0) {
    const progId = defaultOf(host, classes(text));
    return progId === null
      ? { output: `File association not found for extension ${text}`, exitCode: 1 }
      : { output: `${text}=${progId}`, exitCode: 0 };
  }
  const extension = text.slice(0, equals).trim();
  const progId = text.slice(equals + 1).trim();
  const address = classes(extension);
  if (extension === '' || !(host.isAdmin || host.registry.writesUserHive(address))) return { output: DENIED, exitCode: 1 };
  if (progId === '') {
    if (host.registry.keyView(address) === null) return { output: `File association not found for extension ${extension}`, exitCode: 1 };
    host.registry.deleteKey(address);
    return { output: '', exitCode: 0 };
  }
  host.registry.setValue(address, '', 'String', progId);
  return { output: `${extension}=${progId}`, exitCode: 0 };
}

export function cmdFtype(host: AssocHost, argument: string): RegResult {
  const text = argument.trim();
  if (text === '/?') return { output: FTYPE_HELP, exitCode: 0 };
  const openCommand = (progId: string): string | null => defaultOf(host, classes(progId, ...OPEN_COMMAND));
  if (text === '') {
    const lines = sortedKeys(host, name => !name.startsWith('.'))
      .flatMap(name => {
        const command = openCommand(name);
        return command === null ? [] : [`${name}=${command}`];
      });
    return { output: lines.join('\n'), exitCode: 0 };
  }
  const equals = text.indexOf('=');
  if (equals < 0) {
    const command = openCommand(text);
    return command === null
      ? { output: `File type '${text}' not found or no open command associated with it.`, exitCode: 1 }
      : { output: `${text}=${command}`, exitCode: 0 };
  }
  const progId = text.slice(0, equals).trim();
  const command = text.slice(equals + 1).trim();
  const address = classes(progId, ...OPEN_COMMAND);
  if (progId === '' || !(host.isAdmin || host.registry.writesUserHive(address))) return { output: DENIED, exitCode: 1 };
  if (command === '') {
    if (openCommand(progId) === null) return { output: `File type '${progId}' not found or no open command associated with it.`, exitCode: 1 };
    host.registry.deleteKey(classes(progId, 'shell', 'open'));
    return { output: '', exitCode: 0 };
  }
  host.registry.setValue(address, '', 'String', command);
  return { output: `${progId}=${command}`, exitCode: 0 };
}
