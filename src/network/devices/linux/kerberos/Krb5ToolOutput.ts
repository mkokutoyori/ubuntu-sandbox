export interface ToolOutput {
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number;
}

export function outputOf(): ToolOutput {
  return { stdout: '', stderr: '', combined: '', exitCode: 0 };
}

export function emit(out: ToolOutput, stream: 'stdout' | 'stderr', text: string): void {
  out[stream] += text;
  out.combined += text;
}

export const KINIT_USAGE = [
  'Usage: kinit [-V] [-l lifetime] [-s start_time] [-r renewable_life]',
  '\t[-f | -F] [-p | -P] [-n] [-a | -A] [-C] [-E]',
  '\t[--request-pac | --no-request-pac]',
  '\t[-v] [-R] [-k [-i|-t keytab_file]] [-c cachename]',
  '\t[-S service_name] [-I input_ccache] [-T ticket_armor_cache]',
  '\t[-X <attribute>[=<value>]] [principal]',
  '',
  '    options:',
  '\t-V verbose',
  '\t-l lifetime',
  '\t-s start time',
  '\t-r renewable lifetime',
  '\t-f forwardable',
  '\t-F not forwardable',
  '\t-p proxiable',
  '\t-P not proxiable',
  '\t-n anonymous',
  '\t-a include addresses',
  '\t-A do not include addresses',
  '\t-v validate',
  '\t-R renew',
  '\t-C canonicalize',
  '\t-E client is enterprise principal name',
  '\t-k use keytab',
  '\t-i use default client keytab (with -k)',
  '\t-t filename of keytab to use',
  '\t-c Kerberos 5 cache name',
  '\t-S service',
  '\t-I input credential cache',
  '\t-T armor credential cache',
  '\t-X <attribute>[=<value>]',
  '\t--{,no}-request-pac request KDC include/exclude a PAC',
].join('\n');

export const KLIST_USAGE = [
  'Usage: klist [-e] [-V] [[-c] [-l] [-A] [-d] [-f] [-s] [-a [-n]]] [-k [-i] [-t] [-K]] [-C] [name]',
  '\t-c specifies credentials cache',
  '\t-k specifies keytab',
  '\t   (Default is credentials cache)',
  '\t-i uses default client keytab if no name given',
  '\t-l lists credential caches in collection',
  '\t-A shows content of all credential caches',
  '\t-e shows the encryption type',
  '\t-V shows the Kerberos version and exits',
  '\toptions for credential caches:',
  '\t\t-d shows the submitted authorization data types',
  '\t\t-f shows credentials flags',
  '\t\t-s sets exit status based on valid tgt existence',
  '\t\t-a displays the address list',
  '\t\t\t-n do not reverse-resolve',
  '\toptions for keytabs:',
  '\t\t-t shows keytab entry timestamps',
  '\t\t-K shows keytab entry keys',
  '\t\t-C includes configuration data entries',
].join('\n');

export const KDESTROY_USAGE = [
  'Usage: kdestroy [-A] [-q] [-c cache_name] [-p princ_name]',
  '\t-A destroy all credential caches in collection',
  '\t-q quiet mode',
  '\t-c specify name of credentials cache',
  '\t-p specify principal name within collection',
].join('\n');
