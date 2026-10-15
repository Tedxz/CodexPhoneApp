import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';

const LABEL = 'local.codex-phone';
const xml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      '用法：node --import tsx scripts/launch-agent.ts [--output PATH | --install]\n默认仅把 plist 输出到 stdout。--output 保存指定文件；--install 保存到 ~/Library/LaunchAgents，不加载服务。',
    );
    return;
  }
  let output: string | undefined;
  let install = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--install') install = true;
    else if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--'))
      output = path.resolve(args[++i]);
    else throw new Error(`未知参数或缺少参数值：${args[i]}`);
  }
  if (install && output) throw new Error('--install 与 --output 不能同时使用');
  if (install && process.platform !== 'darwin') throw new Error('--install 仅适用于 macOS');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cwd = process.cwd();
  const config = await loadConfig();
  const configPath = path.resolve(
    process.env.CODEX_PHONE_CONFIG || path.join(cwd, 'config.local.json'),
  );
  const logs = path.join(config.dataDir, 'logs');
  await access(path.join(root, 'node_modules/tsx/dist/loader.mjs'));
  const environment = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    CODEX_PHONE_CONFIG: configPath,
  };
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>--import</string><string>${xml(path.join(root, 'node_modules/tsx/dist/loader.mjs'))}</string>
    <string>${xml(path.join(root, 'server/main.ts'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key><dict>
${Object.entries(environment)
  .map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'gateway.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'gateway.err.log'))}</string>
</dict></plist>
`;
  if (install) output = path.join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
  if (!output) {
    process.stdout.write(plist);
    return;
  }
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await writeFile(output, plist, { mode: 0o600, flag: 'wx' });
  console.log(`已生成 ${output}（未加载服务）`);
  console.log(`检查：plutil -lint ${shellQuote(output)}`);
  console.log(`启动：launchctl bootstrap gui/$(id -u) ${shellQuote(output)}`);
  console.log(`停止：launchctl bootout gui/$(id -u)/${LABEL}`);
  console.log('更改配置后重新加载服务；Node.js 路径变化后重新生成 plist。');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '生成失败');
  process.exitCode = 1;
});
