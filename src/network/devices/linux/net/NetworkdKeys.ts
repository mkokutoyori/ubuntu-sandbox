import type { ConfigSpec } from '../systemd/ConfigFiles';

const NETWORK_KEYS: Record<string, string> = {
  Match: 'MACAddress PermanentMACAddress Path Driver Type Kind WLANInterfaceType SSID BSSID Name Property Host Virtualization KernelCommandLine KernelVersion Credential Architecture Firmware',
  Link: 'MACAddress MTUBytes Group ARP Multicast AllMulticast Promiscuous Unmanaged ActivationPolicy RequiredForOnline RequiredFamilyForOnline',
  'SR-IOV': 'VirtualFunction VLANId QualityOfService VLANProtocol MACSpoofCheck QueryReceiveSideScaling Trust LinkState MACAddress',
  Network: 'Description KeepMaster BatmanAdvanced Bond Bridge VRF IPoIB IPVLAN IPVTAP L2TP MACsec MACVLAN MACVTAP Tunnel VLAN VXLAN Xfrm DHCP DHCPServer LinkLocalAddressing IPv6LinkLocalAddressGenerationMode IPv6StableSecretAddress IPv4LLStartAddress IPv4LLRoute DefaultRouteOnDevice LLDP EmitLLDP Address Gateway Domains DNS DNSDefaultRoute LLMNR MulticastDNS DNSOverTLS DNSSEC DNSSECNegativeTrustAnchors NTP IPForward IPMasquerade IPv6PrivacyExtensions IPv6AcceptRA IPv6AcceptRouterAdvertisements IPv6DuplicateAddressDetection IPv6HopLimit IPv6ProxyNDP IPv6MTUBytes IPv4AcceptLocal IPv4RouteLocalnet ActiveSlave PrimarySlave IPv4ProxyARP ProxyARP IPv6ProxyNDPAddress IPv4ReversePathFilter BindCarrier ConfigureWithoutCarrier IgnoreCarrierLoss KeepConfiguration IPv6SendRA DHCPPrefixDelegation IPv4LL IPv6Token IPv6PrefixDelegation DHCPv6PrefixDelegation',
  Address: 'Address Peer Broadcast Label PreferredLifetime HomeAddress ManageTemporaryAddress PrefixRoute AddPrefixRoute AutoJoin DuplicateAddressDetection Scope RouteMetric NetLabel NFTSet',
  IPv6AddressLabel: 'Prefix Label',
  Neighbor: 'Address LinkLayerAddress MACAddress',
  RoutingPolicyRule: 'TypeOfService Priority Table FirewallMark From To IncomingInterface OutgoingInterface IPProtocol SourcePort DestinationPort InvertRule Family User SuppressInterfaceGroup SuppressPrefixLength Type',
  Route: 'Gateway Destination Source Metric Scope PreferredSource Table MTUBytes GatewayOnLink GatewayOnlink IPv6Preference Protocol Type TCPRetransmissionTimeoutSec HopLimit InitialCongestionWindow InitialAdvertisedReceiveWindow TCPAdvertisedMaximumSegmentSize TCPCongestionControlAlgorithm QuickAck FastOpenNoCookie TTLPropagate MultiPathRoute NextHop',
  NextHop: 'Id Gateway Family OnLink Blackhole Group',
  DHCPv4: 'RequestAddress ClientIdentifier UseDNS RoutesToDNS UseNTP RoutesToNTP UseSIP UseCaptivePortal UseMTU UseHostname UseDomains UseRoutes UseGateway QuickAck RequestOptions Anonymize SendHostname Hostname Label RequestBroadcast VendorClassIdentifier MUDURL MaxAttempts UserClass IAID DUIDType DUIDRawData RouteMetric RouteTable UseTimezone ListenPort SendRelease SendDecline DenyList AllowList IPServiceType SocketPriority SendOption SendVendorOption RouteMTUBytes InitialCongestionWindow InitialAdvertisedReceiveWindow FallbackLeaseLifetimeSec Use6RD IPv6OnlyMode NetLabel NFTSet RapidCommit BlackList UseDomainName CriticalConnection',
  DHCPv6: 'UseAddress UseDelegatedPrefix UseDNS UseHostname UseDomains UseNTP UseCaptivePortal MUDURL SendHostname Hostname RequestOptions UserClass VendorClass SendVendorOption PrefixDelegationHint WithoutRA SendOption IAID DUIDType DUIDRawData RapidCommit NetLabel SendRelease NFTSet RouteMetric ForceDHCPv6PDOtherInformation',
  IPv6AcceptRA: 'UseGateway UseRoutePrefix UseAutonomousPrefix UseOnLinkPrefix UsePREF64 UseDNS UseDomains UseMTU UseHopLimit UseICMP6RateLimit DHCPv6Client RouteTable RouteMetric QuickAck UseCaptivePortal RouterAllowList RouterDenyList PrefixAllowList PrefixDenyList RouteAllowList RouteDenyList Token NetLabel NFTSet DenyList BlackList',
  DHCPServer: 'ServerAddress UplinkInterface RelayTarget RelayAgentCircuitId RelayAgentRemoteId MaxLeaseTimeSec DefaultLeaseTimeSec IPv6OnlyPreferredSec EmitDNS DNS EmitNTP NTP EmitSIP SIP EmitPOP3 POP3 EmitSMTP SMTP EmitLPR LPR EmitRouter Router EmitTimezone Timezone PoolOffset PoolSize SendVendorOption SendOption BindToInterface BootServerAddress BootServerName BootFilename RapidCommit',
  DHCPServerStaticLease: 'Address MACAddress',
  Bridge: 'Cost UseBPDU HairPin Isolated FastLeave AllowPortToBeRoot UnicastFlood MulticastFlood MulticastToUnicast NeighborSuppression Learning ProxyARP ProxyARPWiFi Priority MulticastRouter',
  BridgeFDB: 'MACAddress VLANId Destination VNI AssociatedWith OutgoingInterface',
  BridgeMDB: 'MulticastGroupAddress VLANId',
  BridgeVLAN: 'PVID VLAN EgressUntagged',
  DHCPPrefixDelegation: 'UplinkInterface SubnetId Announce Assign ManageTemporaryAddress Token RouteMetric NetLabel NFTSet',
  IPv6SendRA: 'RouterLifetimeSec RetransmitSec Managed OtherInformation RouterPreference HopLimit EmitDNS DNS EmitDomains Domains DNSLifetimeSec UplinkInterface HomeAgent HomeAgentLifetimeSec HomeAgentPreference',
  IPv6Prefix: 'Prefix OnLink AddressAutoconfiguration ValidLifetimeSec PreferredLifetimeSec Assign RouteMetric Token',
  IPv6RoutePrefix: 'Route LifetimeSec',
  IPv6PREF64Prefix: 'Prefix LifetimeSec',
  LLDP: 'MUDURL',
  CAN: 'BitRate SamplePoint TimeQuantaNSec PropagationSegment PhaseBufferSegment1 PhaseBufferSegment2 SyncJumpWidth DataBitRate DataSamplePoint DataTimeQuantaNSec DataPropagationSegment DataPhaseBufferSegment1 DataPhaseBufferSegment2 DataSyncJumpWidth RestartSec Loopback ListenOnly TripleSampling OneShot BusErrorReporting FDMode PresumeACK FDNonISO ClassicDataLengthCode Termination',
  IPoIB: 'Mode IgnoreUserspaceMulticastGroups',
  QDisc: 'Parent Handle',
  BFIFO: 'Parent Handle LimitBytes',
  CAKE: 'Parent Handle Bandwidth AutoRateIngress OverheadBytes MPUBytes CompensationMode UseRawPacketSize FlowIsolationMode NAT PriorityQueueingPreset FirewallMark Wash SplitGSO RTTSec AckFilter',
  ControlledDelay: 'Parent Handle PacketLimit TargetSec IntervalSec CEThresholdSec ECN',
  DeficitRoundRobinScheduler: 'Parent Handle',
  DeficitRoundRobinSchedulerClass: 'Parent ClassId QuantumBytes',
  EnhancedTransmissionSelection: 'Parent Handle Bands StrictBands QuantumBytes PriorityMap',
  PFIFO: 'Parent Handle PacketLimit',
  PFIFOFast: 'Parent Handle',
  PFIFOHeadDrop: 'Parent Handle PacketLimit',
  QuickFairQueueing: 'Parent Handle',
  QuickFairQueueingClass: 'Parent ClassId Weight MaxPacketBytes',
  FairQueueing: 'Parent Handle PacketLimit FlowLimit QuantumBytes InitialQuantumBytes MaximumRate Buckets OrphanMask Pacing CEThresholdSec Quantum InitialQuantum',
  FairQueueingControlledDelay: 'Parent Handle PacketLimit MemoryLimitBytes Flows QuantumBytes TargetSec IntervalSec CEThresholdSec ECN MemoryLimit Quantum',
  FlowQueuePIE: 'Parent Handle PacketLimit',
  GenericRandomEarlyDetection: 'Parent Handle VirtualQueues DefaultVirtualQueue GenericRIO',
  HeavyHitterFilter: 'Parent Handle PacketLimit',
  HierarchyTokenBucket: 'Parent Handle DefaultClass RateToQuantum',
  HierarchyTokenBucketClass: 'Parent ClassId Priority QuantumBytes MTUBytes OverheadBytes Rate CeilRate BufferBytes CeilBufferBytes',
  NetworkEmulator: 'Parent Handle DelaySec DelayJitterSec LossRate DuplicateRate PacketLimit',
  PIE: 'Parent Handle PacketLimit',
  StochasticFairBlue: 'Parent Handle PacketLimit',
  StochasticFairnessQueueing: 'Parent Handle PerturbPeriodSec',
  TokenBucketFilter: 'Parent Handle Rate BurstBytes LimitBytes MTUBytes MPUBytes PeakRate LatencySec Burst LimitSize',
  TrivialLinkEqualizer: 'Parent Handle Id',
  IPv6PrefixDelegation: 'RouterLifetimeSec Managed OtherInformation RouterPreference EmitDNS DNS EmitDomains Domains DNSLifetimeSec',
  DHCP: 'ClientIdentifier UseDNS UseNTP UseMTU UseHostname UseDomains UseDomainName UseRoutes Anonymize SendHostname Hostname RequestBroadcast CriticalConnection VendorClassIdentifier UserClass IAID DUIDType DUIDRawData RouteMetric RouteTable UseTimezone ListenPort RapidCommit ForceDHCPv6PDOtherInformation',
  DHCPv6PrefixDelegation: 'SubnetId Announce Assign ManageTemporaryAddress Token RouteMetric',
  TrafficControlQueueingDiscipline: 'Parent NetworkEmulatorDelaySec NetworkEmulatorDelayJitterSec NetworkEmulatorLossRate NetworkEmulatorDuplicateRate NetworkEmulatorPacketLimit',
};

