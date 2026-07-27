/**
 * routerSshFixtures — a router that genuinely answers SSH.
 *
 * Assigning an address is not enough: a device with an IP and nothing
 * listening on port 22 still "accepts" a login as long as the client
 * decides it locally. A fixture built that way passes tests about
 * sessions that were never opened.
 *
 * These builders configure what a real router needs before sshd will
 * talk — a host key, a local account, and a VTY that admits SSH — so a
 * test written against them exercises the wire. Kept in one place so a
 * suite cannot drift back to the IP-only shape.
 */

import type { CiscoRouter } from '@/network/devices/CiscoRouter';
import type { HuaweiRouter } from '@/network/devices/HuaweiRouter';

export const ROUTER_SSH_USER = 'alice';
export const ROUTER_SSH_PASSWORD = 'Alice@123';

/**
 * IOS: RSA key pair (needs a hostname and a domain name first), a local
 * account, and `line vty` set to authenticate against it over SSH only.
 */
export async function configureCiscoSshServer(
  router: CiscoRouter,
  ip: string,
  mask: string,
  opts: { hostname?: string; interfaceName?: string; vtyRange?: string } = {},
): Promise<void> {
  const iface = opts.interfaceName ?? router.getPortNames()[0];
  for (const cmd of [
    'enable',
    'configure terminal',
    ...(opts.hostname ? [`hostname ${opts.hostname}`] : []),
    `interface ${iface}`,
    `ip address ${ip} ${mask}`,
    'no shutdown',
    'exit',
    `username ${ROUTER_SSH_USER} privilege 15 secret ${ROUTER_SSH_PASSWORD}`,
    `enable secret ${ROUTER_SSH_PASSWORD}`,
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'ip ssh version 2',
    `line vty ${opts.vtyRange ?? '0 4'}`,
    'login local',
    'transport input ssh',
    'end',
  ]) await router.executeCommand(cmd);
}

/**
 * VRP: an AAA local-user cleared for STelnet, an RSA key pair, the
 * STelnet server enabled, and a VTY authenticating through AAA.
 */
export async function configureHuaweiSshServer(
  router: HuaweiRouter,
  ip: string,
  mask: string,
  opts: { hostname?: string; interfaceName?: string; vtyRange?: string } = {},
): Promise<void> {
  const iface = opts.interfaceName ?? router.getPortNames()[0];
  for (const cmd of [
    'system-view',
    ...(opts.hostname ? [`sysname ${opts.hostname}`] : []),
    `interface ${iface}`,
    `ip address ${ip} ${mask}`,
    'undo shutdown',
    'quit',
    'aaa',
    `local-user ${ROUTER_SSH_USER} password irreversible-cipher ${ROUTER_SSH_PASSWORD}`,
    `local-user ${ROUTER_SSH_USER} privilege level 15`,
    `local-user ${ROUTER_SSH_USER} service-type ssh terminal`,
    'quit',
    'rsa local-key-pair create',
    'stelnet server enable',
    `ssh user ${ROUTER_SSH_USER} authentication-type password`,
    `ssh user ${ROUTER_SSH_USER} service-type stelnet`,
    `user-interface vty ${opts.vtyRange ?? '0 4'}`,
    'authentication-mode aaa',
    'protocol inbound ssh',
    'quit',
    'quit',
  ]) await router.executeCommand(cmd);
}
