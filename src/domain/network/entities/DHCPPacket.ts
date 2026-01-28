/**
 * DHCPPacket - Dynamic Host Configuration Protocol (RFC 2131)
 *
 * DHCP is used to automatically configure network parameters for hosts,
 * including IP address, subnet mask, default gateway, and DNS servers.
 *
 * DHCP Packet Format (240+ bytes):
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ op (1) │ htype (1) │ hlen (1) │ hops (1)                           │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ xid (4) - Transaction ID                                            │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ secs (2) │ flags (2)                                                │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ ciaddr (4) - Client IP address                                      │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ yiaddr (4) - Your (client) IP address                               │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ siaddr (4) - Server IP address                                      │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ giaddr (4) - Gateway IP address (relay agent)                       │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ chaddr (16) - Client hardware address                               │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ sname (64) - Server hostname (optional)                             │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ file (128) - Boot filename (optional)                               │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ options (variable) - DHCP options, starts with magic cookie         │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Design Pattern: Entity (DDD) with Factory Methods
 *
 * @example
 * ```typescript
 * // Create DHCP DISCOVER
 * const discover = DHCPPacket.createDiscover(clientMAC);
 *
 * // Create DHCP OFFER response
 * const offer = DHCPPacket.createOffer(discover, offeredIP, serverIP, ...);
 *
 * // Serialize/Deserialize
 * const bytes = packet.toBytes();
 * const restored = DHCPPacket.fromBytes(bytes);
 * ```
 */

import { IPAddress } from '../value-objects/IPAddress';
import { MACAddress } from '../value-objects/MACAddress';

/**
 * DHCP Operation codes
 */
export enum DHCPOperation {
  BOOTREQUEST = 1,
  BOOTREPLY = 2
}

/**
 * DHCP Message Types (Option 53)
 */
export enum DHCPMessageType {
  DISCOVER = 1,
  OFFER = 2,
  REQUEST = 3,
  DECLINE = 4,
  ACK = 5,
  NAK = 6,
  RELEASE = 7,
  INFORM = 8
}

/**
 * Common DHCP Option codes
 */
export enum DHCPOption {
  PAD = 0,
  SUBNET_MASK = 1,
  ROUTER = 3,
  DNS_SERVERS = 6,
  HOSTNAME = 12,
  DOMAIN_NAME = 15,
  BROADCAST_ADDRESS = 28,
  REQUESTED_IP = 50,
  LEASE_TIME = 51,
  MESSAGE_TYPE = 53,
  SERVER_IDENTIFIER = 54,
  PARAMETER_REQUEST_LIST = 55,
  RENEWAL_TIME = 58,
  REBINDING_TIME = 59,
  CLIENT_IDENTIFIER = 61,
  END = 255
}

/**
 * DHCP Option structure
 */
export interface DHCPOptionData {
  code: DHCPOption;
  data: number[];
}

/**
 * DHCP Packet configuration
 */
export interface DHCPPacketConfig {
  operation: DHCPOperation;
  transactionId: number;
  clientMAC: MACAddress;
  messageType: DHCPMessageType;
  hops?: number;
  secs?: number;
  broadcast?: boolean;
  clientIP?: IPAddress;
  yourIP?: IPAddress;
  serverIP?: IPAddress;
  gatewayIP?: IPAddress;
  serverHostname?: string;
  bootFilename?: string;
  options?: DHCPOptionData[];
}

/**
 * DHCP Magic Cookie value (RFC 2131)
 */
const DHCP_MAGIC_COOKIE = [0x63, 0x82, 0x53, 0x63];

/**
 * Minimum DHCP packet size (without options variable part)
 */
const DHCP_MIN_SIZE = 240;

/**
 * Hardware type for Ethernet
 */
const HARDWARE_TYPE_ETHERNET = 1;

/**
 * MAC address length
 */
const HARDWARE_ADDR_LENGTH = 6;

/**
 * DHCPPacket - DHCP message implementation
 */
export class DHCPPacket {
  private readonly operation: DHCPOperation;
  private readonly htype: number;
  private readonly hlen: number;
  private readonly hops: number;
  private readonly transactionId: number;
  private readonly secs: number;
  private readonly flags: number;
  private readonly clientIP?: IPAddress;
  private readonly yourIP?: IPAddress;
  private readonly serverIP?: IPAddress;
  private readonly gatewayIP?: IPAddress;
  private readonly clientMAC: MACAddress;
  private readonly serverHostname: string;
  private readonly bootFilename: string;
  private readonly options: DHCPOptionData[];

