import React from 'react';
import { createPortal } from 'react-dom';
import { Button, Checkbox, Menu, IconDownloadOutlineRegular, IconLinkOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';

export const name = 'dsh-remote-session';
export const inject = ['slots'];

async function post(method: string, body: unknown = {}) {
  const response = await fetch(new URL('remote-session/api/' + method, document.baseURI), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`远程会话请求未通过认证，请重新登录或刷新页面后重试（HTTP ${response.status}）`);
  }
  const text = await response.text();
  if (!text.trim()) throw new Error(`远程会话接口返回空响应，请刷新页面后重试（HTTP ${response.status}）`);
  if (/text\/html/i.test(response.headers.get('content-type') || '') || /^\s*</.test(text)) {
    throw new Error('远程会话接口返回了登录页，请重新登录后重试');
  }
  let data: any;
  try { data = JSON.parse(text); }
  catch { throw new Error(`远程会话接口响应无效，请刷新页面后重试（HTTP ${response.status}）`); }
  if (!response.ok || !data || typeof data !== 'object' || data.ok !== true) {
    throw new Error(data?.error || `远程会话请求失败（HTTP ${response.status}）`);
  }
  return data;
}

let machineState: { snapshot: any; error: string } = { snapshot: null, error: '' };
const machineListeners = new Set<() => void>();
let machineTimer: ReturnType<typeof setInterval> | undefined;
let machineRead: Promise<void> | undefined;
function refreshMachineState(method = 'state') {
  if (method === 'state' && machineRead) return machineRead;
  const task = post(method).then(snapshot => {
    machineState = { snapshot, error: '' };
  }, failure => {
    machineState = { ...machineState, error: failure.message };
  }).then(() => { for (const listener of machineListeners) listener(); });
  if (method === 'state') {
    machineRead = task;
    void task.finally(() => { if (machineRead === task) machineRead = undefined; });
  }
  return task;
}
function subscribeMachineState(listener: () => void) {
  machineListeners.add(listener);
  if (machineListeners.size === 1) {
    void refreshMachineState();
    machineTimer = setInterval(() => { void refreshMachineState(); }, 5000);
  }
  return () => {
    machineListeners.delete(listener);
    if (!machineListeners.size) { clearInterval(machineTimer); machineTimer = undefined; }
  };
}
const getMachineState = () => machineState;
function useMachineState() { return React.useSyncExternalStore(subscribeMachineState, getMachineState); }

function currentEnvironment(snapshot: any, error: string) {
  const peerId = (window as any).__DSH_REMOTE_SESSION__?.peerId || 'local';
  const local = peerId === 'local';
  const machine = local ? snapshot?.self : snapshot?.peers?.find((peer: any) => peer.id === peerId);
  const name = machine?.name || (local ? '' : peerId);
  const environment = (local ? '本机' : '远程') + (name ? ' · ' + name : '');
  const mode = typeof (window as any).dshDesktopBoot?.ready === 'function' ? '客户端' : 'Web 端';
  const online = !!snapshot && !error && (local || (snapshot.relay?.connected && machine?.online));
  const state = error ? '状态未知' : !snapshot ? '连接中' : online ? '已连接' : '离线';
  const label = environment + ' · ' + mode + ' · ' + state;
  return { peerId, local, name: name || (local ? '本机' : peerId), environment, mode, online, state, label };
}

function EnvironmentStatus({ wide = true }: { wide?: boolean }) {
  const { snapshot, error } = useMachineState();
  const { peerId, local, environment, mode, online, state, label } = currentEnvironment(snapshot, error);
  return <div role="status" aria-label={label} title={label} data-remote-environment={peerId}
    className={'dsh-remote-environment' + (wide ? '' : ' dsh-remote-environment-compact')}>
    <style>{`
      /* Footer occupants share a horizontal slot; keep full-width widgets on separate rows. */
      div:has(> div > .dsh-remote-environment) { flex-direction: column; gap: 4px; }
      .dsh-remote-environment { box-sizing: border-box; display: flex; flex: none; align-items: center; gap: 7px; width: 100%; min-width: 0; min-height: 32px; padding: 6px 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
      .dsh-remote-environment-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-remote-environment-mode { flex: 0 0 auto; white-space: nowrap; }
      .dsh-remote-environment-compact { width: 40px; min-height: 56px; padding: 4px 0; flex-direction: column; justify-content: center; gap: 0; font-size: 10px; line-height: 16px; }
    `}</style>
    <StateDot state={online ? 'done' : 'idle'} />
    {wide && <span className="dsh-remote-environment-name">{environment}{!online && snapshot ? ' · ' + state : ''}</span>}
    {!wide && <span>{local ? '本机' : '远程'}</span>}
    <span className="dsh-remote-environment-mode">{mode}</span>
  </div>;
}

