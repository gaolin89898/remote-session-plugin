/** Minimal `shiki` shim: no syntax highlighting, still renders code text. */
const escapeHtml = (text: string): string =>
  String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

export function createCssVariablesTheme(options: Record<string, unknown> = {}) {
  return { name: 'dsh-vendor-shim', type: 'css', ...options };
}

export function createHighlighterCoreSync() {
  const highlighter = {
    codeToHtml(code: string) {
      return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
    },
    codeToTokens(code: string) {
      return { tokens: [[{ content: String(code), color: undefined }]] };
    },
    getLoadedLanguages: () => [],
    getLoadedThemes: () => [],
    loadLanguage: async () => {},
    loadTheme: async () => {},
    setTheme: () => {},
    dispose: () => {},
  };
  return highlighter;
}

export function createHighlighterCore() {
  return Promise.resolve(createHighlighterCoreSync());
}

export function createJavaScriptRegexEngine() {
  return { createRegExp: () => ({}) };
}

export function defaultJavaScriptRegexConstructor(pattern: string) {
  return new RegExp(pattern);
}

export const bundledLanguages = {};
export const bundledThemes = {};

/** Lazy language modules import this default; an empty grammar list is a safe no-op. */
export default [];
