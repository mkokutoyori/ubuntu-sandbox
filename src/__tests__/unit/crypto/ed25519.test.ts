/*
 * Ed25519 (RFC 8032 §5.1) confronte aux vecteurs publies.
 *
 * Les vecteurs viennent de `sign.input`, le fichier de reference de
 * l'implementation de Bernstein et al., tel que pyca/cryptography le
 * distribue (vectors/cryptography_vectors/asymmetric/Ed25519/sign.input).
 * Ses lignes 1, 2, 3 et 1024 sont les TEST 1, 2, 3 et 1024 du §7.1 de la
 * RFC 8032, que le proxy de sortie ne laisse pas lire directement ; les
 * lignes 64 et 512 elargissent l'echantillon. Chaque ligne donne la
 * graine, la cle publique, le message et la signature.
 *
 * Comme pour X25519, seule la confrontation distingue une implementation
 * d'une invention plausible : une arithmetique d'Edwards ecrite de
 * memoire signe et verifie ses propres signatures sans jamais produire
 * celles de la reference.
 */
import { describe, it, expect } from 'vitest';
import { ed25519PublicKey, ed25519Sign, ed25519Verify, ED25519_ORDER } from '@/crypto/ecc';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';

const VECTORS: readonly { line: number; seed: string; publicKey: string; message: string; signature: string }[] = [
  {
    line: 1,
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    line: 2,
    seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    line: 3,
    seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
  {
    line: 64,
    seed: 'de84f2435f78dedb87da18194ff6a336f08111150def901c1ac418146eb7b54a',
    publicKey: 'd3a92bbaa4d63af79c2226a7236e6427428df8b362427f873023b22d2f5e03f2',
    message: [
      '205135ec7f417c858072d5233fb36482d4906abd60a74a498c347ff248dfa2722ca74e879de33169fadc7cd44d6c94a1',
      '7d16e1e630824ba3e0df22ed68eaab',
    ].join(''),
    signature: '471ebc973cfdaceec07279307368b73be35bc6f8d8312b70150567369096706dc471126c3576f9f0eb550df5ac6a525181110029dd1fc11174d1aaced48d630f',
  },
  {
    line: 512,
    seed: '4f4b20d899366f2f23ee628f229b236cf80f43ba183177c97ee34829546f1742',
    publicKey: 'c94576641f4a893cdfcee7b39fc21929b86b349976d7b0a46d39a588bcfe4357',
    message: [
      'db8ef02e3033e6b96a56cab05082fb4695f4a1c916250dd75173f430a10c9468817709d37623346ae8245b42bda0da6b',
      '60462ccfdfc75a9ab994e66c9ab9fecdd8599610910affe4f10215cb280bf8f9f2700a444796dae93e06c6bea7d8b4fe',
      '1301baa79ccec769368feb2442c7de84f095e6b3bff63d388cbafb2b9809dc38e9b12ebd039c0a57f4d522e91ec8d1f2',
      'b8d23a4a0ae059af85393bb0a15f749110f6774a1fd731a6ec213e4ff435daab546d31ed9ec3b6d8cc2edacebf4facc5',
      '566556eea92e5b3f2542239b25e28012dd4ef40072eebf83ed2a255181f3a442189d68c6c609f4dfdf3db7d67d087a2f',
      'cd6d2dc50bbfed8bfbbfcb74d3c41f02a87865b13b8efcf5c3581257be0aa913f60c370527bde11a475c136a17c5eefe',
      'b03f5bff28693ed841e8ed1f7c29102f5599dd444009bcea6a92d5574152458e0caf8a36aa72b5dc4908a6461c9b7414',
      '53005c8fbcc68113ae184208ee14b835480c6efafed18a76000b38e5858290f4d51f52f096cbe490e1eb5cacb226ec49',
      '5a55a7fa457843d57fab67f8be7e209334785bdd665d7b63e4daf57b6e78928b603c8c0f9bc85464733b61273ef9e2b8',
      'a0cd7c3bf8ee0a6872e34d5a27a625e35eaf7ff5440b8b141af704df70c9c18623bd11209513192505105cd7bcfa5f0d',
      '919da706948fbe1f761f315846aa3b4813dd9ba3d81b9204e5409c0382b6eb',
    ].join(''),
    signature: '0f80ff5d17488fe26f93c543b04ed959b5f0643fc61c7f2c3bc60132ba9c6210c8b250ea5e84d07b01de68bc174414eeeb31fdc2ba6823e231e312a91ededd02',
  },
  {
    line: 1024,
    seed: 'f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5',
    publicKey: '278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e',
    message: [
      '08b8b2b733424243760fe426a4b54908632110a66c2f6591eabd3345e3e4eb98fa6e264bf09efe12ee50f8f54e9f77b1',
      'e355f6c50544e23fb1433ddf73be84d879de7c0046dc4996d9e773f4bc9efe5738829adb26c81b37c93a1b270b20329d',
      '658675fc6ea534e0810a4432826bf58c941efb65d57a338bbd2e26640f89ffbc1a858efcb8550ee3a5e1998bd177e93a',
      '7363c344fe6b199ee5d02e82d522c4feba15452f80288a821a579116ec6dad2b3b310da903401aa62100ab5d1a36553e',
      '06203b33890cc9b832f79ef80560ccb9a39ce767967ed628c6ad573cb116dbefefd75499da96bd68a8a97b928a8bbc10',
      '3b6621fcde2beca1231d206be6cd9ec7aff6f6c94fcd7204ed3455c68c83f4a41da4af2b74ef5c53f1d8ac70bdcb7ed1',
      '85ce81bd84359d44254d95629e9855a94a7c1958d1f8ada5d0532ed8a5aa3fb2d17ba70eb6248e594e1a2297acbbb39d',
      '502f1a8c6eb6f1ce22b3de1a1f40cc24554119a831a9aad6079cad88425de6bde1a9187ebb6092cf67bf2b13fd65f270',
      '88d78b7e883c8759d2c4f5c65adb7553878ad575f9fad878e80a0c9ba63bcbcc2732e69485bbc9c90bfbd62481d9089b',
      'eccf80cfe2df16a2cf65bd92dd597b0707e0917af48bbb75fed413d238f5555a7a569d80c3414a8d0859dc65a46128ba',
      'b27af87a71314f318c782b23ebfe808b82b0ce26401d2e22f04d83d1255dc51addd3b75a2b1ae0784504df543af8969b',
      'e3ea7082ff7fc9888c144da2af58429ec96031dbcad3dad9af0dcbaaaf268cb8fcffead94f3c7ca495e056a9b47acdb7',
      '51fb73e666c6c655ade8297297d07ad1ba5e43f1bca32301651339e22904cc8c42f58c30c04aafdb038dda0847dd988d',
      'cda6f3bfd15c4b4c4525004aa06eeff8ca61783aacec57fb3d1f92b0fe2fd1a85f6724517b65e614ad6808d6f6ee34df',
      'f7310fdc82aebfd904b01e1dc54b2927094b2db68d6f903b68401adebf5a7e08d78ff4ef5d63653a65040cf9bfd4aca7',
      '984a74d37145986780fc0b16ac451649de6188a7dbdf191f64b5fc5e2ab47b57f7f7276cd419c17a3ca8e1b939ae49e4',
      '88acba6b965610b5480109c8b17b80e1b7b750dfc7598d5d5011fd2dcc5600a32ef5b52a1ecc820e308aa342721aac09',
      '43bf6686b64b2579376504ccc493d97e6aed3fb0f9cd71a43dd497f01f17c0e2cb3797aa2a2f256656168e6c496afc5f',
      'b93246f6b1116398a346f1a641f3b041e989f7914f90cc2c7fff357876e506b50d334ba77c225bc307ba537152f3f161',
      '0e4eafe595f6d9d90d11faa933a15ef1369546868a7f3a45a96768d40fd9d03412c091c6315cf4fde7cb68606937380d',
      'b2eaaa707b4c4185c32eddcdd306705e4dc1ffc872eeee475a64dfac86aba41c0618983f8741c5ef68d3a101e8a3b8ca',
      'c60c905c15fc910840b94c00a0b9d0',
    ].join(''),
    signature: '0aab4c900501b3e24d7cdf4663326a3a87df5e4843b2cbdb67cbf6e460fec350aa5371b1508f9f4528ecea23c436d94b5e8fcd4f681e30a6ac00a9704a188a03',
  },
];

const h = (hex: string) => hexToBytes(hex);

describe('RFC 8032 §7.1 — the published vectors', () => {
  for (const v of VECTORS) {
    it(`line ${v.line}: the seed gives the public key`, () => {
      expect(bytesToHex(ed25519PublicKey(h(v.seed)))).toBe(v.publicKey);
    });

    it(`line ${v.line}: the signature is the reference one`, () => {
      expect(bytesToHex(ed25519Sign(h(v.seed), h(v.message)))).toBe(v.signature);
    });

    it(`line ${v.line}: the reference signature verifies`, () => {
      expect(ed25519Verify(h(v.publicKey), h(v.message), h(v.signature))).toBe(true);
    });
  }
});

describe('verification refuses what was not signed', () => {
  const [first, second] = VECTORS;

  it('a message changed by one bit', () => {
    const message = h(second.message);
    message[0] ^= 1;
    expect(ed25519Verify(h(second.publicKey), message, h(second.signature))).toBe(false);
  });

  it('a signature changed by one bit', () => {
    const signature = h(first.signature);
    signature[5] ^= 0x10;
    expect(ed25519Verify(h(first.publicKey), h(first.message), signature)).toBe(false);
  });

  it('another key', () => {
    expect(ed25519Verify(h(second.publicKey), h(first.message), h(first.signature))).toBe(false);
  });

  it('an S that is not reduced below the group order', () => {
    const signature = h(first.signature);
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i]);
    let unreduced = s + ED25519_ORDER;
    for (let i = 32; i < 64; i++) { signature[i] = Number(unreduced & 0xffn); unreduced >>= 8n; }
    expect(ed25519Verify(h(first.publicKey), h(first.message), signature)).toBe(false);
  });

  it('a truncated signature', () => {
    expect(ed25519Verify(h(first.publicKey), h(first.message), h(first.signature).subarray(0, 63))).toBe(false);
  });
});
