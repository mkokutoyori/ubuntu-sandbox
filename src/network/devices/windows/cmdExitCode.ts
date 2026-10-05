const FAILURE_MARKERS = [
  'the system cannot find the path specified',
  'the system cannot find the file specified',
  'is not recognized as an internal or external command',
  'access is denied',
  'the syntax of the command is incorrect',
  'the network path was not found',
  'a duplicate name exists',
  'the parameter is incorrect',
  'the filename, directory name, or volume label syntax is incorrect',
  'file not found',
  'could not find',
  'cannot find',
  'invalid switch',
  'not defined',
];

export function commandExitCode(output: string): number {
  const firstLine = output.split('\n').find(line => line.trim() !== '')?.trim().toLowerCase() ?? '';
  if (firstLine === '') return 0;
  if (firstLine.startsWith('error:')) return 1;
  return FAILURE_MARKERS.some(marker => firstLine.includes(marker)) ? 1 : 0;
}
