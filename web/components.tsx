import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ConversationItem,
  ModelOption,
  PendingRequest,
  RequestAnswer,
  SessionSettings,
} from '../shared/protocol';
import { safeImageUrl, describeError } from './state';
import { formatMessageTime, validMessageTime } from './message-time';

export function Icon({
  name,
}: {
  name: 'plus' | 'arrow' | 'back' | 'settings' | 'image' | 'stop' | 'close' | 'refresh' | 'send';
}) {
  const paths = {
    plus: 'M12 5v14M5 12h14',
    arrow: 'm7 17 10-10M7 7h10v10',
    back: 'm14 6-6 6 6 6',
    settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
    image: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8h.01',
    stop: 'M6 6h12v12H6z',
    close: 'm6 6 12 12M6 18 18 6',
    refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
    send: 'm21 3-6.5 18-4-7.5L3 9.5 21 3ZM10.5 13.5 21 3',
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span className="notice">[图片：{alt || '附件'}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
export function Message({
  item,
  targetId = 'local',
}: {
  item: ConversationItem;
  targetId?: string;
}) {
  const labels: Record<string, string> = {
    commandExecution: '命令执行',
    fileChange: '文件变更',
    reasoning: '思考摘要',
    plan: '执行计划',
    diff: '变更汇总',
    mcpToolCall: '工具调用',
    dynamicToolCall: '工具调用',
    error: '执行异常',
    turnStatus: '任务状态',
    contextCompaction: '上下文整理',
  };
  if (!item.role)
    return (
      <details className="tool-card" open={item.type === 'error' || item.type === 'turnStatus'}>
        <summary>
          {labels[item.type] || item.type}
          <span>{item.status === 'inProgress' ? '进行中' : item.status || ''}</span>
        </summary>
        <pre>{item.text || '正在处理…'}</pre>
      </details>
    );
  return (
    <article className={`message ${item.role}`} data-message-id={item.id} tabIndex={-1}>
      <div className="message-meta">
        <span>{item.role === 'user' ? '你' : 'CODEX'}</span>
        <MessageTime createdAt={item.createdAt} />
      </div>
      <div className="message-body">
        {item.role === 'assistant' ? <Markdown text={item.text || '…'} /> : <p>{item.text}</p>}
        {!!item.images?.length && (
          <div className="image-grid">
            {item.images.map(
              (url, i) =>
                safeImageUrl(url, targetId) && (
                  <a href={url} target="_blank" rel="noreferrer" key={i}>
                    <img src={url} alt={`附图 ${i + 1}`} loading="lazy" />
                  </a>
                ),
            )}
          </div>
        )}
      </div>
    </article>
  );
}
export function MessageTime({ createdAt }: { createdAt?: number }) {
  const date = validMessageTime(createdAt) ? new Date(createdAt) : undefined;
  return (
    <time
      className="message-time"
      dateTime={date?.toISOString()}
      title={date?.toLocaleString('zh-CN', { hour12: false }) || '未提供消息时间'}
    >
      {formatMessageTime(createdAt)}
    </time>
  );
}
export function PromptDialog({
  item,
  targetId,
  onClose,
}: {
  item: ConversationItem;
  targetId: string;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="prompt-dialog"
      aria-labelledby="prompt-dialog-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section>
        <div className="prompt-dialog-head">
          <h2 id="prompt-dialog-title">完整提问</h2>
          <button className="icon-button" aria-label="关闭完整提问" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <Message item={item} targetId={targetId} />
      </section>
    </dialog>
  );
}
export function ModelControls({
  models,
  value,
  onChange,
  disabled,
  planAvailable,
}: {
  models: ModelOption[];
  value: SessionSettings;
  onChange(value: SessionSettings): void;
  disabled?: boolean;
  planAvailable: boolean;
}) {
  const model = models.find((m) => m.id === value.model) || models.find((m) => m.isDefault);
  return (
    <div className="settings-row">
      <label>
        模型
        <select
          aria-label="模型"
          disabled={disabled}
          value={value.model || ''}
          onChange={(e) =>
            onChange({ ...value, model: e.target.value || undefined, effort: undefined })
          }
        >
          <option value="">沿用电脑设置</option>
          {value.model && !models.some((m) => m.id === value.model) && (
            <option value={value.model}>{value.model}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        推理强度
        <select
          aria-label="推理强度"
          disabled={disabled}
          value={value.effort || ''}
          onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
        >
          <option value="">default</option>
          {value.effort && !model?.efforts.includes(value.effort) && (
            <option value={value.effort}>{value.effort}</option>
          )}
          {model?.efforts.map((e) => (
            <option value={e} key={e}>
              {e}
            </option>
          ))}
        </select>
      </label>
      <label>
        模式
        <select
          aria-label="模式"
          disabled={disabled || !planAvailable}
          value={value.mode || 'default'}
          onChange={(e) => onChange({ ...value, mode: e.target.value as 'default' | 'plan' })}
        >
          <option value="default">执行</option>
          <option value="plan">Plan · 规划</option>
        </select>
      </label>
    </div>
  );
}
export function RequestCard({
  request,
  connected,
  answer,
}: {
  request: PendingRequest;
  connected: boolean;
  answer(id: string, input: RequestAnswer): Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(input: RequestAnswer) {
    setBusy(true);
    setError('');
    try {
      await answer(request.id, input);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pending-card">
      <div className="eyebrow">需要你的确认</div>
      <h3>{request.title}</h3>
      {request.detail && <pre>{request.detail}</pre>}
      {request.questions?.map((q) => (
        <div className="question" key={q.id}>
          <label htmlFor={`q-${request.id}-${q.id}`}>{q.question}</label>
          <div className="options">
            {q.options?.map((option) => (
              <button
                type="button"
                className={values[q.id] === option.label ? 'selected' : ''}
                aria-pressed={values[q.id] === option.label}
                key={option.label}
                onClick={() => setValues({ ...values, [q.id]: option.label })}
                disabled={busy || !connected}
              >
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </button>
            ))}
          </div>
          <input
            id={`q-${request.id}-${q.id}`}
            type={q.isSecret ? 'password' : 'text'}
            value={values[q.id] || ''}
            onChange={(e) => setValues({ ...values, [q.id]: e.target.value })}
            placeholder="也可以输入你的回答"
            autoComplete="off"
            disabled={busy || !connected}
          />
        </div>
      ))}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="request-actions">
        {request.kind === 'userInput' ? (
          <button
            className="primary"
            disabled={busy || !connected || request.questions?.some((q) => !values[q.id]?.trim())}
            onClick={() =>
              void submit({
                answers: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [v]])),
              })
            }
          >
            {busy ? '正在发送…' : '提交回答'}
          </button>
        ) : (
          request.decisions?.map((decision) => (
            <button
              className={decision === 'accept' ? 'primary' : 'secondary'}
              key={decision}
              disabled={busy || !connected}
              onClick={() => void submit({ decision: decision as RequestAnswer['decision'] })}
            >
              {decision === 'accept' ? '允许本次' : decision === 'decline' ? '拒绝' : '取消任务'}
            </button>
          ))
        )}
      </div>
    </section>
  );
}
