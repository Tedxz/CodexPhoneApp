export const PAGE_BACKGROUND: string = '#F6F7F2';
export const CARD_BACKGROUND: string = '#FFFFFF';
export const INK: string = '#243A32';
export const MUTED: string = '#738178';
export const GREEN: string = '#315D4B';
export const PALE_GREEN: string = '#E7EEE5';
export const BORDER: string = '#E0E6DC';
export const ERROR: string = '#A34535';

export function workspaceName(path: string): string {
  if (!path) return '未指定工作路径';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

export function threadStatus(status: string): string {
  if (status === 'active') return '运行中';
  if (status === 'systemError') return '需要关注';
  if (status === 'notLoaded') return '历史会话';
  return '就绪';
}

export function shortTime(time: number): string {
  if (!time) return '';
  const date = new Date(time);
  const minute = date.getMinutes().toString().padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${minute}`;
}

export function clientTypeLabel(type?: string): string {
  if (type === 'harmony') return 'HarmonyOS App';
  if (type === 'browser') return '浏览器';
  return '旧版授权';
}

export function lastUsedLabel(time?: number): string {
  if (!time || !Number.isFinite(time) || time <= 0) return '最近使用未知';
  return `最近使用 · ${shortTime(time)}`;
}

export function toolLabel(type: string): string {
  if (type === 'commandExecution') return '命令执行';
  if (type === 'fileChange') return '文件变更';
  if (type === 'reasoning') return '思考摘要';
  if (type === 'plan') return '执行计划';
  if (type === 'diff') return '变更汇总';
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') return '工具调用';
  if (type === 'error') return '执行异常';
  if (type === 'turnStatus') return '任务状态';
  if (type === 'contextCompaction') return '上下文整理';
  return type || '执行记录';
}

export function itemStatus(status: string): string {
  if (status === 'inProgress') return '进行中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'interrupted') return '已停止';
  return status;
}
