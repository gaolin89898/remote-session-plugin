import { randomUUID } from 'node:crypto';

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const actionable = new Set(['install', 'update', 'enable', 'disable']);

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }

function registrySource(bundle) {
  if (!bundle.source || bundle.source === bundle.name) return true;
  const prefix = bundle.name + '@';
  return bundle.source.startsWith(prefix) && /^[0-9A-Za-z~^*<>=| .+-]+$/.test(bundle.source.slice(prefix.length));
}

/** Only portable package facts cross machines, never paths or plugin configuration. */
export function describeBundles(bundles) {
  return bundles.filter(bundle => bundle.installed || bundle.enabled || bundle.official || bundle.optional).map(bundle => ({
    name: bundle.name, version: typeof bundle.version === 'string' && VERSION.test(bundle.version) ? bundle.version : undefined, enabled: bundle.enabled === true,
    available: bundle.availability !== 'missing', official: bundle.official === true,
    builtin: bundle.availability === 'installation', optional: bundle.optional === true,
    installed: bundle.installed === true, updatable: bundle.updatable === true,
    protected: !!bundle.readOnlyReason,
    sourceKind: registrySource(bundle) ? 'registry' : 'local',
    installVersion: bundle.installTarget?.version,
    problem: bundle.error?.code,
  }));
}

function validateBundles(bundles) {
  if (!Array.isArray(bundles) || bundles.length > 256) throw fail('插件列表无效');
  const names = new Set();
  for (const bundle of bundles) {
    if (!bundle || typeof bundle.name !== 'string' || !PACKAGE.test(bundle.name) || names.has(bundle.name)
      || (bundle.version !== undefined && !VERSION.test(bundle.version))) throw fail('插件名称或版本无效');
    names.add(bundle.name);
  }
}

/** Recompute the proposed changes on the receiving Host before starting a job. */
export function planPluginSync(source, target) {
  validateBundles(source);
  const byName = new Map(target.map(bundle => [bundle.name, bundle]));
  return source.filter(bundle => bundle.installed || bundle.enabled).map(bundle => {
    const remote = byName.get(bundle.name);
    const row = { name: bundle.name, localVersion: bundle.version, remoteVersion: remote?.version,
      enabled: bundle.enabled, remoteEnabled: remote?.enabled === true, action: 'skip', reason: '' };
    const sameVersion = bundle.version && bundle.version === remote?.version;
    const targetOwnsVersion = bundle.official && remote?.builtin;
    if (remote?.available && !remote.problem && (sameVersion || targetOwnsVersion)) {
      row.action = bundle.enabled === remote.enabled ? 'current' : bundle.enabled ? 'enable' : 'disable';
      if (targetOwnsVersion && !sameVersion) row.reason = '使用目标 DSH 自带版本';
    } else if (!bundle.available || bundle.problem) row.reason = '本机插件不可用';
    else if (bundle.sourceKind !== 'registry' && !bundle.official) row.reason = '本地路径插件需先发布到插件仓库';
    else if (!bundle.version) row.reason = '本机插件没有有效版本号';
    else if (remote?.available && !remote.updatable) row.reason = '目标插件不支持在线替换版本';
    else {
      row.action = remote?.available ? 'update' : 'install';
      row.version = bundle.official && remote?.installVersion ? remote.installVersion : bundle.version;
    }
    if (row.action !== 'current' && (bundle.protected || remote?.protected || bundle.name === 'dsh-remote-session'
      || (bundle.builtin && !bundle.optional && !bundle.official))) {
      row.action = 'skip';
      row.reason = bundle.name === 'dsh-remote-session' ? '远程连接插件需单独更新并重启' : 'DSH 内置基础组件随应用更新';
    }
    return row;
  });
}

function changeFailure(result) {
  if (!result || ['failed', 'cancelled', 'overridden'].includes(result.application)) {
    return result?.error?.diagnostic || result?.error?.code || (result?.application === 'cancelled' ? '安装已取消' : '目标配置未生效');
  }
  return '';
}

