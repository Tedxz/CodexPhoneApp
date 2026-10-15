import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../server/auth.js';

const lan = 'http://192.168.1.2:8787';
const funnel = 'https://phone.example.ts.net';
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phone-identity-'));
  let now = 1_000_000;
  const auth = new AuthStore(dir, () => now);
  return {
    dir,
    auth,
    time: () => now,
    advance: (milliseconds: number) => (now += milliseconds),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    stored: () =>
      readdirSync(join(dir, 'devices'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => readFileSync(join(dir, 'devices', name), 'utf8')),
    legacy: (name = 'Mate 90 Pro Max') => {
      const token = secret();
      const device = {
        id: randomUUID(),
        name,
        createdAt: now - 1000,
        expiresAt: now + 30 * 86400_000,
      };
      writeFileSync(
        join(dir, 'devices', `${device.id}.json`),
        JSON.stringify({ ...device, tokenHash: digest(token) }),
        { mode: 0o600 },
      );
      return { token, device };
    },
  };
}

test('repeat pairing reuses an installation while rotating its same-origin authorization', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const options = { clientKey, clientType: 'harmony' as const, origin: funnel };
    const first = f.auth.pair(f.auth.createPairing().token, 'Old name', options)!;
    f.advance(1000);
    const next = f.auth.pair(f.auth.createPairing().token, 'Mate 90 Pro Max', options)!;
    assert.equal(next.device.id, first.device.id);
    assert.equal(next.device.createdAt, first.device.createdAt);
    assert.equal(next.device.name, 'Mate 90 Pro Max');
    assert.equal(next.device.clientType, 'harmony');
    assert.equal(f.auth.list().length, 1);
    assert.equal(f.auth.authenticate(first.token), null);
    assert.equal(f.auth.authenticate(next.token)?.id, first.device.id);
  } finally {
    f.cleanup();
  }
});

test('same names do not merge different installations or legacy authorizations', () => {
  const f = fixture();
  try {
    const one = f.auth.pair(f.auth.createPairing().token, 'Mate 90 Pro Max', {
      clientKey: secret(),
      clientType: 'harmony',
      origin: funnel,
    })!;
    const two = f.auth.pair(f.auth.createPairing().token, 'Mate 90 Pro Max', {
      clientKey: secret(),
      clientType: 'browser',
      origin: funnel,
    })!;
    const legacy = f.legacy();
    assert.notEqual(one.device.id, two.device.id);
    assert.equal(f.auth.list().length, 3);
    assert.ok(f.auth.authenticate(legacy.token));
  } finally {
    f.cleanup();
  }
});

test('LAN and Funnel sessions share an installation without invalidating each other', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const local = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: lan,
    })!;
    const remote = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    assert.equal(local.device.id, remote.device.id);
    assert.equal(f.auth.list().length, 1);
    assert.equal(f.auth.list()[0].authorizationCount, 2);
    assert.equal(f.auth.authenticate(local.token)?.id, local.device.id);
    assert.equal(f.auth.authenticate(remote.token)?.id, local.device.id);
    const refresh = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    assert.equal(f.auth.authenticate(remote.token), null);
    assert.ok(f.auth.authenticate(local.token));
    assert.ok(f.auth.authenticate(refresh.token));
    assert.equal(f.auth.list()[0].authorizationCount, 2);
  } finally {
    f.cleanup();
  }
});

