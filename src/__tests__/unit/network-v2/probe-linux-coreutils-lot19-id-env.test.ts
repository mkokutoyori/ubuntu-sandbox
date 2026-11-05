/*
/*
 * id, env and printenv ignored most of their grammar. IdCommand.ts ports id.c 9.4 (option checks in the
 * order of the source, -z with one NUL per record and two between users, numeric specs, per-user
 * diagnostics with exit status 1, -Z refused on a kernel without SELinux). EnvCommand.ts ports env.c 9.4
 * (-i, -0, -u, -C, -S with its escapes and ${VAR} expansion, -v debug lines, --default/--ignore/--block-signal
 * validation, exit status 125 for its own failures, 127 for a missing command) and printenv.c. The
 * generic option guard no longer carries a second copy of these three grammars, the second env parser used for network
 * commands is the same plan, and a group sharing the primary gid of a user is listed once.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). Rows depending on who runs the command (HOME, the dev container's own
 * environment) are not pinned.
 *
 * Measured against the commit before (worktree): 105 of 155 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ROOT:id", "uid=0(root) gid=0(root) groups=0(root)\n[0]"],
  ["ROOT:id -u", "0\n[0]"],
  ["ROOT:id -g", "0\n[0]"],
  ["ROOT:id -un", "root\n[0]"],
  ["ROOT:id -gn", "root\n[0]"],
  ["ROOT:id -G", "0\n[0]"],
  ["ROOT:id -Gn", "root\n[0]"],
  ["ROOT:id -r -u", "0\n[0]"],
  ["ROOT:id -ur", "0\n[0]"],
  ["ROOT:id -nr", "id: cannot print only names or real IDs in default format\n[1]"],
  ["ROOT:id -n", "id: cannot print only names or real IDs in default format\n[1]"],
  ["ROOT:id -r", "id: cannot print only names or real IDs in default format\n[1]"],
  ["ROOT:id -u -g", "id: cannot print \"only\" of more than one choice\n[1]"],
  ["ROOT:id -ug", "id: cannot print \"only\" of more than one choice\n[1]"],
  ["ROOT:id -gG", "id: cannot print \"only\" of more than one choice\n[1]"],
  ["ROOT:id -z", "id: option --zero not permitted in default format\n[1]"],
  ["ROOT:id -zu", "0\u0000[0]"],
  ["ROOT:id -zG", "0\u0000[0]"],
  ["ROOT:id -zGn", "root\u0000[0]"],
  ["ROOT:id -Z", "id: --context (-Z) works only on an SELinux-enabled kernel\n[1]"],
  ["ROOT:id -Zu", "id: --context (-Z) works only on an SELinux-enabled kernel\n[1]"],
  ["ROOT:id -a", "uid=0(root) gid=0(root) groups=0(root)\n[0]"],
  ["ROOT:id -au", "0\n[0]"],
  ["ROOT:id --bogus", "id: unrecognized option '--bogus'\nTry 'id --help' for more information.\n[1]"],
  ["ROOT:id -x", "id: invalid option -- 'x'\nTry 'id --help' for more information.\n[1]"],
  ["ROOT:id nosuchuser", "id: 'nosuchuser': no such user\n[1]"],
  ["ROOT:id root", "uid=0(root) gid=0(root) groups=0(root)\n[0]"],
  ["ROOT:id 0", "uid=0(root) gid=0(root) groups=0(root)\n[0]"],
  ["ROOT:id 99999", "id: '99999': no such user\n[1]"],
  ["ROOT:id ''", "id: '': no such user: No such file or directory\n[1]"],
  ["ROOT:id root nosuchuser", "uid=0(root) gid=0(root) groups=0(root)\nid: 'nosuchuser': no such user\n[1]"],
  ["ROOT:id nosuchuser root", "id: 'nosuchuser': no such user\nuid=0(root) gid=0(root) groups=0(root)\n[1]"],
  ["ROOT:id -un root", "root\n[0]"],
  ["ROOT:id -u root", "0\n[0]"],
  ["ROOT:id -G root", "0\n[0]"],
  ["ROOT:id -zG root root", "0\u0000\u00000\u0000\u0000[0]"],
  ["ROOT:id -Gn root root", "root\nroot\n[0]"],
  ["ROOT:id root root", "uid=0(root) gid=0(root) groups=0(root)\nuid=0(root) gid=0(root) groups=0(root)\n[0]"],
  ["ROOT:id --user", "0\n[0]"],
  ["ROOT:id --group --name", "root\n[0]"],
  ["ROOT:id --groups --name", "root\n[0]"],
  ["ROOT:id --real --user", "0\n[0]"],
  ["ROOT:id --zero --groups", "0\u0000[0]"],
  ["ROOT:id --us", "0\n[0]"],
  ["ROOT:id --gr", "id: option '--gr' is ambiguous; possibilities: '--group' '--groups'\nTry 'id --help' for more information.\n[1]"],
  ["ROOT:id --name", "id: cannot print only names or real IDs in default format\n[1]"],
  ["ROOT:id --user=1", "id: option '--user' doesn't allow an argument\nTry 'id --help' for more information.\n[1]"],
  ["ROOT:id -- root", "uid=0(root) gid=0(root) groups=0(root)\n[0]"],
  ["ROOT:id -u -- root", "0\n[0]"],
  ["ROOT:id daemon", "uid=1(daemon) gid=1(daemon) groups=1(daemon)\n[0]"],
  ["ROOT:id -G daemon", "1\n[0]"],
  ["ROOT:id -Gn nobody", "nogroup\n[0]"],
  ["ROOT:id nobody", "uid=65534(nobody) gid=65534(nogroup) groups=65534(nogroup)\n[0]"],
  ["env -i", "[0]"],
  ["env -u HOME printenv HOME", "[1]"],
  ["env A=1 printenv A", "1\n[0]"],
  ["env A=1 B=2 printenv A B", "1\n2\n[0]"],
  ["env A= printenv A", "\n[0]"],
  ["env A=1 A=2 printenv A", "2\n[0]"],
  ["env -i A=1 env", "A=1\n[0]"],
  ["env -i A=1 B=2 env", "A=1\nB=2\n[0]"],
  ["env -i A=1 -0 B=2 env", "env: '-0': No such file or directory\n[127]"],
  ["env -0 -i A=1", "A=1\u0000[0]"],
  ["env -0 -i A=1 B=2 | od -c | head -2", "0000000   A   =   1  \\0   B   =   2  \\0\n0000010\n[0]"],
  ["env -0 A=1 printenv A", "env: cannot specify --null (-0) with command\nTry 'env --help' for more information.\n[125]"],
  ["env -0 -i", "[0]"],
  ["env -i -0", "[0]"],
  ["env --null -i A=1", "A=1\u0000[0]"],
  ["env --bogus", "env: unrecognized option '--bogus'\nTry 'env --help' for more information.\n[125]"],
  ["env -x", "env: invalid option -- 'x'\nTry 'env --help' for more information.\n[125]"],
  ["env -u", "env: option requires an argument -- 'u'\nTry 'env --help' for more information.\n[125]"],
  ["env -C", "env: option requires an argument -- 'C'\nTry 'env --help' for more information.\n[125]"],
  ["env -C sub pwd", "/tmp/ff/sub\n[0]"],
  ["env -C sub -i pwd", "/tmp/ff/sub\n[0]"],
  ["env --chdir=sub pwd", "/tmp/ff/sub\n[0]"],
  ["env --chdir sub pwd", "/tmp/ff/sub\n[0]"],
  ["env -C nodir pwd", "env: cannot change directory to 'nodir': No such file or directory\n[125]"],
  ["env -C a.txt pwd", "env: cannot change directory to 'a.txt': Not a directory\n[125]"],
  ["env -C sub", "env: must specify command with --chdir (-C)\nTry 'env --help' for more information.\n[125]"],
  ["env -C sub -i", "env: must specify command with --chdir (-C)\nTry 'env --help' for more information.\n[125]"],
  ["env -i -C sub /bin/pwd", "/tmp/ff/sub\n[0]"],
  ["env -S 'A=1 printenv A'", "1\n[0]"],
  ["env -S 'A=\"x y\" printenv A'", "x y\n[0]"],
  ["env -S \"A='x y' printenv A\"", "x y\n[0]"],
  ["env -S 'A=\\_x printenv A'", "env: 'x': No such file or directory\n[127]"],
  ["env -S 'echo a\\tb'", "a\tb\n[0]"],
  ["env -S 'echo ${NOPE}x'", "x\n[0]"],
  ["env -S 'echo $HOME'", "env: only ${VARNAME} expansion is supported, error at: $HOME\n[125]"],
  ["env -S 'echo \"unterminated'", "env: no terminating quote in -S string\n[125]"],
  ["env -S 'echo \\'", "env: invalid backslash at end of string in -S\n[125]"],
  ["env -S 'echo \\q'", "env: invalid sequence '\\q' in -S\n[125]"],
  ["env -S '-i A=1'", "A=1\n[0]"],
  ["env -S'-i A=1' env", "A=1\n[0]"],
  ["env -S '-i' A=1 env", "A=1\n[0]"],
  ["env -vS '-i A=1' env", "split -S:  '-i A=1'\n into:    '-i'\n     &    'A=1'\ncleaning environ\nsetenv:   A=1\nexecuting: env\n   arg[0]= 'env'\nA=1\n[0]"],
  ["env --split-string='A=1 printenv A'", "1\n[0]"],
  ["env --split-string 'A=1 printenv A'", "1\n[0]"],
  ["env -S", "env: option requires an argument -- 'S'\nTry 'env --help' for more information.\n[125]"],
  ["env -iS 'A=1 env'", "A=1\n[0]"],
  ["env nocmd", "env: 'nocmd': No such file or directory\n[127]"],
  ["env nocmd arg", "env: 'nocmd': No such file or directory\n[127]"],
  ["env 'no cmd'", "env: 'no cmd': No such file or directory\nenv: use -[v]S to pass options in shebang lines\n[127]"],
  ["env a.txt", "env: 'a.txt': No such file or directory\n[127]"],
  ["env sub", "env: 'sub': No such file or directory\n[127]"],
  ["env -i nocmd", "env: 'nocmd': No such file or directory\n[127]"],
  ["env - A=1 env", "A=1\n[0]"],
  ["env - -u HOME env", "env: '-u': No such file or directory\n[127]"],
  ["env -- A=1 printenv A", "1\n[0]"],
  ["env -i -- A=1 env", "A=1\n[0]"],
  ["env A=1 -u A printenv A", "env: '-u': No such file or directory\n[127]"],
  ["env -i -u HOME env", "[0]"],
  ["env -u HOME -u PATH printenv HOME PATH", "[1]"],
  ["env -u =x env", "env: cannot unset '=x': Invalid argument\n[125]"],
  ["env -u 'a=b' env", "env: cannot unset 'a=b': Invalid argument\n[125]"],
  ["env -u '' env", "env: cannot unset '': Invalid argument\n[125]"],
  ["env -v A=1 true", "setenv:   A=1\nexecuting: true\n   arg[0]= 'true'\n[0]"],
  ["env -v -i A=1 true", "cleaning environ\nsetenv:   A=1\nexecuting: true\n   arg[0]= 'true'\n[0]"],
  ["env -v -u HOME true", "unset:    HOME\nexecuting: true\n   arg[0]= 'true'\n[0]"],
  ["env -v -C sub true", "chdir:    'sub'\nexecuting: true\n   arg[0]= 'true'\n[0]"],
  ["env -v true", "executing: true\n   arg[0]= 'true'\n[0]"],
  ["env -v printenv A", "executing: printenv\n   arg[0]= 'printenv'\n   arg[1]= 'A'\n[1]"],
  ["env -v nocmd", "executing: nocmd\n   arg[0]= 'nocmd'\nenv: 'nocmd': No such file or directory\n[127]"],
  ["env -v -i", "cleaning environ\n[0]"],
  ["env --debug true", "executing: true\n   arg[0]= 'true'\n[0]"],
  ["env -i true; echo $?", "0\n[0]"],
  ["env false; echo $?", "1\n[0]"],
  ["env sh -c 'exit 5'; echo $?", "5\n[0]"],
  ["env echo hi", "hi\n[0]"],
  ["env echo -- hi", "-- hi\n[0]"],
  ["env -i echo hi", "hi\n[0]"],
  ["env -i env env", "[0]"],
  ["env --ignore-environment A=1 env", "A=1\n[0]"],
  ["env --unset=HOME printenv HOME", "[1]"],
  ["env --unset HOME printenv HOME", "[1]"],
  ["env --ig A=1 env", "env: option '--ig' is ambiguous; possibilities: '--ignore-environment' '--ignore-signal'\nTry 'env --help' for more information.\n[125]"],
  ["env --un HOME printenv HOME", "[1]"],
  ["env --block-signal true", "[0]"],
  ["env --block-signal=PIPE true", "[0]"],
  ["env --default-signal=PIPE true", "[0]"],
  ["env --ignore-signal=PIPE true", "[0]"],
  ["env --ignore-signal true", "[0]"],
  ["env --list-signal-handling true", "[0]"],
  ["env --default-signal=BOGUS true", "env: 'BOGUS': invalid signal\nTry 'env --help' for more information.\n[125]"],
  ["env --block-signal=0 true", "env: '0': invalid signal\nTry 'env --help' for more information.\n[125]"],
  ["env -iv A=1 true", "cleaning environ\nsetenv:   A=1\nexecuting: true\n   arg[0]= 'true'\n[0]"],
  ["env -vi A=1 true", "cleaning environ\nsetenv:   A=1\nexecuting: true\n   arg[0]= 'true'\n[0]"],
  ["env -i0 A=1", "A=1\u0000[0]"],
  ["env -0i A=1", "A=1\u0000[0]"],
  ["env -0u HOME true", "env: cannot specify --null (-0) with command\nTry 'env --help' for more information.\n[125]"],
  ["env -iu HOME env", "[0]"],
  ["printenv A", "[1]"],
  ["printenv -x", "printenv: invalid option -- 'x'\nTry 'printenv --help' for more information.\n[2]"],
  ["printenv --bogus", "printenv: unrecognized option '--bogus'\nTry 'printenv --help' for more information.\n[2]"],
  ["printenv HOME=x", "[1]"],
  ["printenv -", "[1]"],
];

describe('id, env and printenv against the real GNU coreutils', () => {
  it.each(CASES)('%s', async (line, expected) => {
    const machine = await lab();
    const asRoot = (text: string): Promise<string> => machine.executor.runAsUser('root', () => machine.executeCommand(text));
    const root = line.startsWith('ROOT:');
    const command = line.replace(/^ROOT:/, '');
    await asRoot('cd /tmp/ff; chmod -R u+rwx /tmp/ff; rm -rf /tmp/ff/*');
    if (root) await asRoot(`cd /tmp/ff; ${SETUP}`); else await machine.executeCommand(`cd /tmp/ff; ${SETUP}`);
    const script = `cd /tmp/ff; ${command} 2>&1; echo "[$?]"`;
    const answer = root ? await asRoot(script) : await machine.executeCommand(script);
    expect(normalise(answer)).toBe(expected);
  });
});