function MachineMenu({ size = 16 }: { size?: number }) {
  const [open, setOpen] = React.useState(false);
  const { snapshot, error: stateError } = useMachineState();
  const [error, setError] = React.useState(() => (window as any).__DSH_REMOTE_SESSION__?.bootError || '');
  const [busy, setBusy] = React.useState(false);
  const icon = React.useRef<HTMLSpanElement>(null);
  const [trigger, setTrigger] = React.useState<HTMLButtonElement | null>(null);
  const bridge = (window as any).__DSH_REMOTE_SESSION__;
  const selected = bridge?.peerId || 'local';
  const current = currentEnvironment(snapshot, stateError);

  // The official panellist slot supplies only the glyph. Adapt its existing
  // button to a menu trigger while preserving the native SidebarRoot layout.
  React.useLayoutEffect(() => {
    const button = icon.current?.closest('button');
    if (!button) return;
    setTrigger(button);
    const previous = ['aria-haspopup', 'aria-expanded', 'title'].map(key => [key, button.getAttribute(key)]);
    const toggle = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(value => !value);
    };
    button.addEventListener('click', toggle, true);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('title', '远程会话');
    return () => {
      button.removeEventListener('click', toggle, true);
      for (const [key, value] of previous) {
        if (value === null) button.removeAttribute(key!);
        else button.setAttribute(key!, value!);
      }
    };
  }, []);
  React.useLayoutEffect(() => {
    icon.current?.closest('button')?.setAttribute('aria-expanded', String(open));
  }, [open]);

  const choose = async (id: string) => {
    if (busy) return;
    if (id === selected) { setOpen(false); return; }
    setError('');
    setBusy(true);
    try {
      if (!bridge) throw new Error('请重启 DSH 以加载机器切换服务');
      await bridge.switchMachine(id);
    } catch (failure: any) {
      setError('切换失败：' + failure.message);
      setBusy(false);
    }
  };
  const peers = (snapshot?.peers || []).filter((peer: any) => peer.id !== 'local' && peer.id !== snapshot?.self?.id);
  const items: any[] = [
    { id: 'local', label: '本机' + (snapshot?.self?.name ? ' · ' + snapshot.self.name : ''), icon: <StateDot state="idle" />, disabled: busy },
    ...peers.map((peer: any) => ({
      id: peer.id, label: peer.name + (peer.online ? '' : '（离线）'),
      icon: <StateDot state={peer.online ? 'done' : 'idle'} />, disabled: busy || !peer.online,
    })),
    ...!peers.length ? [{ type: 'label', id: 'empty', text: snapshot ? '暂无远程机器' : '正在读取机器…' }] : [],
    { type: 'separator', id: 'actions' },
    { id: '$refresh', label: '刷新机器', icon: <IconRefreshOutlineRegular />, disabled: busy },
    ...busy ? [{ type: 'label', id: 'busy', text: '正在连接…' }] : [],
    ...(error || stateError) ? [{ type: 'label', id: 'error', text: error || stateError }] : [],
  ];
  return <><style>{`
    .dsh-remote-machine-menu { width: 288px; max-width: calc(100vw - 24px); }
    .dsh-remote-machine-current { display: flex; align-items: center; gap: 5px; margin-left: auto; min-width: 0; max-width: 50%; flex: 0 1 auto; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; }
    .dsh-remote-machine-current-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dsh-remote-machine-current-mode { flex: none; white-space: nowrap; }
  `}</style>{trigger && size === 16 && !current.local && createPortal(
    <span className="dsh-remote-machine-current" title={current.label} data-remote-machine-current={selected}>
      <span className="dsh-remote-machine-current-name">{current.name}</span>
      <span className="dsh-remote-machine-current-mode">· {current.mode}</span>
    </span>, trigger,
  )}<Menu
    open={open} onClose={() => setOpen(false)} portal autoFocus selectedId={selected}
    listClassName="dsh-remote-machine-menu"
    getAnchorRect={() => icon.current?.closest('button')?.getBoundingClientRect() || null}
    anchor={<span ref={icon} style={{ display: 'inline-flex' }}>
      <IconLinkOutlineRegular size={size} />
    </span>}
    items={items}
    onSelect={id => {
      if (id !== '$refresh') { void choose(id); return; }
      setError('');
      void refreshMachineState('refresh');
    }}
  /></>;
}

