import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, PairingLimiter, sessionCookie, sessionToken } from '../server/auth.js';
import { UploadStore, MAX_IMAGE_BYTES } from '../server/uploads.js';

test('pairing is one-use, expires, and persists only credential hashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-auth-'));
  let now = 1000;
  try {
    const auth = new AuthStore(dir, () => now);
    const pair = auth.createPairing();
    const result = auth.pair(pair.token, 'iPhone');
    assert.ok(result);
    assert.equal(auth.pair(pair.token, 'replay'), null);
    assert.equal(auth.authenticate(result.token)?.name, 'iPhone');
    const file = readFileSync(join(dir, 'devices', readdirSync(join(dir, 'devices'))[0]), 'utf8');
    assert.ok(!file.includes(result.token));
    assert.ok(!file.includes(pair.token));
    const expiry = auth.createPairing();
    now += 5 * 60_000;
    assert.equal(auth.pair(expiry.token, 'expired'), null);
    assert.equal(auth.authenticate('invalid'), null);
    const secondProcess = new AuthStore(dir, () => now);
    assert.equal(secondProcess.revoke(result.device.id), true);
    assert.equal(auth.authenticate(result.token), null);
    assert.equal(auth.revoke('../../escape'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session expiry, cookies, and bounded pairing rate limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-session-'));
  let now = 1000;
  try {
    const auth = new AuthStore(dir, () => now);
    const result = auth.pair(auth.createPairing().token, 'Phone')!;
    const cookie = sessionCookie(result.token, true);
    assert.ok(cookie.includes('HttpOnly; SameSite=Strict'));
    assert.ok(cookie.endsWith('; Secure'));
    assert.equal(sessionToken(cookie), result.token);
    now = result.device.expiresAt;
    assert.equal(auth.authenticate(result.token), null);
    assert.deepEqual(auth.list(), []);
    const limiter = new PairingLimiter(() => now);
    for (let i = 0; i < 10; i++) assert.equal(limiter.allow('one'), true);
    assert.equal(limiter.allow('one'), false);
    assert.equal(limiter.allow('two'), true);
    now += 60001;
    assert.equal(limiter.allow('one'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploads reject MIME spoofing, SVG, oversized data and unowned paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-upload-'));
  try {
    const store = new UploadStore(dir);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJVkAAAAASUVORK5CYII=',
      'base64',
    );
    const saved = store.save(png, 'image/png');
    assert.ok(saved.url.startsWith('/api/v1/uploads/'));
    assert.throws(() => store.save(png, 'image/jpeg'));
    assert.throws(() => store.save(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/svg+xml'));
    const large = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    png.copy(large);
    assert.throws(() => store.save(large, 'image/png'));
    assert.equal(store.get('../../etc/passwd'), undefined);
    assert.equal(store.urlForPath('/etc/passwd'), undefined);
    assert.throws(() => store.attach(['missing']));
    const [path] = store.attach([saved.id]);
    assert.equal(store.urlForPath(path), saved.url);
    assert.equal(store.get(saved.id)?.attached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
