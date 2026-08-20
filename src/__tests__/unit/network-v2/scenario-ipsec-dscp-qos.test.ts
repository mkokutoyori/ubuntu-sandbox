import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  DSCP, computeOuterTos, propagateCeOnDecap,
  makeCopyConfig, makeSetConfig, makeMapConfig,
  dscpOf, ecnOf, withDscp,
} from '@/network/ipsec/DscpTunnelMarker';

const ECN_NONE = 0b00;
const ECN_ECT0 = 0b10;
const ECN_CE = 0b11;

describe('Scénario 16 — DSCP et QoS à travers un tunnel IPsec', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  describe('Constantes DSCP conformes aux standards', () => {
    it('EF (voix) = 46, AF41 (video/critique) = 34, CS0 (best-effort) = 0', () => {
      expect(DSCP.EF).toBe(46);
      expect(DSCP.AF41).toBe(34);
      expect(DSCP.CS0).toBe(0);
    });

    it('les classes CS et AF sont bien espacées (RFC 2474/2597)', () => {
      expect(DSCP.CS1).toBe(8);
      expect(DSCP.CS6).toBe(48);
      expect(DSCP.AF11).toBe(10);
      expect(DSCP.AF43).toBe(38);
    });
  });

  describe('Décodage TOS ↦ DSCP/ECN', () => {
    it('dscpOf isole les bits 7-2', () => {
      expect(dscpOf(withDscp(0, DSCP.EF))).toBe(DSCP.EF);
      expect(dscpOf(withDscp(0, DSCP.AF41))).toBe(DSCP.AF41);
    });

    it('ecnOf isole les bits 1-0', () => {
      const tos = (DSCP.EF << 2) | ECN_CE;
      expect(ecnOf(tos)).toBe(ECN_CE);
      expect(dscpOf(tos)).toBe(DSCP.EF);
    });

    it('withDscp rejette une valeur hors [0,63]', () => {
      expect(() => withDscp(0, 64)).toThrow(/out of range/i);
      expect(() => withDscp(0, -1)).toThrow(/out of range/i);
    });
  });

  describe('Mode copy — visibilité QoS pour les équipements intermédiaires', () => {
    it('DSCP interne EF est recopié tel quel sur le header externe', () => {
      const tos = withDscp(0, DSCP.EF);
      const outer = computeOuterTos(tos, makeCopyConfig());
      expect(dscpOf(outer)).toBe(DSCP.EF);
    });

    it('DSCP AF41 est préservé sur le header externe', () => {
      const outer = computeOuterTos(withDscp(0, DSCP.AF41), makeCopyConfig());
      expect(dscpOf(outer)).toBe(DSCP.AF41);
    });

    it('CS0 (best-effort) reste à zéro', () => {
      const outer = computeOuterTos(withDscp(0, DSCP.CS0), makeCopyConfig());
      expect(dscpOf(outer)).toBe(DSCP.CS0);
    });
  });

  describe('Mode set — QoS aveugle sur le chemin intermédiaire', () => {
    it("réécrit le DSCP externe à une valeur fixe indépendamment du contenu interne", () => {
      const cfg = makeSetConfig(DSCP.CS0);
      expect(dscpOf(computeOuterTos(withDscp(0, DSCP.EF), cfg))).toBe(DSCP.CS0);
      expect(dscpOf(computeOuterTos(withDscp(0, DSCP.AF41), cfg))).toBe(DSCP.CS0);
      expect(dscpOf(computeOuterTos(withDscp(0, DSCP.AF11), cfg))).toBe(DSCP.CS0);
    });

    it("makeSetConfig refuse une valeur DSCP hors [0,63]", () => {
      expect(() => makeSetConfig(64)).toThrow(/out of range/i);
    });

    it("un déploiement 'set 0' rend la QoS invisible aux équipements du chemin (démo explicite)", () => {
      const cfg = makeSetConfig(0);
      const voix = withDscp(0, DSCP.EF);
      const video = withDscp(0, DSCP.AF41);
      const outers = [voix, video].map(t => dscpOf(computeOuterTos(t, cfg)));
      expect(new Set(outers).size).toBe(1);
    });
  });

  describe('Mode map — remappage explicite', () => {
    it('remappe EF ↦ AF31 et AF41 ↦ AF21 quand la table le prescrit', () => {
      const cfg = makeMapConfig(new Map([
        [DSCP.EF, DSCP.AF31],
        [DSCP.AF41, DSCP.AF21],
      ]));
      expect(dscpOf(computeOuterTos(withDscp(0, DSCP.EF), cfg))).toBe(DSCP.AF31);
      expect(dscpOf(computeOuterTos(withDscp(0, DSCP.AF41), cfg))).toBe(DSCP.AF21);
    });

    it('un DSCP non listé dans la map retombe sur la valeur interne (fallback = copy)', () => {
      const cfg = makeMapConfig(new Map([[DSCP.EF, DSCP.AF31]]));
      expect(dscpOf(computeOuterTos(withDscp(0, DSCP.AF41), cfg))).toBe(DSCP.AF41);
    });

    it("makeMapConfig refuse une clé ou valeur hors [0,63]", () => {
      expect(() => makeMapConfig(new Map([[100, 10]]))).toThrow(/out of range/i);
      expect(() => makeMapConfig(new Map([[10, 100]]))).toThrow(/out of range/i);
    });
  });

  describe('ECN — RFC 6040', () => {
    it('mode copy propage les bits ECN vers l\'externe', () => {
      const tos = (DSCP.EF << 2) | ECN_ECT0;
      const outer = computeOuterTos(tos, makeCopyConfig());
      expect(ecnOf(outer)).toBe(ECN_ECT0);
    });

    it("ecnEnabled=false efface l'ECN sur l'externe", () => {
      const tos = (DSCP.EF << 2) | ECN_ECT0;
      const cfg = { ...makeCopyConfig(), ecnEnabled: false };
      const outer = computeOuterTos(tos, cfg);
      expect(ecnOf(outer)).toBe(ECN_NONE);
    });

    it('propagateCeOnDecap : outer=CE ⟹ inner reçoit CE', () => {
      const outerTos = (DSCP.CS0 << 2) | ECN_CE;
      const innerTos = (DSCP.EF << 2) | ECN_ECT0;
      const updated = propagateCeOnDecap(outerTos, innerTos, makeCopyConfig());
      expect(ecnOf(updated)).toBe(ECN_CE);
      expect(dscpOf(updated)).toBe(DSCP.EF);
    });

    it("propagateCeOnDecap : sans CE sur l'externe, l'ECN interne n'est pas modifié", () => {
      const outerTos = (DSCP.CS0 << 2) | ECN_ECT0;
      const innerTos = (DSCP.EF << 2) | ECN_ECT0;
      const updated = propagateCeOnDecap(outerTos, innerTos, makeCopyConfig());
      expect(updated).toBe(innerTos);
    });

    it("propagateCeOnDecap : quand ecnEnabled=false, l'inner reste intact même si outer=CE", () => {
      const outerTos = (DSCP.CS0 << 2) | ECN_CE;
      const innerTos = (DSCP.EF << 2) | ECN_ECT0;
      const cfg = { ...makeCopyConfig(), ecnEnabled: false };
      expect(propagateCeOnDecap(outerTos, innerTos, cfg)).toBe(innerTos);
    });
  });

  describe('Traçabilité et cohérence bout-en-bout', () => {
    it('un flux VoIP EF traverse copy ↦ copy sans dégradation', () => {
      const innerTos = withDscp(0, DSCP.EF);
      const outerTos = computeOuterTos(innerTos, makeCopyConfig());
      expect(dscpOf(outerTos)).toBe(DSCP.EF);
      const decapedInner = propagateCeOnDecap(outerTos, innerTos, makeCopyConfig());
      expect(dscpOf(decapedInner)).toBe(DSCP.EF);
    });

    it("un flux EF traverse set 0 ↦ arrive avec inner=EF intact (le DSCP interne n'est jamais réécrit)", () => {
      const innerTos = withDscp(0, DSCP.EF);
      const outerTos = computeOuterTos(innerTos, makeSetConfig(0));
      expect(dscpOf(outerTos)).toBe(0);
      const decapedInner = propagateCeOnDecap(outerTos, innerTos, makeSetConfig(0));
      expect(dscpOf(decapedInner)).toBe(DSCP.EF);
    });

    it('trois classes distinctes (EF, AF41, CS0) restent séparables en mode copy', () => {
      const cfg = makeCopyConfig();
      const outers = [DSCP.EF, DSCP.AF41, DSCP.CS0].map(d => dscpOf(computeOuterTos(withDscp(0, d), cfg)));
      expect(new Set(outers).size).toBe(3);
    });

    it('les trois mêmes classes deviennent indiscernables en mode set 0 (QoS externe aveugle)', () => {
      const cfg = makeSetConfig(0);
      const outers = [DSCP.EF, DSCP.AF41, DSCP.CS0].map(d => dscpOf(computeOuterTos(withDscp(0, d), cfg)));
      expect(new Set(outers).size).toBe(1);
    });
  });
});
