import { loadConfig } from './config.js';
import { TargetManager } from './targets.js';
import { createGateway } from './gateway.js';

const config = loadConfig();
const targets = new TargetManager(config);
const gateway = createGateway(config, targets);
gateway.server.on('error', (error) => {
  console.error(`网关启动失败: ${error.message}`);
  void gateway.close().finally(() => {
    process.exitCode = 1;
  });
});
gateway.server.listen(config.port, config.host, () => {
  console.log(`Codex Phone: ${config.publicUrl}`);
  console.log('运行 npm run pair 生成手机配对二维码。');
  targets.start();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void gateway.close().finally(() => process.exit(0));
  });
