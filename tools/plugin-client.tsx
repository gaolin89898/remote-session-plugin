import { apply as applyRemoteSession, name, inject } from './machine-client';
import { apply as applyToolbox } from './toolbox-client';

// One plugin bundle serves both halves so a device only installs and upgrades
// once; machine switching carries the toolbox page to the selected machine.
export { name };
export const inject = [...new Set([...inject, 'layout'])];

export function apply(ctx: any) {
  applyRemoteSession(ctx);
  applyToolbox(ctx);
}
