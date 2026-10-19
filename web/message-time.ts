export function validMessageTime(value?: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(new Date(value).getTime())
  );
}

export function formatMessageTime(value?: number, now = Date.now()): string {
  if (!validMessageTime(value)) return '时间未知';
  const date = new Date(value);
  const today = new Date(now);
  const sameYear = date.getFullYear() === today.getFullYear();
  const sameDay =
    sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat('zh-CN', {
    ...(sameDay
      ? {}
      : {
          ...(sameYear ? {} : { year: 'numeric' as const }),
          month: 'numeric' as const,
          day: 'numeric' as const,
        }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
