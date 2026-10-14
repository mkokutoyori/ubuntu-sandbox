#!/usr/bin/env python3
"""Record AES-SIV (RFC 5297) and AES-CMAC (RFC 4493) vectors from OpenSSL 3 through python-cryptography. usage: record_aes_siv.py (writes src/__tests__/support/oracle/aes-siv-cmac-openssl.json)"""
import json, os
from cryptography.hazmat.primitives.ciphers.aead import AESSIV
from cryptography.hazmat.primitives.cmac import CMAC
from cryptography.hazmat.primitives.ciphers import algorithms
import random
rng = random.Random(7)
cases=[]
for n in range(40):
    keylen = rng.choice([32,48,64])
    key = bytes(rng.randrange(256) for _ in range(keylen))
    ad = [bytes(rng.randrange(256) for _ in range(rng.choice([0,1,15,16,17,48,100]))) for _ in range(rng.choice([0,1,2,3]))]
    pt = bytes(rng.randrange(256) for _ in range(rng.choice([1,15,16,17,31,32,33,64,200])))
    ct = AESSIV(key).encrypt(pt, ad)
    cases.append({"key":key.hex(),"ad":[a.hex() for a in ad],"pt":pt.hex(),"ct":ct.hex()})
cm=[]
for n in range(20):
    key=bytes(rng.randrange(256) for _ in range(rng.choice([16,32])))
    msg=bytes(rng.randrange(256) for _ in range(rng.choice([0,1,15,16,17,32,40,64,100])))
    c=CMAC(algorithms.AES(key)); c.update(msg)
    cm.append({"key":key.hex(),"msg":msg.hex(),"mac":c.finalize().hex()})
json.dump({"tool":"python cryptography 41.0.7 (OpenSSL 3.0.13)","siv":cases,"cmac":cm}, open('/home/user/ubuntu-sandbox/src/__tests__/support/oracle/aes-siv-cmac-openssl.json','w'), separators=(',',':'))
print(len(cases),len(cm))
