import { choice, count, enable, reference, refList, text, word, type FortiTableSpec } from './types';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp'];
const INTERFACE_TARGETS = ['system interface', 'system zone', 'system sdwan zone'];
const SCHEDULE_TARGETS = ['firewall schedule recurring', 'firewall schedule onetime', 'firewall schedule group'];

export const WEB_PROXY_EXPLICIT: FortiTableSpec = {
  path: ['web-proxy', 'explicit'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 247,
  help: 'Configure explicit Web proxy settings.',
  attributes: [
    enable('status', 'Enable/disable the explicit Web proxy for HTTP and HTTPS session.'),
    count('http-incoming-port', 'Accept incoming HTTP requests on one or more ports (0 - 65535, default = 8080).', 0, 65535, 8080),
    choice('sec-default-action', 'Accept or deny explicit web proxy sessions when no web proxy firewall policy exists.', [
      { keyword: 'accept', description: 'Accept requests. All explicit web proxy traffic is accepted whether there is an explicit web proxy policy or not.' },
      { keyword: 'deny', description: 'Deny requests unless there is a matching explicit web proxy policy.' },
    ], 'deny'),
  ],
  onCommit(object, context) {
    const port = Number.parseInt(object.effective('http-incoming-port')[0] ?? '8080', 10);
    if (object.effective('status')[0] === 'enable' && port === 0) {
      return 'the explicit web proxy needs an http-incoming-port between 1 and 65535.';
    }
    context.device.applyExplicitProxy({
      status: object.effective('status')[0] === 'enable',
      port,
      defaultAction: object.effective('sec-default-action')[0] === 'accept' ? 'accept' : 'deny',
    });
  },
};

const NO_OTHER_PROXY = 'only the explicit web proxy exists here; transparent, FTP, SSH, access-proxy and WAN optimisation proxies are not built.';

export const FIREWALL_PROXY_POLICY: FortiTableSpec = {
  path: ['firewall', 'proxy-policy'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 706,
  help: 'Configure proxy policies.',
  attributes: [
    { ...word('policyid', 'Policy ID.'), readOnly: true },
    word('name', 'Policy name.'),
    {
      ...choice('proxy', 'Type of explicit proxy.', [
        { keyword: 'explicit-web', description: 'Explicit Web Proxy.' },
        { keyword: 'transparent-web', description: 'Transparent Web Proxy.' },
        { keyword: 'ftp', description: 'Explicit FTP Proxy.' },
        { keyword: 'ssh', description: 'SSH Proxy.' },
        { keyword: 'ssh-tunnel', description: 'SSH Tunnel.' },
        { keyword: 'access-proxy', description: 'Access Proxy.' },
        { keyword: 'ztna-proxy', description: 'ZTNA Proxy.' },
        { keyword: 'wanopt', description: 'WAN Optimization Proxy.' },
      ], 'explicit-web'),
      unimplementedValues: {
        'transparent-web': NO_OTHER_PROXY, ftp: NO_OTHER_PROXY, ssh: NO_OTHER_PROXY, 'ssh-tunnel': NO_OTHER_PROXY,
        'access-proxy': NO_OTHER_PROXY, 'ztna-proxy': NO_OTHER_PROXY, wanopt: NO_OTHER_PROXY,
      },
    },
    refList('srcintf', 'Source interface names.', INTERFACE_TARGETS),
    refList('dstintf', 'Destination interface names.', INTERFACE_TARGETS),
    refList('srcaddr', 'Source address objects.', ADDRESS_TARGETS),
    refList('dstaddr', 'Destination address objects.', ADDRESS_TARGETS),
    {
      ...choice('action', 'Accept or deny traffic matching the policy parameters.', [
        { keyword: 'accept', description: 'Action accept.' },
        { keyword: 'deny', description: 'Action deny.' },
        { keyword: 'redirect', description: 'Action redirect.' },
      ], 'deny'),
      unimplementedValues: { redirect: 'a redirect needs the replacement-page machinery (redirect-url) the web proxy does not have.' },
    },
    reference('schedule', 'Name of schedule object.', SCHEDULE_TARGETS, 'always'),
    enable('status', 'Enable/disable the active status of the policy.', true),
    text('comments', 'Optional comments.'),
  ],
  onCommit(object, context) {
    context.device.applyProxyPolicy(object.key, {
      id: object.key,
      name: object.effective('name')[0] ?? '',
      srcIntf: [...object.effective('srcintf')],
      dstIntf: [...object.effective('dstintf')],
      srcAddr: object.effective('srcaddr').filter(entry => entry !== 'all'),
      dstAddr: object.effective('dstaddr').filter(entry => entry !== 'all'),
      schedule: object.effective('schedule')[0] ?? 'always',
      action: object.effective('action')[0] === 'accept' ? 'accept' : 'deny',
      enabled: object.effective('status')[0] !== 'disable',
    });
  },
  onDelete(key, context) {
    context.device.removeProxyPolicy(key);
  },
};

export const WEB_PROXY_SPECS: readonly FortiTableSpec[] = Object.freeze([WEB_PROXY_EXPLICIT, FIREWALL_PROXY_POLICY]);
