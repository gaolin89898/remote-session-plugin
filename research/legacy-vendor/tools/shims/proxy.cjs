// Universal stand-in for third-party widget packages (syntax highlighters,
// virtualizers, chart libs). Any property access returns the same proxy, so
// vendored components can import arbitrary names without crashing.
function lazyProxy() {
  const target = function () {};
  return new Proxy(target, {
    get(_, key) {
      if (key === 'then') return undefined;
      if (key === '__esModule') return true;
      return proxy;
    },
    apply() {
      return proxy;
    },
    construct() {
      return proxy;
    },
  });
}
const proxy = lazyProxy();
module.exports = proxy;
module.exports.default = proxy;
