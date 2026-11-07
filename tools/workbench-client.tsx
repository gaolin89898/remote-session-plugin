import React from 'react';
import { createPortal } from 'react-dom';

async function request(action: string, body: any = {}, signal?: AbortSignal) {
  const response = await fetch(new URL('remote-session/api/workbench/' + action, document.baseURI), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
export function AgentWorkbench() {
  const [open, setOpen] = React.useState(false);
  return <><button onClick={() => setOpen(true)}>Agent 工作台</button>{open && createPortal(<Workbench close={() => setOpen(false)} />, document.body)}</>;
}
function Workbench({ close }: { close: () => void }) {
  const [hosts, setHosts] = React.useState<any[]>([]), [hostId, setHostId] = React.useState('');
  const [agents, setAgents] = React.useState<any[]>([]), [agentId, setAgentId] = React.useState('');
  const [workspaces, setWorkspaces] = React.useState<any[]>([]), [workspaceId, setWorkspaceId] = React.useState('');
  const [sessions, setSessions] = React.useState<any[]>([]), [sessionId, setSessionId] = React.useState('');
  const [snapshot, setSnapshot] = React.useState<any>(null), [text, setText] = React.useState('');
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [connected, setConnected] = React.useState(false);
  const [editing, setEditing] = React.useState(false), [form, setForm] = React.useState<any>({ name: '', mode: 'direct', url: 'http://127.0.0.1:3490', target: '', sshPort: 22, gatewayPort: 3490, token: '' });
  const epoch = React.useRef(0);
  const run = async (task: () => Promise<void>) => { setBusy(true); setError(''); try { await task(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const call = async (method: string, params: any = {}, signal?: AbortSignal) => (await request('call', { id: hostId, method, params }, signal)).result;
  const reset = () => { epoch.current++; setConnected(false); setAgents([]); setWorkspaces([]); setAgentId(''); setWorkspaceId(''); setSessions([]); setSessionId(''); setSnapshot(null); };
  React.useEffect(() => { void run(async () => setHosts((await request('hosts')).hosts)); }, []);
  React.useEffect(() => {
    if (!connected || !agentId || !workspaceId) return;
    const abort = new AbortController(); setSessions([]); setSessionId(''); setSnapshot(null);
    void call('sessions.list', { agentId, workspaceId }, abort.signal).then(result => { if (!abort.signal.aborted) setSessions(result.sessions); }, e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [connected, hostId, agentId, workspaceId]);
  React.useEffect(() => {
    if (!sessionId || !connected) return;
    const abort = new AbortController(); setSnapshot(null);
    void (async () => {
      try {
        let current = await call('sessions.read', { sessionId }, abort.signal);
        while (!abort.signal.aborted) {
          const next = current;
          setSnapshot((old: any) => !old || old.id !== next.id || old.epoch !== next.epoch || next.cursor >= old.cursor ? next : old);
          current = await call('sessions.watch', { sessionId, epoch: current.epoch, after: current.cursor }, abort.signal);
        }
      } catch (e: any) { if (!abort.signal.aborted) setError(e.message); }
    })();
    return () => abort.abort();
  }, [sessionId, connected, hostId]);
  const connect = () => run(async () => {
    reset(); const revision = epoch.current;
    await request('connect', { id: hostId });
    const [a, w] = await Promise.all([call('agents.list'), call('workspaces.list')]);
    if (revision !== epoch.current) return;
    setAgents(a.agents); setWorkspaces(w.workspaces); setAgentId(a.agents[0]?.id || ''); setWorkspaceId(w.workspaces[0]?.id || ''); setConnected(true);
  });
  const mutate = (method: string, params: any = {}) => run(async () => { const result = await call(method, { sessionId, ...params }); if (result.id === sessionId) setSnapshot((old: any) => !old || old.epoch !== result.epoch || result.cursor >= old.cursor ? result : old); });
  const field = (key: string, label: string, type = 'text') => <label>{label}<input type={type} value={form[key] ?? ''} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>;
  return <div className="agent-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}><section className="agent-workbench" role="dialog" aria-modal="true" aria-label="Agent 工作台">
    <style>{`.agent-backdrop{position:fixed;inset:0;background:#0008;z-index:10000;display:grid;place-items:center}.agent-workbench{width:min(960px,96vw);height:90vh;background:var(--dsw-alias-surface-primary,#181a20);color:var(--dsw-alias-label-primary,#eee);border:1px solid #6665;border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box}.agent-workbench header,.agent-controls,.agent-compose{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.agent-workbench h2{flex:1;margin:0;font-size:18px}.agent-workbench button,.agent-workbench select,.agent-workbench input,.agent-workbench textarea{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:7px;padding:8px}.agent-workbench button:disabled{opacity:.45}.agent-workbench option{color:#111}.agent-form{display:flex;flex-wrap:wrap;gap:10px}.agent-form label{display:flex;flex-direction:column;gap:5px}.agent-messages{flex:1;overflow:auto;min-height:80px}.agent-message{padding:12px;margin:8px 0;border-radius:10px;background:#8881}.agent-message[data-role=user]{margin-left:12%;background:#4685d522}.agent-message[data-role=reasoning],.agent-message[data-role=tool]{font-size:12px;opacity:.8}.agent-message pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:6px 0}.agent-compose textarea{flex:1;resize:vertical;min-height:56px}.agent-error{color:#ff9494}.agent-approval{border:1px solid #dca653;border-radius:8px;padding:10px;display:flex;gap:10px;align-items:center}`}</style>
    <header><h2>Agent 工作台</h2><button onClick={close} aria-label="关闭">×</button></header>
    <div className="agent-controls"><select aria-label="机器" disabled={busy} value={hostId} onChange={e => { reset(); setHostId(e.target.value); }}><option value="">选择机器</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
      <button disabled={busy || !hostId} onClick={connect}>{connected ? '重新连接' : '连接'}</button>
      <button disabled={busy} onClick={() => { const host = hosts.find(h => h.id === hostId); setForm(host ? { ...host, token: '' } : { name: '', mode: 'direct', url: 'http://127.0.0.1:3490', token: '' }); setEditing(!editing); }}>{hostId ? '编辑机器' : '添加机器'}</button>
      {connected && <button onClick={() => void run(async () => { reset(); await request('disconnect', { id: hostId }); })}>断开</button>}
    </div>
    {editing && <form className="agent-form" onSubmit={e => { e.preventDefault(); void run(async () => { reset(); const result = await request('save', form); setHosts(result.hosts); setEditing(false); if (!form.id) setHostId(result.hosts.at(-1).id); }); }}>
      {field('name', '机器名称')}<label>连接方式<select value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })}><option value="direct">HTTP(S)</option><option value="ssh">SSH</option></select></label>
      {form.mode === 'ssh' ? <>{field('target', 'SSH 别名 / user@host')}{field('sshPort', 'SSH 端口', 'number')}{field('gatewayPort', '网关端口', 'number')}</> : field('url', '网关地址')}
      {field('token', form.id ? '网关令牌（留空保留）' : '网关令牌', 'password')}<button disabled={busy}>保存</button>
      {form.id && <button type="button" disabled={busy} onClick={() => void run(async () => { reset(); setHosts((await request('remove', { id: form.id })).hosts); setHostId(''); setEditing(false); })}>删除机器</button>}
    </form>}
    {connected && <div className="agent-controls"><select aria-label="Agent" value={agentId} disabled={busy} onChange={e => { setSnapshot(null); setSessionId(''); setAgentId(e.target.value); }}>{agents.map(a => <option key={a.id} value={a.id}>{a.name} · {a.kind}</option>)}</select>
      <select aria-label="工作区" value={workspaceId} disabled={busy} onChange={e => { setSnapshot(null); setSessionId(''); setWorkspaceId(e.target.value); }}>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <select aria-label="会话" value={sessionId} disabled={busy} onChange={e => setSessionId(e.target.value)}><option value="">选择会话</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
      <button disabled={busy || !agentId || !workspaceId} onClick={() => void run(async () => { const result = await call('sessions.create', { agentId, workspaceId }); setSessions(old => [...old, result]); setSessionId(result.id); })}>新建会话</button>
    </div>}
    {error && <div className="agent-error" role="alert">{error}</div>}
    <div className="agent-messages" aria-live="polite">{snapshot?.hasMore && <p>仅显示最近的会话记录</p>}{snapshot?.messages.map((message: any) => <article className="agent-message" data-role={message.role} key={message.id}><small>{({ user: '你', assistant: 'Agent', reasoning: '思考', tool: '工具' } as any)[message.role] || message.role}</small><pre>{message.text}</pre></article>)}{snapshot?.error && <p className="agent-error">{snapshot.error}</p>}</div>
    {snapshot?.approvals.map((approval: any) => <div className="agent-approval" key={approval.id}><span style={{ flex: 1 }}>{approval.title}</span><button disabled={busy || approval.pending} onClick={() => void mutate('sessions.approve', { approvalId: approval.id, decision: 'allow' })}>允许一次</button><button disabled={busy || approval.pending} onClick={() => void mutate('sessions.approve', { approvalId: approval.id, decision: 'reject' })}>拒绝</button></div>)}
    <form className="agent-compose" onSubmit={e => { e.preventDefault(); const prompt = text; void run(async () => { const id = sessionId; await call('sessions.prompt', { sessionId: id, text: prompt }); setText(''); }); }}><textarea aria-label="消息" value={text} onChange={e => setText(e.target.value)} disabled={!snapshot || busy || snapshot.running} /><button disabled={!snapshot || busy || snapshot.running || !text.trim()}>发送</button><button type="button" disabled={busy || !snapshot?.running} onClick={() => void mutate('sessions.cancel')}>停止</button></form>
  </section></div>;
}
