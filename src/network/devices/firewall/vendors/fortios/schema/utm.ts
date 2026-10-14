import {
  choice, count, enable, reference, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';
import { APPLICATION_SIGNATURES } from '../../../inspection/ApplicationSignatures';
import {
  DEFAULT_OVERSIZE_LIMIT_MB, MIN_OVERSIZE_LIMIT_MB, MAX_OVERSIZE_LIMIT_MB,
} from '../../../inspection/StreamAssembler';

const NO_SIGNATURES = 'this simulator has no FortiGuard signature database, and will '
  + 'have none. Accepting the profile would install an inspection that never '
  + 'inspects — the worst possible defect, since a learner would believe a threat '
  + 'was blocked.';

const NO_WIRE_CLOCK = 'frames are delivered synchronously, with no wire clock, so a '
  + 'shaper cannot slow anything down. Counting without limiting would let a learner '
  + 'believe the limit applies.';

const SCAN_ACTIONS = [
  { keyword: 'block', description: 'Block the infected file.' },
  { keyword: 'monitor', description: 'Log the detection and let the file through.' },
  { keyword: 'disable', description: 'Do not scan.' },
];

const FILTER_ACTIONS = [
  { keyword: 'block', description: 'Block access.' },
  { keyword: 'monitor', description: 'Allow and log.' },
  { keyword: 'allow', description: 'Allow access.' },
];

function scanChannel(name: string, help: string): FortiTableSpec {
  return {
    path: [name],
    kind: 'object',
    scope: 'vdom',
    accessGroup: 'utmgrp',
    renderOrder: 1,
    help,
    attributes: [
      choice('av-scan', 'Enable/disable AV scan service.', SCAN_ACTIONS, 'block'),
      choice('outbreak-prevention', 'Enable virus outbreak prevention service.',
        SCAN_ACTIONS, 'disable'),
    ],
    onCommit() {},
  };
}

export const ANTIVIRUS_PROFILE: FortiTableSpec = {
  path: ['antivirus', 'profile'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 400,
  help: 'Configure AntiVirus profiles.',
  attributes: [
    { ...word('name', 'Profile name.'), readOnly: true },
    text('comment', 'Comment.'),
    choice('feature-set', 'Flow/proxy feature set.', [
      { keyword: 'flow', description: 'Flow-based inspection.' },
      { keyword: 'proxy', description: 'Proxy-based inspection.' },
    ], 'flow'),
  ],
  children: [
    scanChannel('http', 'Configure HTTP AntiVirus options.'),
    scanChannel('ftp', 'Configure FTP AntiVirus options.'),
    scanChannel('smtp', 'Configure SMTP AntiVirus options.'),
  ],
  onCommit(object, context) {
    context.device.applyAntivirusProfile({
      name: object.key,
      http: channelAction(object, 'http'),
      ftp: channelAction(object, 'ftp'),
      smtp: channelAction(object, 'smtp'),
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeAntivirusProfile(key);
  },
};

export const WEBFILTER_PROFILE: FortiTableSpec = {
  path: ['webfilter', 'profile'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 410,
  help: 'Configure Web filter profiles.',
  attributes: [
    { ...word('name', 'Profile name.'), readOnly: true },
    text('comment', 'Comment.'),
    choice('feature-set', 'Flow/proxy feature set.', [
      { keyword: 'flow', description: 'Flow-based inspection.' },
      { keyword: 'proxy', description: 'Proxy-based inspection.' },
    ], 'flow'),
    enable('log-all-url', 'Enable/disable logging all URLs visited.'),
    choice('unclassified-action', 'Action for domains this build cannot classify.',
      FILTER_ACTIONS, 'allow'),
  ],
  children: [
    {
      path: ['web'],
      kind: 'object',
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 411,
      help: 'Configure web content filtering.',
      attributes: [
        count('urlfilter-table', 'URL filter table ID.', 0, 65535, 0),
      ],
      onCommit() {},
    },
    {
      path: ['ftgd-wf'],
      kind: 'object',
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 412,
      help: 'Configure FortiGuard Web Filter service.',
      children: [filterCategories(413)],
      attributes: [],
      onCommit() {},
    },
  ],
  onCommit(object, context) {
    context.device.applyWebFilterProfile({
      name: object.key,
      urlFilterTable: tableReference(object, 'web', 'urlfilter-table'),
      categoryFilters: categoryEntries(object, 'ftgd-wf'),
      unclassifiedAction: object.effective('unclassified-action')[0] ?? 'allow',
      logAllUrl: object.effective('log-all-url')[0] === 'enable',
      featureSet: object.effective('feature-set')[0] ?? 'flow',
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeWebFilterProfile(key);
  },
};

export const DNSFILTER_PROFILE: FortiTableSpec = {
  path: ['dnsfilter', 'profile'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 420,
  help: 'Configure DNS domain filter profiles.',
  attributes: [
    { ...word('name', 'Profile name.'), readOnly: true },
    text('comment', 'Comment.'),
    choice('unclassified-action', 'Action for domains this build cannot classify.',
      FILTER_ACTIONS, 'allow'),
    enable('log-all-domain', 'Enable/disable logging of all domains visited.'),
  ],
  children: [
    {
      path: ['domain-filter'],
      kind: 'object',
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 421,
      help: 'Configure domain filter settings.',
      attributes: [
        count('domain-filter-table', 'Domain filter table ID.', 0, 65535, 0),
      ],
      onCommit() {},
    },
    {
      path: ['ftgd-dns'],
      kind: 'object',
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 422,
      help: 'Configure FortiGuard DNS Filter.',
      children: [filterCategories(423)],
      attributes: [],
      onCommit() {},
    },
  ],
  onCommit(object, context) {
    context.device.applyDnsFilterProfile({
      name: object.key,
      domainFilterTable: tableReference(object, 'domain-filter', 'domain-filter-table'),
      categoryFilters: categoryEntries(object, 'ftgd-dns'),
      unclassifiedAction: object.effective('unclassified-action')[0] ?? 'allow',
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeDnsFilterProfile(key);
  },
};

export const FILE_FILTER_PROFILE: FortiTableSpec = {
  path: ['file-filter', 'profile'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 430,
  help: 'Configure file-filter profiles.',
  attributes: [
    { ...word('name', 'Profile name.'), readOnly: true },
    text('comment', 'Comment.'),
    choice('feature-set', 'Flow/proxy feature set.', [
      { keyword: 'flow', description: 'Flow-based inspection.' },
      { keyword: 'proxy', description: 'Proxy-based inspection.' },
    ], 'flow'),
    enable('scan-archive-contents', 'Enable/disable archive contents scan.'),
    enable('log', 'Enable/disable file-filter logging.', true),
  ],
  children: [
    {
      path: ['rules'],
      kind: 'table',
      keyType: 'name',
      ordered: true,
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 431,
      help: 'File filter rules.',
      attributes: [
        text('comment', 'Comment.'),
        {
          name: 'protocol',
          help: 'Protocols to apply the rule to.',
          quoted: false,
          multiValue: true,
          parts: [{
            name: 'protocol', type: 'ENUM', description: 'Protocol.',
            values: [
              { keyword: 'http-get', description: 'HTTP downloads.' },
              { keyword: 'http-post', description: 'HTTP uploads.' },
              { keyword: 'ftp', description: 'FTP transfers.' },
              { keyword: 'smtp', description: 'SMTP messages.' },
              { keyword: 'imap', description: 'IMAP messages.' },
              { keyword: 'pop3', description: 'POP3 messages.' },
              { keyword: 'cifs', description: 'CIFS transfers.' },
            ],
          }],
          defaultValue: [],
        },
        {
          name: 'file-type',
          help: 'Select file types recognised by their magic number.',
          quoted: true,
          multiValue: true,
          parts: [{
            name: 'file-type', type: 'ENUM', description: 'File type.',
            values: [
              { keyword: 'exe', description: 'Windows executable (MZ).' },
              { keyword: 'zip', description: 'ZIP archive (PK).' },
              { keyword: 'pdf', description: 'PDF document (%PDF-).' },
              { keyword: 'elf', description: 'ELF binary.' },
              { keyword: 'gzip', description: 'gzip archive.' },
              { keyword: 'gif', description: 'GIF image.' },
              { keyword: 'png', description: 'PNG image.' },
              { keyword: 'jpeg', description: 'JPEG image.' },
              { keyword: 'msi', description: 'Windows installer (OLE compound file).' },
              { keyword: 'bat', description: 'Windows batch script.' },
            ],
          }],
          unimplementedValues: {
            bat: 'a batch script has no magic number; this build recognises a file '
              + 'type by its leading bytes, so `bat` could never match.',
          },
          defaultValue: [],
        },
        choice('action', 'Action taken for the matched file.', [
          { keyword: 'block', description: 'Block the file.' },
          { keyword: 'log-only', description: 'Log the file and let it through.' },
        ], 'block'),
        choice('direction', 'Traffic direction.', [
          { keyword: 'any', description: 'Any direction.' },
          { keyword: 'incoming', description: 'Incoming only.' },
          { keyword: 'outgoing', description: 'Outgoing only.' },
        ], 'any'),
      ],
      onCommit() {},
    },
  ],
  onCommit(object, context) {
    context.device.applyFileFilterProfile({
      name: object.key,
      entries: listOf(object, 'rules').map(entry => ({
        id: entry.key,
        fileTypes: [...entry.effective('file-type')],
        action: field(entry, 'action') === 'log-only' ? 'monitor' : 'block',
        direction: field(entry, 'direction') || 'any',
      })),
      scanArchiveContents: object.effective('scan-archive-contents')[0] === 'enable',
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeFileFilterProfile(key);
  },
};

export const SSL_SSH_PROFILE: FortiTableSpec = {
  path: ['firewall', 'ssl-ssh-profile'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 440,
  help: 'Configure SSL/SSH protocol options.',
  predefined: [
    'certificate-inspection', 'deep-inspection',
    'no-inspection', 'custom-deep-inspection',
  ],
  attributes: [
    { ...word('name', 'Profile name.'), readOnly: true },
    text('comment', 'Comment.'),
    choice('server-cert-mode', 'How the server certificate is handled.', [
      { keyword: 're-sign', description: 'Re-sign the server certificate with the CA below.' },
      { keyword: 'replace', description: 'Replace it with a certificate of this FortiGate.' },
    ], 're-sign'),
    reference('caname', 'CA certificate used by SSL inspection.',
      ['vpn certificate local'], 'Fortinet_CA_SSL'),
    reference('untrusted-caname', 'CA used when the server certificate is untrusted.',
      ['vpn certificate local'], 'Fortinet_CA_Untrusted'),
    reference('server-cert', 'Certificate presented under `replace` mode.',
      ['vpn certificate local']),
    choice('untrusted-cert', 'What to do with an untrusted server certificate.', [
      { keyword: 'allow', description: 'Allow the session.' },
      { keyword: 'block', description: 'Block the session.' },
      { keyword: 'ignore', description: 'Ignore the server certificate.' },
    ], 'allow'),
  ],
  children: [
    {
      path: ['ssl-exempt'],
      kind: 'table',
      keyType: 'integer',
      ordered: false,
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 442,
      help: 'Servers to exempt from SSL inspection.',
      attributes: [
        { ...word('id', 'Entry identifier.'), readOnly: true },
        choice('type', 'Type of the exemption.', [
          { keyword: 'fortiguard-category', description: 'Exempt a FortiGuard category.' },
          { keyword: 'address', description: 'Exempt an IPv4 address object.' },
          { keyword: 'address6', description: 'Exempt an IPv6 address object.' },
          { keyword: 'wildcard-fqdn', description: 'Exempt a wildcard FQDN object.' },
          { keyword: 'regex', description: 'Exempt hosts matching a regular expression.' },
        ], 'fortiguard-category'),
        count('fortiguard-category', 'FortiGuard category identifier.', 0, 255, 0),
        reference('address', 'IPv4 address object to exempt.', ['firewall address']),
        reference('address6', 'IPv6 address object to exempt.', ['firewall address6']),
        reference('wildcard-fqdn', 'Wildcard FQDN object to exempt.',
          ['firewall wildcard-fqdn custom']),
        word('regex', 'Regular expression matched against the server name.'),
      ],
    },
    {
      path: ['https'],
      kind: 'object',
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 441,
      help: 'Configure HTTPS options.',
      attributes: [
        {
          name: 'ports', help: 'Ports to scan for content.', quoted: false,
          multiValue: true,
          parts: [{ name: 'ports', type: 'INT', description: 'Port number.', range: [1, 65535] }],
          defaultValue: ['443'],
        },
        {
          ...choice('status', 'Configure protocol inspection status.', [
            { keyword: 'disable', description: 'Do not inspect.' },
            {
              keyword: 'certificate-inspection',
              description: 'Read the SNI of the ClientHello without decrypting.',
            },
            {
              keyword: 'deep-inspection',
              description: 'Intercept and decrypt the session.',
            },
          ], 'certificate-inspection'),
        },
      ],
      onCommit() {},
    },
  ],
  onCommit(object, context) {
    const declared = object.childSetting('https', 'status')[0] ?? 'certificate-inspection';

    context.device.applySslSshProfile({
      name: object.key,
      httpsMode: declared,
      httpsPorts: channelPorts(object, 'https', 443),
      caName: object.effective('caname')[0] ?? 'Fortinet_CA_SSL',
      untrustedCaName: object.effective('untrusted-caname')[0] ?? 'Fortinet_CA_Untrusted',
      serverCertMode: object.effective('server-cert-mode')[0] ?? 're-sign',
      untrustedCert: object.effective('untrusted-cert')[0] ?? 'allow',
      exemptions: object.childEntries('ssl-exempt').map(entry => ({
        type: entry.effective('type')[0] ?? 'fortiguard-category',
        category: Number.parseInt(entry.effective('fortiguard-category')[0] ?? '0', 10),
        regex: entry.effective('regex')[0] || entry.effective('wildcard-fqdn')[0] || undefined,
        addressName: entry.effective('address')[0] || entry.effective('address6')[0] || undefined,
      })),
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeSslSshProfile(key);
  },
};

export const PROTOCOL_OPTIONS: FortiTableSpec = {
  path: ['firewall', 'profile-protocol-options'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 450,
  help: 'Configure protocol options.',
  predefined: ['default'],
  attributes: [
    { ...word('name', 'Profile name.'), readOnly: true },
    text('comment', 'Comment.'),
  ],
  children: [
    portChannel('http', 'Configure HTTP protocol options.', '80'),
    portChannel('https', 'Configure HTTPS protocol options.', '443'),
    portChannel('ftp', 'Configure FTP protocol options.', '21'),
    portChannel('dns', 'Configure DNS protocol options.', '53'),
  ],
  onCommit(object, context) {
    context.device.applyProtocolOptions({
      name: object.key,
      httpPorts: channelPorts(object, 'http', 80),
      httpsPorts: channelPorts(object, 'https', 443),
      ftpPorts: channelPorts(object, 'ftp', 21),
      dnsPorts: channelPorts(object, 'dns', 53),
      oversizeLimitMb: channelNumber(object, 'http', 'oversize-limit',
        DEFAULT_OVERSIZE_LIMIT_MB),
      blockOversize: object.childSetting('http', 'options').includes('oversize'),
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeProtocolOptions(key);
  },
};

function portChannel(name: string, help: string, byDefault: string): FortiTableSpec {
  return {
    path: [name],
    kind: 'object',
    scope: 'vdom',
    accessGroup: 'utmgrp',
    renderOrder: 451,
    help,
    attributes: [
      {
        name: 'ports', help: 'Ports to scan for content.', quoted: false,
        multiValue: true,
        parts: [{ name: 'ports', type: 'INT', description: 'Port number.', range: [1, 65535] }],
        defaultValue: [byDefault],
      },
      enable('status', 'Enable/disable the active status of scanning.', true),
      count('oversize-limit',
        'Maximum in-memory file size that can be scanned, in megabytes.',
        MIN_OVERSIZE_LIMIT_MB, MAX_OVERSIZE_LIMIT_MB, DEFAULT_OVERSIZE_LIMIT_MB),
      {
        ...choice('options', 'One or more options that can be applied to the session.', [
          {
            keyword: 'oversize',
            description: 'Block files larger than oversize-limit instead of'
              + ' letting them through unscanned.',
          },
        ], ''),
        multiValue: true,
        defaultValue: [],
      },
    ],
    onCommit() {},
  };
}

export const APPLICATION_LIST: FortiTableSpec = {
  path: ['application', 'list'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 460,
  help: 'Configure application control lists.',
  attributes: [
    { ...word('name', 'List name.'), readOnly: true },
    text('comment', 'Comment.'),
    choice('other-application-action', 'Action for an application with no entry.', [
      { keyword: 'pass', description: 'Let it through.' },
      { keyword: 'block', description: 'Block it.' },
    ], 'pass'),
  ],
  children: [
    {
      path: ['entries'],
      kind: 'table',
      keyType: 'integer',
      ordered: true,
      scope: 'vdom',
      accessGroup: 'utmgrp',
      renderOrder: 464,
      help: 'Application control entries.',
      attributes: [
        { ...word('id', 'Entry identifier.'), readOnly: true },
        {
          name: 'application',
          help: 'Applications recognised by their own protocol exchange.',
          quoted: true,
          multiValue: true,
          parts: [{
            name: 'application', type: 'ENUM', description: 'Application.',
            values: APPLICATION_SIGNATURES.map(signature => ({
              keyword: signature.name, description: signature.description,
            })),
          }],
          defaultValue: [],
        },
        choice('action', 'Action taken for the matched application.', [
          { keyword: 'pass', description: 'Let the flow through.' },
          { keyword: 'block', description: 'Block the flow.' },
          { keyword: 'reset', description: 'Reset the connection.' },
        ], 'block'),
      ],
    },
  ],
  onCommit(object, context) {
    context.device.applyApplicationList({
      name: object.key,
      entries: listOf(object, 'entries').flatMap(entry =>
        [...entry.effective('application')].map(application => ({
          id: entry.key,
          application,
          action: field(entry, 'action') === 'pass' ? 'allow' : 'block',
        }))),
      otherApplicationAction: object.effective('other-application-action')[0] ?? 'pass',
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeApplicationList(key);
  },
};

export const IPS_SENSOR: FortiTableSpec = {
  path: ['ips', 'sensor'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 461,
  help: 'Configure IPS sensors.',
  attributes: [
    { ...word('name', 'Sensor name.'), unimplemented: NO_SIGNATURES },
  ],
  onCommit() {},
};

export const IPS_GLOBAL: FortiTableSpec = {
  path: ['ips', 'global'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'utmgrp',
  renderOrder: 465,
  help: 'Configure IPS global parameters.',
  attributes: [
    enable('fail-open',
      'Enable to allow new sessions through when the IPS engine cannot scan'
      + ' them. Disabled by default, so flow-based inspection fails CLOSED.'),
  ],
  onCommit(object, context) {
    context.device.applyIpsGlobal({
      failOpen: object.effective('fail-open')[0] === 'enable',
    });
  },
};

export const DLP_SENSOR: FortiTableSpec = {
  path: ['dlp', 'sensor'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'utmgrp',
  renderOrder: 462,
  help: 'Configure DLP sensors.',
  attributes: [
    { ...word('name', 'Sensor name.'), unimplemented: NO_SIGNATURES },
  ],
  onCommit() {},
};

const SHAPER_UNITS = [
  { keyword: 'kbps', description: 'Kilobits per second.' },
  { keyword: 'mbps', description: 'Megabits per second.' },
  { keyword: 'gbps', description: 'Gigabits per second.' },
];

const SHAPER_MARKING = [
  { keyword: 'static', description: 'Static marking.' },
  { keyword: 'multi-stage', description: 'Multistage marking.' },
];

const SHAPER_QUEUE = 'needs a scheduler that arbitrates a congested egress queue between '
  + 'shapers; this firewall meters each shaper on its own bucket and has no shared egress queue.';

const SHAPER_VLAN = 'needs a 802.1p field on the frames; the frames this firewall forwards '
  + 'carry no CoS.';

function shaperCode(object: FortiObjectView, name: string): number | undefined {
  const raw = object.effective(name)[0];
  return raw === undefined || raw === '' ? undefined : Number.parseInt(raw, 2);
}

const SHAPER_CODE = (value: string): boolean => /^[01]{6}$/.test(value);

export const TRAFFIC_SHAPER: FortiTableSpec = {
  path: ['firewall', 'shaper', 'traffic-shaper'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 463,
  help: 'Configure shared traffic shaper.',
  attributes: [
    { ...word('name', 'Traffic shaper name.'), readOnly: true },
    choice('bandwidth-unit', 'Unit of measurement for guaranteed and maximum bandwidth for this shaper (Kbps, Mbps or Gbps).', SHAPER_UNITS, 'kbps'),
    count('guaranteed-bandwidth', 'Amount of bandwidth guaranteed for this shaper (0 - 80000000). Units depend on the bandwidth-unit setting.', 0, 80000000, 0),
    count('maximum-bandwidth', 'Upper bandwidth limit enforced by this shaper (0 - 80000000). 0 means no limit. Units depend on the bandwidth-unit setting.', 0, 80000000, 0),
    count('exceed-bandwidth', 'Exceed bandwidth used for DSCP/VLAN CoS multi-stage marking. Units depend on the bandwidth-unit setting.', 0, 80000000, 0),
    count('overhead', 'Per-packet size overhead used in rate computations.', 0, 100, 0),
    enable('per-policy', 'Enable/disable applying a separate shaper for each policy. For example, if enabled the guaranteed bandwidth is applied separately for each policy.', false),
    enable('diffserv', 'Enable/disable changing the DiffServ setting applied to traffic accepted by this shaper.', false),
    { ...word('diffservcode', 'DiffServ setting to be applied to traffic accepted by this shaper.'), acceptsValue: SHAPER_CODE },
    choice('dscp-marking-method', 'Select DSCP marking method.', SHAPER_MARKING, 'static'),
    { ...word('exceed-dscp', 'DSCP mark for traffic in guaranteed-bandwidth and exceed-bandwidth.'), acceptsValue: SHAPER_CODE },
    { ...word('maximum-dscp', 'DSCP mark for traffic in exceed-bandwidth and maximum-bandwidth.'), acceptsValue: SHAPER_CODE },
    { ...choice('priority', 'Higher priority traffic is more likely to be forwarded without delays and without compromising the guaranteed bandwidth.', [
      { keyword: 'low', description: 'Low priority.' },
      { keyword: 'medium', description: 'Medium priority.' },
      { keyword: 'high', description: 'High priority.' },
    ], 'high'), unimplemented: SHAPER_QUEUE },
    { ...enable('cos-marking', 'Enable/disable VLAN CoS marking.', false), unimplemented: SHAPER_VLAN },
    { ...choice('cos-marking-method', 'Select VLAN CoS marking method.', SHAPER_MARKING, 'static'), unimplemented: SHAPER_VLAN },
    { ...word('cos', 'VLAN CoS mark.'), unimplemented: SHAPER_VLAN },
    { ...word('exceed-cos', 'VLAN CoS mark for traffic in [guaranteed-bandwidth, exceed-bandwidth].'), unimplemented: SHAPER_VLAN },
    { ...word('maximum-cos', 'VLAN CoS mark for traffic in [exceed-bandwidth, maximum-bandwidth].'), unimplemented: SHAPER_VLAN },
    { ...count('exceed-class-id', 'Class ID for traffic in guaranteed-bandwidth and maximum-bandwidth.', 0, 4294967295, 0), unimplemented: SHAPER_QUEUE },
  ],
  onCommit(object, context) {
    const amount = (name: string): number => Number.parseInt(object.effective(name)[0] ?? '0', 10) || 0;
    const multi = object.effective('dscp-marking-method')[0] === 'multi-stage';
    context.device.applyTrafficShaper({
      name: object.key,
      unit: (object.effective('bandwidth-unit')[0] ?? 'kbps') as 'kbps' | 'mbps' | 'gbps',
      guaranteed: amount('guaranteed-bandwidth'),
      exceed: amount('exceed-bandwidth'),
      maximum: amount('maximum-bandwidth'),
      overheadBytes: amount('overhead'),
      perPolicy: object.effective('per-policy')[0] === 'enable',
      diffserv: object.effective('diffserv')[0] === 'enable' && !multi
        ? shaperCode(object, 'diffservcode') : undefined,
      multiStageDscp: multi
        ? { guaranteedExceed: shaperCode(object, 'exceed-dscp'), exceedMaximum: shaperCode(object, 'maximum-dscp') }
        : undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeTrafficShaper(key);
  },
};

export const PER_IP_SHAPER: FortiTableSpec = {
  path: ['firewall', 'shaper', 'per-ip-shaper'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 464,
  help: 'Configure per-IP traffic shaper.',
  attributes: [
    { ...word('name', 'Traffic shaper name.'), readOnly: true },
    choice('bandwidth-unit', 'Unit of measurement for maximum bandwidth for this shaper (Kbps, Mbps or Gbps).', SHAPER_UNITS, 'kbps'),
    enable('diffserv-forward', 'Enable/disable changing the Forward (original) DiffServ setting applied to traffic accepted by this shaper.', false),
    enable('diffserv-reverse', 'Enable/disable changing the Reverse (reply) DiffServ setting applied to traffic accepted by this shaper.', false),
    { ...word('diffservcode-forward', 'Forward (original) DiffServ setting to be applied to traffic accepted by this shaper.'), acceptsValue: SHAPER_CODE },
    { ...word('diffservcode-rev', 'Reverse (reply) DiffServ setting to be applied to traffic accepted by this shaper.'), acceptsValue: SHAPER_CODE },
    count('max-bandwidth', 'Upper bandwidth limit enforced by this shaper (0 - 80000000). 0 means no limit. Units depend on the bandwidth-unit setting.', 0, 80000000, 0),
    count('max-concurrent-session', 'Maximum number of concurrent sessions allowed by this shaper (0 - 2097000). 0 means no limit.', 0, 2097000, 0),
    count('max-concurrent-tcp-session', 'Maximum number of concurrent TCP sessions allowed by this shaper (0 - 2097000). 0 means no limit.', 0, 2097000, 0),
    count('max-concurrent-udp-session', 'Maximum number of concurrent UDP sessions allowed by this shaper (0 - 2097000). 0 means no limit.', 0, 2097000, 0),
  ],
  onCommit(object, context) {
    const amount = (name: string): number => Number.parseInt(object.effective(name)[0] ?? '0', 10) || 0;
    context.device.applyPerIpShaper({
      name: object.key,
      unit: (object.effective('bandwidth-unit')[0] ?? 'kbps') as 'kbps' | 'mbps' | 'gbps',
      maximum: amount('max-bandwidth'),
      forwardDscp: object.effective('diffserv-forward')[0] === 'enable'
        ? shaperCode(object, 'diffservcode-forward') : undefined,
      reverseDscp: object.effective('diffserv-reverse')[0] === 'enable'
        ? shaperCode(object, 'diffservcode-rev') : undefined,
      maxSessions: amount('max-concurrent-session'),
      maxTcpSessions: amount('max-concurrent-tcp-session'),
      maxUdpSessions: amount('max-concurrent-udp-session'),
    });
  },
  onDelete(key, context) {
    context.device.removePerIpShaper(key);
  },
};

function listOf(object: FortiObjectView, name: string): readonly FortiObjectView[] {
  return object.childEntries(name);
}

function filterCategories(renderOrder: number): FortiTableSpec {
  return {
    path: ['filters'],
    kind: 'table',
    keyType: 'integer',
    ordered: true,
    scope: 'vdom',
    accessGroup: 'utmgrp',
    renderOrder,
    help: 'FortiGuard category filter table.',
    attributes: [
      count('category', 'Category number.', 0, 255, 0),
      choice('action', 'Action taken for the matched category.', FILTER_ACTIONS, 'block'),
    ],
    onCommit() {},
  };
}

function filterEntryTable(
  path: readonly string[], renderOrder: number, field_: string, help: string,
): FortiTableSpec {
  return {
    path: [...path],
    kind: 'table',
    keyType: 'integer',
    ordered: false,
    scope: 'vdom',
    accessGroup: 'utmgrp',
    renderOrder,
    help,
    attributes: [
      {
        name: 'id', help: 'ID.', quoted: false, readOnly: true,
        parts: [{ name: 'id', type: 'INT', description: 'ID.', range: [0, 65535] }],
      },
      word('name', 'Table name.'),
      text('comment', 'Optional comments.'),
    ],
    children: [
      {
        path: ['entries'],
        kind: 'table',
        keyType: 'integer',
        ordered: true,
        scope: 'vdom',
        accessGroup: 'utmgrp',
        renderOrder: renderOrder + 1,
        help: 'Filter entries.',
        attributes: [
          word(field_, help),
          choice('type', 'Filter type.', [
            { keyword: 'simple', description: 'Simple substring match.' },
            { keyword: 'wildcard', description: 'Wildcard match.' },
            { keyword: 'regex', description: 'Regular expression match.' },
          ], 'simple'),
          choice('action', 'Action taken for a match.', FILTER_ACTIONS, 'block'),
          enable('status', 'Enable/disable this entry.', true),
        ],
        onCommit() {},
      },
    ],
    onCommit() {},
  };
}

function filterTablePatch(object: FortiObjectView, field_: string) {
  return {
    id: object.key,
    name: object.effective('name')[0] || object.key,
    entries: listOf(object, 'entries').map(entry => ({
      id: entry.key,
      pattern: field(entry, field_),
      type: field(entry, 'type') || 'simple',
      action: field(entry, 'action') || 'block',
      enabled: field(entry, 'status') !== 'disable',
    })),
    comment: object.effective('comment')[0] || undefined,
  };
}

function categoryEntries(object: FortiObjectView, group: string) {
  const entries = object.childGroup(group)?.childEntries('filters') ?? [];
  return entries.map(entry => ({
    id: entry.key,
    category: Number.parseInt(field(entry, 'category') || '0', 10),
    action: field(entry, 'action') || 'block',
  }));
}

function tableReference(
  object: FortiObjectView, group: string, attribute: string,
): string | undefined {
  const declared = object.childSetting(group, attribute)[0];
  if (declared === undefined || declared === '' || declared === '0') return undefined;
  return declared;
}

export const WEBFILTER_URLFILTER: FortiTableSpec = {
  ...filterEntryTable(['webfilter', 'urlfilter'], 405, 'url', 'URL to be filtered.'),
  help: 'Configure URL filter lists.',
  onCommit(object, context) {
    context.device.applyUrlFilterTable(filterTablePatch(object, 'url'));
  },
  onDelete(key, context) {
    context.device.removeUrlFilterTable(key);
  },
};

export const DNSFILTER_DOMAINFILTER: FortiTableSpec = {
  ...filterEntryTable(['dnsfilter', 'domain-filter'], 415, 'domain', 'Domain entry name.'),
  help: 'Configure DNS domain filters.',
  onCommit(object, context) {
    context.device.applyDomainFilterTable(filterTablePatch(object, 'domain'));
  },
  onDelete(key, context) {
    context.device.removeDomainFilterTable(key);
  },
};

function channelAction(object: FortiObjectView, name: string): string {
  return object.childSetting(name, 'av-scan')[0] ?? 'disable';
}

function channelNumber(
  object: FortiObjectView, channel: string, setting: string, byDefault: number,
): number {
  const declared = object.childSetting(channel, setting)[0];
  const value = Number.parseInt(declared ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : byDefault;
}

function channelPorts(
  object: FortiObjectView, name: string, byDefault: number,
): number[] {
  const declared = object.childSetting(name, 'ports');
  const ports = declared.map(port => Number.parseInt(port, 10)).filter(Number.isFinite);
  return ports.length > 0 ? ports : [byDefault];
}

function field(entry: FortiObjectView, name: string): string {
  return entry.effective(name)[0] ?? '';
}

export const UTM_SPECS: readonly FortiTableSpec[] = Object.freeze([
  ANTIVIRUS_PROFILE,
  WEBFILTER_URLFILTER,
  DNSFILTER_DOMAINFILTER,
  WEBFILTER_PROFILE,
  DNSFILTER_PROFILE,
  FILE_FILTER_PROFILE,
  SSL_SSH_PROFILE,
  PROTOCOL_OPTIONS,
  APPLICATION_LIST,
  IPS_SENSOR,
  IPS_GLOBAL,
  DLP_SENSOR,
  TRAFFIC_SHAPER,
  PER_IP_SHAPER,
]);

export { NO_SIGNATURES, NO_WIRE_CLOCK };


