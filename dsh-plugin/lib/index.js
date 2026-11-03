import { createHandler, PREFIX } from './server.js';

export const name = 'dsh-workbuddy-accounts';
export const inject = ['webServer'];

export function apply(ctx, config = {}) {
  const handler = createHandler(config);
  // DSH matches the prefix itself or prefix + '/'; omit the trailing slash.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX.slice(0, -1), handler }),
    'workbuddy-accounts: frontend and local API bridge');
}
