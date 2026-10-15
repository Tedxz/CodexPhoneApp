import QRCode from 'qrcode';
import { loadConfig } from './config.js';
import { AuthStore } from './auth.js';

const config = loadConfig();
const auth = new AuthStore(config.dataDir);
const [command, ...args] = process.argv.slice(2);
if (command === 'pair') {
  const index = args.indexOf('--url');
  const url = new URL(index >= 0 ? args[index + 1] : config.publicUrl);
  if (!config.allowedOrigins.includes(url.origin))
    throw new Error('请先将此 URL 配置为 publicUrl 或 allowedOrigins，防止生成无法访问的配对链接');
  const pairing = auth.createPairing();
  url.hash = `pair=${pairing.token}`;
  console.log(await QRCode.toString(url.toString(), { type: 'terminal', small: true }));
  console.log(`配对地址（5 分钟内一次有效）: ${url}`);
  console.log(`手动配对凭据: ${pairing.token}`);
} else if (command === 'devices') {
  console.table(
    auth
      .list()
      .map((x) => ({ id: x.id, name: x.name, expires: new Date(x.expiresAt).toLocaleString() })),
  );
} else if (command === 'revoke') {
  if (!args[0]) throw new Error('用法: npm run revoke -- <设备 ID>');
  console.log(auth.revoke(args[0]) ? '设备已撤销，现有连接将关闭。' : '设备不存在。');
} else throw new Error('支持的命令: pair、devices、revoke');