/** Jobs live on the target, so closing Settings or a relay interruption does not repeat an installation. */
export class PluginSync {
  jobs = new Map();
  active = null;
  stopped = false;
  constructor(ctx) { this.ctx = ctx; }
  manager() {
    const manager = this.ctx.get('pluginManager');
    if (!manager) throw fail('这台机器没有启用 DSH 官方插件管理服务', 409);
    return manager;
  }
  async inventory() { return { protocol: 1, bundles: describeBundles(await this.manager().listBundles()) }; }
  snapshot(job) {
    return { id: job.id, state: job.state, cancelRequested: job.cancelRequested,
      restartRequired: job.rows.some(row => row.restartRequired), rows: job.rows.map(row => ({ ...row })) };
  }
  owned(source, id) {
    const job = this.jobs.get(id);
    if (!job || job.source !== source) throw fail('同步任务不存在，请重新比较插件', 404);
    return job;
  }
  async dispatch(source, input) {
    if (input?.action === 'inventory') return this.inventory();
    if (input?.action === 'status') return this.snapshot(this.owned(source, input.id));
    if (input?.action === 'cancel') {
      const job = this.owned(source, input.id);
      if (job.state === 'running') {
        job.cancelRequested = true;
        if (job.requestId) void this.manager().cancelInstall(job.requestId).catch(() => {});
      }
      return this.snapshot(job);
    }
    if (input?.action !== 'start') throw fail('未知插件同步操作');
    if (this.stopped) throw fail('插件同步服务正在停止', 409);
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) throw fail('同步任务标识无效');
    const previous = this.jobs.get(input.id);
    if (previous) return this.snapshot(this.owned(source, input.id));
    if (this.active) throw fail('这台机器已有插件同步任务正在运行', 409);
    validateBundles(input.bundles);
    const inventory = await this.inventory();
    // Inventory is asynchronous; another start can have claimed the target meanwhile.
    if (this.jobs.has(input.id)) return this.snapshot(this.owned(source, input.id));
    if (this.active) throw fail('这台机器已有插件同步任务正在运行', 409);
    const rows = planPluginSync(input.bundles, inventory.bundles).map(row => ({ ...row,
      state: actionable.has(row.action) ? 'pending' : row.action === 'current' ? 'done' : 'skipped' }));
    if (!rows.length) throw fail('没有选择插件');
    for (const [id, job] of this.jobs) if (this.jobs.size >= 32 && job.state !== 'running') this.jobs.delete(id);
    const job = { id: input.id, source, state: 'running', rows, cancelRequested: false, requestId: null };
    this.jobs.set(job.id, job);
    this.active = job;
    job.task = this.run(job).catch(error => {
      for (const row of job.rows) if (['pending', 'running'].includes(row.state)) { row.state = 'failed'; row.error = String(error.message).slice(0, 1200); }
      job.state = 'failed';
    }).finally(() => { if (this.active === job) this.active = null; });
    return this.snapshot(job);
  }
  async run(job) {
    const manager = this.manager();
    for (const row of job.rows) {
      if (row.state !== 'pending') continue;
      if (job.cancelRequested || this.stopped) { row.state = 'cancelled'; continue; }
      row.state = 'running';
      try {
        let result;
        if (row.action === 'install') {
          job.requestId = randomUUID();
          result = await manager.installBundle(`${row.name}@${row.version}`, { enabled: row.enabled, saveExact: true, requestId: job.requestId });
        } else if (row.action === 'update') {
          job.requestId = randomUUID();
          const update = await manager.updateBundle(row.name, row.version, { requestId: job.requestId });
          result = update.result;
          if (changeFailure(result)) throw new Error(changeFailure(result));
          row.restartRequired = result.application === 'restart-required';
          if (!job.cancelRequested) {
            const activation = await manager.setBundleEnabled(row.name, row.enabled);
            if (changeFailure(activation)) throw new Error(changeFailure(activation));
            row.restartRequired ||= activation.application === 'restart-required';
          }
        } else result = await manager.setBundleEnabled(row.name, row.enabled);
        if (changeFailure(result)) throw new Error(changeFailure(result));
        row.restartRequired ||= result.application === 'restart-required';
        try {
          const accepted = (await manager.listBundles()).find(bundle => bundle.name === row.name);
          if (accepted) { row.remoteVersion = accepted.version; row.remoteEnabled = accepted.enabled === true; }
        } catch { row.reason = '已提交更改，暂时无法重新读取目标插件状态'; }
        row.state = 'done';
      } catch (error) {
        row.state = job.cancelRequested ? 'cancelled' : 'failed';
        row.error = String(error.message || error).slice(0, 1200);
      } finally { job.requestId = null; }
    }
    job.state = job.cancelRequested ? 'cancelled' : job.rows.some(row => row.state === 'failed') ? 'failed' : 'done';
  }
  async dispose() {
    this.stopped = true;
    if (!this.active) return;
    this.active.cancelRequested = true;
    if (this.active.requestId) await this.manager().cancelInstall(this.active.requestId).catch(() => {});
    await this.active?.task;
  }
}

export function selectablePlugin(row) { return actionable.has(row.action); }