  constructor(config: DHCPPacketConfig) {
    this.operation = config.operation;
    this.htype = HARDWARE_TYPE_ETHERNET;
    this.hlen = HARDWARE_ADDR_LENGTH;
    this.hops = config.hops ?? 0;
    this.transactionId = config.transactionId;
    this.secs = config.secs ?? 0;
    this.flags = config.broadcast !== false ? 0x8000 : 0; // Broadcast flag
    this.clientIP = config.clientIP;
    this.yourIP = config.yourIP;
    this.serverIP = config.serverIP;
    this.gatewayIP = config.gatewayIP;
    this.clientMAC = config.clientMAC;
    this.serverHostname = config.serverHostname ?? '';
    this.bootFilename = config.bootFilename ?? '';

    // Build options array with message type
    this.options = [
      { code: DHCPOption.MESSAGE_TYPE, data: [config.messageType] },
      ...(config.options ?? [])
    ];
  }

  // ============== Getters ==============

  public getOperation(): DHCPOperation {
    return this.operation;
  }

  public getHardwareType(): number {
    return this.htype;
  }

  public getHardwareAddressLength(): number {
    return this.hlen;
  }

  public getHops(): number {
    return this.hops;
  }

  public getTransactionId(): number {
    return this.transactionId;
  }

  public getSecs(): number {
    return this.secs;
  }

  public isBroadcast(): boolean {
    return (this.flags & 0x8000) !== 0;
  }

  public getClientIP(): IPAddress | undefined {
    return this.clientIP;
  }

  public getYourIP(): IPAddress | undefined {
    return this.yourIP;
  }

  public getServerIP(): IPAddress | undefined {
    return this.serverIP;
  }

  public getGatewayIP(): IPAddress | undefined {
    return this.gatewayIP;
  }

  public getClientMAC(): MACAddress {
    return this.clientMAC;
  }

  public getServerHostname(): string {
    return this.serverHostname;
  }

  public getBootFilename(): string {
    return this.bootFilename;
  }

  public getOptions(): readonly DHCPOptionData[] {
    return this.options;
  }

  // ============== Option Helpers ==============

  /**
   * Gets a specific option by code
   */
  public getOption(code: DHCPOption): DHCPOptionData | undefined {
    return this.options.find(opt => opt.code === code);
  }

  /**
   * Gets DHCP message type
   */
  public getMessageType(): DHCPMessageType {
    const option = this.getOption(DHCPOption.MESSAGE_TYPE);
    return option ? option.data[0] as DHCPMessageType : DHCPMessageType.DISCOVER;
  }

  /**
   * Gets human-readable message type name
   */
  public getMessageTypeName(): string {
    const type = this.getMessageType();
    const names: Record<DHCPMessageType, string> = {
      [DHCPMessageType.DISCOVER]: 'DHCPDISCOVER',
      [DHCPMessageType.OFFER]: 'DHCPOFFER',
      [DHCPMessageType.REQUEST]: 'DHCPREQUEST',
      [DHCPMessageType.DECLINE]: 'DHCPDECLINE',
      [DHCPMessageType.ACK]: 'DHCPACK',
      [DHCPMessageType.NAK]: 'DHCPNAK',
      [DHCPMessageType.RELEASE]: 'DHCPRELEASE',
      [DHCPMessageType.INFORM]: 'DHCPINFORM'
    };
    return names[type] ?? `Unknown (${type})`;
  }

  /**
   * Gets subnet mask from options
   */
  public getSubnetMask(): IPAddress | undefined {
    const option = this.getOption(DHCPOption.SUBNET_MASK);
    if (!option || option.data.length < 4) return undefined;
    return IPAddress.fromBytes(option.data.slice(0, 4));
  }

  /**
   * Gets router (default gateway) from options
   */
  public getRouter(): IPAddress | undefined {
    const option = this.getOption(DHCPOption.ROUTER);
    if (!option || option.data.length < 4) return undefined;
    return IPAddress.fromBytes(option.data.slice(0, 4));
  }

  /**
   * Gets DNS servers from options
   */
  public getDNSServers(): IPAddress[] {
    const option = this.getOption(DHCPOption.DNS_SERVERS);
    if (!option) return [];

    const servers: IPAddress[] = [];
    for (let i = 0; i + 4 <= option.data.length; i += 4) {
      servers.push(IPAddress.fromBytes(option.data.slice(i, i + 4)));
    }
    return servers;
  }

