/**
 * Render the vendored official ChatFlow with plugin-provided data.
 *
 * The official chat tree is written against the shell's slot renderer and
 * Session services. This module supplies a thin adapter: one official Chat
 * snapshot (built by the vendored Conversation assembler) becomes the data
 * source, the official node renderers are dispatched directly, and slots the
 * remote session cannot serve (turn tail actions, fork, images) degrade to
 * null instead of throwing.
 */
import React from 'react';
import { ChatFlow } from '../vendor/.src/packages/client/ui-chat/src/client/chat/ChatFlow.tsx';
import { UserMessageNodeView, ContextMessageNodeView, CompactionNodeView, RetryNodeView, TurnErrorNodeView, TurnMaxTokensNodeView, UnknownNodeView } from '../vendor/.src/packages/client/ui-chat/src/client/chat/MessageItem.tsx';
import { AssistantNodeView } from '../vendor/.src/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx';
import { TurnProcessNodeView } from '../vendor/.src/packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx';
import { TurnTailNodeView } from '../vendor/.src/packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx';
import { TurnTriggerNodeView } from '../vendor/.src/packages/client/ui-chat/src/client/chat/TurnTriggerNodeView.tsx';
import { SystemPromptNodeView } from '../vendor/.src/packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx';
import { CommandNodeView, ManualCompactionNodeView } from '../vendor/.src/packages/client/ui-chat/src/client/chat/CommandNodeView.tsx';
import { DefaultReasoningBody, ReasoningContent } from '../vendor/.src/packages/client/ui-chat/src/client/chat/ReasoningContent.tsx';
import { UserContent } from '../vendor/.src/packages/client/ui-chat/src/client/chat/UserContent.tsx';
import { ToolCallTree } from '../vendor/.src/packages/client/ui-tool/src/client/tool/ToolCallTree.tsx';
import { MessageImages, MessageImagesContent } from '../vendor/.src/packages/client/ui-attachment/src/client/MessageImages.tsx';
import { MarkdownDelegateProvider } from '../vendor/.src/packages/client/ui-primitives/src/markdown/MarkdownDelegate.tsx';
import chatViewCss from '../vendor/.src/packages/client/ui-chat/src/client/chat/ChatView.module.css';
import { isVisibleChatNode } from '../vendor/.src/packages/client/ui-chat/src/client/contract/chat-visibility.ts';
import { relativeTime } from '../vendor/.src/packages/client/ui-primitives/src/relative-time.ts';
import { ICON_SYMBOLS } from '../vendor/.src/packages/client/ui-primitives/src/icons/artwork.ts';
import turnNavigatorCss from '../vendor/.src/packages/client/ui-chat/src/client/chat/TurnNavigator.module.css';
import { FeedbackDialog } from '../vendor/.src/packages/client/ui-message-feedback/src/client/FeedbackDialog.tsx';
import { zh as feedbackZh } from '../vendor/.src/packages/client/ui-message-feedback/src/client/locales.ts';
import { GoalBar } from '../vendor/.src/packages/client/ui-goal/src/client/GoalBar.tsx';
import { zh as goalZh } from '../vendor/.src/packages/client/ui-goal/src/client/locales.ts';
import rowsCss from '../vendor/.src/packages/client/ui-workspace/src/client/rows/Rows.module.css';
import browserCss from '../vendor/.src/packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.module.css';
import {
  IconCloseFillRegular,
  IconChevronDownOutlineRegular,
  IconDataOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconNewChatOutlineRegular,
  IconPlusOutlineMedium,
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconTriangleRightFillRegular,
  StateDot,
} from '../vendor/.src/packages/client/ui-primitives/src/index.ts';
import {
  PermissionIconAutoReviewRegular,
  PermissionIconFullAccessRegular,
  PermissionIconReadOnlyRegular,
  PermissionIconWorkspaceWriteRegular,
} from '../vendor/.src/packages/client/ui-primitives/src/index.ts';
import { zh as chatZh } from '../vendor/.src/packages/client/ui-chat/src/client/locale.ts';
import { zh as conversationZh } from '../vendor/.src/packages/client/ui-conversation/src/client/locales.ts';
import inputBarCss from '../vendor/.src/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css';
import permissionSelectCss from '../vendor/.src/packages/client/ui-permission-presets/src/client/PermissionSelect.module.css';
import modelSelectCss from '../vendor/.src/packages/client/ui-model-selection/src/client/ModelSelect.module.css';
export { observeControlRow as observeVendorComposerRow } from '../vendor/.src/packages/client/ui-conversation/src/client/skeleton/control-row-layout.ts';
import conversationRootCss from '../vendor/.src/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css';
import { HeroShell } from '../vendor/.src/packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx';

