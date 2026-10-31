import { describe, it, expect } from 'vitest';
import { Cpace, PakeError, pakeSid, confirmMatches, wrapTransferKey, unwrapTransferKey, authProof, checkAuthProof } from './pake.js';
import { bytesToBase64Url } from './encoding.js';
import { parseCode, randomWords, WORDS } from '../codes.js';

const sid = pakeSid('room1', 'sender1', 'receiver1');

function run(senderPw: string, receiverPw: string, s = sid, r = sid) {
  const a = new Cpace(senderPw, s, 'sender');
  const b = new Cpace(receiverPw, r, 'receiver');
  return { a: a.finish(b.share), b: b.finish(a.share) };
}

describe('CPace', () => {
  it('agrees on keys when both sides know the code', () => {
    const { a, b } = run('42-tiger-ocean', '42-tiger-ocean');
    expect(confirmMatches(a.receiverConfirm, bytesToBase64Url(b.receiverConfirm))).toBe(true);
    expect(Buffer.compare(Buffer.from(a.wrapKey), Buffer.from(b.wrapKey))).toBe(0);
  });

  it('disagrees on a wrong code or a different session', () => {
    const wrong = run('42-tiger-ocean', '42-tiger-otter');
    expect(confirmMatches(wrong.a.receiverConfirm, bytesToBase64Url(wrong.b.receiverConfirm))).toBe(false);
    const other = run('42-tiger-ocean', '42-tiger-ocean', sid, pakeSid('room1', 'sender1', 'mallory'));
    expect(confirmMatches(other.a.receiverConfirm, bytesToBase64Url(other.b.receiverConfirm))).toBe(false);
  });

  it('uses fresh randomness every run', () => {
    expect(new Cpace('x', sid, 'sender').share).not.toEqual(new Cpace('x', sid, 'sender').share);
  });

  it('rejects malformed and identity shares', () => {
    const a = new Cpace('x', sid, 'sender');
    expect(() => a.finish(new Uint8Array(32))).toThrow(PakeError); // identity
    expect(() => a.finish(new Uint8Array(32).fill(255))).toThrow(PakeError); // not canonical
    expect(() => a.finish(new Uint8Array(5))).toThrow(PakeError);
  });

  it('wraps the transfer key so only the right wrap key opens it', async () => {
    const { a, b } = run('7-fox-swan', '7-fox-swan');
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapTransferKey(a.wrapKey, raw);
    expect(Buffer.compare(Buffer.from(await unwrapTransferKey(b.wrapKey, wrapped)), Buffer.from(raw))).toBe(0);
    const bad = run('7-fox-swan', '7-fox-swat');
    await expect(unwrapTransferKey(bad.b.wrapKey, wrapped)).rejects.toThrow(PakeError);
  });
});

describe('link auth proof', () => {
  it('binds the proof to key, room and receiver', () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const proof = authProof(key, 'room', 'rx1');
    expect(checkAuthProof(key, 'room', 'rx1', proof)).toBe(true);
    expect(checkAuthProof(key, 'room', 'rx2', proof)).toBe(false);
    expect(checkAuthProof(key, 'room2', 'rx1', proof)).toBe(false);
    expect(checkAuthProof(crypto.getRandomValues(new Uint8Array(32)), 'room', 'rx1', proof)).toBe(false);
    expect(checkAuthProof(key, 'room', 'rx1', 'garbage!')).toBe(false);
  });
});

describe('codes', () => {
  it('has 256 distinct words', () => {
    expect(WORDS).toHaveLength(256);
    expect(new Set(WORDS).size).toBe(256);
  });

  it('parses forgiving input and rejects anything else', () => {
    expect(parseCode('42-tiger-ocean')).toEqual({ nameplate: '42', password: '42-tiger-ocean' });
    expect(parseCode('  042 Tiger  OCEAN ')).toEqual({ nameplate: '42', password: '42-tiger-ocean' });
    expect(parseCode('42-tiger')).toBeNull();
    expect(parseCode('42-tiger-oceans')).toBeNull();
    expect(parseCode('tiger-ocean-42')).toBeNull();
    expect(parseCode('123456-tiger-ocean')).toBeNull();
  });

  it('generates codes it can parse', () => {
    for (let i = 0; i < 50; i++) expect(parseCode(`9-${randomWords()}`)).not.toBeNull();
  });
});