test('a valid legacy cookie claims its existing record without changing its session', () => {
  const f = fixture();
  try {
    const legacy = f.legacy();
    const clientKey = secret();
    const identified = f.auth.identify(legacy.token, clientKey, 'harmony', funnel);
    assert.equal(identified?.id, legacy.device.id);
    assert.equal(identified?.createdAt, legacy.device.createdAt);
    assert.equal(identified?.name, legacy.device.name);
    assert.equal(f.auth.authenticate(legacy.token)?.id, legacy.device.id);
    assert.equal(f.auth.list().length, 1);
    const paired = f.auth.pair(f.auth.createPairing().token, legacy.device.name, {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    assert.equal(paired.device.id, legacy.device.id);
    assert.equal(f.auth.authenticate(legacy.token), null);
  } finally {
    f.cleanup();
  }
});

test('fresh pairing can claim a legacy cookie rather than duplicating its device', () => {
  const f = fixture();
  try {
    const legacy = f.legacy();
    const result = f.auth.pair(f.auth.createPairing().token, 'Mate 90 Pro Max', {
      clientKey: secret(),
      clientType: 'harmony',
      sessionToken: legacy.token,
      origin: funnel,
    })!;
    assert.equal(result.device.id, legacy.device.id);
    assert.equal(result.device.createdAt, legacy.device.createdAt);
    assert.equal(f.auth.list().length, 1);
    assert.equal(f.auth.authenticate(legacy.token), null);
    assert.ok(f.auth.authenticate(result.token));
  } finally {
    f.cleanup();
  }
});

test('claiming another legacy origin merges only the identified records and preserves cookies', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const bound = f.auth.pair(f.auth.createPairing().token, 'Mate 90 Pro Max', {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    const legacy = f.legacy();
    const unrelated = f.legacy();
    const identified = f.auth.identify(legacy.token, clientKey, 'harmony', lan);
    assert.ok(identified);
    assert.equal(f.auth.list().length, 2);
    assert.equal(f.auth.authenticate(bound.token)?.id, identified.id);
    assert.equal(f.auth.authenticate(legacy.token)?.id, identified.id);
    assert.equal(f.auth.authenticate(unrelated.token)?.id, unrelated.device.id);
    assert.equal(identified.authorizationCount, 2);
  } finally {
    f.cleanup();
  }
});

test('an installation identity cannot replace credentials or rebind an already claimed cookie', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const bound = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    assert.equal(f.auth.authenticate(clientKey), null);
    assert.equal(f.auth.identify(clientKey, secret(), 'harmony', funnel), null);
    assert.throws(() => f.auth.identify(bound.token, secret(), 'harmony', funnel));
    assert.equal(
      f.auth.pair(secret(), 'No pairing credential', { clientKey, clientType: 'harmony' }),
      null,
    );
    assert.equal(f.auth.list().length, 1);
    assert.ok(f.auth.authenticate(bound.token));
  } finally {
    f.cleanup();
  }
});

test('expired cookies cannot claim a device identity', () => {
  const f = fixture();
  try {
    const legacy = f.legacy();
    f.advance(30 * 86400_000);
    assert.equal(f.auth.identify(legacy.token, secret(), 'harmony', funnel), null);
    assert.equal(f.auth.authenticate(legacy.token), null);
  } finally {
    f.cleanup();
  }
});

test('invalid or incomplete client identities do not consume a fresh pairing credential', () => {
  const f = fixture();
  try {
    const pairing = f.auth.createPairing().token;
    const clientKey = secret();
    for (const options of [
      { clientKey },
      { clientType: 'harmony' as const },
      { clientKey: 'short', clientType: 'harmony' as const },
      { clientKey: '!'.repeat(43), clientType: 'harmony' as const },
      { clientKey, clientType: 'unsupported' as 'harmony' },
      { clientKey, clientType: ['harmony'] as unknown as 'harmony' },
      { clientKey, clientType: null as unknown as 'harmony' },
    ]) {
      assert.throws(() => f.auth.pair(pairing, 'Phone', options));
      assert.equal(f.auth.list().length, 0);
    }
    assert.ok(f.auth.pair(pairing, 'Phone', { clientKey, clientType: 'harmony' }));
    assert.equal(f.auth.pair(pairing, 'Replay'), null);
  } finally {
    f.cleanup();
  }
});