const NETDEV_KEYS: Record<string, string> = {
  Match: 'Host Virtualization KernelCommandLine KernelVersion Credential Architecture Firmware',
  NetDev: 'Description Name Kind MTUBytes MACAddress',
  VLAN: 'Id Protocol GVRP MVRP LooseBinding ReorderHeader EgressQOSMaps IngressQOSMaps',
  MACVLAN: 'Mode SourceMACAddress BroadcastMulticastQueueLength',
  MACVTAP: 'Mode SourceMACAddress',
  IPVLAN: 'Mode Flags',
  IPVTAP: 'Mode Flags',
  Tunnel: 'Local Remote TOS TTL Key InputKey OutputKey DiscoverPathMTU IgnoreDontFragment Mode IPv6FlowLabel CopyDSCP EncapsulationLimit Independent AssignToLoopback AllowLocalRemote FooOverUDP FOUDestinationPort FOUSourcePort Encapsulation IPv6RapidDeploymentPrefix ERSPANVersion ERSPANIndex ERSPANDirection ERSPANHardwareId SerializeTunneledPackets ISATAP External',
  FooOverUDP: 'Protocol Encapsulation Port PeerPort Local Peer',
  L2TP: 'TunnelId PeerTunnelId UDPSourcePort UDPDestinationPort Local Remote EncapsulationType UDPCheckSum UDP6CheckSumRx UDP6CheckSumTx',
  L2TPSession: 'SessionId PeerSessionId Layer2SpecificHeader Name',
  Peer: 'Name MACAddress',
  VXCAN: 'Peer',
  VXLAN: 'VNI Id Group Local Remote TOS TTL MacLearning ARPProxy ReduceARPProxy L2MissNotification L3MissNotification RouteShortCircuit UDPCheckSum UDPChecksum UDP6ZeroCheckSumRx UDP6ZeroChecksumRx UDP6ZeroCheckSumTx UDP6ZeroChecksumTx RemoteChecksumTx RemoteChecksumRx FDBAgeingSec GroupPolicyExtension GenericProtocolExtension MaximumFDBEntries PortRange DestinationPort FlowLabel IPDoNotFragment Independent',
  GENEVE: 'Id Remote TOS TTL UDPChecksum UDP6ZeroCheckSumRx UDP6ZeroChecksumRx UDP6ZeroCheckSumTx UDP6ZeroChecksumTx DestinationPort IPDoNotFragment FlowLabel InheritInnerProtocol',
  MACsec: 'Port Encrypt',
  MACsecReceiveChannel: 'Port MACAddress',
  MACsecTransmitAssociation: 'PacketNumber KeyId Key KeyFile Activate UseForEncoding',
  MACsecReceiveAssociation: 'Port MACAddress PacketNumber KeyId Key KeyFile Activate',
  Tun: 'OneQueue MultiQueue PacketInfo VNetHeader User Group KeepCarrier',
  Tap: 'OneQueue MultiQueue PacketInfo VNetHeader User Group KeepCarrier',
  Bond: 'Mode TransmitHashPolicy LACPTransmitRate AdSelect FailOverMACPolicy ARPIPTargets ARPValidate ARPAllTargets PrimaryReselectPolicy ResendIGMP PacketsPerSlave GratuitousARP AllSlavesActive DynamicTransmitLoadBalancing MinLinks MIIMonitorSec UpDelaySec DownDelaySec ARPIntervalSec LearnPacketIntervalSec AdActorSystemPriority AdUserPortKey AdActorSystem',
  Bridge: 'HelloTimeSec MaxAgeSec AgeingTimeSec ForwardDelaySec Priority GroupForwardMask DefaultPVID MulticastQuerier MulticastSnooping VLANFiltering VLANProtocol STP MulticastIGMPVersion',
  VRF: 'TableId Table',
  BareUDP: 'DestinationPort EtherType',
  WireGuard: 'FirewallMark FwMark ListenPort PrivateKey PrivateKeyFile RouteTable RouteMetric',
  WireGuardPeer: 'AllowedIPs Endpoint PublicKey PresharedKey PresharedKeyFile PersistentKeepalive RouteTable RouteMetric',
  Xfrm: 'InterfaceId Independent',
  BatmanAdvanced: 'Aggregation BridgeLoopAvoidance DistributedArpTable Fragmentation GatewayMode GatewayBandwithDown GatewayBandwithUp GatewayBandwidthDown GatewayBandwidthUp HopPenalty OriginatorIntervalSec RoutingAlgorithm',
  IPoIB: 'PartitionKey Mode IgnoreUserspaceMulticastGroups',
  WLAN: 'PhysicalDevice Type WDS',
};

