import { ConversationItem } from './Protocol';

export function validMessageTime(value?: number): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime());
}

export function messageTime(value?: number, now: number = Date.now()): string {
  if (!validMessageTime(value)) return '时间未知';
  const date = new Date(value as number);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const today = new Date(now);
  const sameYear = date.getFullYear() === today.getFullYear();
  const sameDay = sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const clock = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  if (sameDay) return clock;
  return `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

// The index belongs to the message array, excluding the older-history button.
// A user card at the top remains its own context until its heading scrolls away.
export function readingUser(items: ConversationItem[], firstVisible: number, top: number,
  contextUser?: ConversationItem): ConversationItem | undefined {
  if (!items.length || firstVisible < 0) return undefined;
  const index = Math.min(firstVisible, items.length - 1);
  if (firstVisible < items.length && items[index].role === 'user' && top >= -1) return undefined;
  for (let cursor = index; cursor >= 0; cursor--) {
    if (items[cursor].role === 'user') return items[cursor];
  }
  return contextUser?.role === 'user' ? contextUser : undefined;
}

export function userSummary(item: ConversationItem): string {
  return item.text.trim().replace(/\s+/g, ' ') || (item.images?.length ? '图片消息' : '用户消息');
}
