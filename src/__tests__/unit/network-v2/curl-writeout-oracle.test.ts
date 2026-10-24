/**
 * curl --write-out et lignes de requete, rejoues contre le vrai curl 8.5.0.
 *
 * src/__tests__/support/oracle/curl-writeout-8.5.0.json vient de scripts/oracle/record_curl_writeout.py : le curl installe (8.5.0) interroge un
 * serveur HTTP/1.1 scripte dont les octets de reponse sont conserves dans la fixture. Le simulateur sert ces memes octets depuis une machine
 * a 10.0.0.10 (meme port, hote de meme longueur que 127.0.0.1 : « Host: 10.0.0.10:PORT » pese autant que « Host: 127.0.0.1:PORT »), et
 * compare : la sortie de chaque --write-out, la sortie d'erreur, le code de retour, les fichiers de %output{}, et les lignes « > » de curl -v.
 * Les valeurs qui different d'un lancement a l'autre (durees, debits, port local) sont comparees par leur forme. La syntaxe suit
 * src/tool_writeout.c de curl 8.5.0 : variables insensibles a la casse, « \\q » restitue tel quel, « %z » restitue tel quel, « %{ » sans
 * accolade fermante, %header{}, %output{}, %{stderr}, %{onerror}, %{json}, %{header_json}, http_code sur trois chiffres.
 *
 * Mesure avant correction (git stash de src/network) : 40 cas sur 66 tombent. Le moteur ne connaissait que 17 variables sur 61 (ni
 * size_header, size_request, num_connects, url, urlnum, filename_effective, redirect_url, referer, ssl_verify_result, http_connect, remote_ip
 * d'un echec, url.*, urle.*, les temps de connexion, header_json, json, %header{}, %output{}, %{stderr}, %{onerror}), restituait « \\ »
 * en « \ », ignorait la casse des noms a l'envers, affichait « 0 » au lieu de « 000 » pour http_code d'un echec, envoyait Content-Length: 0
 * sur un GET, plaçait Authorization et les en-tetes personnalises a une autre place que curl, et ecrivait dans /dev/null le corps de la
 * deuxieme URL alors que -o ne vaut que pour la premiere.
 * Passent avant comme apres (26) : les variables deja correctes (http_code d'une reponse 200 : l'idiome `curl -s -o /dev/null -w "%{http_code}\n"`
 * fonctionnait deja, content_type, size_download, scheme, method, http_version, url_effective, exitcode, errormsg, remote_ip, time_total), les
 * lignes de requete de GET, HEAD, -H, -e/-A et -L.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { runCurl } from '@/network/http/curl/CurlEngine';
import type { CurlHost } from '@/network/http/curl/CurlHost';

interface Recorded {
  readonly format: string;
  readonly path: string;
  readonly flags: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
  readonly file: string | null;
}

interface Fixture {
  readonly port: number;
  readonly responses: Readonly<Record<string, readonly number[]>>;
  readonly cases: readonly Recorded[];
  readonly verbose: ReadonlyArray<{ name: string; path: string; flags: readonly string[]; lines: readonly string[]; exit: number }>;
  readonly failures: ReadonlyArray<{ label: string; format: string; url: string; stdout: string; stderr: string; exit: number }>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/curl-writeout-8.5.0.json', import.meta.url), 'utf8')) as Fixture;

const SERVER = '10.0.0.10';
const CLIENT = '10.0.0.11';
const SHAPE_ONLY = /^%\{(time_[a-z]+|speed_[a-z]+)\}$/;

async function lab(): Promise<{ pc: LinuxPC; server: LinuxServer }> {
  const server = new LinuxServer('linux-server', 'web', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  server.powerOn();
  pc.powerOn();
  new Cable('c').connect(server.getPort('eth0') as never, pc.getPort('eth0') as never);
  for (const line of ['ip link set eth0 up', `ip addr add ${SERVER}/24 dev eth0`]) await server.executeCommand(line);
  for (const line of ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`]) await pc.executeCommand(line);
  server.getTcpStack().listen(fixture.port, {
    onAccept: (socket) => {
      socket.onData((data) => {
        const target = String(data).split('\r\n')[0].split(' ')[1]?.split('?')[0] ?? '/';
        const raw = fixture.responses[target] ?? fixture.responses['/missing'];
        socket.write(String.fromCharCode(...raw));
        socket.close();
      });
    },
  });
  return { pc, server };
}

function quote(argument: string): string {
  return `'${argument.replace(/'/g, `'\\''`)}'`;
}

function hostOf(pc: LinuxPC, files: Map<string, string>): CurlHost {
  return {
    resolveHostname: async (name) => (/^\d+\.\d+\.\d+\.\d+$/.test(name) ? name : null),
    tcpStack: () => pc.getTcpStack(),
    interfaceAddress: () => null,
    ownsAddress: () => false,
    trustAnchors: () => [],
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => { files.set(path, content); return true; },
  };
}

const expectedText = (text: string): string => text.replace(/127\.0\.0\.1/g, SERVER);

function stripVolatile(json: string): unknown {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (/^(time_|speed_|local_)/.test(key) || key === 'curl_version') delete parsed[key];
  }
  return parsed;
}

describe('curl --write-out against the recorded curl 8.5.0', () => {
  it('witness: the exact idiom curl -s -o /dev/null -w "%{http_code}\\n" answers 200', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`curl -s -o /dev/null -w "%{http_code}\\n" http://${SERVER}:${fixture.port}/ok`)).toBe('200');
  });

  for (const [index, recorded] of fixture.cases.entries()) {
    it(`#${index} ${recorded.flags.join(' ')} ${recorded.path} -w ${JSON.stringify(recorded.format)}`, async () => {
      const { pc } = await lab();
      const urls = [`http://${SERVER}:${fixture.port}${recorded.path}`];
      if (recorded.flags.includes('URL2')) urls.push(`http://${SERVER}:${fixture.port}/missing`);
      const flags = recorded.flags.filter((f) => f !== 'URL2');
      const outputTarget = flags.includes('-O') ? [] : ['-o', '/dev/null'];
      const outfile = '/tmp/writeout-out.txt';
      const files = new Map<string, string>();
      const run = await runCurl(hostOf(pc, files), ['-s', ...outputTarget, ...flags, '-w', recorded.format.replace('OUTFILE', outfile), ...urls]);
      const stdout = run.output;
      const stderr = run.stderr;
      const exit = run.exitCode;
      expect(exit).toBe(recorded.exit);
      if (SHAPE_ONLY.test(recorded.format)) {
        expect(stdout).toMatch(/^\d+(\.\d{6})?$/);
      } else if (recorded.format === '%{json}') {
        expect(stripVolatile(stdout)).toEqual(stripVolatile(expectedText(recorded.stdout)));
      } else {
        expect(stdout.replace(/\r/g, '\n')).toBe(expectedText(recorded.stdout).replace(/\r/g, '\n'));
      }
      expect(stderr.replace(/\n$/, '')).toBe(expectedText(recorded.stderr).replace(/\n$/, ''));
      if (recorded.file !== null) expect(files.get(outfile)).toBe(recorded.file);
    });
  }

  for (const recorded of fixture.verbose) {
    it(`curl -v request lines: ${recorded.name}`, async () => {
      const { pc } = await lab();
      const run = await runCurl(hostOf(pc, new Map()), ['-sv', '-o', '/dev/null', ...recorded.flags, `http://${SERVER}:${fixture.port}${recorded.path}`]);
      const lines = run.stderr.split('\n').filter((l) => l.startsWith('> '));
      expect(lines).toEqual(recorded.lines.map(expectedText));
    });
  }

  for (const recorded of fixture.failures) {
    it(`a ${recorded.label} transfer prints ${JSON.stringify(recorded.format.slice(0, 30))}...`, async () => {
      const { pc } = await lab();
      const deadPort = Number(/:(\d+)\//.exec(recorded.url)?.[1] ?? 0);
      const url = recorded.label === 'refused' ? `http://${SERVER}:${deadPort}/` : recorded.url;
      const run = await runCurl(hostOf(pc, new Map()), ['-s', '-o', '/dev/null', '-w', recorded.format, url]);
      expect(run.exitCode).toBe(recorded.exit);
      const stdout = run.output.replace(/after \d+ ms/, 'after 0 ms');
      expect(stdout).toBe(expectedText(recorded.stdout).replace(/after \d+ ms/, 'after 0 ms').replace(new RegExp(String(deadPort), 'g'), String(deadPort)));
    });
  }
});