const DICTIONARY: Record<string, string> = { ...conversationZh, ...chatZh };
/** Official InputBar module classes shared with the remote-session composer shell. */
export const VendorInputBarStyles = inputBarCss as Record<string, string>;
export const VendorPermissionSelectStyles = permissionSelectCss as Record<string, string>;
export const VendorModelSelectStyles = modelSelectCss as Record<string, string>;

export function VendorComposerChevron(props: { className?: string }) {
  return React.createElement(IconChevronDownOutlineRegular, props);
}

export function VendorComposerModelIcon(props: { className?: string }) {
  return React.createElement(IconDataOutlineRegular, { ...props, size: 16 });
}

/** Official add/control glyph used by InputBar. */
export function VendorComposerAddIcon() {
  return React.createElement(IconPlusOutlineMedium, { size: 14 });
}

function translate(key: string, vars?: Record<string, unknown>): string {
  const template = DICTIONARY[key];
  if (typeof template !== 'string') return key;
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name) => (name in vars ? String(vars[name]) : match));
}

const NODE_RENDERERS: Record<string, any> = {
  user: UserMessageNodeView,
  steering: UserMessageNodeView,
  context: ContextMessageNodeView,
  'turn-trigger': TurnTriggerNodeView,
  'system-prompt': SystemPromptNodeView,
  'assistant-step': AssistantNodeView,
  'tool-call': ToolCallTree,
  command: CommandNodeView,
  'manual-compaction': ManualCompactionNodeView,
  compaction: CompactionNodeView,
  retry: RetryNodeView,
  'turn-error': TurnErrorNodeView,
  'turn-max-tokens': TurnMaxTokensNodeView,
  'turn-process': TurnProcessNodeView,
  'turn-tail': TurnTailNodeView,
  unknown: UnknownNodeView,
};

const EMPTY_SNAPSHOT = {
  order: [],
  nodes: { get: () => undefined, values: () => [], source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
  locations: { getTurn: () => [], getStep: () => [] },
  navigation: { items: () => [] },
  timeline: { turns: new Map(), turnOrder: [], steps: new Map() },
  legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
};

/** Build the hook-shaped props the official ChatFlow reads. */
/** First text block of one chat node, for injected-reminder detection. */
function nodeTextStartsWith(node: any, prefix: string): boolean {
  const data = node && node.data ? node.data : {};
  const content = Array.isArray(data.content) ? data.content : Array.isArray(data.blocks) ? data.blocks : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text !== 'string') continue;
    return block.text.trim().toLowerCase().startsWith(prefix);
  }
  return false;
}