const LINK_KEYS: Record<string, string> = {
  Match: 'MACAddress PermanentMACAddress OriginalName Path Driver Type Kind Property Host Virtualization KernelCommandLine KernelVersion Credential Architecture Firmware',
  Link: 'Description MACAddressPolicy MACAddress NamePolicy Name AlternativeName AlternativeNamesPolicy Alias TransmitQueues ReceiveQueues TransmitQueueLength MTUBytes BitsPerSecond Duplex AutoNegotiation WakeOnLan WakeOnLanPassword Port ReceiveChecksumOffload TransmitChecksumOffload GenericSegmentationOffload TCPSegmentationOffload TCP6SegmentationOffload UDPSegmentationOffload GenericReceiveOffload GenericReceiveOffloadHardware LargeReceiveOffload ReceiveVLANCTAGHardwareAcceleration TransmitVLANCTAGHardwareAcceleration ReceiveVLANCTAGFilter TransmitVLANSTAGHardwareAcceleration NTupleFilter RxChannels TxChannels OtherChannels CombinedChannels Advertise RxBufferSize RxMiniBufferSize RxJumboBufferSize TxBufferSize RxFlowControl TxFlowControl AutoNegotiationFlowControl GenericSegmentOffloadMaxBytes GenericSegmentOffloadMaxSegments RxCoalesceSec RxMaxCoalescedFrames RxCoalesceIrqSec RxMaxCoalescedIrqFrames TxCoalesceSec TxMaxCoalescedFrames TxCoalesceIrqSec TxMaxCoalescedIrqFrames StatisticsBlockCoalesceSec UseAdaptiveRxCoalesce UseAdaptiveTxCoalesce CoalescePacketRateLow RxCoalesceLowSec RxMaxCoalescedLowFrames TxCoalesceLowSec TxMaxCoalescedLowFrames CoalescePacketRateHigh RxCoalesceHighSec RxMaxCoalescedHighFrames TxCoalesceHighSec TxMaxCoalescedHighFrames CoalescePacketRateSampleIntervalSec MDI SR-IOVVirtualFunctions',
  'SR-IOV': 'VirtualFunction VLANId QualityOfService VLANProtocol MACSpoofCheck QueryReceiveSideScaling Trust LinkState MACAddress',
};

