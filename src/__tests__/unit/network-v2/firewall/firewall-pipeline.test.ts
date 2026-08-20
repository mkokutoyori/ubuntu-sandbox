/**
 * `FirewallPipeline` — le pari d'architecture du module.
 *
 * BRD-Firewall §13.1 et principe P2 : **l'ordre d'operations est une DONNEE,
 * pas du code**. Quatre constructeurs, quatre ordres, un seul moteur.
 * Ajouter un vendeur dont l'ordre differe ne doit jamais conduire a un
 * `if (vendor === ...)` dans le moteur.
 *
 * Ce fichier verifie cette affirmation plutot que de la repeter : deux
 * profils qui ne different QUE par leur liste d'etapes produisent deux
 * traces differentes, sans qu'aucun code ne les distingue.
 *
 * Le pipeline est bati sur `core/FilterChain.ts`, qui existait deja et
 * n'etait pas utilise (BRD §4.1.5). Rien n'est reecrit ici : le registre
 * d'etapes et la composition depuis un profil sont les deux seules
 * nouveautes.
 *
 * G7 : une etape declaree par un profil mais absente du registre est
 * refusee A LA COMPOSITION, pas silencieusement ignoree — sinon un profil
 * avec une faute de frappe produirait un pare-feu qui saute une etape sans
 * que rien ne le dise.
 */

import { describe, it, expect } from 'vitest';
import {
  FirewallPipeline,
  PipelineStageRegistry,
  UnknownPipelineStageError,
  type PipelineStage,
} from '@/network/devices/firewall/pipeline/FirewallPipeline';
import { makePacketContext, type PacketContext } from '@/network/devices/firewall/pipeline/PacketContext';
import { Continue, Drop, Transform } from '@/network/core/FilterChain';
import { IPAddress, IP_PROTO_TCP, type IPv4Packet } from '@/network/core/types';

function packet(): IPv4Packet {
  return {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 40,
    identification: 1, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: new IPAddress('192.168.1.10'),
    destinationIP: new IPAddress('203.0.113.5'),
    payload: null,
  } as IPv4Packet;
}

function context(): PacketContext {
  return makePacketContext({ ingressPort: 'port1', packet: packet(), arrivedAt: 1000 });
}

function noop(name: string): PipelineStage {
  return { name, apply: () => Continue() };
}

function marking(name: string): PipelineStage {
  return {
    name,
    apply: (ctx) => {
      ctx.trace.push({ stage: name, verdict: 'continue' });
      return Continue();
    },
  };
}

function dropping(name: string, reason: string): PipelineStage {
  return { name, apply: () => Drop(reason) };
}

function registry(...stages: PipelineStage[]): PipelineStageRegistry {
  const r = new PipelineStageRegistry();
  for (const stage of stages) r.register(stage);
  return r;
}

describe('PipelineStageRegistry — patron Registre', () => {
  it('enregistre et retrouve une etape', () => {
    const r = registry(noop('a'));

    expect(r.has('a')).toBe(true);
    expect(r.get('a')?.name).toBe('a');
  });

  it('ne connait pas une etape non enregistree', () => {
    expect(registry().has('fantome')).toBe(false);
  });

  it('refuse d\'enregistrer deux fois le meme nom', () => {
    const r = registry(noop('a'));

    expect(() => r.register(noop('a'))).toThrow();
  });

  it('remplace explicitement une etape quand on le demande', () => {
    const r = registry(noop('a'));

    r.replace(dropping('a', 'remplacee'));

    expect(r.get('a')).toBeDefined();
  });

  it('E1 : ajouter une etape n\'exige de toucher a rien d\'autre', () => {
    const r = registry(noop('a'));
    r.register(noop('nouvelle-etape'));

    const pipeline = FirewallPipeline.fromStageNames(['a', 'nouvelle-etape'], r);

    expect(pipeline.stageNames()).toEqual(['a', 'nouvelle-etape']);
  });
});

describe('FirewallPipeline — P2, l\'ordre est une donnee', () => {
  it('compose les etapes dans l\'ordre declare', () => {
    const r = registry(marking('un'), marking('deux'), marking('trois'));

    const pipeline = FirewallPipeline.fromStageNames(['un', 'deux', 'trois'], r);

    expect(pipeline.stageNames()).toEqual(['un', 'deux', 'trois']);
  });

  it('DEUX profils, DEUX ordres, AUCUN code different', () => {
    const r = registry(marking('nat'), marking('policy'), marking('route'));

    const asaLike = FirewallPipeline.fromStageNames(['nat', 'policy', 'route'], r);
    const fortiLike = FirewallPipeline.fromStageNames(['nat', 'route', 'policy'], r);

    const a = context();
    const b = context();
    asaLike.process(a);
    fortiLike.process(b);

    expect(a.trace.map(t => t.stage)).toEqual(['nat', 'policy', 'route']);
    expect(b.trace.map(t => t.stage)).toEqual(['nat', 'route', 'policy']);
  });

  it('la meme etape peut servir deux profils sans etre dupliquee', () => {
    const r = registry(marking('commune'), marking('propre-a-l-un'));

    const p1 = FirewallPipeline.fromStageNames(['commune'], r);
    const p2 = FirewallPipeline.fromStageNames(['commune', 'propre-a-l-un'], r);

    expect(p1.stageNames()).toEqual(['commune']);
    expect(p2.stageNames()).toEqual(['commune', 'propre-a-l-un']);
  });

  it('un pipeline VIDE accepte sans rien faire', () => {
    const pipeline = FirewallPipeline.fromStageNames([], registry());

    const outcome = pipeline.process(context());

    expect(outcome.verdict).toBe('accepted');
  });
});

