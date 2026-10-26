import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginSync, describeBundles, planPluginSync } from '../lib/plugin-sync.js';

const bundle = (name, overrides = {}) => ({ name, version: '1.0.0', enabled: true, installed: true,
  availability: 'profile', source: name + '@1.0.0', updatable: true, ...overrides });
const desired = rows => describeBundles(rows);
const applied = { changed: true, application: 'applied' };
const waitDone = async sync => { while (sync.active) await sync.active.task; };

test('inventory exports package facts without local paths, credentials, or settings', () => {
  const inventory = desired([bundle('local-plugin', { source: 'file:C:/private/project', config: { token: 'private' } })]);
  assert.equal(inventory[0].sourceKind, 'local');
  assert.doesNotMatch(JSON.stringify(inventory), /private|token|file:/);
  assert.equal(desired([bundle('git-plugin', { source: 'git-plugin@https://example.test/plugin.tgz' })])[0].sourceKind, 'local');
});

test('preview plans exact versions and activation while preserving built-in runtime versions and unrelated plugins', () => {
  const source = desired([
    bundle('new-plugin'), bundle('old-plugin', { version: '2.0.0' }), bundle('off-plugin', { enabled: false }),
    bundle('optional-plugin', { official: true, optional: true, availability: 'installation' }),
    bundle('local-plugin', { source: 'file:C:/private' }), bundle('dsh-remote-session', { source: 'file:C:/plugin' }),
    bundle('base', { availability: 'installation' }),
  ]);
  const target = desired([bundle('old-plugin'), bundle('off-plugin'), bundle('unrelated'),
    bundle('optional-plugin', { version: '0.9.0', enabled: false, official: true, optional: true, availability: 'installation' })]);
  const rows = planPluginSync(source, target);
  assert.deepEqual(rows.map(row => row.action), ['install', 'update', 'disable', 'enable', 'skip', 'skip', 'skip']);
  assert.equal(rows[0].version, '1.0.0');
  assert.equal(rows[1].version, '2.0.0');
  assert.equal(rows[3].version, undefined);
  assert.equal(rows.some(row => row.name === 'unrelated'), false);
  assert.throws(() => planPluginSync([{ ...source[0], name: '--config' }], []), /名称/);
  assert.throws(() => planPluginSync([{ ...source[0], version: 'file:/private' }], []), /版本/);
});

test('target serializes jobs, makes starts idempotent, reports failures separately, and retains restart requirements', async () => {
  const calls = [];
  let finish;
  const blocker = new Promise(resolve => { finish = resolve; });
  const manager = {
    listBundles: async () => [],
    installBundle: async (spec, options) => {
      calls.push({ spec, options });
      if (spec.startsWith('first@')) await blocker;
      return spec.startsWith('broken@') ? { application: 'failed', error: { code: 'incompatible-version' } }
        : { ...applied, application: 'restart-required' };
    },
  };
  const sync = new PluginSync({ get: () => manager });
  const input = { action: 'start', id: 'one', bundles: desired([bundle('first'), bundle('broken'), bundle('last', { enabled: false })]) };
  const started = await sync.dispatch('home', input);
  assert.equal(started.state, 'running');
  assert.equal((await sync.dispatch('home', input)).id, 'one');
  await assert.rejects(sync.dispatch('company', { action: 'status', id: 'one' }), /不存在/);
  await assert.rejects(sync.dispatch('home', { ...input, id: 'two' }), /正在运行/);
  finish(); await waitDone(sync);
  const result = await sync.dispatch('home', { action: 'status', id: 'one' });
  assert.equal(result.state, 'failed');
  assert.equal(result.restartRequired, true);
  assert.deepEqual(result.rows.map(row => row.state), ['done', 'failed', 'done']);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.enabled, false);
  assert.equal(calls[2].options.saveExact, true);
  await sync.dispose();
});

test('cancelling a current installation prevents the remaining plugins from being installed', async () => {
  let finish;
  let installs = 0;
  const manager = {
    listBundles: async () => [],
    installBundle: async () => { installs++; return new Promise(resolve => { finish = resolve; }); },
    cancelInstall: async () => { finish({ application: 'cancelled' }); },
  };
  const sync = new PluginSync({ get: () => manager });
  await sync.dispatch('home', { action: 'start', id: 'cancel', bundles: desired([bundle('first'), bundle('next')]) });
  await sync.dispatch('home', { action: 'cancel', id: 'cancel' });
  await waitDone(sync);
  const result = await sync.dispatch('home', { action: 'status', id: 'cancel' });
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(result.rows.map(row => row.state), ['cancelled', 'cancelled']);
  assert.equal(installs, 1);
  await sync.dispose();
});

test('a failed official update does not change activation and successful updates adopt the source activation', async () => {
  const activations = [];
  const manager = {
    listBundles: async () => [bundle('first'), bundle('broken')],
    updateBundle: async name => ({ result: name === 'broken' ? { application: 'failed', error: { code: 'operation-error' } } : applied }),
    setBundleEnabled: async (name, enabled) => { activations.push([name, enabled]); return applied; },
  };
  const sync = new PluginSync({ get: () => manager });
  await sync.dispatch('home', { action: 'start', id: 'update', bundles: desired([
    bundle('first', { version: '2.0.0', enabled: false }), bundle('broken', { version: '2.0.0' }),
  ]) });
  await waitDone(sync);
  assert.deepEqual(activations, [['first', false]]);
  await sync.dispose();
});
