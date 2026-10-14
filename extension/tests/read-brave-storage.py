"""Reads BetterTube's chrome.storage.local from Brave's profile on disk (LevelDB
log files), e.g. the automatic layout snapshot the content script saves under
"diag:auto" a few seconds after each video loads.

Usage:
  python3 tests/read-brave-storage.py [key-prefix]
  python3 tests/read-brave-storage.py diag:auto | python3 -m json.tool
Env: EXT_ID (default: the unpacked BetterTube id), BRAVE_PROFILE (default: Default)
"""
import os, sys, glob, struct, json

def records(path):
    data = open(path, 'rb').read()
    BLOCK = 32768
    buf = b''
    pos = 0
    while pos < len(data):
        block_end = (pos // BLOCK + 1) * BLOCK
        if block_end - pos < 7:
            pos = block_end; continue
        _crc, length, rtype = struct.unpack('<IHB', data[pos:pos+7])
        if length == 0 and rtype == 0:
            pos = block_end; continue
        payload = data[pos+7:pos+7+length]
        pos += 7 + length
        if rtype == 1: yield payload
        elif rtype == 2: buf = payload
        elif rtype == 3: buf += payload
        elif rtype == 4: buf += payload; yield buf; buf = b''

def varint(b, i):
    shift = n = 0
    while True:
        c = b[i]; i += 1
        n |= (c & 0x7f) << shift
        if c < 0x80: return n, i
        shift += 7

def batch_items(rec):
    i = 12
    while i < len(rec):
        t = rec[i]; i += 1
        kl, i = varint(rec, i); key = rec[i:i+kl]; i += kl
        if t == 1:
            vl, i = varint(rec, i); val = rec[i:i+vl]; i += vl
            yield key.decode('utf-8', 'replace'), val.decode('utf-8', 'replace')
        else:
            yield key.decode('utf-8', 'replace'), None

ext_id = os.environ.get('EXT_ID', 'dmicoeklfiiolacepgnhmdneihlbeina')
profile = os.environ.get('BRAVE_PROFILE', 'Default')
d = os.path.expanduser(f'~/Library/Application Support/BraveSoftware/Brave-Browser/{profile}/Local Extension Settings/{ext_id}')
prefix = sys.argv[1] if len(sys.argv) > 1 else ''
latest = {}
for log in sorted(glob.glob(os.path.join(d, '*.log'))):
    for rec in records(log):
        for k, v in batch_items(rec):
            latest[k] = v
matches = {k: v for k, v in latest.items() if k.startswith(prefix)}
if prefix and len(matches) == 1:
    print(next(iter(matches.values())) or '<deleted>')  # raw JSON, pipe to json.tool
else:
    for k, v in matches.items():
        print(k, '=>', (v or '<deleted>')[:300])
