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
  'already exists',
];

const NET_ERROR = /NET HELPMSG \d+|^System error \d+ has occurred\./im;
const SERVICE_ERROR = /FAILED (\d+):/;
const SERVICE_ACCESS_DENIED = /^\[SC\][^\n]*FAILED:\s*\n\s*\nAccess is denied\./m;

export function commandExitCode(output: string): number {
  if (NET_ERROR.test(output)) return 2;
  if (SERVICE_ACCESS_DENIED.test(output)) return 5;
  const service = SERVICE_ERROR.exec(output);
  if (service !== null) return Number(service[1]);
  const firstLine = output.split('\n').find(line => line.trim() !== '')?.trim().toLowerCase() ?? '';
  if (firstLine === '') return 0;
  if (firstLine.startsWith('error:')) return 1;
  return FAILURE_MARKERS.some(marker => firstLine.includes(marker)) ? 1 : 0;
}
