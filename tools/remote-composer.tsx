/** Remote transport adapter for the unmodified upstream composer and its seats. */
import React from 'react';
import { createSnapshotStore } from '../vendor/.src/packages/client/store/src/index.ts';
import { InputBar } from '../vendor/.src/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx';
import { DraftEditorRuntime } from '../vendor/.src/packages/client/ui-conversation/src/client/input/editor/runtime.ts';
import { zh as conversationZh } from '../vendor/.src/packages/client/ui-conversation/src/client/locales.ts';
import { ModelSelect } from '../vendor/.src/packages/client/ui-model-selection/src/client/ModelSelect.tsx';
import { zh as modelZh } from '../vendor/.src/packages/client/ui-model-selection/src/client/locales.ts';
import { PermissionSelect } from '../vendor/.src/packages/client/ui-permission-presets/src/client/PermissionSelect.tsx';
import { accessZh } from '../vendor/.src/packages/client/ui-permission-presets/src/client/locales.ts';
import { MenuView } from '../vendor/.src/packages/client/ui-input-trigger/src/client/MenuView.tsx';
import { zh as menuZh } from '../vendor/.src/packages/client/ui-input-trigger/src/client/locales.ts';

const locale = (dictionary: Record<string, string>) => (key: string, vars?: Record<string, unknown>) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (match, name) => vars && name in vars ? String(vars[name]) : match);
const tConversation = locale(conversationZh);
const tModel = locale(modelZh);
const tPermission = locale(accessZh);
const tMenu = locale(menuZh);
const CLOSED = { open: false, groups: [], highlight: null };
const EMPTY_HEADERS = createSnapshotStore(new Map());
const EMPTY_UPLOADS = {};
const EMPTY_LEXICON = new Map();
const EMPTY_KEYS: string[] = [];

function useStore(store: any, selector: any) {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  return selector(snapshot);
}

/** Keep the official model directory contract while sending writes through the relay. */
function RemoteModelSelect({ owner, remote }: any) {
  const directory = React.useMemo(() => createSnapshotStore<any>({
    current: remote.currentModel ?? null, routable: null, groups: [], failures: [],
    status: 'idle', pending: null, error: null,
  }), []);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const syncCatalog = (catalog: any, current: any) => {
    const before = directory.getSnapshot();
    const selection = current ?? before.current ?? catalog?.default ?? null;
    const groups = catalog?.groups ?? before.groups;
    directory.set({ ...before, current: selection, groups, failures: catalog?.failures ?? [],
      routable: selection === null ? null : groups.some((group: any) => group.id === selection.provider
        && group.models.some((model: any) => model.id === selection.model)),
      status: before.pending !== null ? 'selecting' : catalog ? 'ready' : before.status,
      error: catalog ? null : before.error,
    });
  };
  React.useEffect(() => {
    syncCatalog(remote.modelCatalog, remote.currentModel);
  }, [remote.modelCatalog, remote.currentModel]);
  const load = () => {
    directory.set({ ...directory.getSnapshot(), status: 'loading', error: null });
    void remote.request('models', {}).then((result: any) => {
      if (!alive.current) return;
      syncCatalog(result.catalog, remote.currentModel);
    }).catch((error: any) => {
      if (alive.current) directory.set({ ...directory.getSnapshot(), status: 'error', error: String(error.message ?? error) });
    });
  };
  const select = async (selection: any) => {
    directory.set({ ...directory.getSnapshot(), status: 'selecting', pending: selection, error: null });
    let result: any;
    try { result = await remote.onModelChange(selection); }
    catch (error: any) { result = { ok: false, error: { code: 'remote/model', message: String(error.message ?? error) } }; }
    if (alive.current) {
      directory.set({ ...directory.getSnapshot(), pending: null,
        ...(result?.ok ? { current: selection, status: 'ready', error: null }
          : { status: 'error', error: result?.error?.message ?? '切换模型失败' }),
      });
    }
    return result;
  };
  return <ModelSelect {...owner} available directory={directory} load={load} select={select}
    t={tModel as any} renderSlot={(_name: any, _owner: any, options: any) => options?.fallback ?? null} />;
}

function RemotePermissionSelect({ owner, remote }: any) {
  const catalog = React.useMemo(() => remote.permissionCatalog == null ? null : {
    ...remote.permissionCatalog,
    options: (remote.permissionCatalog.options ?? []).map((option: any) => ({ ...option, name: option.name ?? option.value })),
  }, [remote.permissionCatalog]);
  const useProjection = (_key: string, selector?: any) => {
    const value = remote.currentPermission ? { currentValue: remote.currentPermission } : undefined;
    return selector ? selector(value) : value;
  };
  return <PermissionSelect {...owner} useProjection={useProjection as any}
    usePermissionCatalog={((selector: any) => selector({ value: catalog })) as any}
    select={remote.onPermissionChange} t={tPermission as any} />;
}

