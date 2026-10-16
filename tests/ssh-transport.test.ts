import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { existsSync, statSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { SshTargetConfig } from '../server/config.js';
import {
  SftpTransfer,
  SshTunnel,
  sftpQuote,
  sshFailure,
  spawnManaged,
  type CommandSpawner,
} from '../server/ssh.js';

const target: SshTargetConfig = {
  id: 'remote',
  name: 'Remote',
  sshHost: 'configured-alias',
  socketPath: '/remote/codex.sock',
  projects: [],
  uploadDir: '/home/test/new folder/uploads',
};
class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  onKill?: () => void;
  kill() {
    this.onKill?.();
    this.finish(1);
    return true;
  }
  finish(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}
async function until(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error('Timed out');
    await delay(10);
  }
}

test('SSH tunnel uses a short private Unix path, retries independently and closes its child', async () => {
  let count = 0;
  let server: Server | undefined;
  const children: FakeProcess[] = [];
  const spawner: CommandSpawner = (command, args) => {
    assert.equal(command, 'ssh');
    assert.equal(args.at(-1), target.sshHost);
    for (const option of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'ForwardAgent=no',
      'ControlPath=none',
    ])
      assert.ok(args.includes(option));
    assert.ok(args.includes('-N'));
    const child = new FakeProcess();
    children.push(child);
    if (++count === 1)
      queueMicrotask(() => {
        child.stderr.write('Permission denied (publickey).');
        child.finish(255);
      });
    else {
      const socket = args[args.indexOf('-L') + 1].split(':')[0];
      server = createServer();
      server.listen(socket);
      child.onKill = () => {
        server?.close();
      };
    }
    return child as unknown as ChildProcess;
  };
  const tunnel = new SshTunnel(target, { spawn: spawner, retryDelayMs: 5, pollIntervalMs: 5 });
  const states: string[] = [];
  tunnel.on('state', (state) => {
    states.push(state.errorCode ?? state.stage);
  });
  try {
    assert.ok(tunnel.socketPath.length < 90);
    assert.equal(statSync(tunnel.directory).mode & 0o777, 0o700);
    tunnel.start();
    await until(() => tunnel.state.ready);
    assert.equal(count, 2);
    assert.ok(states.includes('SSH_AUTH'));
    assert.ok(states.includes('ssh_ready'));
  } finally {
    await tunnel.close();
  }
  assert.equal(children[1].exitCode, 1);
  assert.equal(existsSync(tunnel.directory), false);
});

test('SFTP preserves the SSH alias, stages with rename, and only chmods the configured leaf', async () => {
  const batches: string[] = [];
  const spawner: CommandSpawner = (command, args) => {
    assert.equal(command, 'sftp');
    assert.equal(args.at(-1), target.sshHost);
    assert.ok(args.includes('ClearAllForwardings=yes'));
    const child = new FakeProcess();
    let text = '';
    child.stdin.on('data', (chunk) => {
      text += String(chunk);
    });
    child.stdin.on('finish', () => {
      batches.push(text);
      queueMicrotask(() => child.finish(0));
    });
    return child as unknown as ChildProcess;
  };
  const transfer = new SftpTransfer(target, spawner);
  const remote = target.uploadDir + '/00000000-0000-0000-0000-000000000000.png';
  try {
    await transfer.probe();
    assert.equal(batches[0], 'pwd\n');
    await transfer.upload('/local/a [1] "quote".png', remote);
    const batch = batches[1];
    assert.ok(batch.includes('-mkdir "/home/test/new folder"'));
    assert.equal(batch.split('\n').filter((line) => line.startsWith('chmod 700')).length, 1);
    assert.ok(batch.includes('chmod 700 "/home/test/new folder/uploads"'));
    assert.ok(batch.includes('put -p "/local/a [1] \\"quote\\".png"'));
    assert.ok(batch.indexOf('put -p ') < batch.indexOf('rename '));
    assert.ok(batch.includes('.png.part"'));
    await assert.rejects(
      transfer.upload('/local/image.png', '/outside/00000000-0000-0000-0000-000000000000.png'),
      /专用上传目录/,
    );
    await assert.rejects(transfer.remove('/etc/passwd'), /之外/);
  } finally {
    await transfer.close();
  }
});

