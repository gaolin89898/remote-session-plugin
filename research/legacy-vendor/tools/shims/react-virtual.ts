/** Minimal @tanstack/react-virtual shim: non-virtualized fallback. */
export function useVirtualizer(options: { count?: number } = {}) {
  const count = options.count || 0;
  return {
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 40, size: 40 })),
    getTotalSize: () => count * 40,
    measureElement: () => 0,
    scrollToIndex: () => {},
    measure: () => {},
  };
}
export function useWindowVirtualizer(options: { count?: number } = {}) {
  return useVirtualizer(options);
}

/** Small compatibility surface used by the official turn rail. */
export function defaultRangeExtractor(range: { startIndex?: number; endIndex?: number; count?: number }) {
  const start = Math.max(0, range.startIndex ?? 0);
  const end = Math.min(Math.max(0, (range.count ?? 0) - 1), range.endIndex ?? -1);
  return end < start ? [] : Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function elementScroll(offset: number, _options: unknown, instance: { scrollElement?: { scrollTo?: (options: { top: number; behavior?: string }) => void } | null }) {
  instance.scrollElement?.scrollTo?.({ top: offset });
}

export function observeElementOffset(instance: { scrollElement?: { scrollTop?: number; addEventListener?: Function; removeEventListener?: Function } | null }, notify: (offset: number, scrolling: boolean) => void) {
  const element = instance.scrollElement;
  if (!element) return () => {};
  const onScroll = () => notify(Number(element.scrollTop || 0), true);
  element.addEventListener?.('scroll', onScroll, { passive: true });
  notify(Number(element.scrollTop || 0), false);
  return () => element.removeEventListener?.('scroll', onScroll);
}

export default { useVirtualizer, useWindowVirtualizer, defaultRangeExtractor, elementScroll, observeElementOffset };
