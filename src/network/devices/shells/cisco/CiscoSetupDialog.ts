import type { CommandInteractionPlan, InteractionStep } from '@/shell/interaction/CommandInteraction';

export interface SetupTarget {
  hostname: string;
  interfaceNames: string[];
}

const PREAMBLE = [
  '',
  'At any point you may enter a question mark \'?\' for help.',
  'Use ctrl-c to abort configuration dialog at any prompt.',
  'Default settings are in square brackets \'[]\'.',
  '',
  'Basic management setup configures only enough connectivity',
  'for management of the system, extended setup will ask you',
  'to configure each interface on the system',
  '',
];

const ENABLE_SECRET_HELP = [
  '',
  '  The enable secret is a password used to protect access to',
  '  privileged EXEC and configuration modes. This password, after',
  '  entered, becomes encrypted in the configuration.',
];

const ENABLE_PASSWORD_HELP = [
  '  The enable password is used when you do not specify an',
  '  enable secret password, with some older software versions, and',
  '  some boot images.',
];

const VTY_PASSWORD_HELP = [
  '  The virtual terminal password is used to protect',
  '  access to the router over a network interface.',
];

export function isYesAnswer(value: string, byDefault: boolean): boolean {
  const answer = value.trim().toLowerCase();
  if (answer === '') return byDefault;
  return answer.startsWith('y');
}

function scriptLines(values: Map<string, string>, target: SetupTarget): string[] {
  const lines = ['!'];
  const hostname = values.get('setup_hostname')?.trim() || target.hostname;
  lines.push(`hostname ${hostname}`);
  const secret = values.get('setup_enable_secret')?.trim();
  if (secret) lines.push(`enable secret ${secret}`);
  const password = values.get('setup_enable_password')?.trim();
  if (password) lines.push(`enable password ${password}`);
  const vty = values.get('setup_vty_password')?.trim();
  if (vty) lines.push('line vty 0 4', `password ${vty}`, 'login', 'exit');
  for (const name of target.interfaceNames) {
    const wanted = values.get(`setup_iface_${name}`) ?? 'no';
    if (!isYesAnswer(wanted, false)) continue;
    const ip = values.get(`setup_ip_${name}`)?.trim();
    const mask = values.get(`setup_mask_${name}`)?.trim();
    lines.push(`interface ${name}`);
    if (ip && mask) lines.push(`ip address ${ip} ${mask}`);
    lines.push('no shutdown', 'exit');
  }
  lines.push('!', 'end');
  return lines;
}

function globalParameterSteps(target: SetupTarget): InteractionStep[] {
  return [
    { kind: 'output', lines: ['', 'Configuring global parameters:', ''] },
    {
      kind: 'text',
      prompt: `  Enter host name [${target.hostname}]: `,
      storeAs: 'setup_hostname',
      allowEmpty: true,
    },
    { kind: 'output', lines: ENABLE_SECRET_HELP },
    { kind: 'text', prompt: '  Enter enable secret: ', storeAs: 'setup_enable_secret', allowEmpty: true },
    { kind: 'output', lines: ENABLE_PASSWORD_HELP },
    { kind: 'text', prompt: '  Enter enable password: ', storeAs: 'setup_enable_password', allowEmpty: true },
    { kind: 'output', lines: VTY_PASSWORD_HELP },
    { kind: 'text', prompt: '  Enter virtual terminal password: ', storeAs: 'setup_vty_password', allowEmpty: true },
  ];
}

function interfaceSteps(target: SetupTarget): InteractionStep[] {
  const steps: InteractionStep[] = [
    { kind: 'output', lines: ['', 'Configuring interface parameters:', ''] },
  ];
  for (const name of target.interfaceNames) {
    steps.push({
      kind: 'text',
      prompt: `Do you want to configure ${name} interface? [no]: `,
      storeAs: `setup_iface_${name}`,
      allowEmpty: true,
    });
    steps.push({
      kind: 'text',
      prompt: '  Configure IP on this interface? [no]: ',
      storeAs: `setup_ipon_${name}`,
      allowEmpty: true,
    });
    steps.push({
      kind: 'text',
      prompt: '    IP address for this interface: ',
      storeAs: `setup_ip_${name}`,
      allowEmpty: true,
    });
    steps.push({
      kind: 'text',
      prompt: '    Subnet mask for this interface [255.255.255.0]: ',
      storeAs: `setup_mask_${name}`,
      allowEmpty: true,
    });
  }
  return steps;
}

export function setupInteractionPlan(target: SetupTarget): CommandInteractionPlan {
  return {
    steps: [
      { kind: 'output', lines: ['', '         --- System Configuration Dialog ---', ''] },
      {
        kind: 'text',
        prompt: 'Continue with configuration dialog? [yes/no]: ',
        storeAs: 'setup_continue',
        allowEmpty: true,
        validate: (value) => (isYesAnswer(value, true)
          ? { valid: true }
          : { valid: false, errorMessage: '', maxRetries: 0 }),
      },
      { kind: 'output', lines: PREAMBLE },
      ...globalParameterSteps(target),
      ...interfaceSteps(target),
      {
        kind: 'run',
        run: async (rt) => {
          const script = scriptLines(rt.values, target);
          rt.output([
            '',
            'The following configuration command script was created:',
            '',
            ...script,
            '',
          ].join('\n'));
        },
      },
      {
        kind: 'text',
        prompt: '[0] Go to the IOS command prompt without saving this config.\n'
          + '[1] Return back to the setup without saving this config.\n'
          + '[2] Save this configuration to nvram and exit.\n\n'
          + 'Enter your selection [2]: ',
        storeAs: 'setup_selection',
        allowEmpty: true,
      },
      {
        kind: 'run',
        run: async (rt) => {
          const selection = (rt.values.get('setup_selection') ?? '').trim() || '2';
          if (selection === '0' || selection === '1') {
            rt.output('');
            return;
          }
          await rt.exec('configure terminal');
          for (const command of scriptLines(rt.values, target)) {
            if (command === '!') continue;
            await rt.exec(command);
          }
          await rt.exec('write memory');
          rt.output([
            'Building configuration...',
            '[OK]',
            '',
            'Use the enabled mode \'configure\' command to modify this configuration.',
            '',
          ].join('\n'));
        },
      },
    ],
  };
}