  /**
   * Gets lease time in seconds from options
   */
  public getLeaseTime(): number | undefined {
    const option = this.getOption(DHCPOption.LEASE_TIME);
    if (!option || option.data.length < 4) return undefined;

    return (option.data[0] << 24) |
           (option.data[1] << 16) |
           (option.data[2] << 8) |
           option.data[3];
  }

  /**
   * Gets requested IP address from options
   */
  public getRequestedIP(): IPAddress | undefined {
    const option = this.getOption(DHCPOption.REQUESTED_IP);
    if (!option || option.data.length < 4) return undefined;
    return IPAddress.fromBytes(option.data.slice(0, 4));
  }

  /**
   * Gets server identifier from options
   */
  public getServerIdentifier(): IPAddress | undefined {
    const option = this.getOption(DHCPOption.SERVER_IDENTIFIER);
    if (!option || option.data.length < 4) return undefined;
    return IPAddress.fromBytes(option.data.slice(0, 4));
  }

  /**
   * Gets parameter request list from options
   */
  public getParameterRequestList(): DHCPOption[] {
    const option = this.getOption(DHCPOption.PARAMETER_REQUEST_LIST);
    if (!option) return [];
    return option.data as DHCPOption[];
  }

  /**
   * Gets domain name from options
   */
  public getDomainName(): string | undefined {
    const option = this.getOption(DHCPOption.DOMAIN_NAME);
    if (!option) return undefined;
    return String.fromCharCode(...option.data);
  }

  /**
   * Gets hostname from options
   */
  public getHostname(): string | undefined {
    const option = this.getOption(DHCPOption.HOSTNAME);
    if (!option) return undefined;
    return String.fromCharCode(...option.data);
  }

  // ============== Serialization ==============

  /**
   * Serializes DHCP packet to bytes (RFC 2131 format)
   */
  public toBytes(): Buffer {
    // Calculate options size
    let optionsSize = 4; // Magic cookie
    for (const opt of this.options) {
      if (opt.code === DHCPOption.PAD || opt.code === DHCPOption.END) {
        optionsSize += 1;
      } else {
        optionsSize += 2 + opt.data.length; // code + length + data
      }
    }
    optionsSize += 1; // END option

    const totalSize = DHCP_MIN_SIZE + optionsSize - 4; // -4 because magic cookie is at 236
    const buffer = Buffer.alloc(totalSize);

    // op (1 byte)
    buffer.writeUInt8(this.operation, 0);

    // htype (1 byte)
    buffer.writeUInt8(this.htype, 1);

    // hlen (1 byte)
    buffer.writeUInt8(this.hlen, 2);

    // hops (1 byte)
    buffer.writeUInt8(this.hops, 3);

    // xid (4 bytes)
    buffer.writeUInt32BE(this.transactionId, 4);

    // secs (2 bytes)
    buffer.writeUInt16BE(this.secs, 8);

    // flags (2 bytes)
    buffer.writeUInt16BE(this.flags, 10);

    // ciaddr (4 bytes)
    if (this.clientIP) {
      const bytes = this.clientIP.toBytes();
      for (let i = 0; i < 4; i++) buffer[12 + i] = bytes[i];
    }

    // yiaddr (4 bytes)
    if (this.yourIP) {
      const bytes = this.yourIP.toBytes();
      for (let i = 0; i < 4; i++) buffer[16 + i] = bytes[i];
    }

    // siaddr (4 bytes)
    if (this.serverIP) {
      const bytes = this.serverIP.toBytes();
      for (let i = 0; i < 4; i++) buffer[20 + i] = bytes[i];
    }

    // giaddr (4 bytes)
    if (this.gatewayIP) {
      const bytes = this.gatewayIP.toBytes();
      for (let i = 0; i < 4; i++) buffer[24 + i] = bytes[i];
    }

    // chaddr (16 bytes) - client hardware address
    const macBytes = this.clientMAC.toBytes();
    for (let i = 0; i < 6; i++) buffer[28 + i] = macBytes[i];
    // Remaining 10 bytes are zero (padding for 16-byte field)

    // sname (64 bytes) - server hostname
    const snameBytes = Buffer.from(this.serverHostname);
    snameBytes.copy(buffer, 44, 0, Math.min(snameBytes.length, 63));

    // file (128 bytes) - boot filename
    const fileBytes = Buffer.from(this.bootFilename);
    fileBytes.copy(buffer, 108, 0, Math.min(fileBytes.length, 127));

    // Magic cookie (4 bytes at offset 236)
    for (let i = 0; i < 4; i++) buffer[236 + i] = DHCP_MAGIC_COOKIE[i];

    // Options (starting at offset 240)
    let optOffset = 240;
    for (const opt of this.options) {
      if (opt.code === DHCPOption.PAD) {
        buffer.writeUInt8(0, optOffset++);
      } else if (opt.code === DHCPOption.END) {
        buffer.writeUInt8(255, optOffset++);
      } else {
        buffer.writeUInt8(opt.code, optOffset++);
        buffer.writeUInt8(opt.data.length, optOffset++);
        for (const byte of opt.data) {
          buffer.writeUInt8(byte, optOffset++);
        }
      }
    }

    // END option
    buffer.writeUInt8(DHCPOption.END, optOffset);

    return buffer;
  }