const syncStorageKey = 'dsh.remote-session.plugin-sync.v1';
const syncActions: Record<string, string> = { install: '安装', update: '更新', enable: '启用', disable: '停用', current: '已一致', skip: '跳过' };
const syncStates: Record<string, string> = { pending: '等待中', running: '同步中', done: '已完成', failed: '失败', cancelled: '已取消', skipped: '跳过' };
function savedSync() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(syncStorageKey) || 'null');
    return typeof saved?.peerId === 'string' && typeof saved?.id === 'string' ? saved : null;
  } catch { return null; }
}

function PluginSyncSettings() {
  const initial = React.useRef(savedSync()).current;
  const [snapshot, setSnapshot] = React.useState<any>(null);
  const [peerId, setPeerId] = React.useState(initial?.peerId || '');
  const [rows, setRows] = React.useState<any[] | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [job, setJob] = React.useState<any>(initial ? { id: initial.id, state: 'running', rows: [] } : null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const requestId = React.useRef<string | null>(initial?.id || null);
  const generation = React.useRef(0);
  const running = job?.state === 'running';
  const onlinePeers = (snapshot?.peers || []).filter((peer: any) => peer.id !== snapshot?.self?.id && peer.id !== 'local');
  const target = onlinePeers.find((peer: any) => peer.id === peerId);
  const refreshMachines = async () => {
    const data = await post('state');
    setError('');
    setSnapshot(data);
    const peers = data.peers.filter((peer: any) => peer.online && peer.id !== data.self.id && peer.id !== 'local');
    setPeerId((value: string) => value || peers.find((peer: any) => peer.id === (window as any).__DSH_REMOTE_SESSION__?.peerId)?.id || peers[0]?.id || '');
  };
  React.useEffect(() => {
    let alive = true;
    post('state').then(data => {
      if (!alive) return;
      setSnapshot(data);
      const peers = data.peers.filter((peer: any) => peer.online && peer.id !== data.self.id && peer.id !== 'local');
      setPeerId((value: string) => value || peers.find((peer: any) => peer.id === (window as any).__DSH_REMOTE_SESSION__?.peerId)?.id || peers[0]?.id || '');
    }, failure => { if (alive) setError(failure.message); });
    return () => { alive = false; generation.current++; };
  }, []);
  React.useEffect(() => {
    if (!running || !peerId || !job?.id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await post('plugin-sync/status', { peerId, id: job.id });
        if (!alive) return;
        setJob(status); setError('');
        if (status.state !== 'running') { sessionStorage.removeItem(syncStorageKey); return; }
      } catch (failure: any) {
        if (!alive) return;
        if (/同步任务不存在/.test(failure.message)) {
          sessionStorage.removeItem(syncStorageKey); setJob(null); requestId.current = null;
          setError('同步任务已失效，请重新比较插件'); return;
        }
        setError('暂时无法读取进度，目标机器上的任务可能仍在运行：' + failure.message);
      }
      if (alive) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [peerId, job?.id, running]);

  const compare = async () => {
    const current = ++generation.current;
    setBusy(true); setError(''); setJob(null); requestId.current = null;
    try {
      const data = await post('plugin-sync/preview', { peerId });
      if (current !== generation.current) return;
      setRows(data.rows);
      setSelected(data.rows.filter((row: any) => ['install', 'update', 'enable', 'disable'].includes(row.action)).map((row: any) => row.name));
    } catch (failure: any) { if (current === generation.current) setError(failure.message); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setError('');
    requestId.current ||= crypto.randomUUID();
    sessionStorage.setItem(syncStorageKey, JSON.stringify({ peerId, id: requestId.current }));
    try {
      const status = await post('plugin-sync/start', { peerId, id: requestId.current, names: selected });
      sessionStorage.setItem(syncStorageKey, JSON.stringify({ peerId, id: status.id }));
      setJob(status);
      if (status.state !== 'running') sessionStorage.removeItem(syncStorageKey);
    } catch (failure: any) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const displayed = job?.rows.length ? job.rows : rows;
  return <section aria-label="插件同步" className="dsh-plugin-sync">
    <style>{`
      .dsh-plugin-sync { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 20px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .dsh-plugin-sync h3 { margin: 0; font-size: 14px; font-weight: 600; }
      .dsh-plugin-sync-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .dsh-plugin-sync select { min-width: 120px; max-width: 100%; height: 32px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-background-primary); color: inherit; font: inherit; padding: 0 8px; flex: 1; }
      .dsh-plugin-sync-list { max-height: 360px; overflow: auto; border-block: 1px solid var(--dsw-alias-border-l2); }
      .dsh-plugin-sync-row { padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; font-size: 12px; }
      .dsh-plugin-sync-row:last-child { border-bottom: 0; }
      .dsh-plugin-sync-row > :first-child, .dsh-plugin-sync-detail { min-width: 0; overflow-wrap: anywhere; }
      .dsh-plugin-sync-row label { align-items: flex-start; min-width: 0; }
      .dsh-plugin-sync-row label span { overflow-wrap: anywhere; min-width: 0; }
      .dsh-plugin-sync-detail { grid-column: 1 / -1; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
      .dsh-plugin-sync-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
    `}</style>
    <h3>插件同步</h3>
    <div style={{ fontSize: 12 }}>来源：{snapshot ? '本机' + (snapshot.self?.name ? ' · ' + snapshot.self.name : '') : '未读取'}</div>
    <div className="dsh-plugin-sync-tools">
      <select aria-label="同步目标机器" value={peerId} disabled={busy || running} onChange={event => {
        generation.current++; setPeerId(event.target.value); setRows(null); setSelected([]); setJob(null); setError(''); requestId.current = null;
      }}>
        <option value="" disabled>选择目标机器</option>
        {onlinePeers.map((peer: any) => <option key={peer.id} value={peer.id} disabled={!peer.online}>{peer.name}{peer.online ? '' : '（离线）'}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy || running || !target?.online} icon={<IconRefreshOutlineRegular />} onClick={() => { void compare(); }}>{busy && !job ? '处理中…' : '比较插件'}</Button>
      <Button size="sm" variant="toolbar" title="刷新机器" aria-label="刷新同步机器" disabled={busy || running} icon={<IconRefreshOutlineRegular />} onClick={() => { void refreshMachines().catch(failure => setError(failure.message)); }} />
    </div>
    {snapshot && !onlinePeers.length && <div role="status">暂无远程机器</div>}
    {displayed && <>
      {!job && <Checkbox label="全选可同步插件" checked={!!selected.length && selected.length === rows?.filter(row => ['install', 'update', 'enable', 'disable'].includes(row.action)).length}
        disabled={busy} onChange={(checked: boolean) => setSelected(checked ? rows!.filter(row => ['install', 'update', 'enable', 'disable'].includes(row.action)).map(row => row.name) : [])} />}
      <div className="dsh-plugin-sync-list" aria-label="插件同步列表">
        {displayed.map((row: any) => <div key={row.name} className="dsh-plugin-sync-row" data-plugin-sync-name={row.name}>
          <Checkbox label={row.name} checked={job ? row.state !== 'skipped' : selected.includes(row.name)}
            disabled={busy || !!job || !['install', 'update', 'enable', 'disable'].includes(row.action)}
            onChange={(checked: boolean) => setSelected(value => checked ? [...value, row.name] : value.filter(name => name !== row.name))} />
          <span>{job ? syncStates[row.state] : syncActions[row.action]}</span>
          <div className="dsh-plugin-sync-detail">本机 {row.localVersion || '—'} · {row.enabled ? '启用' : '停用'} / 目标 {row.remoteVersion || '未安装'} · {row.remoteEnabled ? '启用' : '停用'}{row.version && row.version !== row.localVersion ? ' · 安装 ' + row.version : ''}</div>
          {(row.reason || row.error) && <div className={'dsh-plugin-sync-detail' + (row.error ? ' dsh-plugin-sync-error' : '')}>{row.error || row.reason}</div>}
        </div>)}
      </div>
      {!job && <Button size="sm" variant="primary" style={{ alignSelf: 'flex-end' }} icon={<IconDownloadOutlineRegular />} disabled={busy || !selected.length || !target?.online} onClick={() => { void start(); }}>同步到{target?.name || '远程机器'}{selected.length ? `（${selected.length}）` : ''}</Button>}
    </>}
    {job && <div role="status" style={{ fontSize: 12 }}>
      {running ? `正在同步 ${job.rows.filter((row: any) => row.state === 'done').length}/${job.rows.length}` : job.state === 'done' ? '插件同步完成' : job.state === 'cancelled' ? '同步已取消' : '部分插件同步失败'}
      {job.restartRequired && <div>目标机器需要重启 DSH 后生效</div>}
    </div>}
    {running && <Button size="sm" variant="outline" style={{ alignSelf: 'flex-end' }} disabled={busy || job.cancelRequested} onClick={async () => {
      setBusy(true);
      try { setJob(await post('plugin-sync/cancel', { peerId, id: job.id })); }
      catch (failure: any) { setError(failure.message); }
      finally { setBusy(false); }
    }}>{job.cancelRequested ? '正在取消…' : '取消同步'}</Button>}
    {error && <div role="alert" className="dsh-plugin-sync-error">{error}</div>}
  </section>;
}

function ConnectionSettings() {
  const [form, setForm] = React.useState({ relayUrl: '', token: '', instanceId: '', instanceName: '' });
  const [meta, setMeta] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState('');
  const [readAttempt, setReadAttempt] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    setBusy(true); setError(''); setLoaded(false);
    post('settings').then(data => {
      if (!alive) return;
      setMeta(data);
      setForm({ relayUrl: data.relayUrl || '', token: '', instanceId: data.instanceId || '', instanceName: data.instanceName || '' });
      setLoaded(true);
    }, failure => { if (alive) setError(failure.message); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [readAttempt]);
  const fields = [['relayUrl', 'Relay 地址'], ['token', '访问令牌'], ['instanceId', '实例 ID'], ['instanceName', '实例名称']] as const;
  return <div aria-label="远程会话设置" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <StateDot state={meta?.relay?.connected ? 'done' : 'idle'} />
      <span style={{ flex: 1 }}>{busy ? '正在读取配置…' : !loaded ? '配置读取失败' : meta.relay?.connected ? 'relay 已连接' : 'relay 未连接'}</span>
      <Button size="sm" variant="toolbar" title="重新读取配置" aria-label="重新读取配置" disabled={busy} icon={<IconRefreshOutlineRegular />} onClick={() => setReadAttempt(value => value + 1)} />
    </div>
    {fields.map(([key, label]) => <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
      {label}<input aria-label={label} disabled={busy || !loaded} type={key === 'token' ? 'password' : 'text'} value={form[key]}
        placeholder={key === 'token' && meta?.hasToken ? '已设置（留空保持不变）' : ''}
        onChange={event => setForm(value => ({ ...value, [key]: event.target.value }))}
        style={{ boxSizing: 'border-box', width: '100%', height: 32, padding: '0 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-background-primary)', color: 'inherit', font: 'inherit' }} />
    </label>)}
    {error && <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div>}
    <Button size="sm" variant="outline" disabled={busy || !loaded} style={{ alignSelf: 'flex-end' }} icon={<IconRefreshOutlineRegular />} onClick={async () => {
      setBusy(true); setError('');
      try {
        const saved = await post('settings-save', form);
        setMeta(saved); setForm(value => ({ ...value, token: '' }));
        if (!saved.relay?.connected) setError(saved.relay?.lastError || 'relay 尚未连接');
      } catch (failure: any) { setError(failure.message); }
      finally { setBusy(false); }
    }}>{busy ? '连接中…' : '保存并重连'}</Button>
    <PluginSyncSettings />
  </div>;
}

export function apply(ctx: any) {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'remote-session-environment', order: 100,
  }, EnvironmentStatus));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'remote-session', order: 50, label: () => '远程会话',
  }, MachineMenu));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'remote-session', order: 90, label: () => '远程会话',
  }, ConnectionSettings));
}