function createFlowHooks(snapshot: any, options: any) {
  const chatSnapshot = snapshot || EMPTY_SNAPSHOT;
  const nodeStore = chatSnapshot.nodes;
  const presentationState = {
    foldCompletedTurns: true,
    foldedReplies: 'all',
    mode: 'transcript',
    collapseTiming: 'next-input',
    ...(options.presentation || {}),
  };
  // Turn-process disclosure store: a real React state container so clicking a
  // folded Turn expands it (official store semantics, plugin-owned).
  const storeState = React.useState<any[]>([]);
  const turnProcesses = storeState[0];
  const setTurnProcesses = storeState[1];
  const chatStore = {
    getSnapshot: () => ({ turnProcesses }),
    subscribe: () => () => {},
  };
  const useChat = (selector: any) => selector(chatSnapshot);
  const useSession = (selector: any) => selector({ running: options.running === true, openState: 'open', openError: undefined, hasMore: false, loadingOlder: false });
  const useChatNode = (key: string, selector?: any) => {
    const node = nodeStore && key ? nodeStore.get(key) : undefined;
    return typeof selector === 'function' ? selector(node) : node;
  };
  const useChatNodeBottom = (key: string, selector?: any) => {
    let value = false;
    try {
      const source = nodeStore && nodeStore.bottomSource ? nodeStore.bottomSource(key) : undefined;
      value = source && source.getSnapshot ? source.getSnapshot() === true : false;
    } catch (error) {
      value = false;
    }
    return typeof selector === 'function' ? selector(value) : value;
  };
  const processSpecFor = (key: string) => {
    const node = nodeStore && key ? nodeStore.get(key) : undefined;
    if (!node) return undefined;
    const turn = node.location && node.location.kind !== 'turn' ? node.location.turn : node.location?.turn;
    const turnNo = turn && typeof turn.turn === 'number' ? turn.turn : node.anchorSeq;
    return {
      turn: turnNo,
      answerStep: node.data && typeof node.data.step === 'number' ? node.data.step : 1,
      processStartSeq: 0,
      answerAnchorSeq: null,
      inlineReasoning: false,
    };
  };
  const useChatNodeProcess = (key: string, selector?: any) => {
    const spec = processSpecFor(key);
    if (!spec) return typeof selector === 'function' ? selector(undefined) : undefined;
    const value = {
      turn: spec.turn,
      spec,
      turnStarted: true,
      turnClosed: options.running !== true,
      hasExternalProcess: true,
      hasNonReplyProcess: true,
      hasInterleavedInput: false,
    };
    return typeof selector === 'function' ? selector(value) : value;
  };
  const useChatGroup = (key: string, selector: any) => {
    const source = options.groupSources && options.groupSources.get ? options.groupSources.get(key) : undefined;
    const group = source && source.getSnapshot ? source.getSnapshot() : undefined;
    return typeof selector === 'function' ? selector(group) : group;
  };
  const usePresentation = (selector: any) => selector(presentationState);
  const useConnectionState = (selector: any) => selector(options.connectionState || 'connected');
  const useStore = (selector: any) => selector(chatStore.getSnapshot());
  const setTurnProcessOpen = (turn: number, answerStep: number, open: boolean) => {
    setTurnProcesses(function (current: any[]) {
      const index = current.findIndex((entry) => entry.turn === turn);
      const next = open ? { turn, answerStep } : { turn, answerStep, collapsed: true };
      if (index < 0) return current.concat([next]);
      const copy = current.slice();
      copy[index] = next;
      return copy;
    });
  };
  const useGroupAction = (_hidden?: boolean, _reveal?: () => void) => ({ current: null });
  const useGroupHeaderAction = (_ref?: unknown, _hidden?: boolean) => {};
  const useAccess = (permission: string) => (typeof options.useAccess === 'function' ? options.useAccess(permission) : false);
  const usePerformanceUsage = (selector: any) => selector('simple');
  const useDisclosure = () => ({
    // The smoke harness can opt into open cards to exercise DiffBlock bodies;
    // the production transcript keeps the official collapsed default.
    expanded: options.openDisclosures === true,
    setExpanded: () => {},
    toggle: () => {},
  });
  const useTurnData = () => undefined;
  const useHostInfo = (selector: any) => selector({ home: '~' });

  const dispatchNode = (props: any, opts: any) => {
    // The official ChatView hides system prompts, plain Context, and the
    // permission command; keep that visibility rule when rendering standalone.
    const node = props && props.node;
    if (node && typeof node === 'object' && isVisibleChatNode(node) === false) return null;
    // Hindsight memory reminders are injected user-role messages; the panel
    // keeps them out of the transcript surface.
    if (node && nodeTextStartsWith(node, '<hindsight_')) return null;
    const renderer = NODE_RENDERERS[opts && opts.entryKey];
    if (!renderer) return opts && opts.fallback ? opts.fallback : null;
    return React.createElement(renderer, {
      ...props,
      t: translate,
      renderFactorySlot: factoryImpl,
      renderSlot: renderSlotImpl,
      useDisclosure,
      useGroupAction,
      useTurnData,
      usePresentation,
      useAccess,
      useChat,
      usePerformanceUsage,
      useHostInfo,
    });
  };
  const factoryImpl = (name: string, props: any, opts: any) => {
    if (name === 'conversation.chat.user.content') {
      return React.createElement(UserContent, { ...props, t: translate, renderSlot: renderSlotImpl, renderFactorySlot: factoryImpl });
    }
    if (name === 'conversation.chat.reasoning.content') {
      return React.createElement(ReasoningContent, { ...props, t: translate, renderFactorySlot: factoryImpl });
    }
    if (name === 'conversation.images.content') {
      return React.createElement(MessageImagesContent, { ...props, t: translate });
    }
    if (name === 'conversation.user.text') {
      return React.createElement('span', null, String(props.text || ''));
    }
    return null;
  };
  const renderSlotImpl = (name: string, props: any, opts: any) => {
    if (name === 'conversation.chat.node') return dispatchNode(props, opts);
    if (name === 'conversation.chat.reasoning.body') return React.createElement(DefaultReasoningBody, { ...props, t: translate, renderFactorySlot: factoryImpl });
    if (name === 'conversation.chat.reasoning.content') return React.createElement(ReasoningContent, { ...props, t: translate });
    if (name === 'conversation.chat.assistant-actions') {
      return options && typeof options.renderAssistantActions === 'function'
        ? options.renderAssistantActions(props && props.messageId)
        : null;
    }
    if (name === 'conversation.chat.user.images' || name === 'conversation.chat.message.images') {
      return React.createElement(MessageImages, { ...props, renderFactorySlot: factoryImpl });
    }
    return opts && opts.fallback ? opts.fallback : null;
  };

  return {
    hooks: { useChat, useSession, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation, useConnectionState, useStore, useGroupAction, useGroupHeaderAction, useAccess, usePerformanceUsage, useDisclosure, useTurnData },
    renderSlot: renderSlotImpl,
    renderFactorySlot: factoryImpl,
    t: translate,
    actions: { setTurnProcessOpen: () => {} },
  };
}