  /**
   * Deserializes DHCP packet from bytes
   */
  public static fromBytes(bytes: Buffer): DHCPPacket {
    if (bytes.length < DHCP_MIN_SIZE) {
      throw new Error(`Invalid DHCP packet size: ${bytes.length} < ${DHCP_MIN_SIZE}`);
    }

    // Verify magic cookie
    if (bytes[236] !== 0x63 || bytes[237] !== 0x82 ||
        bytes[238] !== 0x53 || bytes[239] !== 0x63) {
      throw new Error('Invalid DHCP magic cookie');
    }

    const operation = bytes.readUInt8(0) as DHCPOperation;
    const hops = bytes.readUInt8(3);
    const transactionId = bytes.readUInt32BE(4);
    const secs = bytes.readUInt16BE(8);
    const flags = bytes.readUInt16BE(10);

    // Parse IP addresses
    const ciaddr = bytes.slice(12, 16);
    const yiaddr = bytes.slice(16, 20);
    const siaddr = bytes.slice(20, 24);
    const giaddr = bytes.slice(24, 28);

    const clientIP = DHCPPacket.isZeroIP(ciaddr) ? undefined : IPAddress.fromBytes(Array.from(ciaddr));
    const yourIP = DHCPPacket.isZeroIP(yiaddr) ? undefined : IPAddress.fromBytes(Array.from(yiaddr));
    const serverIP = DHCPPacket.isZeroIP(siaddr) ? undefined : IPAddress.fromBytes(Array.from(siaddr));
    const gatewayIP = DHCPPacket.isZeroIP(giaddr) ? undefined : IPAddress.fromBytes(Array.from(giaddr));

    // Parse client MAC
    const macBytes = Array.from(bytes.slice(28, 34));
    const clientMAC = MACAddress.fromBytes(macBytes);

    // Parse server hostname
    const snameEnd = bytes.indexOf(0, 44);
    const serverHostname = bytes.toString('utf8', 44, snameEnd > 44 ? snameEnd : 108).replace(/\0/g, '');

    // Parse boot filename
    const fileEnd = bytes.indexOf(0, 108);
    const bootFilename = bytes.toString('utf8', 108, fileEnd > 108 ? fileEnd : 236).replace(/\0/g, '');

    // Parse options (starting at offset 240)
    const options: DHCPOptionData[] = [];
    let messageType = DHCPMessageType.DISCOVER;
    let optOffset = 240;

    while (optOffset < bytes.length) {
      const code = bytes.readUInt8(optOffset++);

      if (code === DHCPOption.PAD) {
        continue;
      }

      if (code === DHCPOption.END) {
        break;
      }

      if (optOffset >= bytes.length) break;
      const length = bytes.readUInt8(optOffset++);

      if (optOffset + length > bytes.length) break;
      const data = Array.from(bytes.slice(optOffset, optOffset + length));
      optOffset += length;

      if (code === DHCPOption.MESSAGE_TYPE && data.length > 0) {
        messageType = data[0] as DHCPMessageType;
      }

      options.push({ code, data });
    }

    // Remove MESSAGE_TYPE from options (it will be added in constructor)
    const filteredOptions = options.filter(opt => opt.code !== DHCPOption.MESSAGE_TYPE);

    return new DHCPPacket({
      operation,
      transactionId,
      clientMAC,
      messageType,
      hops,
      secs,
      broadcast: (flags & 0x8000) !== 0,
      clientIP,
      yourIP,
      serverIP,
      gatewayIP,
      serverHostname,
      bootFilename,
      options: filteredOptions
    });
  }

  /**
   * Checks if IP bytes are all zeros
   */
  private static isZeroIP(bytes: Buffer): boolean {
    return bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
  }

