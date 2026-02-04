/**
 * Tests for Port and Cable
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, EthernetFrame, ETHERTYPE_IPV4 } from '@/network/core/types';

function makeFrame(srcMAC?: MACAddress, dstMAC?: MACAddress): EthernetFrame {
  return {
    srcMAC: srcMAC || MACAddress.generate(),
    dstMAC: dstMAC || MACAddress.generate(),
    etherType: ETHERTYPE_IPV4,
    payload: { type: 'test' },
  };
}

describe('Port', () => {
  beforeEach(() => { MACAddress.resetCounter(); });

  it('should have a name and MAC', () => {
    const port = new Port('eth0');
    expect(port.getName()).toBe('eth0');
    expect(port.getMAC()).toBeInstanceOf(MACAddress);
  });

  it('should start as up and unconnected', () => {
    const port = new Port('eth0');
    expect(port.getIsUp()).toBe(true);
    expect(port.isConnected()).toBe(false);
  });

  it('should not send when no cable', () => {
    const port = new Port('eth0');
    const result = port.sendFrame(makeFrame());
    expect(result).toBe(false);
  });

  it('should not send when down', () => {
    const port = new Port('eth0');
    port.setUp(false);
    const result = port.sendFrame(makeFrame());
    expect(result).toBe(false);
  });

  it('should deliver received frames to handler', () => {
    const port = new Port('eth0');
    let received: EthernetFrame | null = null;
    port.onFrame((name, frame) => { received = frame; });

    const frame = makeFrame();
    port.receiveFrame(frame);

    expect(received).toBe(frame);
  });

  it('should not deliver when down', () => {
    const port = new Port('eth0');
    let received = false;
    port.onFrame(() => { received = true; });
    port.setUp(false);
    port.receiveFrame(makeFrame());
    expect(received).toBe(false);
  });
});

describe('Cable', () => {
  beforeEach(() => { MACAddress.resetCounter(); });

  it('should connect two ports', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);

    expect(portA.isConnected()).toBe(true);
    expect(portB.isConnected()).toBe(true);
  });

  it('should transmit frame from port A to port B', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);

    let received: EthernetFrame | null = null;
    portB.onFrame((name, frame) => { received = frame; });

    const frame = makeFrame();
    cable.transmit(frame, portA);

    expect(received).toBe(frame);
  });

  it('should transmit frame from port B to port A', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);

    let received: EthernetFrame | null = null;
    portA.onFrame((name, frame) => { received = frame; });

    const frame = makeFrame();
    cable.transmit(frame, portB);

    expect(received).toBe(frame);
  });

  it('should not transmit when cable is down', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);
    cable.setUp(false);

    let received = false;
    portB.onFrame(() => { received = true; });

    const result = cable.transmit(makeFrame(), portA);
    expect(result).toBe(false);
    expect(received).toBe(false);
  });

  it('should disconnect both ports', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);
    cable.disconnect();

    expect(portA.isConnected()).toBe(false);
    expect(portB.isConnected()).toBe(false);
  });
});
