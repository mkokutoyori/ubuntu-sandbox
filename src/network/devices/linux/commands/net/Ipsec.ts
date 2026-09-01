import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import {
  parseIpsecConf, parseIpsecSecrets, secretFor, ikeVersionOf, authClassOf,
  type IpsecConn,
} from '../../ipsec/IpsecConf';

const UNIT = 'strongswan-starter';
const CONF_PATH = '/etc/ipsec.conf';
const SECRETS_PATH = '/etc/ipsec.secrets';
const VERSION = '5.9.8';

function conns(ctx: LinuxCommandContext): IpsecConn[] {
  const text = ctx.executor.vfs.readFile(CONF_PATH);
  if (text === undefined || text === null) return [];
  return [...parseIpsecConf(text).conns];
}

function findConn(ctx: LinuxCommandContext, name: string): IpsecConn | undefined {
  return conns(ctx).find(c => c.name === name);
}

function endpoint(conn: IpsecConn, side: 'left' | 'right'): string {
  return conn.settings.get(side) ?? '%any';
}

function selectors(conn: IpsecConn, side: 'left' | 'right'): string {
  return conn.settings.get(`${side}subnet`) ?? `${endpoint(conn, side)}/32`;
}

function pad12(name: string): string {
  return name.length >= 12 ? name : ' '.repeat(12 - name.length) + name;
}

function identityOf(conn: IpsecConn, side: 'left' | 'right'): string {
  return conn.settings.get(`${side}id`) ?? endpoint(conn, side);
}

function connectionLines(conn: IpsecConn): string[] {
  const head = `${pad12(conn.name)}:  ${endpoint(conn, 'left')}...${endpoint(conn, 'right')}`
    + `  ${ikeVersionOf(conn)}`;
  const mode = (conn.settings.get('type') ?? 'tunnel').toUpperCase();
  return [
    head,
    `${pad12(conn.name)}:   local:  [${identityOf(conn, 'left')}] uses ${authClassOf(conn, 'left')} authentication`,
    `${pad12(conn.name)}:   remote: [${identityOf(conn, 'right')}] uses ${authClassOf(conn, 'right')} authentication`,
    `${pad12(conn.name)}:   child:  ${selectors(conn, 'left')} === ${selectors(conn, 'right')} ${mode}`,
  ];
}

function listeningAddresses(ctx: LinuxCommandContext): string[] {
  const out: string[] = [];
  for (const [, port] of ctx.net.getPorts()) {
    const ip = port.getIPAddress()?.toString();
    if (ip && ip !== '127.0.0.1') out.push(ip);
  }
  return out;
}

const NO_NEGOTIATION =
  'ipsec: this build has no IKE daemon on a Linux host — the configuration is read '
  + 'and checked, but no SA can be established from here';