/**
 * Render the official Chat flow for one assembled snapshot.
 * @param props - snapshot, entries, group sources, running flag, locale and path hooks.
 * @returns the official Flow element tree.
 */
export function VendorChatFlow(props: any) {
  const hooks = createFlowHooks(props.snapshot, props);
  const entries = props.entries || (props.snapshot && props.snapshot.order ? props.snapshot.order.map((key: string) => ({ kind: 'node', key })) : []);
  const openExternal = (href: string) => {
    try {
      if (typeof props.openExternalLink === 'function') return props.openExternalLink(href);
      if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(href, '_blank', 'noopener');
    } catch {
      /* popup blocked */
    }
  };
  const flow = React.createElement(ChatFlow, {
    entries,
    pendingInputs: [],
    lastInputTurn: undefined,
    deferCollapse: false,
    cwd: props.cwd,
    openFile: props.openFile || (() => {}),
    inspectCall: props.inspectCall,
    forkAt: props.forkAt || (() => {}),
    loadImage: props.loadImage || (async () => ({})),
    fileMentions: props.fileMentions,
    ...hooks.hooks,
    renderSlot: hooks.renderSlot,
    renderFactorySlot: hooks.renderFactorySlot,
    t: hooks.t,
    actions: hooks.actions,
  });
  return React.createElement(
    MarkdownDelegateProvider,
    {
      openFile: typeof props.openFile === 'function' ? props.openFile : undefined,
      openExternalLink: openExternal,
      fileImages: undefined,
    },
    flow,
  );
}


export { VendorComposer } from './remote-composer.tsx';

/**
 * Official conversation header chrome: the vendored ConversationRoot module
 * classes own the grid, crumb typography, and hairline border; the owner
 * supplies the title, a one-line subtitle, and trailing action nodes.
 * @param props - title/subtitle text, running flag, and action React nodes.
 * @returns the official header block.
 */
