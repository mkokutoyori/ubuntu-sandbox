import type { CommandSpec } from '../../CommandTable';
import type { NatHost } from './natHost';

function requireAddress(host: NatHost, interfaceName: string): string | null {
  const port = host.portOf(interfaceName);
  if (!port) return null;
  if (!port.address && !/^Loopback/i.test(interfaceName) && !/\.\d+$/.test(interfaceName)) {
    return `% Interface ${interfaceName} has no IP address configured.`;
  }
  return null;
}

export function natInterfaceFamily(host: () => NatHost, modes: readonly string[]): CommandSpec[] {
  const onSelected = (run: (h: NatHost, interfaceName: string) => string): string => {
    const h = host();
    const interfaceName = h.selectedInterface();
    return interfaceName ? run(h, interfaceName) : '% No interface selected.';
  };

  return [
    {
      id: 'config-if-ip-nat-inside',
      path: ['ip', 'nat', 'inside'],
      description: 'Mark interface as NAT inside',
      modes, minPrivilege: 15,
      run: () => onSelected((h, interfaceName) => {
        const port = h.portOf(interfaceName);
        if (port && !port.up && /^Loopback/i.test(interfaceName)) {
          return `% Cannot enable ip nat inside: ${interfaceName} is administratively down.`;
        }
        const refusal = requireAddress(h, interfaceName);
        if (refusal) return refusal;
        h.engine().setInsideInterface(interfaceName);
        return '';
      }),
      undoDescription: 'Remove NAT inside designation',
      undo: () => onSelected((h, interfaceName) => {
        h.engine().removeInsideInterface(interfaceName);
        return '';
      }),
    },
    {
      id: 'config-if-ip-nat-outside',
      path: ['ip', 'nat', 'outside'],
      description: 'Mark interface as NAT outside',
      modes, minPrivilege: 15,
      run: () => onSelected((h, interfaceName) => {
        const refusal = requireAddress(h, interfaceName);
        if (refusal) return refusal;
        h.engine().setOutsideInterface(interfaceName);
        return '';
      }),
      undoDescription: 'Remove NAT outside designation',
      undo: () => onSelected((h, interfaceName) => {
        h.engine().removeOutsideInterface(interfaceName);
        return '';
      }),
    },
  ];
}