const NETWORK_SECTIONS = [
  'Match', 'Link', 'SR-IOV', 'Network', 'Address', 'Neighbor', 'IPv6AddressLabel', 'RoutingPolicyRule', 'Route', 'NextHop',
  'DHCP', 'DHCPv4', 'DHCPv6', 'DHCPv6PrefixDelegation', 'DHCPPrefixDelegation', 'DHCPServer', 'DHCPServerStaticLease',
  'IPv6AcceptRA', 'IPv6NDPProxyAddress', 'Bridge', 'BridgeFDB', 'BridgeMDB', 'BridgeVLAN', 'IPv6SendRA', 'IPv6PrefixDelegation',
  'IPv6Prefix', 'IPv6RoutePrefix', 'IPv6PREF64Prefix', 'LLDP', 'TrafficControlQueueingDiscipline', 'CAN', 'QDisc', 'BFIFO', 'CAKE',
  'ControlledDelay', 'DeficitRoundRobinScheduler', 'DeficitRoundRobinSchedulerClass', 'EnhancedTransmissionSelection',
  'FairQueueing', 'FairQueueingControlledDelay', 'FlowQueuePIE', 'GenericRandomEarlyDetection', 'HeavyHitterFilter',
  'HierarchyTokenBucket', 'HierarchyTokenBucketClass', 'NetworkEmulator', 'PFIFO', 'PFIFOFast', 'PFIFOHeadDrop', 'PIE',
  'QuickFairQueueing', 'QuickFairQueueingClass', 'StochasticFairBlue', 'StochasticFairnessQueueing', 'TokenBucketFilter',
  'TrivialLinkEqualizer',
] as const;