export function VendorSessionHeader(props: any) {
  const css = conversationRootCss as Record<string, string>;
  const actions = Array.isArray(props.actions) ? props.actions.filter(Boolean) : [];
  return React.createElement(
    'div',
    { className: css.header, 'data-conversation-header': '' },
    React.createElement(
      'div',
      { className: css.headerLeading },
      props.running
        ? React.createElement('span', {
            style: {
              width: 8,
              height: 8,
              borderRadius: 999,
              background: 'var(--dsw-alias-button-info-fill)',
              display: 'inline-block',
              flex: 'none',
            },
          })
        : null,
    ),
    React.createElement(
      'div',
      { className: css.titleRow },
      React.createElement(
        'div',
        { className: css.titleCluster },
        React.createElement(
          'nav',
          { className: css.crumbs, 'aria-label': '会话层级' },
          React.createElement(
            'span',
            { className: `${css.crumb} ${css.crumbCurrent}` },
            props.title || '',
          ),
        ),
        React.createElement(
          'div',
          { className: css.headerUtilities },
          props.subtitle
            ? React.createElement(
                'span',
                {
                  style: {
                    fontSize: 12,
                    lineHeight: '18px',
                    color: 'var(--dsw-alias-label-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                  title: props.subtitle,
                },
                props.subtitle,
              )
            : null,
        ),
        React.createElement('div', { className: css.headerActions }, actions),
      ),
    ),
    React.createElement('div', { className: css.headerCorner }),
  );
}



/**
 * Official blank-session hero chrome (fish, headline, preview badge) for a
 * remote Session that has no messages yet.
 * @param props - owner children rendered under the headline.
 * @returns the centered hero element.
 */
export function VendorHero(props: any) {
  const renderHeroSlot = (_name: string, _owner: any, options?: any) =>
    options && options.fallback !== undefined ? options.fallback : null;
  return React.createElement(HeroShell, { t: translate, renderSlot: renderHeroSlot, children: props.children });
}


/**
 * Official permission preset glyph for one preset value.
 * @param props - preset value rendered by the composer permission chip.
 * @returns the matching official permission icon, or null for unknown names.
 */
export function VendorPermissionIcon(props: any) {
  const value = String(props && props.value ? props.value : '');
  const size = typeof props?.size === 'number' ? props.size : 16;
  const icon =
    value === 'read-only' ? PermissionIconReadOnlyRegular
      : value === 'workspace-write' ? PermissionIconWorkspaceWriteRegular
        : value === 'danger-full-access' ? PermissionIconFullAccessRegular
          : value === 'auto' ? PermissionIconAutoReviewRegular
            : null;
  return icon === null ? null : React.createElement(icon, { size });
}


/**
 * Official transcript history loader, rendered above the conversation flow
 * while older events remain outside the loaded window.
 * @param props - loading flag and load callback.
 * @returns the official centered "load earlier" control.
 */
export function VendorLoadOlder(props: any) {
  return React.createElement(
    'div',
    { className: (chatViewCss as Record<string, string>).older },
    React.createElement(
      'button',
      { type: 'button', disabled: props.loading === true, onClick: props.onLoad },
      props.loading === true ? translate('loading') : translate('chat.loadOlder'),
    ),
  );
}


/** Translate one goal-namespace key with the official Chinese dictionary. */
function goalTranslate(key: string): string {
  const dictionary = goalZh as Record<string, string>;
  return dictionary[key] ?? key;
}

/**
 * Official goal strip docked above the composer (GoalBar).
 * @param props - goal snapshot plus pause/resume/edit/clear callbacks.
 * @returns the official goal dock, or null without a visible goal.
 */
export function VendorGoalBar(props: any) {
  return React.createElement(GoalBar, {
    goal: props.goal,
    onEdit: props.onEdit,
    onPause: props.onPause,
    onResume: props.onResume,
    onClear: props.onClear,
    t: goalTranslate,
  });
}


const sidebarCss = rowsCss as Record<string, string>;

const ICON_PARTS = new Map<string, { attrs: Record<string, string>; inner: string } | null>();

/** Parse one official sprite symbol into root attributes plus inner markup. */
function iconParts(id: string) {
  if (ICON_PARTS.has(id)) return ICON_PARTS.get(id);
  const markup = (ICON_SYMBOLS as Record<string, string>)[id];
  let parts: { attrs: Record<string, string>; inner: string } | null = null;
  if (typeof markup === 'string' && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const root = document.documentElement;
    if (root && root.tagName.toLowerCase() === 'svg') {
      const attrs: Record<string, string> = {};
      for (const attribute of Array.from(root.attributes)) {
        if (attribute.name === 'xmlns' || attribute.name === 'width' || attribute.name === 'height') continue;
        // React SVG props are camelCase; artwork attributes arrive kebab-case.
        const prop = attribute.name.replace(/-([a-z])/g, (_match: string, letter: string) => letter.toUpperCase());
        attrs[prop] = attribute.value;
      }
      const inner = Array.from(root.childNodes)
        .map((node) => new XMLSerializer().serializeToString(node))
        .join('');
      parts = { attrs, inner };
    }
  }
  ICON_PARTS.set(id, parts);
  return parts;
}

/**
 * Render one official product glyph inline from the vendored artwork, so panel
 * rows keep their icons even when the host document mounts no icon sprite.
 * @param props - sprite symbol id and pixel size.
 * @returns an inline svg or null for an unknown symbol.
 */
function InlineIcon(props: any) {
  const parts = iconParts(String(props.id || ''));
  if (!parts) return null;
  const size = typeof props.size === 'number' ? props.size : 16;
  return React.createElement('svg', {
    ...parts.attrs,
    width: size,
    height: size,
    className: props.className,
    'data-icon': props.id,
    'aria-hidden': 'true',
    dangerouslySetInnerHTML: { __html: parts.inner },
  });
}

/** Column-1 folder glyph for the official project row. */
function ProjectFolderIcon(props: any) {
  return React.createElement(InlineIcon, {
    id: props.open ? 'dsw-icon-folder-open-regular' : 'dsw-icon-folder-close-regular',
    size: 16,
  });
}

/** Official rotation arrow for the project row's hover chevron slot. */
function ProjectArrowIcon(props: any) {
  return React.createElement(InlineIcon, { id: 'dsw-icon-triangle-right-fill-regular', size: 12, className: props.className });
}

/**
 * Official Workspace sidebar project row (folder, hover chevron, title, and a
 * hover New-Session action) without the workspace menu/drag wiring.
 * @param props - label, expanded state, toggle, and optional create callback.
 * @returns the official project row element.
 */
export function VendorSidebarProjectRow(props: any) {
  const expanded = props.expanded === true;
  const folder = React.createElement(ProjectFolderIcon, { open: expanded });
  const arrowClassName = expanded ? `${sidebarCss.arrow} ${sidebarCss.arrowOpen}` : sidebarCss.arrow;
  return React.createElement(
    'div',
    {
      className: sidebarCss.projectRow,
      role: 'treeitem',
      'aria-expanded': expanded,
      title: props.title || props.label,
      onClick: props.onToggle,
      style: { opacity: props.online === false ? 0.55 : 1 },
    },
    React.createElement('span', { className: `${sidebarCss.slot} ${sidebarCss.folder}${props.active ? ` ${sidebarCss.folderActive}` : ''}` }, folder),
    React.createElement(
      'span',
      { className: `${sidebarCss.slot} ${sidebarCss.chevron}` },
      React.createElement(ProjectArrowIcon, { className: arrowClassName }),
    ),
    React.createElement(
      'span',
      { className: sidebarCss.projectText },
      React.createElement('span', { className: sidebarCss.title }, props.label),
    ),
    typeof props.onCreate === 'function'
      ? React.createElement(
          'span',
          { className: sidebarCss.rowActions, onClick: (event: any) => event.stopPropagation() },
          React.createElement(
            'button',
            {
              type: 'button',
              className: sidebarCss.iconButton,
              'aria-label': '新建会话',
              title: '在此工作区新建会话',
              onClick: props.onCreate,
            },
            React.createElement(IconNewChatOutlineRegular, { size: 16 }),
          ),
        )
      : null,
  );
}

/**
 * Official Workspace sidebar session row (status slot, title, trailing time).
 * @param props - title, selection/running flags, relative time, and click.
 * @returns the official session row element.
 */
export function VendorSidebarSessionRow(props: any) {
  const selected = props.selected === true;
  return React.createElement(
    'div',
    {
      className: selected ? `${sidebarCss.sessionRow} ${sidebarCss.selected}` : sidebarCss.sessionRow,
      role: 'treeitem',
      'aria-selected': selected,
      title: props.title,
      onClick: props.onClick,
      style: { opacity: props.online === false ? 0.55 : 1, '--dsh-workspace-indent': '12px' },
    },
    React.createElement(
      'span',
      { className: sidebarCss.slot },
      props.running ? React.createElement(StateDot, { state: 'ongoing' }) : null,
    ),
    React.createElement('span', { className: sidebarCss.title }, props.title),
    React.createElement(
      'span',
      { className: sidebarCss.rowResting },
      React.createElement('span', { className: sidebarCss.time }, props.time || ''),
    ),
  );
}


const browserStyles = browserCss as Record<string, string>;

/**
 * Official sidebar section header (label + tertiary meta), used for the peer
 * grouping line above its workspace rows.
 * @param props - label, meta text, expanded state, and toggle.
 * @returns the official-styled section header row.
 */
export function VendorSidebarSectionHeader(props: any) {
  const expanded = props.expanded !== false;
  const arrowClassName = expanded ? `${sidebarCss.arrow} ${sidebarCss.arrowOpen}` : sidebarCss.arrow;
  return React.createElement(
    'div',
    {
      className: browserStyles.sectionHeader,
      role: 'treeitem',
      'aria-expanded': expanded,
      onClick: props.onToggle,
      title: props.title,
      style: {
        justifyContent: 'flex-start',
        gap: 6,
        paddingLeft: 8,
        overflow: 'visible',
        cursor: 'pointer',
        opacity: props.dim ? 0.55 : 1,
      },
    },
    React.createElement(ProjectArrowIcon, { className: arrowClassName }),
    React.createElement(
      'span',
      { className: `${browserStyles.sectionLabel} ${browserStyles.wide}`, style: { maxWidth: 'none', flex: '1 1 auto' } },
      props.label,
    ),
    React.createElement(
      'span',
      {
        style: {
          flex: '0 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          lineHeight: '20px',
          opacity: 0.72,
        },
      },
      props.meta || '',
    ),
  );
}

/**
 * Official sidebar header action cluster (search, view options, new session).
 * @param props - create callback plus placeholders for the unsupported actions.
 * @returns the official icon-button cluster.
 */
export function VendorSidebarHeaderActions(props: any) {
  const button = (key: string, label: string, icon: any, onClick?: () => void, disabled?: boolean) =>
    React.createElement(
      'button',
      {
        key,
        type: 'button',
        className: browserStyles.iconButton,
        'aria-label': label,
        title: label,
        onClick,
        disabled,
        style: disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined,
      },
      icon,
    );
  return React.createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 2 } },
    button('search', '搜索会话', React.createElement(InlineIcon, { id: 'dsw-icon-search-outline-regular', size: 14 }), props.onSearch),
    button('view', '视图选项（暂未接入）', React.createElement(InlineIcon, { id: 'dsw-icon-sliders-two-outline-regular', size: 14 }), undefined, true),
    button('create', '新建会话', React.createElement(InlineIcon, { id: 'dsw-icon-project-add-outline-regular', size: 14 }), props.onCreate),
  );
}


