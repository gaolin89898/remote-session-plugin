import React from 'react';
import { createPortal } from 'react-dom';
import { Button, Checkbox, Menu, MenuItemButton, Modal, IconDownloadOutlineRegular, IconLinkOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';

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

function runtimeLabel(runtime: unknown) {
  return runtime === 'desktop' ? '客户端' : runtime === 'web' ? 'Web 端' : '';
}
function platformLabel(platform: string) {
  return ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[platform] || '未知系统';
}

function currentEnvironment(snapshot: any, error: string) {
  const peerId = (window as any).__DSH_REMOTE_SESSION__?.peerId || 'local';
  const local = peerId === 'local';
  const machine = local ? snapshot?.self : snapshot?.peers?.find((peer: any) => peer.id === peerId);
  const name = machine?.name || (local ? '' : peerId);
  const environment = (local ? '本机' : '远程') + (name ? ' · ' + name : '');
  const mode = runtimeLabel(machine?.runtime);
  const online = !!snapshot && !error && (local || (snapshot.relay?.connected && machine?.online));
  const state = error ? '状态未知' : !snapshot ? '连接中' : online ? '已连接' : '离线';
  const label = [environment, mode, state].filter(Boolean).join(' · ');
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
    {mode && <span className="dsh-remote-environment-mode">{mode}</span>}
  </div>;
}

function MachineMenu({ size = 16 }: { size?: number }) {
  const [open, setOpen] = React.useState(false);
  const { snapshot, error: stateError } = useMachineState();
  const [error, setError] = React.useState(() => (window as any).__DSH_REMOTE_SESSION__?.bootError || '');
  const [busy, setBusy] = React.useState(false);
  const [restartTarget, setRestartTarget] = React.useState<any>(null);
  const [restartingId, setRestartingId] = React.useState('');
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
    const keydown = (event: KeyboardEvent) => {
      if ((event.key !== 'Enter' && event.key !== ' ') || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) setOpen(value => !value);
    };
    button.addEventListener('click', toggle, true);
    button.addEventListener('keydown', keydown, true);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('title', '远程会话');
    return () => {
      button.removeEventListener('click', toggle, true);
      button.removeEventListener('keydown', keydown, true);
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
    if (busy || restartingId) return;
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
  const restartMachine = async (machine: any) => {
    setRestartTarget(null);
    setRestartingId(machine.id);
    setError('');
    try {
      const started = await post('restart', { peerId: machine.id });
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        let status;
        try { status = await post('restart/status', { peerId: machine.id }); }
        catch { continue; }
        if (status.state === 'failed') throw new Error(status.error || '目标 DSH 重启失败');
        if (status.bootId && status.bootId !== started.bootId) {
          await refreshMachineState();
          if (machine.id === 'local' || machine.id === selected) window.location.reload();
          return;
        }
      }
      throw new Error('等待 DSH 重新上线超时，请检查目标机器上的服务状态');
    } catch (failure: any) {
      setError('重启失败：' + failure.message);
      setOpen(true);
    } finally { setRestartingId(''); }
  };
  const peers = (snapshot?.peers || []).filter((peer: any) => peer.id !== 'local' && peer.id !== snapshot?.self?.id);
  const machines = [{ ...snapshot?.self, id: 'local', online: !!snapshot, name: '本机' + (snapshot?.self?.name ? ' · ' + snapshot.self.name : '') }, ...peers];
  return <span style={{ display: 'inline-flex' }} onClick={event => event.stopPropagation()}><style>{`
    .dsh-remote-machine-menu { width: 288px; max-width: calc(100vw - 24px); }
    .dsh-remote-machine-row { display: grid; grid-template-columns: minmax(0, 1fr) 28px; align-items: center; gap: 2px; border-radius: 6px; padding-right: 6px; min-height: 34px; }
    .dsh-remote-machine-row[data-machine-id="local"] { grid-template-columns: minmax(0, 1fr); }
    .dsh-remote-machine-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-hover); }
    .dsh-remote-machine-row > div { min-width: 0; }
    .dsh-remote-machine-row button[role="menuitem"] { width: 100%; min-width: 0; }
    .dsh-remote-machine-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dsh-remote-machine-restart { display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; }
    .dsh-remote-machine-restart button { width: 28px; height: 28px; min-width: 28px; padding: 0; }
    .dsh-remote-machine-note { padding: 6px 10px; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
    .dsh-remote-machine-current { display: flex; align-items: center; gap: 5px; margin-left: auto; min-width: 0; max-width: 50%; flex: 0 1 auto; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; }
    .dsh-remote-machine-current-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dsh-remote-machine-current-mode { flex: none; white-space: nowrap; }
  `}</style>{trigger && size === 16 && !current.local && createPortal(
    <span className="dsh-remote-machine-current" title={current.label} data-remote-machine-current={selected}>
      <span className="dsh-remote-machine-current-name">{current.name}</span>
      {current.mode && <span className="dsh-remote-machine-current-mode">· {current.mode}</span>}
    </span>, trigger,
  )}<Menu
    open={open} onClose={() => setOpen(false)} portal autoFocus selectedId={selected}
    listClassName="dsh-remote-machine-menu"
    getAnchorRect={() => icon.current?.closest('button')?.getBoundingClientRect() || null}
    anchor={<span ref={icon} style={{ display: 'inline-flex' }}>
      <IconLinkOutlineRegular size={size} />
    </span>}
  >
    {machines.map(machine => {
      const disabledReason = !machine.online ? '机器离线' : !machine.restart?.supported
        ? machine.restart?.reason || '请更新目标机器上的插件并重启 DSH' : '';
      const restarting = restartingId === machine.id;
      const title = disabledReason || [restarting ? '正在重启' : '重启 DSH', platformLabel(machine.platform), runtimeLabel(machine.runtime)].filter(Boolean).join(' · ');
      return <div key={machine.id} className="dsh-remote-machine-row" data-selected={selected === machine.id} data-machine-id={machine.id}>
        <MenuItemButton current={selected === machine.id} disabled={busy || !!restartingId || !machine.online}
          icon={<StateDot state={machine.id === 'local' || !machine.online ? 'idle' : 'done'} />} onSelect={() => { void choose(machine.id); }}>
          <span className="dsh-remote-machine-label">{machine.name}{restarting ? '（重启中）' : !machine.online ? '（离线）' : ''}</span>
        </MenuItemButton>
        {machine.id !== 'local' && <span className="dsh-remote-machine-restart" title={title}>
          <Button size="sm" variant="toolbar" aria-label={'重启 ' + machine.name} title={title}
            disabled={busy || !!restartingId || !!disabledReason} icon={<IconRefreshOutlineRegular size={14} />}
            onClick={() => { setOpen(false); setRestartTarget(machine); }} />
        </span>}
      </div>;
    })}
    {!peers.length && <div className="dsh-remote-machine-note">{snapshot ? '暂无远程机器' : '正在读取机器…'}</div>}
    <MenuItemButton separatorBefore disabled={busy || !!restartingId} icon={<IconRefreshOutlineRegular />} onSelect={() => {
      setError('');
      void refreshMachineState('refresh');
    }}>刷新机器</MenuItemButton>
    {busy && <div className="dsh-remote-machine-note">正在连接…</div>}
    {(error || stateError) && <div role="alert" className="dsh-remote-machine-note">{error || stateError}</div>}
  </Menu>
  <Modal open={!!restartTarget} title={'重启 ' + (restartTarget?.name || '') + ' 上的 DSH？'} closeLabel="关闭" onClose={() => setRestartTarget(null)}
    description={[platformLabel(restartTarget?.platform), runtimeLabel(restartTarget?.runtime)].filter(Boolean).join(' · ') + '。当前正在运行的任务将会中断。'}
    footer={<><Button variant="outline" onClick={() => setRestartTarget(null)}>取消</Button>
      <Button variant="primary" icon={<IconRefreshOutlineRegular />} onClick={() => { void restartMachine(restartTarget); }}>重启</Button></>} />
  </span>;
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
  const actionableCount = rows ? rows.filter((r: any) => ['install', 'update', 'enable', 'disable'].includes(r.action)).length : 0;

  return <section aria-label="插件同步" className="dsh-remote-card dsh-plugin-sync">
    <div className="dsh-card-header">
      <div className="dsh-card-header-left">
        <span className="dsh-card-header-icon">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 9.5a5 5 0 0 1-8.7 3.5M2.5 6.5a5 5 0 0 1 8.7-3.5" />
            <path d="M2.5 10v-3.5H6M13.5 6v3.5H10" />
          </svg>
        </span>
        <div>
          <h3 className="dsh-card-title">插件同步</h3>
          <p className="dsh-card-desc">比对并同步本机与远程设备上的插件安装与启用状态</p>
        </div>
      </div>
    </div>

    {/* Device Flow Selector Bar */}
    <div className="dsh-sync-route-bar">
      <div className="dsh-sync-source">
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>来源：</span>
        <span className="dsh-sync-source-tag">
          {snapshot ? '本机' + (snapshot.self?.name ? ' · ' + snapshot.self.name : '') : '未读取'}
        </span>
      </div>

      <span className="dsh-sync-arrow">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </span>

      <select
        aria-label="同步目标机器"
        className="dsh-sync-target-select"
        value={peerId}
        disabled={busy || running}
        onChange={event => {
          generation.current++; setPeerId(event.target.value); setRows(null); setSelected([]); setJob(null); setError(''); requestId.current = null;
        }}
      >
        <option value="" disabled>选择目标机器</option>
        {onlinePeers.map((peer: any) => <option key={peer.id} value={peer.id} disabled={!peer.online}>{peer.name}{peer.online ? '' : '（离线）'}</option>)}
      </select>

      <div className="dsh-sync-buttons">
        <Button size="sm" variant="outline" disabled={busy || running || !target?.online} icon={<IconRefreshOutlineRegular />} onClick={() => { void compare(); }}>{busy && !job ? '处理中…' : '比较插件'}</Button>
        <Button size="sm" variant="toolbar" title="刷新机器" aria-label="刷新同步机器" disabled={busy || running} icon={<IconRefreshOutlineRegular />} onClick={() => { void refreshMachines().catch(failure => setError(failure.message)); }} />
      </div>
    </div>

    {snapshot && !onlinePeers.length && <div role="status" className="dsh-alert-banner" style={{ background: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.03))' }}>暂无远程机器</div>}

    {displayed && <div className="dsh-sync-results">
      <div className="dsh-sync-list-header">
        {!job ? (
          <Checkbox
            label="全选可同步插件"
            checked={!!selected.length && selected.length === actionableCount}
            disabled={busy}
            onChange={(checked: boolean) => setSelected(checked ? rows!.filter(row => ['install', 'update', 'enable', 'disable'].includes(row.action)).map(row => row.name) : [])}
          />
        ) : (
          <span style={{ fontWeight: 500 }}>同步明细</span>
        )}
        <span className="dsh-sync-list-count">
          {rows ? `共 ${rows.length} 个插件` + (actionableCount ? ` · 可同步 ${selected.length}/${actionableCount}` : '') : ''}
        </span>
      </div>

      <div className="dsh-plugin-sync-list" aria-label="插件同步列表">
        {displayed.map((row: any) => {
          const actionText = job ? syncStates[row.state] : syncActions[row.action];
          const pillClass = `dsh-status-pill dsh-status-pill-${job ? row.state : row.action}`;
          return (
            <div key={row.name} className="dsh-plugin-sync-row" data-plugin-sync-name={row.name}>
              <div className="dsh-plugin-row-top">
                <Checkbox
                  label={row.name}
                  checked={job ? row.state !== 'skipped' : selected.includes(row.name)}
                  disabled={busy || !!job || !['install', 'update', 'enable', 'disable'].includes(row.action)}
                  onChange={(checked: boolean) => setSelected(value => checked ? [...value, row.name] : value.filter(name => name !== row.name))}
                />
                <span className={pillClass}>{actionText}</span>
              </div>
              <div className="dsh-plugin-sync-detail">
                本机 {row.localVersion || '—'} · {row.enabled ? '启用' : '停用'} / 目标 {row.remoteVersion || '未安装'} · {row.remoteEnabled ? '启用' : '停用'}
                {row.version && row.version !== row.localVersion ? ' · 安装 ' + row.version : ''}
              </div>
              {(row.reason || row.error) && <div className={'dsh-plugin-sync-detail' + (row.error ? ' dsh-plugin-sync-error' : '')}>{row.error || row.reason}</div>}
            </div>
          );
        })}
      </div>

      {!job && (
        <div className="dsh-card-actions">
          <Button
            size="sm"
            variant="primary"
            icon={<IconDownloadOutlineRegular />}
            disabled={busy || !selected.length || !target?.online}
            onClick={() => { void start(); }}
          >
            同步到{target?.name || '远程机器'}{selected.length ? `（${selected.length}）` : ''}
          </Button>
        </div>
      )}
    </div>}

    {job && (
      <div role="status" className="dsh-sync-job-info">
        <div className="dsh-sync-job-status-line">
          <StateDot state={running ? 'idle' : job.state === 'done' ? 'done' : 'error'} />
          <span>
            {running ? `正在同步 ${job.rows.filter((row: any) => row.state === 'done').length}/${job.rows.length}` : job.state === 'done' ? '插件同步完成' : job.state === 'cancelled' ? '同步已取消' : '部分插件同步失败'}
          </span>
        </div>
        {job.restartRequired && <div className="dsh-restart-hint">目标机器需要重启 DSH 后生效</div>}
      </div>
    )}

    {running && (
      <div className="dsh-card-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || job.cancelRequested}
          onClick={async () => {
            setBusy(true);
            try { setJob(await post('plugin-sync/cancel', { peerId, id: job.id })); }
            catch (failure: any) { setError(failure.message); }
            finally { setBusy(false); }
          }}
        >
          {job.cancelRequested ? '正在取消…' : '取消同步'}
        </Button>
      </div>
    )}

    {error && <div role="alert" className="dsh-alert-banner dsh-alert-error dsh-plugin-sync-error">{error}</div>}
  </section>;
}

function ConnectionSettings() {
  const [form, setForm] = React.useState({ relayUrl: '', token: '', instanceId: '', instanceName: '' });
  const [meta, setMeta] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState('');
  const [savedSuccess, setSavedSuccess] = React.useState(false);
  const [readAttempt, setReadAttempt] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setBusy(true); setError(''); setLoaded(false); setSavedSuccess(false);
    post('settings').then(data => {
      if (!alive) return;
      setMeta(data);
      setForm({ relayUrl: data.relayUrl || '', token: '', instanceId: data.instanceId || '', instanceName: data.instanceName || '' });
      setLoaded(true);
      if (data.native?.error) setError(data.native.error);
    }, failure => { if (alive) setError(failure.message); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [readAttempt]);

  const mode = runtimeLabel(meta?.runtime);
  const currentDisplayName = form.instanceName || form.instanceId || (meta?.instanceName || meta?.instanceId) || '当前机器';

  return <div aria-label="远程会话设置" className="dsh-remote-settings">
    <style>{`
      .dsh-remote-settings { box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 600px; color: var(--dsw-alias-label-primary); font-family: inherit; }
      .dsh-remote-card { box-sizing: border-box; width: 100%; min-width: 0; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); border-radius: var(--dsw-radius-xl, 10px); padding: 16px; display: flex; flex-direction: column; gap: 14px; }
      .dsh-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .dsh-card-header-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dsh-card-header-icon { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-secondary); flex-shrink: 0; }
      .dsh-card-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-primary); }
      .dsh-card-desc { margin: 2px 0 0; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .dsh-status-hero { box-sizing: border-box; width: 100%; min-width: 0; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); border-radius: var(--dsw-radius-xl, 10px); padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .dsh-status-hero-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; font-size: 13px; font-weight: 500; }
      .dsh-status-hero-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .dsh-env-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.08)); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dsh-env-badge-name { font-weight: 500; color: var(--dsw-alias-label-primary); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-env-badge-mode { color: var(--dsw-alias-label-tertiary); }
      .dsh-fields-stack { display: flex; flex-direction: column; gap: 12px; width: 100%; }
      .dsh-grid-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; width: 100%; }
      .dsh-field-item { display: flex; flex-direction: column; gap: 6px; min-width: 0; width: 100%; font-size: 12px; }
      .dsh-field-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); font-weight: 500; line-height: 16px; }
      .dsh-configured-tag { font-size: 10.5px; padding: 1px 6px; border-radius: var(--dsw-radius-xs, 4px); background: rgba(82,196,26,0.1); color: var(--dsw-alias-state-success-primary); border: 0.5px solid rgba(82,196,26,0.25); font-weight: normal; }
      .dsh-text-input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-background-primary); color: inherit; font: inherit; font-size: 12.5px; transition: border-color 0.15s ease; }
      .dsh-text-input:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4); }
      .dsh-text-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary); }
      .dsh-text-input:disabled { opacity: 0.55; cursor: not-allowed; }
      .dsh-input-mono { font-family: var(--dsw-font-mono, monospace); font-size: 12px; }
      .dsh-field-tip { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
      .dsh-card-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 2px; }
      .dsh-alert-banner { box-sizing: border-box; display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 6px); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; width: 100%; }
      .dsh-alert-error { background: rgba(255,77,79,0.08); border: 0.5px solid rgba(255,77,79,0.25); color: var(--dsw-alias-state-error-primary); }
      .dsh-alert-success { background: rgba(82,196,26,0.08); border: 0.5px solid rgba(82,196,26,0.25); color: var(--dsw-alias-state-success-primary); }
      .dsh-sync-route-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-lg, 8px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02)); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); flex-wrap: wrap; }
      .dsh-sync-source { font-size: 12px; display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dsh-sync-source-tag { font-weight: 500; color: var(--dsw-alias-label-primary); }
      .dsh-sync-arrow { color: var(--dsw-alias-label-tertiary); display: flex; align-items: center; flex-shrink: 0; }
      .dsh-sync-target-select { flex: 1 1 140px; min-width: 120px; height: 32px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-background-primary); color: inherit; font: inherit; font-size: 12px; padding: 0 8px; }
      .dsh-sync-buttons { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .dsh-sync-results { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .dsh-sync-list-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 2px; font-size: 12px; }
      .dsh-sync-list-count { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .dsh-plugin-sync-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-background-primary); display: flex; flex-direction: column; }
      .dsh-plugin-sync-row { padding: 9px 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); display: flex; flex-direction: column; gap: 3px; font-size: 12px; transition: background 0.1s ease; }
      .dsh-plugin-sync-row:last-child { border-bottom: none; }
      .dsh-plugin-sync-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02)); }
      .dsh-plugin-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
      .dsh-plugin-row-top > :first-child { min-width: 0; overflow-wrap: anywhere; }
      .dsh-status-pill { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: var(--dsw-radius-xs, 4px); font-size: 11px; font-weight: 500; white-space: nowrap; }
      .dsh-status-pill-install, .dsh-status-pill-update { background: rgba(24,144,255,0.1); color: var(--dsw-alias-state-business-primary); border: 0.5px solid rgba(24,144,255,0.25); }
      .dsh-status-pill-enable, .dsh-status-pill-done { background: rgba(82,196,26,0.1); color: var(--dsw-alias-state-success-primary); border: 0.5px solid rgba(82,196,26,0.25); }
      .dsh-status-pill-disable { background: rgba(250,173,20,0.1); color: var(--dsw-alias-state-warn-primary); border: 0.5px solid rgba(250,173,20,0.25); }
      .dsh-status-pill-current, .dsh-status-pill-skip, .dsh-status-pill-skipped { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-tertiary); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); }
      .dsh-status-pill-running { background: rgba(24,144,255,0.1); color: var(--dsw-alias-state-business-primary); }
      .dsh-status-pill-failed { background: rgba(255,77,79,0.1); color: var(--dsw-alias-state-error-primary); }
      .dsh-plugin-sync-detail { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .dsh-plugin-sync-error { color: var(--dsw-alias-state-error-primary); }
      .dsh-sync-job-info { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02)); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); font-size: 12px; }
      .dsh-sync-job-status-line { display: flex; align-items: center; gap: 6px; font-weight: 500; }
      .dsh-restart-hint { color: var(--dsw-alias-state-warn-primary); font-size: 11px; }
    `}</style>

    {/* Hero Connection Status Banner */}
    <div className="dsh-status-hero">
      <div className="dsh-status-hero-left">
        <StateDot state={meta?.relay?.connected ? 'done' : 'idle'} />
        <span>{busy ? '正在读取配置…' : !loaded ? '配置读取失败' : meta.relay?.connected ? 'relay 已连接' : 'relay 未连接'}</span>
      </div>
      <div className="dsh-status-hero-right">
        <div className="dsh-env-badge" title="当前设备身份与运行模式">
          <StateDot state={meta?.relay?.connected ? 'done' : 'idle'} />
          <span className="dsh-env-badge-name">本机 · {currentDisplayName}</span>
          {mode && <span className="dsh-env-badge-mode">· {mode}</span>}
        </div>
        <Button
          size="sm"
          variant="toolbar"
          title="重新读取配置"
          aria-label="重新读取配置"
          disabled={busy}
          icon={<IconRefreshOutlineRegular />}
          onClick={() => setReadAttempt(value => value + 1)}
        />
      </div>
    </div>

    {/* Relay Connection Configuration */}
    <div className="dsh-remote-card">
      <div className="dsh-card-header">
        <div className="dsh-card-header-left">
          <span className="dsh-card-header-icon">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M2 8h12M8 2c2 2 3 4 3 6s-1 4-3 6M8 2c-2 2-3 4-3 6s1 4 3 6" />
            </svg>
          </span>
          <div>
            <h3 className="dsh-card-title">中继服务</h3>
            <p className="dsh-card-desc">配置中央转发 Relay 服务地址与安全鉴权密钥</p>
          </div>
        </div>
      </div>

      <div className="dsh-fields-stack">
        <label className="dsh-field-item">
          <span className="dsh-field-header">Relay 地址</span>
          <input
            aria-label="Relay 地址"
            disabled={busy || !loaded}
            type="text"
            value={form.relayUrl}
            placeholder="例如 https://118.196.78.91:8081/dsh-relay"
            onChange={event => setForm(value => ({ ...value, relayUrl: event.target.value }))}
            className="dsh-text-input"
          />
          <span className="dsh-field-tip">用于多机器信令路由与会话隧道转发的中继 URL</span>
        </label>

        <label className="dsh-field-item">
          <div className="dsh-field-header">
            <span>访问令牌</span>
            {meta?.hasToken && <span className="dsh-configured-tag">已配置</span>}
          </div>
          <input
            aria-label="访问令牌"
            disabled={busy || !loaded}
            type="password"
            value={form.token}
            placeholder={meta?.hasToken ? '已设置（留空保持不变）' : '请输入访问令牌'}
            onChange={event => setForm(value => ({ ...value, token: event.target.value }))}
            className="dsh-text-input"
          />
          <span className="dsh-field-tip">与 Relay 服务建立长连接所需的安全认证 Token</span>
        </label>
      </div>
    </div>

    {/* Instance Identity Configuration */}
    <div className="dsh-remote-card">
      <div className="dsh-card-header">
        <div className="dsh-card-header-left">
          <span className="dsh-card-header-icon">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2.5" width="12" height="9" rx="1.5" />
              <path d="M5 14.5h6M8 11.5v3" />
            </svg>
          </span>
          <div>
            <h3 className="dsh-card-title">实例标识</h3>
            <p className="dsh-card-desc">设定当前设备在中继网络中的唯一代号与好友展示名称</p>
          </div>
        </div>
      </div>

      <div className="dsh-grid-fields">
        <label className="dsh-field-item">
          <span className="dsh-field-header">实例 ID</span>
          <input
            aria-label="实例 ID"
            disabled={busy || !loaded}
            type="text"
            value={form.instanceId}
            placeholder="例如 company, home, macbook"
            onChange={event => setForm(value => ({ ...value, instanceId: event.target.value }))}
            className="dsh-text-input dsh-input-mono"
          />
          <span className="dsh-field-tip">全局唯一机器 ID，建议使用小写字母和连字符</span>
        </label>

        <label className="dsh-field-item">
          <span className="dsh-field-header">实例名称</span>
          <input
            aria-label="实例名称"
            disabled={busy || !loaded}
            type="text"
            value={form.instanceName}
            placeholder="例如 公司、家里台式机"
            onChange={event => setForm(value => ({ ...value, instanceName: event.target.value }))}
            className="dsh-text-input"
          />
          <span className="dsh-field-tip">在切换菜单与插件同步列表中展示的友好设备名</span>
        </label>
      </div>

      {error && <div role="alert" className="dsh-alert-banner dsh-alert-error" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div>}
      {savedSuccess && !error && <div className="dsh-alert-banner dsh-alert-success">✓ 配置已保存并连接成功</div>}

      <div className="dsh-card-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !loaded}
          icon={<IconRefreshOutlineRegular />}
          onClick={async () => {
            setBusy(true); setError(''); setSavedSuccess(false);
            try {
              const saved = await post('settings-save', form);
              setMeta(saved); setForm(value => ({ ...value, token: '' }));
              if (saved.native?.error) {
                setError(saved.native.error);
              } else if (!saved.relay?.connected) {
                setError(saved.relay?.lastError || 'relay 尚未连接');
              } else {
                setSavedSuccess(true);
              }
            } catch (failure: any) { setError(failure.message); }
            finally { setBusy(false); }
          }}
        >
          {busy ? '连接中…' : '保存并重连'}
        </Button>
      </div>
    </div>

    {/* Plugin Synchronization */}
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