const LINK_SECTIONS = ['Match', 'Link', 'SR-IOV'] as const;

const NETDEV_COMMON_SECTIONS = ['Match', 'NetDev'] as const;

const NETDEV_KIND_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  bareudp: ['BareUDP'],
  batadv: ['BatmanAdvanced'],
  bond: ['Bond'],
  bridge: ['Bridge'],
  fou: ['FooOverUDP'],
  geneve: ['GENEVE'],
  ipoib: ['IPoIB'],
  ipvlan: ['IPVLAN'],
  ipvtap: ['IPVTAP'],
  l2tp: ['L2TP', 'L2TPSession'],
  macsec: ['MACsec', 'MACsecReceiveChannel', 'MACsecTransmitAssociation', 'MACsecReceiveAssociation'],
  macvlan: ['MACVLAN'],
  macvtap: ['MACVTAP'],
  tap: ['Tap'],
  tun: ['Tun'],
  veth: ['Peer'],
  vlan: ['VLAN'],
  vrf: ['VRF'],
  vxcan: ['VXCAN'],
  vxlan: ['VXLAN'],
  wireguard: ['WireGuard', 'WireGuardPeer'],
  wlan: ['WLAN'],
  xfrm: ['Xfrm'],
  erspan: ['Tunnel'],
  gre: ['Tunnel'],
  gretap: ['Tunnel'],
  ip6gre: ['Tunnel'],
  ip6gretap: ['Tunnel'],
  ip6tnl: ['Tunnel'],
  ipip: ['Tunnel'],
  sit: ['Tunnel'],
  vti: ['Tunnel'],
  vti6: ['Tunnel'],
};