/**
 * Official sidebar search pill (expanded state), including the clear control.
 * @param props - current query, change/close callbacks, and placeholder.
 * @returns the official search field.
 */
export function VendorSidebarSearchPill(props: any) {
  return React.createElement(
    'div',
    { className: `${browserStyles.search} ${browserStyles.searchExpanded}`, style: { width: '100%' } },
    React.createElement(
      'button',
      { type: 'button', className: browserStyles.searchButton, 'aria-label': '搜索会话' },
      React.createElement(InlineIcon, { id: 'dsw-icon-search-outline-regular', size: 11 }),
    ),
    React.createElement('input', {
      className: browserStyles.searchInput,
      type: 'text',
      autoFocus: true,
      placeholder: props.placeholder || '搜索会话…',
      value: props.value || '',
      onChange: (event: any) => {
        if (typeof props.onChange === 'function') props.onChange(event.target.value);
      },
      onKeyDown: (event: any) => {
        if (event.key !== 'Escape') return;
        if (typeof props.onChange === 'function') props.onChange('');
        if (typeof props.onClose === 'function') props.onClose();
      },
    }),
    React.createElement(
      'button',
      {
        type: 'button',
        className: browserStyles.clearButton,
        'aria-label': '清除搜索',
        onClick: () => {
          if (typeof props.onChange === 'function') props.onChange('');
          if (typeof props.onClose === 'function') props.onClose();
        },
      },
      React.createElement(InlineIcon, { id: 'dsw-icon-close-fill-regular', size: 12 }),
    ),
  );
}


