import { loadConfig } from './config.js';
import { CodexAdapter } from './codex.js';
import { createGateway } from './gateway.js';

const config = loadConfig();
const adapter = new CodexAdapter({ socketPath: config.socketPath });
const gateway = createGateway(config, adapter);
gateway.server.on('error', (error) => {
  console.error(`网关启动失败: ${error.message}`);
  void gateway.close().finally(() => {
    process.exitCode = 1;
  });
});
gateway.server.listen(config.port, config.host, () => {
  console.log(`Codex Phone: ${config.publicUrl}`);
  console.log('运行 npm run pair 生成手机配对二维码。');
  void adapter.connect().catch((error) => console.error(`Codex 后端尚未连接: ${error.message}`));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void gateway.close().finally(() => process.exit(0));
  });