const COMMON_ONLY_NETDEV_KINDS = ['dummy', 'ifb', 'netdevsim', 'nlmon', 'vcan'] as const;

const NETDEV_KIND_SECTION_NAMES = [...new Set(Object.values(NETDEV_KIND_SECTIONS).flat())];

function keySet(table: Readonly<Record<string, string>>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [section, names] of Object.entries(table)) for (const name of names.split(' ')) keys.add(`${section}.${name}`);
  return keys;
}

const NETWORK_KEY_SET = keySet(NETWORK_KEYS);
const NETDEV_KEY_SET = keySet(NETDEV_KEYS);
const LINK_KEY_SET = keySet(LINK_KEYS);

function ownSections(netdevKind: string): readonly string[] | undefined {
  const declared = NETDEV_KIND_SECTIONS[netdevKind];
  if (declared !== undefined) return declared;
  return (COMMON_ONLY_NETDEV_KINDS as readonly string[]).includes(netdevKind) ? [] : undefined;
}

export type NetworkdFileKind = 'network' | 'link' | 'netdev';

export function networkdSpec(kind: NetworkdFileKind, path: string, basename: string, netdevKind: string | null = null): ConfigSpec[] {
  const dropInName = `network/${basename}.d`;
  if (kind === 'network') return [{ mainFile: path, dropInName, sections: NETWORK_SECTIONS, knownKeys: NETWORK_KEY_SET, handlers: new Map() }];
  if (kind === 'link') return [{ mainFile: path, dropInName, sections: LINK_SECTIONS, knownKeys: LINK_KEY_SET, handlers: new Map() }];
  const firstPass: ConfigSpec = {
    mainFile: path,
    dropInName,
    sections: NETDEV_COMMON_SECTIONS,
    ignoredSections: NETDEV_KIND_SECTION_NAMES,
    knownKeys: NETDEV_KEY_SET,
    handlers: new Map(),
  };
  const own = netdevKind === null ? undefined : ownSections(netdevKind);
  if (own === undefined) return [firstPass];
  return [firstPass, { mainFile: path, dropInName, sections: [...NETDEV_COMMON_SECTIONS, ...own], knownKeys: NETDEV_KEY_SET, handlers: new Map() }];
}