/**
 * Official Workspace session overflow control ("展开其余 N 个会话" / "收起").
 * @param props - hidden count, expansion state, and toggle callback.
 * @returns the official overflow button.
 */
export function VendorSidebarOverflowButton(props: any) {
  const expanded = props.expanded === true;
  return React.createElement(
    'button',
    {
      type: 'button',
      className: browserStyles.sessionOverflowButton,
      'aria-expanded': expanded,
      onClick: props.onClick,
    },
    expanded ? '收起' : '展开其余 ' + String(props.hiddenCount || 0) + ' 个会话',
  );
}

/**
 * Official workspace dictionary relative time ("刚刚 / 5分钟 / 3小时 / 2天").
 * @param props - epoch ms of the row's update time.
 * @returns the compact localized distance.
 */
export function workspaceTimeLabel(props: any) {
  const at = Number(props.at) || 0;
  const now = Number(props.now) || Date.now();
  const bucket = relativeTime(at, now);
  if (bucket.unit === 'now') return '刚刚';
  const table: Record<string, string> = {
    minutes: '分钟',
    hours: '小时',
    days: '天',
    months: '个月',
    years: '年',
  };
  return String(bucket.n) + (table[bucket.unit] || '');
}


/** Translate one feedback-namespace key with the official Chinese dictionary. */
function feedbackTranslate(key: string, vars?: Record<string, unknown>): string {
  // 'submit' / 'submitting' / 'close' live in the shared locale namespace the
  // shell merges into every t() seat; standalone rendering supplies them here.
  const shared: Record<string, string> = { submit: '提交', submitting: '提交中…', close: '关闭' };
  const dictionary = { ...shared, ...(feedbackZh as Record<string, string>) };
  const template = dictionary[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(vars[name] ?? ''));
}

const FEEDBACK_CLOSED = { target: null, category: null, text: '', submitting: false, failure: null, toast: 0 } as any;