test('aborting SFTP staging terminates it without rename confirmation or a second transfer', async () => {
  const child = new FakeProcess();
  let spawns = 0;
  const transfer = new SftpTransfer(target, () => {
    spawns++;
    return child as unknown as ChildProcess;
  });
  const controller = new AbortController();
  try {
    const operation = transfer.upload(
      '/local/one.png',
      target.uploadDir + '/00000000-0000-0000-0000-000000000000.png',
      controller.signal,
    );
    controller.abort();
    await assert.rejects(operation, /尚未发送消息/);
    assert.equal(child.exitCode, 1);
    assert.equal(spawns, 1);
  } finally {
    await transfer.close();
  }
});

test('SFTP quoting rejects command-line injection and SSH diagnostics do not echo raw stderr', () => {
  assert.throws(() => sftpQuote('/safe\n!touch /tmp/unsafe'), /控制字符/);
  assert.throws(() => sftpQuote('/safe\0path'), /控制字符/);
  assert.equal(sftpQuote('/has * ? [x] $ (text)'), '"/has * ? [x] $ (text)"');
  assert.equal(
    sshFailure('Host key verification failed: private details').errorCode,
    'SSH_HOST_KEY',
  );
  assert.ok(!sshFailure('other secret stderr').message.includes('secret'));
});

test('gateway parent SIGKILL closes the supervisor lifeline and terminates its SSH-style child', async () => {
  const moduleUrl = pathToFileURL(resolve('server/ssh.ts')).href;
  const childCode = 'process.stdout.write(String(process.pid)+"\\n");setInterval(()=>{},1000)';
  const code = `import { spawnManaged } from ${JSON.stringify(moduleUrl)}; const child = spawnManaged(process.execPath, ['-e', ${JSON.stringify(childCode)}]); child.stdout.pipe(process.stdout);`;
  const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  parent.stdout.on('data', (data) => {
    output += String(data);
  });
  let childPid = 0;
  try {
    await until(() => /^\d+\n/.test(output), 5000);
    childPid = Number(output.trim());
    assert.ok(childPid > 1);
    const exited = once(parent, 'exit');
    parent.kill('SIGKILL');
    await exited;
    await until(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 4000);
  } finally {
    parent.kill('SIGKILL');
    if (childPid)
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        /* Already reaped. */
      }
  }
});

test('managed subprocess receives batch stdin and exits promptly after normal completion', async () => {
  const child = spawnManaged('/bin/cat', []);
  let output = '';
  child.stdout?.on('data', (data) => {
    output += String(data);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const exited = once(child, 'exit');
    child.stdin?.end('pwd\n');
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Supervisor did not exit')), 3000);
      }),
    ]);
    assert.equal(result[0], 0);
    assert.equal(output, 'pwd\n');
  } finally {
    if (timer) clearTimeout(timer);
    child.kill('SIGKILL');
  }
});

test('system SFTP local fixture preserves quoted paths, private modes and complete rename', async (t) => {
  const subsystem = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find(existsSync);
  if (!subsystem) {
    t.skip('Local OpenSSH SFTP subsystem is not installed');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'phone-sftp-fixture-'));
  const uploadDir = join(dir, 'new parent', 'images [x] "quoted" * ? \\');
  const source = join(dir, 'source [1] "quoted" * ? \\ $(text).png');
  const destination = join(uploadDir, '00000000-0000-0000-0000-000000000000.png');
  writeFileSync(source, 'image-fixture', { mode: 0o600 });
  let errors = '';
  const transfer = new SftpTransfer({ ...target, uploadDir }, () => {
    const child = spawn('sftp', ['-D', subsystem, '-b', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', (data) => {
      errors += String(data);
    });
    return child;
  });
  try {
    await transfer.probe();
    await transfer.upload(source, destination);
    assert.equal(readFileSync(destination, 'utf8'), 'image-fixture');
    assert.equal(statSync(uploadDir).mode & 0o777, 0o700);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.equal(existsSync(destination + '.part'), false);
    await transfer.remove(destination);
    assert.equal(existsSync(destination), false);
  } catch (error) {
    t.diagnostic(errors);
    throw error;
  } finally {
    await transfer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
