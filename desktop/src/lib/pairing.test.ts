import { describe, expect, it } from 'vitest';
import { LatestWhileBusy, PairingUrlDeduper, parsePairingUrl } from './pairing.js';

describe('parsePairingUrl', () => {
  it('accepts exactly one host and one opaque code', () => {
    expect(parsePairingUrl(
      'vantage://connect?host=https%3A%2F%2Fplay.example.test%2Fmap-stream%2F&code=abc_DEF-123',
    )).toEqual({
      endpoint: 'https://play.example.test/map-stream/',
      code: 'abc_DEF-123',
    });
  });

  it('normalizes the endpoint path to a directory', () => {
    expect(parsePairingUrl(
      'vantage://connect?host=https%3A%2F%2Fplay.example.test%2Fmap-stream&code=abc',
    ).endpoint).toBe('https://play.example.test/map-stream/');
  });

  it('allows plaintext only for loopback development servers', () => {
    expect(parsePairingUrl(
      'vantage://connect?host=http%3A%2F%2Flocalhost%3A3000%2Fmap-stream%2F&code=abc',
    ).endpoint).toBe('http://localhost:3000/map-stream/');
    expect(() => parsePairingUrl(
      'vantage://connect?host=http%3A%2F%2Fplay.example.test%2Fmap-stream%2F&code=abc',
    )).toThrow(/HTTPS/);
  });

  it('rejects malformed link shapes and parameter smuggling', () => {
    for (const link of [
      'https://connect?host=https%3A%2F%2Fplay.example.test&code=abc',
      'vantage://other?host=https%3A%2F%2Fplay.example.test&code=abc',
      'vantage://connect/path?host=https%3A%2F%2Fplay.example.test&code=abc',
      'vantage://connect?host=https%3A%2F%2Fplay.example.test&host=https%3A%2F%2Fevil.test&code=abc',
      'vantage://connect?host=https%3A%2F%2Fplay.example.test&code=abc&extra=x',
      'vantage://connect?host=https%3A%2F%2Fplay.example.test&code=abc#fragment',
    ]) expect(() => parsePairingUrl(link), link).toThrow();
  });

  it('rejects unsafe hosts and codes', () => {
    for (const link of [
      'vantage://connect?host=ftp%3A%2F%2Fplay.example.test&code=abc',
      'vantage://connect?host=https%3A%2F%2Fuser%3Apass%40play.example.test&code=abc',
      'vantage://connect?host=https%3A%2F%2Fplay.example.test%2F%3Fx%3D1&code=abc',
      'vantage://connect?host=https%3A%2F%2Fplay.example.test&code=abc%2Fdef',
      'vantage://connect?host=https%3A%2F%2Fplay.example.test&code=',
    ]) expect(() => parsePairingUrl(link), link).toThrow();
  });
});

describe('LatestWhileBusy', () => {
  it('keeps a later request queued until the in-flight request finishes', () => {
    const queue = new LatestWhileBusy<string>();
    expect(queue.offer('first')).toBe('first');
    queue.start();
    expect(queue.offer('second')).toBeNull();
    expect(queue.offer('latest')).toBeNull();
    expect(queue.finish()).toBe('latest');
  });
});

describe('PairingUrlDeduper', () => {
  it('drops cold-start overlap but permits a later user retry', () => {
    const seen = new PairingUrlDeduper();
    expect(seen.accept('vantage://connect?x', 1000)).toBe(true);
    expect(seen.accept('vantage://connect?x', 1500)).toBe(false);
    expect(seen.accept('vantage://connect?x', 2101)).toBe(true);
  });
});