/** Minimal snapshot store matching the official FeedbackDialog store contract. */
class FeedbackDialogStore {
  snapshot: any = { ...FEEDBACK_CLOSED };
  listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  set(next: any) {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Per-session feedback dialog controller (the official dialog state machine),
 * submitting through the panel's message-feedback RPC.
 */
class FeedbackDialogController {
  state = new FeedbackDialogStore();
  private generation = 0;
  private toastSeq = 0;
  constructor(private readonly submit: (target: any, entry: any) => Promise<any>) {}

  open(target: any) {
    this.generation += 1;
    this.state.set({ ...FEEDBACK_CLOSED, target, toast: this.state.getSnapshot().toast });
  }

  dismiss() {
    this.generation += 1;
    this.state.set({ ...FEEDBACK_CLOSED, toast: this.state.getSnapshot().toast });
  }

  edit(draft: any) {
    const snapshot = this.state.getSnapshot();
    if (snapshot.target === null || snapshot.submitting) return;
    this.state.set({ ...snapshot, ...draft });
  }

  async submitDraft() {
    const snapshot = this.state.getSnapshot();
    if (snapshot.target === null || snapshot.submitting) return;
    const generation = this.generation;
    this.state.set({ ...snapshot, submitting: true, failure: null });
    const text = snapshot.text.trim();
    const entry = {
      ...(text.length === 0 ? {} : { text }),
      ...(snapshot.category === null ? {} : { category: snapshot.category }),
    };
    const result = await this.submit(snapshot.target, entry).catch((error: any) => ({
      ok: false,
      error: { code: 'gateway/internal', message: String((error && error.message) || error) },
    }));
    if (result && result.ok) {
      if (generation === this.generation) this.dismiss();
      this.toastSeq += 1;
      this.state.set({ ...this.state.getSnapshot(), toast: this.toastSeq });
      return;
    }
    if (generation !== this.generation) return;
    this.state.set({
      ...this.state.getSnapshot(),
      submitting: false,
      failure: result && result.error ? result.error.code : 'gateway/internal',
      toast: 0,
    });
  }

  dismissFailure() {
    this.state.set({ ...this.state.getSnapshot(), failure: null });
  }

  dismissToast(seq: number) {
    const snapshot = this.state.getSnapshot();
    if (snapshot.toast === seq) this.state.set({ ...snapshot, toast: 0 });
  }

  dispose() {
    this.generation += 1;
    this.state.set({ ...FEEDBACK_CLOSED, toast: 0 });
  }
}

/**
 * Create one feedback dialog controller for a panel session.
 * @param submit - maps a dialog target and draft entry to the panel's feedback RPC.
 * @returns the controller consumed by VendorFeedbackDialog.
 */
export function createFeedbackDialog(submit: any) {
  return new FeedbackDialogController(submit);
}

/**
 * Official message-feedback dialog (categories, detail note, toast) driven by a
 * panel-created controller.
 * @param props - the controller from createFeedbackDialog.
 * @returns the official dialog overlay.
 */
export function VendorFeedbackDialog(props: any) {
  const controller = props.controller;
  const useDialog = (selector: any) =>
    selector(
      React.useSyncExternalStore(
        controller.state.subscribe,
        controller.state.getSnapshot,
        controller.state.getSnapshot,
      ),
    );
  return React.createElement(FeedbackDialog, {
    useDialog,
    edit: (draft: any) => controller.edit(draft),
    submit: () => controller.submitDraft(),
    dismiss: () => controller.dismiss(),
    dismissFailure: () => controller.dismissFailure(),
    dismissToast: (seq: any) => controller.dismissToast(seq),
    t: feedbackTranslate,
  });
}


const turnRailCss = turnNavigatorCss as Record<string, string>;

/**
 * Official conversation turn rail (fixed-pitch marks at the transcript's right
 * edge, active tick, hover preview) for the standalone panel scroll container.
 * @param props - turns with previews, active turn, running turn, and navigation.
 * @returns the rail overlay.
 */
export function VendorTurnRail(props: any) {
  const items: any[] = Array.isArray(props.items) ? props.items : [];
  const activeTurn = typeof props.activeTurn === 'number' ? props.activeTurn : null;
  const runningTurn = typeof props.runningTurn === 'number' ? props.runningTurn : null;
  const [previewTurn, setPreviewTurn] = React.useState<number | null>(null);
  if (items.length < 2) return null;
  const markHeight = 10;
  const activeIndex = items.findIndex((item) => item.turn === activeTurn);
  const previewIndex = previewTurn === null ? -1 : items.findIndex((item) => item.turn === previewTurn);
  const preview = previewIndex >= 0 ? items[previewIndex] : null;
  return React.createElement(
    'div',
    { className: turnRailCss.slot, 'data-vendor-turn-rail': '' },
    React.createElement(
      'div',
      { className: turnRailCss.frame, style: { display: 'block' } },
      React.createElement(
        'div',
        { className: turnRailCss.scroller },
        React.createElement(
          'div',
          { className: turnRailCss.marks, style: { height: items.length * markHeight } },
          items.map((item: any, index: number) =>
            React.createElement('button', {
              key: item.turn,
              type: 'button',
              className: [
                turnRailCss.mark,
                idxEquals(activeIndex, index) ? turnRailCss.markActive : '',
                item.turn === runningTurn ? turnRailCss.markBusy : '',
              ].filter(Boolean).join(' '),
              style: { top: index * markHeight },
              'aria-label': '跳转到第 ' + item.turn + ' 轮',
              'aria-current': idxEquals(activeIndex, index) ? 'true' : undefined,
              onMouseEnter: () => setPreviewTurn(item.turn),
              onMouseLeave: () => setPreviewTurn(null),
              onFocus: () => setPreviewTurn(item.turn),
              onBlur: () => setPreviewTurn(null),
              onClick: () => {
                if (typeof props.onNavigate === 'function') props.onNavigate(item.turn);
              },
            }),
          ),
        ),
        preview
          ? React.createElement(
              'div',
              {
                className: turnRailCss.preview,
                style: { '--turn-preview-center': String((previewIndex + 0.5) * markHeight) + 'px' },
              },
              React.createElement('div', { className: turnRailCss.previewPrompt }, preview.prompt || '第 ' + preview.turn + ' 轮'),
              preview.response
                ? React.createElement('div', { className: turnRailCss.previewResponse }, preview.response)
                : null,
            )
          : null,
      ),
    ),
  );
}

/** Index comparison that keeps the active-mark expression readable. */
function idxEquals(expected: number, actual: number): boolean {
  return expected >= 0 && expected === actual;
}
