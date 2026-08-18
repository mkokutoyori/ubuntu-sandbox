import type { DebugPair } from './debugFamily';
import { CliInvalidInput } from '@/network/devices/shells/cli/CliDiagnostic';

export interface RouterDebugHost {
  getDebugService(): {
    enable(category: string, scope?: string, detail?: boolean): string;
    disable(category: string): string;
  };
  _getIPSecEngineInternal?: () => {
    setDebug(kind: string, on: boolean): void;
    setDebugDetail?: (kind: string, detail: boolean) => void;
  } | undefined;
  _getOrCreateIPSecEngine?: () => {
    setDebug(kind: string, on: boolean): void;
    setDebugDetail?: (kind: string, detail: boolean) => void;
  };
  _getDHCPServerInternal?: () => {
    setDebugServerPacket(on: boolean): void;
    setDebugServerEvents(on: boolean): void;
    getDebugFlags(): { serverPacket: boolean; serverEvents: boolean };
  } | undefined;
  _getOSPFEngineInternal?: () => { logAdjacencyChanges: boolean } | undefined;
}

export const IKEV2_NO_TRACE = '% IKEv2 has no trace point on this platform:'
  + ' the IPSec engine emits its exchange on the ISAKMP channel';

export const PKI_NO_TRACE = '% Crypto PKI has no trace point on this platform:'
  + ' the certificate engine publishes no enrolment or validation event';

const OSPF_DEBUG_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ['adj', 'ip.ospf.adj'],
  ['events', 'ip.ospf.events'],
  ['spf', 'ip.ospf.spf'],
  ['hello', 'ip.ospf.hello'],
  ['packet', 'ip.ospf.packet'],
  ['lsa-generation', 'ip.ospf.lsa-generation'],
];

function ospfCategory(args: string[]): string | null {
  const flag = args.join(' ').toLowerCase();
  if (!flag) return 'ip.ospf.adj';
  for (const [word, category] of OSPF_DEBUG_CATEGORIES) {
    if (word.startsWith(flag)) return category;
  }
  return null;
}

function cryptoPair(
  host: () => RouterDebugHost, verb: 'isakmp' | 'ipsec', category: string,
): DebugPair {
  const label = verb.toUpperCase();
  return {
    path: ['debug', 'crypto', verb],
    description: `Enable ${label} debug output`,
    undoDescription: `Disable ${label} debug output`,
    takesArguments: true,
    subKeywords: [{ keyword: 'detail', description: `Detailed ${label} output` }],
    enable: (args) => {
      const detail = /^detail$/i.test(args.join(' ').trim());
      const engine = host()._getOrCreateIPSecEngine?.();
      engine?.setDebug(verb, true);
      engine?.setDebugDetail?.(verb, detail);
      return detail
        ? host().getDebugService().enable(category, 'detail')
        : host().getDebugService().enable(category);
    },
    disable: () => {
      host()._getIPSecEngineInternal?.()?.setDebug(verb, false);
      return host().getDebugService().disable(category);
    },
  };
}

function refusalPair(
  word: string, description: string, message: string,
): DebugPair {
  return {
    path: ['debug', 'crypto', word],
    description,
    undoDescription: `Disable ${description}`,
    takesArguments: true,
    enable: () => message,
    disable: () => message,
  };
}

export function routerOnlyDebugPairs(host: () => RouterDebugHost): DebugPair[] {
  const dhcp = () => host()._getDHCPServerInternal?.();
  const svc = () => host().getDebugService();
  return [
    cryptoPair(host, 'isakmp', 'crypto.isakmp'),
    cryptoPair(host, 'ipsec', 'crypto.ipsec'),
    refusalPair('ikev2', 'IKEv2 debug output', IKEV2_NO_TRACE),
    refusalPair('pki', 'PKI debug', PKI_NO_TRACE),
    {
      path: ['debug', 'ip', 'dhcp', 'server'],
      description: 'Debug DHCP server',
      undoDescription: 'Disable DHCP server debugging',
      takesArguments: false,
      enable: () => {
        dhcp()?.setDebugServerPacket(true);
        dhcp()?.setDebugServerEvents(true);
        svc().enable('ip.dhcp.server');
        return 'DHCP server debugging is on';
      },
      disable: () => {
        dhcp()?.setDebugServerPacket(false);
        dhcp()?.setDebugServerEvents(false);
        svc().disable('ip.dhcp.server');
        return 'DHCP server debugging is off';
      },
    },
    {
      path: ['debug', 'ip', 'dhcp', 'server', 'packets'],
      description: 'Debug DHCP server packets',
      undoDescription: 'Disable DHCP packet debugging',
      takesArguments: false,
      enable: () => {
        dhcp()?.setDebugServerPacket(true);
        svc().enable('ip.dhcp.server', 'packet');
        return 'DHCP server packet debugging is on';
      },
      disable: () => {
        dhcp()?.setDebugServerPacket(false);
        if (!dhcp()?.getDebugFlags().serverEvents) svc().disable('ip.dhcp.server');
        return 'DHCP server packet debugging is off';
      },
    },
    {
      path: ['debug', 'ip', 'dhcp', 'server', 'events'],
      description: 'Debug DHCP server events',
      undoDescription: 'Disable DHCP event debugging',
      takesArguments: false,
      enable: () => {
        dhcp()?.setDebugServerEvents(true);
        svc().enable('ip.dhcp.server', 'events');
        return 'DHCP server event debugging is on';
      },
      disable: () => {
        dhcp()?.setDebugServerEvents(false);
        if (!dhcp()?.getDebugFlags().serverPacket) svc().disable('ip.dhcp.server');
        return 'DHCP server event debugging is off';
      },
    },
    {
      path: ['debug', 'ip', 'dhcp', 'server', 'linkage'],
      description: 'Debug DHCP database linkage',
      undoDescription: 'Disable DHCP linkage debugging',
      takesArguments: false,
      enable: () => {
        svc().enable('ip.dhcp.server', 'linkage');
        return 'DHCP server linkage debugging is on';
      },
      disable: () => {
        svc().disable('ip.dhcp.server');
        return 'DHCP server linkage debugging is off';
      },
    },
    {
      path: ['debug', 'ip', 'ospf'],
      description: 'Enable OSPF debugging',
      undoDescription: 'Disable OSPF debugging',
      takesArguments: true,
      subKeywords: OSPF_DEBUG_CATEGORIES.map(([word]) => ({
        keyword: word, description: `Debug OSPF ${word}`,
      })),
      enable: (args) => {
        const category = ospfCategory(args);
        if (!category) throw new CliInvalidInput({ token: args[0] });
        const ospf = host()._getOSPFEngineInternal?.();
        if (ospf) ospf.logAdjacencyChanges = true;
        return svc().enable(category);
      },
      disable: (args) => {
        const category = ospfCategory(args);
        if (!category) throw new CliInvalidInput({ token: args[0] });
        const ospf = host()._getOSPFEngineInternal?.();
        if (ospf) ospf.logAdjacencyChanges = false;
        return svc().disable(category);
      },
    },
  ];
}