  // ============== Factory Methods ==============

  /**
   * Generates random transaction ID
   */
  private static generateTransactionId(): number {
    return Math.floor(Math.random() * 0xFFFFFFFF);
  }

  /**
   * Creates DHCP DISCOVER packet
   */
  public static createDiscover(
    clientMAC: MACAddress,
    hostname?: string,
    requestedIP?: IPAddress
  ): DHCPPacket {
    const options: DHCPOptionData[] = [];

    // Parameter request list
    options.push({
      code: DHCPOption.PARAMETER_REQUEST_LIST,
      data: [
        DHCPOption.SUBNET_MASK,
        DHCPOption.ROUTER,
        DHCPOption.DNS_SERVERS,
        DHCPOption.DOMAIN_NAME,
        DHCPOption.BROADCAST_ADDRESS,
        DHCPOption.LEASE_TIME
      ]
    });

    // Hostname if provided
    if (hostname) {
      options.push({
        code: DHCPOption.HOSTNAME,
        data: Array.from(Buffer.from(hostname))
      });
    }

    // Requested IP if provided
    if (requestedIP) {
      options.push({
        code: DHCPOption.REQUESTED_IP,
        data: requestedIP.toBytes()
      });
    }

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREQUEST,
      transactionId: DHCPPacket.generateTransactionId(),
      clientMAC,
      messageType: DHCPMessageType.DISCOVER,
      broadcast: true,
      options
    });
  }

  /**
   * Creates DHCP OFFER packet in response to DISCOVER
   */
  public static createOffer(
    discover: DHCPPacket,
    offeredIP: IPAddress,
    serverIP: IPAddress,
    subnetMask: IPAddress,
    router: IPAddress,
    dnsServers: IPAddress[],
    leaseTime: number
  ): DHCPPacket {
    const options: DHCPOptionData[] = [
      {
        code: DHCPOption.SUBNET_MASK,
        data: subnetMask.toBytes()
      },
      {
        code: DHCPOption.ROUTER,
        data: router.toBytes()
      },
      {
        code: DHCPOption.SERVER_IDENTIFIER,
        data: serverIP.toBytes()
      },
      {
        code: DHCPOption.LEASE_TIME,
        data: [
          (leaseTime >> 24) & 0xFF,
          (leaseTime >> 16) & 0xFF,
          (leaseTime >> 8) & 0xFF,
          leaseTime & 0xFF
        ]
      }
    ];

    // Add DNS servers
    if (dnsServers.length > 0) {
      const dnsData: number[] = [];
      for (const dns of dnsServers) {
        dnsData.push(...dns.toBytes());
      }
      options.push({
        code: DHCPOption.DNS_SERVERS,
        data: dnsData
      });
    }

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREPLY,
      transactionId: discover.getTransactionId(),
      clientMAC: discover.getClientMAC(),
      messageType: DHCPMessageType.OFFER,
      yourIP: offeredIP,
      serverIP,
      broadcast: discover.isBroadcast(),
      options
    });
  }

  /**
   * Creates DHCP REQUEST packet in response to OFFER
   */
  public static createRequest(
    offer: DHCPPacket,
    clientMAC: MACAddress
  ): DHCPPacket {
    const offeredIP = offer.getYourIP();
    const serverID = offer.getServerIdentifier() ?? offer.getServerIP();

    const options: DHCPOptionData[] = [];

    if (offeredIP) {
      options.push({
        code: DHCPOption.REQUESTED_IP,
        data: offeredIP.toBytes()
      });
    }

    if (serverID) {
      options.push({
        code: DHCPOption.SERVER_IDENTIFIER,
        data: serverID.toBytes()
      });
    }

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREQUEST,
      transactionId: offer.getTransactionId(),
      clientMAC,
      messageType: DHCPMessageType.REQUEST,
      broadcast: true,
      options
    });
  }

  /**
   * Creates DHCP ACK packet in response to REQUEST
   */
  public static createAck(
    request: DHCPPacket,
    assignedIP: IPAddress,
    serverIP: IPAddress,
    subnetMask: IPAddress,
    router: IPAddress,
    dnsServers: IPAddress[],
    leaseTime: number
  ): DHCPPacket {
    const options: DHCPOptionData[] = [
      {
        code: DHCPOption.SUBNET_MASK,
        data: subnetMask.toBytes()
      },
      {
        code: DHCPOption.ROUTER,
        data: router.toBytes()
      },
      {
        code: DHCPOption.SERVER_IDENTIFIER,
        data: serverIP.toBytes()
      },
      {
        code: DHCPOption.LEASE_TIME,
        data: [
          (leaseTime >> 24) & 0xFF,
          (leaseTime >> 16) & 0xFF,
          (leaseTime >> 8) & 0xFF,
          leaseTime & 0xFF
        ]
      },
      {
        code: DHCPOption.RENEWAL_TIME,
        data: [
          ((leaseTime / 2) >> 24) & 0xFF,
          ((leaseTime / 2) >> 16) & 0xFF,
          ((leaseTime / 2) >> 8) & 0xFF,
          (leaseTime / 2) & 0xFF
        ]
      },
      {
        code: DHCPOption.REBINDING_TIME,
        data: [
          ((leaseTime * 0.875) >> 24) & 0xFF,
          ((leaseTime * 0.875) >> 16) & 0xFF,
          ((leaseTime * 0.875) >> 8) & 0xFF,
          Math.floor(leaseTime * 0.875) & 0xFF
        ]
      }
    ];

    // Add DNS servers
    if (dnsServers.length > 0) {
      const dnsData: number[] = [];
      for (const dns of dnsServers) {
        dnsData.push(...dns.toBytes());
      }
      options.push({
        code: DHCPOption.DNS_SERVERS,
        data: dnsData
      });
    }

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREPLY,
      transactionId: request.getTransactionId(),
      clientMAC: request.getClientMAC(),
      messageType: DHCPMessageType.ACK,
      yourIP: assignedIP,
      serverIP,
      broadcast: request.isBroadcast(),
      options
    });
  }

  /**
   * Creates DHCP NAK packet in response to REQUEST
   */
  public static createNak(
    request: DHCPPacket,
    serverIP: IPAddress,
    message?: string
  ): DHCPPacket {
    const options: DHCPOptionData[] = [
      {
        code: DHCPOption.SERVER_IDENTIFIER,
        data: serverIP.toBytes()
      }
    ];

    // Add error message if provided
    if (message) {
      options.push({
        code: 56, // DHCP Message option
        data: Array.from(Buffer.from(message))
      });
    }

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREPLY,
      transactionId: request.getTransactionId(),
      clientMAC: request.getClientMAC(),
      messageType: DHCPMessageType.NAK,
      serverIP,
      broadcast: true, // NAK is always broadcast
      options
    });
  }

  /**
   * Creates DHCP RELEASE packet
   */
  public static createRelease(
    clientIP: IPAddress,
    clientMAC: MACAddress,
    serverIP: IPAddress
  ): DHCPPacket {
    const options: DHCPOptionData[] = [
      {
        code: DHCPOption.SERVER_IDENTIFIER,
        data: serverIP.toBytes()
      }
    ];

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREQUEST,
      transactionId: DHCPPacket.generateTransactionId(),
      clientMAC,
      messageType: DHCPMessageType.RELEASE,
      clientIP,
      broadcast: false, // RELEASE is unicast
      options
    });
  }

  /**
   * Creates DHCP DECLINE packet
   */
  public static createDecline(
    requestedIP: IPAddress,
    clientMAC: MACAddress,
    serverIP: IPAddress
  ): DHCPPacket {
    const options: DHCPOptionData[] = [
      {
        code: DHCPOption.REQUESTED_IP,
        data: requestedIP.toBytes()
      },
      {
        code: DHCPOption.SERVER_IDENTIFIER,
        data: serverIP.toBytes()
      }
    ];

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREQUEST,
      transactionId: DHCPPacket.generateTransactionId(),
      clientMAC,
      messageType: DHCPMessageType.DECLINE,
      broadcast: false,
      options
    });
  }

  /**
   * Creates DHCP INFORM packet
   */
  public static createInform(
    clientIP: IPAddress,
    clientMAC: MACAddress
  ): DHCPPacket {
    const options: DHCPOptionData[] = [
      {
        code: DHCPOption.PARAMETER_REQUEST_LIST,
        data: [
          DHCPOption.SUBNET_MASK,
          DHCPOption.ROUTER,
          DHCPOption.DNS_SERVERS,
          DHCPOption.DOMAIN_NAME
        ]
      }
    ];

    return new DHCPPacket({
      operation: DHCPOperation.BOOTREQUEST,
      transactionId: DHCPPacket.generateTransactionId(),
      clientMAC,
      messageType: DHCPMessageType.INFORM,
      clientIP,
      broadcast: false,
      options
    });
  }
}