/** All DOM inside the capsule and its menus is rendered by upstream components. */
export function VendorComposer(props: any) {
  const latest = React.useRef(props);
  latest.current = props;
  const controller = React.useMemo(() => {
    const input = createSnapshotStore<any>({ draft: '', attachmentIds: [], queue: [], phase: 'plain' });
    const menu = createSnapshotStore<any>(CLOSED);
    const launcher = createSnapshotStore<string | null>(null);
    const notices = createSnapshotStore<any>(null);
    let commands: any[] | null = null;
    let commandRequest: Promise<any[]> | null = null;
    let hit: any = null;
    let dismissed = '';
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let launchSpan: any = null;
    let pending = false;
    let noticeSeq = 0;
    const notify = (error: any) => notices.set({ level: 'error', seq: ++noticeSeq, text: String(error.message ?? error) });
    const close = () => {
      generation += 1;
      clearTimeout(timer);
      menu.set(CLOSED);
      launcher.set(null);
      launchSpan = null;
    };
    const dismiss = () => { dismissed = hit?.key ?? ''; close(); };
    const requestCommands = () => {
      if (commands !== null) return Promise.resolve(commands);
      if (commandRequest === null) commandRequest = latest.current.request('commands', {}).then((result: any) => {
        commands = result.commands ?? [];
        return commands!;
      }).finally(() => { commandRequest = null; });
      return commandRequest;
    };
    const updateInput = () => {
      const projection = runtime.projection;
      const command = projection.command;
      const name = command?.token.trim().replace(/^\//u, '');
      const definition = commands?.find(item => item.name === name);
      input.set({ ...input.getSnapshot(), draft: projection.clipboardText,
        phase: pending ? 'submitting' : command ? 'claimed' : 'plain',
        claim: command ? { name, token: command.token, hint: definition?.input?.hint } : undefined,
      });
    };
    const publish = (nextHit: any, candidates: any[], loading: boolean) => {
      if (disposed || hit?.key !== nextHit.key) return;
      const source = nextHit.mode === 'command' ? 'command' : 'file';
      const items = candidates.map(candidate => nextHit.mode === 'command'
        ? { name: '/' + candidate.name, description: candidate.description, candidate }
        : { name: candidate.path ?? candidate.name, label: candidate.name ?? candidate.path,
          icon: String(candidate.path ?? '').endsWith('/') ? 'folder' : 'file', candidate });
      menu.set({ open: true, groups: [{ source, status: loading ? 'pending' : 'ready',
        showGroupTitle: source === 'command', items }],
        highlight: items.length ? { source, index: 0 } : null });
    };
    const discover = (nextHit: any) => {
      hit = nextHit;
      const ticket = ++generation;
      clearTimeout(timer);
      publish(nextHit, [], true);
      if (nextHit.mode === 'command') {
        void requestCommands().then(items => {
          if (ticket !== generation) return;
          const query = nextHit.query.toLowerCase();
          publish(nextHit, items.filter(item => String(item.name).toLowerCase().includes(query)).slice(0, 40), false);
        }).catch(error => { if (ticket === generation) { close(); notify(error); } });
        return;
      }
      timer = setTimeout(() => {
        void latest.current.request('file-references', { query: nextHit.query }).catch(() => ({ candidates: [] }))
          .then((result: any) => result.candidates?.length ? result
            : latest.current.request('files', { query: nextHit.query }))
          .then((result: any) => { if (ticket === generation) publish(nextHit, result.candidates ?? [], false); })
          .catch(error => { if (ticket === generation) { close(); notify(error); } });
      }, 140);
    };
    const track = () => {
      const projection = runtime.projection;
      const caret = projection.caret;
      if (caret === null) { close(); hit = null; return; }
      const before = projection.detectText.slice(0, caret);
      const match = /(^|\s)([@/])([^\s@/]*)$/u.exec(before);
      let next: any;
      if (match) next = { mode: match[2] === '/' ? 'command' : 'file', query: match[3],
        span: { start: caret - match[3].length - 1, end: caret } };
      else if (launchSpan !== null && caret >= launchSpan.start) next = { mode: 'command',
        query: projection.detectText.slice(launchSpan.start, caret), span: { start: launchSpan.start, end: caret } };
      else { close(); hit = null; return; }
      next.key = `${next.mode}:${next.span.start}:${next.span.end}:${next.query}`;
      if (next.key === hit?.key || next.key === dismissed) return;
      discover(next);
    };
    const runtime = new DraftEditorRuntime({
      onUpdate: () => { runtime.refreshProjection(); updateInput(); track(); },
      quoteLabels: () => ({ remove: tConversation('quote.remove') }),
      openReference: () => false, lexicon: () => EMPTY_LEXICON, resolveLexicon: () => undefined,
    });
    const pick = (_source: string, index: number) => {
      const group = menu.getSnapshot().groups[0];
      const candidate = group?.items[index]?.candidate;
      const selected = hit;
      if (!candidate || !selected) return;
      close();
      hit = null;
      if (selected.mode === 'command') {
        runtime.insertCommand(selected.span, { name: candidate.name, token: `/${candidate.name} `,
          hint: candidate.input?.hint, attachments: false, submit: async () => undefined }, ' ');
      } else {
        const path = String(candidate.path ?? candidate.name);
        runtime.insertReference(selected.span, { source: 'file', ref: `@${path}`,
          label: candidate.name ?? path.split('/').pop() ?? path,
          appearance: path.endsWith('/') ? 'folder' : 'file', clipboardText: `@${path}` }, ' ');
      }
    };
    const keyboard = {
      editor: runtime.editor,
      get snapshot() { return input.getSnapshot(); },
      submit: async (mode: string) => {
        if (pending || latest.current.disabled) return;
        runtime.refreshProjection();
        const text = runtime.projection.clipboardText.trim();
        if (!text) return;
        close();
        pending = true;
        updateInput();
        try {
          const accepted = await latest.current.onSend(text, mode);
          if (accepted !== false && !disposed) runtime.setDraft('');
        } catch (error) { if (!disposed) notify(error); }
        finally { pending = false; if (!disposed) updateInput(); }
      },
      steerQueue: () => {},
      paste: (text: string) => runtime.paste(text),
      caretSpan: () => runtime.caretSpan(),
      arbitrate: (key: string, composing: boolean) => {
        const state = menu.getSnapshot();
        if (!state.open || composing) return 'pass';
        if (key === 'escape' || key === 'tabBack') { dismiss(); return 'consumed'; }
        const count = state.groups[0]?.items.length ?? 0;
        if (key === 'up' || key === 'down') {
          if (count) menu.set({ ...state, highlight: { source: state.groups[0].source,
            index: ((state.highlight?.index ?? 0) + (key === 'down' ? 1 : -1) + count) % count } });
          return 'consumed';
        }
        if (key === 'enter' || key === 'tab') {
          if (count) pick(state.groups[0].source, state.highlight?.index ?? 0);
          return 'consumed';
        }
        return 'pass';
      },
      space: () => false,
      dismissPopup: dismiss,
      bindFilePicker: () => () => {},
    };
    return { runtime, input, menu, launcher, notices, keyboard, pick, dismiss,
      activate: () => { disposed = false; },
      dispose: () => { disposed = true; close(); },
      toggleCommandMenu: (selection: any) => {
        if (launcher.getSnapshot() === 'command') { dismiss(); return; }
        launchSpan = selection;
        launcher.set('command');
        const next = { mode: 'command', query: '', span: selection,
          key: `launcher:${selection.start}:${selection.end}` };
        dismissed = '';
        discover(next);
      },
    };
  }, []);
  React.useLayoutEffect(() => {
    controller.activate();
    const off = controller.runtime.register();
    return () => { controller.dispose(); off(); };
  }, [controller]);
  const session = { running: props.running === true, removed: false, subagent: null, promptError: null };
  const useProjection = (key: string, selector?: any) => {
    const value = key === 'goal' ? props.goal : undefined;
    return selector ? selector(value) : value;
  };
  const renderSlot = (name: string, owner: any) => {
    if (name === 'conversation.input.model') return <RemoteModelSelect owner={owner} remote={props} />;
    if (name === 'conversation.input.permission') return <RemotePermissionSelect owner={owner} remote={props} />;
    if (name === 'conversation.input.overlay') return <MenuView menu={controller.menu} headers={EMPTY_HEADERS}
      onPick={controller.pick} onCrumb={() => {}} onDismiss={controller.dismiss}
      onHover={(source: string, index: number) => controller.menu.set({ ...controller.menu.getSnapshot(), highlight: { source, index } })}
      t={tMenu as any} />;
    return null;
  };
  return <InputBar {...{
    sessionId: props.sessionId, variant: props.variant ?? 'composer', disabled: props.disabled,
    placeholder: props.placeholder, useSession: (selector: any) => selector(session),
    useInput: (selector: any) => useStore(controller.input, selector),
    inputActions: { pruneAttachments: () => {} }, keyboard: controller.keyboard,
    useBusyEnter: (selector: any) => selector('steer'),
    useFileUploads: (selector: any) => selector(EMPTY_UPLOADS),
    useNotices: (selector: any) => useStore(controller.notices, selector),
    useLexicon: (selector: any) => selector(EMPTY_LEXICON),
    useMenuLauncher: (selector: any) => useStore(controller.launcher, selector),
    useStopShortcut: (selector: any) => selector(EMPTY_KEYS),
    useAccess: (action: string) => action === 'fileUploads/upload' ? false : true,
    useProjection, toggleCommandMenu: controller.toggleCommandMenu, stop: props.onCancel,
    renderSlot, t: tConversation,
  } as any} />;
}