test('an interrupted gateway auth mutation does not leave a dead process lock blocking pairing', () => {
  const f = fixture();
  try {
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.equal(child.status, 0);
    const orphan = join(f.dir, 'auth-locks', `${child.pid}-${randomUUID()}.json`);
    writeFileSync(orphan, JSON.stringify({ ticket: 1 }), { mode: 0o600 });
    const result = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey: secret(),
      clientType: 'harmony',
      origin: funnel,
    });
    assert.ok(result);
    assert.ok(f.auth.authenticate(result.token));
    assert.equal(existsSync(orphan), false);
    assert.deepEqual(readdirSync(join(f.dir, 'auth-locks')), []);
  } finally {
    f.cleanup();
  }
});

test('a live gateway choosing its lock ticket is not bypassed, and timeout leaves pairing reusable', () => {
  const f = fixture();
  try {
    const blocker = join(f.dir, 'auth-locks', `${process.pid}-${randomUUID()}.json`);
    writeFileSync(blocker, JSON.stringify({ ticket: 0 }), { mode: 0o600 });
    const pairing = f.auth.createPairing().token;
    assert.throws(() => f.auth.pair(pairing, 'Phone'), { code: 'AUTH_STORE_BUSY' });
    assert.equal(f.auth.list().length, 0);
    assert.equal(readdirSync(join(f.dir, 'auth-locks')).length, 1);
    rmSync(blocker);
    assert.ok(f.auth.pair(pairing, 'Phone'));
    assert.deepEqual(readdirSync(join(f.dir, 'auth-locks')), []);
  } finally {
    f.cleanup();
  }
});

test('public device projections never reveal installation keys or credential hashes', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const pair = f.auth.createPairing();
    const result = f.auth.pair(pair.token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    const output = JSON.stringify([
      result.device,
      f.auth.list(),
      f.auth.authenticate(result.token),
      f.auth.identify(result.token, clientKey, 'harmony', funnel),
    ]);
    for (const forbidden of [clientKey, digest(clientKey), result.token, digest(result.token)]) {
      assert.ok(!output.includes(forbidden));
    }
    assert.ok(!output.includes('credentials'));
    assert.ok(!output.includes('tokenHash'));
    assert.ok(!output.includes('clientKey'));
    const persisted = f.stored().join('\n');
    for (const forbidden of [clientKey, result.token, pair.token]) {
      assert.ok(!persisted.includes(forbidden));
    }
  } finally {
    f.cleanup();
  }
});

test('revoking one installation invalidates every origin but leaves other installations usable', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const local = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: lan,
    })!;
    const remote = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    const other = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey: secret(),
      clientType: 'harmony',
      origin: funnel,
    })!;
    assert.equal(f.auth.revoke(local.device.id), true);
    assert.equal(f.auth.authenticate(local.token), null);
    assert.equal(f.auth.authenticate(remote.token), null);
    assert.ok(f.auth.authenticate(other.token));
    assert.equal(f.auth.list().length, 1);
  } finally {
    f.cleanup();
  }
});

test('logout follows a legacy cookie after identity merge and cannot be undone by activity updates', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const local = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: lan,
    })!;
    const legacy = f.legacy();
    const unrelated = f.legacy('Another phone');
    const secondGateway = new AuthStore(f.dir, f.time);
    // Logout may already have read this ID when the other gateway merges it.
    assert.equal(f.auth.authenticate(legacy.token)?.id, legacy.device.id);
    const identified = secondGateway.identify(legacy.token, clientKey, 'harmony', funnel);
    assert.equal(identified?.id, local.device.id);
    assert.notEqual(identified?.id, legacy.device.id);
    assert.equal(f.auth.revokeSession(legacy.token), true);
    assert.equal(f.auth.authenticate(legacy.token), null);
    assert.equal(secondGateway.authenticate(local.token), null);
    f.advance(60_001);
    assert.equal(secondGateway.touch(legacy.token), null);
    assert.equal(f.auth.touch(local.token), null);
    assert.equal(f.auth.revokeSession(legacy.token), false);
    assert.equal(f.auth.revokeSession(undefined), false);
    assert.equal(f.auth.revokeSession('invalid'), false);
    assert.equal(f.auth.revokeSession(secret()), false);
    assert.equal(f.auth.list().length, 1);
    assert.ok(secondGateway.authenticate(unrelated.token));
  } finally {
    f.cleanup();
  }
});