describe('FirewallPipeline — G7, etape inconnue', () => {
  it('refuse la composition quand une etape declaree n\'existe pas', () => {
    const r = registry(noop('a'));

    expect(() => FirewallPipeline.fromStageNames(['a', 'fantome'], r))
      .toThrow(UnknownPipelineStageError);
  });

  it('l\'erreur NOMME l\'etape manquante', () => {
    const r = registry(noop('a'));

    try {
      FirewallPipeline.fromStageNames(['a', 'fantome'], r);
      expect.unreachable('la composition aurait du echouer');
    } catch (error) {
      expect((error as UnknownPipelineStageError).stageName).toBe('fantome');
    }
  });

  it('ne compose PAS partiellement — rien plutot qu\'un pipeline ampute', () => {
    const r = registry(noop('a'));

    expect(() => FirewallPipeline.fromStageNames(['a', 'fantome', 'a'], r)).toThrow();
  });
});

describe('FirewallPipeline — verdicts', () => {
  it('une etape qui rejette arrete la chaine', () => {
    const r = registry(marking('un'), dropping('deux', 'policy-deny'), marking('trois'));
    const pipeline = FirewallPipeline.fromStageNames(['un', 'deux', 'trois'], r);
    const ctx = context();

    const outcome = pipeline.process(ctx);

    expect(outcome.verdict).toBe('dropped');
    expect(outcome.reason).toBe('policy-deny');
    expect(ctx.trace.map(t => t.stage)).toEqual(['un']);
  });

  it('nomme l\'etape qui a decide', () => {
    const r = registry(noop('un'), dropping('deux', 'no-route'));
    const pipeline = FirewallPipeline.fromStageNames(['un', 'deux'], r);

    expect(pipeline.process(context()).decidedBy).toBe('deux');
  });

  it('une etape qui transforme passe le contexte modifie a la suivante', () => {
    const r = new PipelineStageRegistry();
    r.register({
      name: 'zone',
      apply: (ctx) => Transform({ ...ctx, ingressZone: 'trust' }),
    });
    r.register({
      name: 'lecture',
      apply: (ctx) => {
        ctx.trace.push({ stage: 'lecture', verdict: 'continue', detail: ctx.ingressZone });
        return Continue();
      },
    });
    const pipeline = FirewallPipeline.fromStageNames(['zone', 'lecture'], r);
    const ctx = context();

    const outcome = pipeline.process(ctx);

    expect(outcome.payload?.ingressZone).toBe('trust');
    expect(outcome.payload?.trace.at(-1)?.detail).toBe('trust');
  });

  it('la trace de la chaine liste TOUTES les etapes traversees', () => {
    const r = registry(noop('un'), dropping('deux', 'stop'), noop('trois'));
    const pipeline = FirewallPipeline.fromStageNames(['un', 'deux', 'trois'], r);

    expect(pipeline.process(context()).trace).toEqual(['un', 'deux']);
  });

  it('une etape qui leve devient un rejet, jamais une exception qui remonte', () => {
    const r = new PipelineStageRegistry();
    r.register({ name: 'casse', apply: () => { throw new Error('boum'); } });
    const pipeline = FirewallPipeline.fromStageNames(['casse'], r);

    const outcome = pipeline.process(context());

    expect(outcome.verdict).toBe('rejected');
    expect(outcome.decidedBy).toBe('casse');
  });
});

describe('PacketContext', () => {
  it('porte le paquet ORIGINAL a cote du courant', () => {
    const ctx = context();

    expect(ctx.originalPacket).toBe(ctx.packet);
  });

  it('l\'original ne suit pas une transformation du courant', () => {
    const ctx = context();
    const original = ctx.originalPacket;

    ctx.packet = { ...ctx.packet, ttl: 63 } as IPv4Packet;

    expect(ctx.originalPacket).toBe(original);
    expect((ctx.originalPacket as IPv4Packet).ttl).toBe(64);
    expect((ctx.packet as IPv4Packet).ttl).toBe(63);
  });

  it('demarre en premier paquet', () => {
    expect(context().isFirstPacket).toBe(true);
  });

  it('demarre avec une trace vide et sans verdict', () => {
    const ctx = context();

    expect(ctx.trace).toEqual([]);
    expect(ctx.verdict).toBeUndefined();
  });

  it('attribue un identifiant distinct a chaque contexte', () => {
    expect(context().id).not.toBe(context().id);
  });

  it('porte l\'instant d\'arrivee', () => {
    expect(context().arrivedAt).toBe(1000);
  });
});