export const ipsecCommand: LinuxCommand = {
  name: 'ipsec',
  package: 'strongswan',
  needsNetworkContext: true,
  binaryPath: '/usr/sbin/ipsec',
  usage: 'ipsec <command> [arguments]',
  run(ctx: LinuxCommandContext, argv: string[]): string {
    return ipsecCommand.runWithStatus!(ctx, argv) as unknown as string;
  },
  runWithStatus(ctx: LinuxCommandContext, argv: string[]) {
    const mgr = ctx.executor.serviceMgr;
    const verb = argv[0] ?? '';

    if (!verb) {
      return Promise.resolve({
        output: [
          'Usage: ipsec <command> [arguments]',
          '',
          'Commands:',
          '  start        start the IPsec subsystem',
          '  stop         stop the IPsec subsystem',
          '  restart      restart the IPsec subsystem',
          '  status       show IPsec status',
          '  statusall    show detailed IPsec status',
          '  up <conn>    bring up a connection',
          '  down <conn>  tear down a connection',
          '  reload       reload configuration',
          '  version      show strongSwan version',
        ].join('\n'),
        exitCode: 0,
      });
    }

    const running = () => mgr.isActive(UNIT);
    const notRunning = { output: 'IPsec is not running', exitCode: 1 };
    const failed = (r: { error?: string }) =>
      ({ output: r.error ?? 'ipsec: failed to start', exitCode: 1 });

    switch (verb) {
      case 'start': {
        const r = mgr.start(UNIT);
        if (!r.ok) return Promise.resolve(failed(r));
        return Promise.resolve({
          output: `Starting strongSwan ${VERSION} IPsec [starter]...`, exitCode: 0,
        });
      }
      case 'stop':
        mgr.stop(UNIT);
        return Promise.resolve({ output: 'Stopping strongSwan IPsec...', exitCode: 0 });
      case 'restart': {
        const r = running() ? mgr.restart(UNIT) : mgr.start(UNIT);
        if (!r.ok) return Promise.resolve(failed(r));
        return Promise.resolve({
          output: `Stopping strongSwan IPsec...\nStarting strongSwan ${VERSION} IPsec [starter]...`,
          exitCode: 0,
        });
      }
      case 'reload':
        if (!running()) return Promise.resolve(notRunning);
        return Promise.resolve({
          output: 'Reloading strongSwan IPsec configuration...', exitCode: 0,
        });
      case 'version':
        return Promise.resolve({
          output: `Linux strongSwan U${VERSION}/K5.15.0-generic\n`
            + 'University of Applied Sciences Rapperswil, Switzerland',
          exitCode: 0,
        });
      case 'status':
        if (!running()) return Promise.resolve(notRunning);
        return Promise.resolve({
          output: 'Security Associations (0 up, 0 connecting):\n  none', exitCode: 0,
        });
      case 'statusall': {
        if (!running()) return Promise.resolve(notRunning);
        const lines = [
          `Status of IKE charon daemon (strongSwan ${VERSION}, Linux 5.15.0-generic, x86_64):`,
          '  uptime: 0 seconds, since now',
          '  worker threads: 16 of 16 idle, 5/0/0/0 working, job queue: 0/0/0/0',
          '  loaded plugins: charon aes sha2 sha1 md5 hmac pem x509 kernel-netlink',
        ];
        const addresses = listeningAddresses(ctx);
        if (addresses.length > 0) {
          lines.push('Listening IP addresses:');
          for (const address of addresses) lines.push(`  ${address}`);
        }
        const loaded = conns(ctx);
        if (loaded.length > 0) {
          lines.push('Connections:');
          for (const conn of loaded) lines.push(...connectionLines(conn));
        }
        lines.push('Security Associations (0 up, 0 connecting):', '  none');
        return Promise.resolve({ output: lines.join('\n'), exitCode: 0 });
      }
      case 'up': {
        if (!running()) return Promise.resolve(notRunning);
        const name = argv[1] ?? '';
        if (!name) return Promise.resolve({ output: 'Usage: ipsec up <connection-name>', exitCode: 1 });
        const conn = findConn(ctx, name);
        if (!conn) {
          return Promise.resolve({ output: `no config named '${name}'`, exitCode: 1 });
        }
        const secretsText = ctx.executor.vfs.readFile(SECRETS_PATH) ?? '';
        const psk = secretFor(
          parseIpsecSecrets(secretsText), endpoint(conn, 'left'), endpoint(conn, 'right'));
        const head = `initiating IKE_SA ${name}[1] to ${endpoint(conn, 'right')}`;
        if (authClassOf(conn, 'left') === 'pre-shared key' && !psk) {
          return Promise.resolve({
            output: '',
            stderr: `${head}\nno shared key found for '${endpoint(conn, 'left')}'`
              + ` - '${endpoint(conn, 'right')}'`,
            exitCode: 1,
          });
        }
        return Promise.resolve({ output: '', stderr: `${head}\n${NO_NEGOTIATION}`, exitCode: 1 });
      }
      case 'down': {
        if (!running()) return Promise.resolve(notRunning);
        const name = argv[1] ?? '';
        if (!name) return Promise.resolve({ output: 'Usage: ipsec down <connection-name>', exitCode: 1 });
        if (!findConn(ctx, name)) {
          return Promise.resolve({ output: `no config named '${name}'`, exitCode: 1 });
        }
        return Promise.resolve({ output: '', exitCode: 0 });
      }
      default:
        return Promise.resolve({ output: `unknown command: ${verb}`, exitCode: 1 });
    }
  },
};