test('each origin expires separately even when another origin renews the installation', () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const local = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: lan,
    })!;
    f.advance(86400_000);
    const remote = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey,
      clientType: 'harmony',
      origin: funnel,
    })!;
    f.advance(29 * 86400_000);
    assert.equal(f.auth.authenticate(local.token), null);
    assert.ok(f.auth.authenticate(remote.token));
    assert.equal(f.auth.list()[0].authorizationCount, 1);
  } finally {
    f.cleanup();
  }
});

test('last use updates only on touch and its write throttle is shared across AuthStore instances', () => {
  const f = fixture();
  try {
    const paired = f.auth.pair(f.auth.createPairing().token, 'Phone', {
      clientKey: secret(),
      clientType: 'harmony',
      origin: funnel,
    })!;
    const second = new AuthStore(f.dir, f.time);
    const initial = f.stored();
    f.advance(60_001);
    assert.ok(second.authenticate(paired.token));
    assert.deepEqual(f.stored(), initial);
    second.touch(paired.token);
    assert.equal(f.auth.list()[0].lastSeenAt, f.time());
    const touched = f.stored();
    f.advance(1000);
    f.auth.touch(paired.token);
    assert.deepEqual(f.stored(), touched);
    f.advance(60_001);
    f.auth.touch(paired.token);
    assert.equal(second.list()[0].lastSeenAt, f.time());
  } finally {
    f.cleanup();
  }
});

async function pairInProcess(
  dir: string,
  pairing: string,
  clientKey: string,
  origin: string,
  now: number,
): Promise<{ token: string; device: { id: string } } | null> {
  const source = `
    import { AuthStore } from ${JSON.stringify(new URL('../server/auth.ts', import.meta.url).href)};
    const input = JSON.parse(process.env.PHONE_IDENTITY_TEST_INPUT);
    const auth = new AuthStore(input.dir, () => input.now);
    process.stdout.write(JSON.stringify(auth.pair(input.pairing, 'Phone', {
      clientKey: input.clientKey, clientType: 'harmony', origin: input.origin,
    })));
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      {
        env: {
          ...process.env,
          PHONE_IDENTITY_TEST_INPUT: JSON.stringify({ dir, pairing, clientKey, origin, now }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Pairing child failed (${code}): ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

test('two gateway processes pairing the same installation preserve one device and both origins', async () => {
  const f = fixture();
  try {
    const clientKey = secret();
    const [one, two] = await Promise.all([
      pairInProcess(f.dir, f.auth.createPairing().token, clientKey, lan, f.time()),
      pairInProcess(f.dir, f.auth.createPairing().token, clientKey, funnel, f.time()),
    ]);
    assert.ok(one);
    assert.ok(two);
    assert.equal(one.device.id, two.device.id);
    assert.equal(f.auth.list().length, 1);
    assert.equal(f.auth.list()[0].authorizationCount, 2);
    assert.ok(f.auth.authenticate(one.token));
    assert.ok(f.auth.authenticate(two.token));
  } finally {
    f.cleanup();
  }
});

test('two gateway processes cannot consume the same pairing credential twice', async () => {
  const f = fixture();
  try {
    const pairing = f.auth.createPairing().token;
    const results = await Promise.all([
      pairInProcess(f.dir, pairing, secret(), lan, f.time()),
      pairInProcess(f.dir, pairing, secret(), funnel, f.time()),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.auth.list().length, 1);
  } finally {
    f.cleanup();
  }
});
