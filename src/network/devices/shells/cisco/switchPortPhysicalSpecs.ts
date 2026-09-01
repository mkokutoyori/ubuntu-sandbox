import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface PhysicalPortHost {
  refusePortPhysique(): string | null;
  recordInterfaceLine(line: string): void;
  removeInterfaceLine(prefix: string): void;
}

const MODES = ['config-if'] as const;

const PROTOCOLE: ArgumentSpec = {
  name: 'protocole', type: 'ENUM', description: 'EtherChannel protocol',
  values: [
    { keyword: 'lacp', description: 'Prepare interface for LACP protocol' },
    { keyword: 'pagp', description: 'Prepare interface for PAgP protocol' },
  ],
};

const MODE_POE: ArgumentSpec = {
  name: 'mode', type: 'ENUM', description: 'Inline power mode',
  values: [
    { keyword: 'auto', description: 'Automatically detect and power inline devices' },
    { keyword: 'never', description: 'Never apply inline power' },
    { keyword: 'static', description: 'High priority inline power interface' },
  ],
};

const MILLIWATTS: ArgumentSpec = {
  name: 'milliwatts', type: 'INT', description: 'Power limit in milliwatts',
  range: [4000, 30000],
};

export function switchPortPhysicalSpecs(ctx: () => PhysicalPortHost): CommandSpec[] {
  const surPortPhysique = (appliquer: (host: PhysicalPortHost) => string) => (): string => {
    const host = ctx();
    const refus = host.refusePortPhysique();
    return refus ?? appliquer(host);
  };
  return [
    {
      id: 'config-if-channel-protocol',
      path: ['channel-protocol', PROTOCOLE],
      description: 'Select the channel protocol (PAgP, LACP)',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => surPortPhysique((host) => {
        host.recordInterfaceLine(`channel-protocol ${args.protocole}`);
        return '';
      })(),
      undo: () => surPortPhysique((host) => {
        host.removeInterfaceLine('channel-protocol');
        return '';
      })(),
    },
    {
      id: 'config-if-mdix-auto',
      path: ['mdix', 'auto'],
      description: 'Enable auto MDIX on the interface',
      undoDescription: 'Disable auto MDIX on the interface',
      modes: MODES, minPrivilege: 15,
      run: () => surPortPhysique((host) => {
        host.removeInterfaceLine('no mdix auto');
        return '';
      })(),
      undo: () => surPortPhysique((host) => {
        host.recordInterfaceLine('no mdix auto');
        return '';
      })(),
    },
    {
      id: 'config-if-power-inline',
      path: ['power', 'inline', MODE_POE],
      description: 'Inline power configuration',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => surPortPhysique((host) => {
        host.recordInterfaceLine(`power inline ${args.mode}`);
        return '';
      })(),
      undo: () => surPortPhysique((host) => {
        host.removeInterfaceLine('power inline');
        return '';
      })(),
    },
    {
      id: 'config-if-power-inline-max',
      path: ['power', 'inline', MODE_POE, 'max', MILLIWATTS],
      description: 'Inline power configuration',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => surPortPhysique((host) => {
        host.recordInterfaceLine(`power inline ${args.mode} max ${args.milliwatts}`);
        return '';
      })(),
    },
  ];
}
