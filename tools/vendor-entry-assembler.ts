/**
 * Offline harness: drive the official Conversation assembler with raw relay
 * session events (the same events the official host folds), so the plugin can
 * render the official Chat snapshot without booting the whole Web shell.
 */
import { ConversationNodeAssembler } from '../vendor/.src/packages/client/ui-conversation/src/client/conversation/assembler.ts';
import { ConversationEventRegistry } from '../vendor/.src/packages/client/ui-conversation/src/client/conversation/event-registry.ts';
import { ConversationViewRegistry } from '../vendor/.src/packages/client/ui-conversation/src/client/conversation/view-registry.ts';
import { ConversationGroupRegistry } from '../vendor/.src/packages/client/ui-conversation/src/client/conversation/group-registry.ts';
import { registerMessageConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/message.ts';
import { registerAssistantConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/assistant.ts';
import { registerToolConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/tool.ts';
import { registerTurnProcess } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts';
import { registerTurnTailConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts';
import { registerCommandConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/command.ts';
import { registerCompactionConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/compaction.ts';
import { registerRetryConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/retry.ts';
import { registerTurnErrorConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts';
import { registerTurnMaxTokensConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/turn-max-tokens.ts';
import { registerUnknownConversationFallback } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/fallback.ts';
import { registerRequestPromptConversationNode } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts';
import { registerInboxConversationNodes } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/inbox.ts';
import { registerChatConversationView } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts';
import { processGroupDefinition } from '../vendor/.src/packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts';

/** Minimal ctx surface used by the Definition registries during registration. */
function fakeContext(): any {
  const ctx: any = {
    effect(run: () => unknown) {
      const disposer = run();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on() {
      return () => {};
    },
    get() {
      return undefined;
    },
    provide() {
      return () => {};
    },
  };
  return ctx;
}

export interface RawEvent {
  readonly seq: number;
  readonly type: string;
  readonly time: number;
  readonly data: Record<string, unknown>;
}

export interface ChatAssembler {
  /** Fold one complete contiguous event window. */
  replace(events: readonly RawEvent[]): void;
  /** Fold one appended live event. */
  append(event: RawEvent): void;
  /** The official Chat grouped snapshot for the current window. */
  snapshot(): unknown;
  /** Number of events currently folded. */
  readonly size: number;
}


/** Extract visible text from a Conversation content block list. */
function blocksText(content: unknown): { text: string; reasoning: string } {
  if (typeof content === 'string') return { text: content, reasoning: '' };
  if (!Array.isArray(content)) return { text: '', reasoning: '' };
  const texts: string[] = [];
  const reasoning: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const value = block as { type?: string; text?: unknown };
    if (typeof value.text !== 'string') continue;
    if (value.type === 'reasoning' || value.type === 'thinking') reasoning.push(value.text);
    else texts.push(value.text);
  }
  return { text: texts.join('\n'), reasoning: reasoning.join('\n') };
}

/** Human-readable activity detail from a tool call argument object. */
function activityDetail(args: unknown): string {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value.replace(/\s+/gu, ' ').trim().slice(0, 160);
    }
  }
  if (value && typeof value === 'object') {
    for (const field of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description', 'content']) {
      const candidate = (value as Record<string, unknown>)[field];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.replace(/\s+/gu, ' ').trim().slice(0, 160);
      }
    }
  }
  return '';
}

/**
 * Project an official Chat snapshot into the plugin's rendering rows.
 * The fold logic is the official Conversation assembler; only the final
 * row vocabulary differs, so the existing panel can render official data.
 * @param snapshot - official Chat grouped/target snapshot.
 * @returns ordered rows with roles user/context/reasoning/tool/assistant/system/turn-end.
 */
export function buildMessages(snapshot: any): any[] {
  const rows: any[] = [];
  const timeline = snapshot?.timeline;
  if (!timeline || !Array.isArray(timeline.turnOrder)) return rows;
  const order: readonly string[] = Array.isArray(snapshot.order) ? snapshot.order : [];
  const byTurn = new Map<number, any[]>();
  for (const key of order) {
    const node = snapshot.nodes?.get ? snapshot.nodes.get(key) : undefined;
    if (!node) continue;
    const turnNo = node.location?.turn?.turn ?? node.data?.turn ?? node.turn;
    if (typeof turnNo !== 'number') continue;
    const list = byTurn.get(turnNo) || [];
    const base = { seq: node.anchorSeq ?? node.seq ?? 0, at: node.time || 0, step: node.location?.step?.step };
    if (node.kind === 'user' || node.kind === 'steering' || node.kind === 'turn-trigger') {
      const { text } = blocksText(node.data?.content ?? node.data?.blocks ?? node.content);
      list.push({ ...base, role: 'user', text });
    } else if (node.kind === 'context') {
      const { text } = blocksText(node.data?.content ?? node.data?.blocks ?? node.content);
      list.push({ ...base, role: 'context', text });
    } else if (node.kind === 'assistant-step' || node.kind === 'assistant') {
      const data = node.data || {};
      const blocks = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data.content) ? data.content : [];
      const reasoning: string[] = [];
      const texts: string[] = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (typeof block.text !== 'string') continue;
        if (block.kind === 'reasoning' || block.type === 'reasoning' || block.kind === 'thinking') reasoning.push(block.text);
        else texts.push(block.text);
      }
      if (reasoning.length) list.push({ ...base, role: 'reasoning', text: reasoning.join('\n\n') });
      if (texts.length) list.push({ ...base, seq: base.seq + 0.5, role: 'assistant', text: texts.join('\n\n') });
    } else if (node.kind === 'tool-call') {
      const root = node.data?.root || node.data;
      if (root && (root.kind === 'tool-result' || root.callId || root.name)) {
        const argsRaw = root.call?.argsRaw;
        const contentText = typeof root.content === 'string' ? root.content : blocksText(root.content).text;
        list.push({
          ...base,
          role: 'tool',
          text: contentText,
          tool: {
            name: root.name || root.call?.name,
            callId: root.callId,
            isError: root.isError === true,
            done: root.settled !== false,
            args: typeof argsRaw === 'string' ? argsRaw : root.args === undefined ? undefined : JSON.stringify(root.args),
            detail: activityDetail(typeof argsRaw === 'string' ? argsRaw : root.args),
          },
        });
      }
    } else if (node.kind === 'tool-result') {
      list.push({
        ...base,
        role: 'tool',
        text: typeof node.content === 'string' ? node.content : blocksText(node.content).text,
        tool: {
          name: node.name,
          callId: node.callId,
          isError: node.isError === true,
          done: true,
          args: node.args === undefined ? undefined : JSON.stringify(node.args),
          detail: activityDetail(node.args),
        },
      });
    } else if (node.kind === 'turn-error' || node.kind === 'turn-max-tokens') {
      const { text } = blocksText(node.data?.content ?? node.content);
      list.push({ ...base, role: 'system', text: text || (node.kind === 'turn-error' ? '执行失败' : '达到输出上限') });
    }
    byTurn.set(turnNo, list);
  }

  for (const turnNo of timeline.turnOrder) {
    const turn = timeline.turns.get(turnNo);
    const timing = snapshot.legacy?.turnTimings?.get(turnNo);
    const endSeq = snapshot.legacy?.turnEnds?.get(turnNo);
    const reasonRaw = turn?.end?.data?.reason;
    const reasonKind = typeof reasonRaw === 'string' ? reasonRaw : reasonRaw && typeof reasonRaw === 'object' ? String(reasonRaw.kind || '') : '';
    const reason = reasonKind === 'error' ? 'error' : reasonKind === 'aborted' || reasonKind === 'interrupted' ? 'aborted' : 'ok';
    const rowsForTurn = byTurn.get(turnNo) || [];
    const sorted = [...rowsForTurn].sort((left, right) => left.seq - right.seq);
    rows.push(...sorted);
    const startTime = turn?.start?.time || (timing ? timing.startTime : 0);
    const endTime = turn?.end?.time || (timing ? timing.endTime : 0);
    const durationMs = startTime && endTime ? Math.max(0, endTime - startTime) : 0;
    rows.push({ seq: typeof endSeq === 'number' ? endSeq : turn?.end?.seq ?? 0, at: endTime || 0, role: 'turn-end', turn: turnNo, durationMs, reason });
  }
  return rows;
}

/**
 * Create a Chat assembler bound to the official ui-chat node definitions.
 * @returns assembler facade over the vendored Conversation tree.
 */
export function createChatAssembler(): ChatAssembler {
  const ctx = fakeContext();
  const events = new ConversationEventRegistry(ctx);
  const views = new ConversationViewRegistry(ctx);
  const groups = new ConversationGroupRegistry(ctx, views);
  // Unknown registry methods (request-prompt inspection, user-text rules, ...)
  // are presentation-only: returning undefined keeps the fold deterministic.
  const uiConversation: any = new Proxy(
    {
      events,
      views,
      groups,
      // Presentation-only inspectors: the remote transcript has no system
      // prompt cards, so the fold gets a minimal well-formed inspection.
      inspectRequestPrompt: () => ({ change: undefined, prompt: { system: '', tools: [] } }),
      inspectSystemPrompt: () => ({ introduced: undefined, effective: undefined, update: undefined }),
    },
    {
      get(target: any, key: string) {
        if (key in target) return target[key];
        return () => undefined;
      },
    },
  );
  Object.assign(ctx, { uiConversation });
  registerInboxConversationNodes(ctx);
  registerMessageConversationNode(ctx);
  registerRequestPromptConversationNode(ctx);
  registerAssistantConversationNode(ctx);
  registerTurnProcess(ctx);
  registerToolConversationNode(ctx);
  registerCommandConversationNode(ctx);
  registerCompactionConversationNode(ctx);
  registerRetryConversationNode(ctx);
  registerTurnErrorConversationNode(ctx);
  registerTurnMaxTokensConversationNode(ctx);
  registerTurnTailConversationNode(ctx);
  registerUnknownConversationFallback(ctx);
  registerChatConversationView(ctx);
  groups.register(processGroupDefinition);

  const assembler = new ConversationNodeAssembler(events, views, groups);
  let size = 0;
  const wrap = (event: RawEvent) => ({ type: 'event' as const, event: { ...event } });

  return {
    get size() {
      return size;
    },
    replace(window) {
      const entries = window.map(wrap);
      size = entries.length;
      (assembler as unknown as { activateTarget(target: string): boolean }).activateTarget('chat');
      assembler.replaceWindow(entries, false);
      const flusher = assembler as unknown as { flush(): boolean };
      for (let round = 0; round < 8 && flusher.flush(); round += 1) {
        /* drain dirty contexts until the snapshot settles */
      }
    },
    append(event) {
      size += 1;
      assembler.append(wrap(event));
    },
    messages() {
      const snapshot = (assembler as unknown as { snapshot(target: string): unknown }).snapshot('chat');
      return buildMessages(snapshot);
    },
    chatSnapshot() {
      const chat = (assembler as unknown as { snapshot(target: string): unknown }).snapshot('chat');
      return chat;
    },
    snapshot() {
      const grouped = (assembler as unknown as { grouped(target: string): unknown }).grouped('chat');
      return grouped;
    },
  };
}

export { ConversationNodeAssembler, ConversationEventRegistry, ConversationViewRegistry, ConversationGroupRegistry };
