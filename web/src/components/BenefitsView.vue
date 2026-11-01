<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton, Checkbox as ACheckbox, Empty as AEmpty, Input as AInput, Modal as AModal, Option as AOption, Progress as AProgress, Radio as ARadio, RadioGroup as ARadioGroup, Select as ASelect, Spin as ASpin, Table as ATable, TableColumn as ATableColumn, Tag as ATag, Message } from '@arco-design/web-vue';
import { IconRefresh, IconPlayArrow, IconSearch, IconGift, IconCopy, IconDownload, IconCheck, IconClockCircle, IconArrowRight, IconInfoCircle, IconCalendar, IconThunderbolt } from '@arco-design/web-vue/es/icon';
import { accountCredits, formatNumber } from '../useAccounts';

const props = defineProps({ model: Object, section: String });
const names = { tasks: '任务中心', rewards: '活动奖励', credits: '积分明细' };
const uid = ref(''), loading = ref(false), working = ref(false), error = ref(''), result = ref('');
const tasks = ref([]), automatic = ref([]), rewards = ref(null), packages = ref([]), history = ref([]);
const queue = ref({ running: false, items: [] }), scan = ref(null), concurrency = ref(1);
const filter = ref('all'), search = ref(''), includeExpired = ref(false), confirmation = ref(null);
const creditFilter = ref('all'), loadedAt = ref(null), packageView = ref(null), rulesView = ref(null);
let version = 0, queueTimer;
const abort = new AbortController();
const api = (path, options = {}) => props.model.api(path, { ...options, signal: abort.signal });
const personal = computed(() => props.model.accounts.filter(a => !a.disabled && !a.enterprise && a.realm !== 'global' && a.benefits_supported !== false));
const unsupportedAccounts = computed(() => props.model.provider === 'workbuddy' ? props.model.accounts.filter(a => a.benefits_supported === false) : []);
const options = computed(() => props.section === 'credits' ? props.model.accounts : personal.value);
const account = computed(() => options.value.find(a => a.uid === uid.value));
const supported = computed(() => props.model.provider === 'workbuddy');
const activeAccounts = computed(() => props.model.accounts.filter(a => !uid.value || uid.value === a.uid));
const allPackages = computed(() => packages.value.filter(a => !uid.value || a.uid === uid.value).flatMap(a => (a.packages || []).map((p, index) => ({ ...p, uid: a.uid, account: props.model.accountName(a), key: a.uid + ':' + index }))));
const packageRows = computed(() => allPackages.value.filter(p => includeExpired.value || p.remain > 0 && (!p.expires_at || p.expires_at > Date.now())));
const packageErrors = computed(() => packages.value.filter(a => a.error && (!uid.value || uid.value === a.uid)));
const validPackageCount = computed(() => packageRows.value.filter(p => p.remain > 0 && (!p.expires_at || p.expires_at > Date.now())).length);
const ledger = computed(() => history.value.filter(e => !uid.value || e.uid === uid.value));
const visibleLedger = computed(() => ledger.value.filter(e => creditFilter.value === 'all' || creditFilter.value === 'income' && e.delta > 0 || creditFilter.value === 'expense' && e.delta < 0));
const balance = computed(() => activeAccounts.value.reduce((sum, a) => sum + Number(a.credits || 0), 0));
const expiring = computed(() => allPackages.value.filter(p => p.remain > 0 && p.expires_at > Date.now() && p.expires_at <= Date.now() + 30 * 86400000).sort((a, b) => a.expires_at - b.expires_at));
const expiringCredits = computed(() => expiring.value.reduce((sum, p) => sum + Number(p.remain), 0));
const monthlyLedger = computed(() => ledger.value.filter(e => new Date(e.time).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7) === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7)));
const monthIncome = computed(() => monthlyLedger.value.reduce((sum, e) => sum + Math.max(0, Number(e.delta)), 0));
const monthExpense = computed(() => monthlyLedger.value.reduce((sum, e) => sum + Math.min(0, Number(e.delta)), 0));
const completedTasks = computed(() => tasks.value.filter(t => t.claimed).length);
const taskProgress = computed(() => tasks.value.length ? completedTasks.value / tasks.value.length : 0);
const availableTiers = computed(() => (rewards.value?.streak?.redemption_status?.tiers || []).filter(canRedeem));
const canCompensate = computed(() => rewards.value?.compensation?.active && !rewards.value.compensation.claimed && rewards.value.compensation.credit_num > 0);
const claimCount = computed(() => availableTiers.value.length + Number(!!canCompensate.value));
const rewardCredits = computed(() => availableTiers.value.reduce((sum, t) => sum + Number(t.credit || 0), 0) + (canCompensate.value ? Number(rewards.value.compensation.credit_num) : 0));
const coverage = computed(() => props.model.accounts.map(a => ({ ...a, pendingTasks: scan.value?.accounts?.find(item => item.uid === a.uid) })));
const taskRows = computed(() => tasks.value.filter(t => (!search.value || (t.title + ' ' + t.task_code).toLowerCase().includes(search.value.toLowerCase())) && (filter.value === 'all' || filter.value === 'claimable' && t.claimable || filter.value === 'claimed' && t.claimed || filter.value === 'pending' && !t.claimed && !t.claimable || filter.value === 'error' && queue.value.items?.some(i => i.uid === uid.value && i.code === t.task_code && i.status === 'error'))));
const done = computed(() => (queue.value.items || []).filter(i => ['done', 'skipped', 'error'].includes(i.status)).length);
const statusName = value => ({ pending: '等待执行', running: '执行中', done: '已完成', skipped: '已跳过', error: '失败', locked: '未解锁', claimed: '已领取', redeemed: '已兑换', available: '可兑换', unlocked: '可兑换', claimable: '可兑换' })[value] || value || '--';
const date = value => {
  if (!value) return '--';
  const instant = typeof value === 'string' && /^\d{4}-\d\d-\d\d /.test(value) ? value.replace(' ', 'T') + '+08:00' : value;
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
};
function tierStatus(tier) { return rewards.value?.streak?.redemption_status?.['tier_' + tier.tier + '_status']; }
function canRedeem(tier) { return tier.days > 0 && rewards.value?.streak?.streak?.days >= tier.days && !!tierStatus(tier) && !['locked', 'claimed', 'redeemed'].includes(tierStatus(tier)); }
function taskState(task) {
  if (task.claimed) return { label: '已完成', color: 'arcoblue' };
  const queued = queue.value.items?.find(item => item.uid === uid.value && item.code === task.task_code);
  if (queued?.status === 'running') return { label: '执行中', color: 'arcoblue' };
  if (queued?.status === 'error') return { label: '失败', color: 'red' };
  return { label: task.locked ? '未解锁' : task.claimable ? '待领取' : '待执行', color: task.claimable ? 'orange' : 'gray' };
}

async function load() {
  const request = ++version;
  const section = props.section, provider = props.model.provider, selected = uid.value;
  error.value = ''; result.value = ''; loading.value = true;
  tasks.value = []; automatic.value = []; rewards.value = null; packages.value = []; history.value = [];
  try {
    if (provider !== 'workbuddy') return;
    if (section === 'credits') {
      const responses = await Promise.allSettled([api('packages'), api('credit_history?limit=1000')]);
      if (request !== version) return;
      if (responses[0].status === 'fulfilled') packages.value = responses[0].value.accounts || [];
      if (responses[1].status === 'fulfilled') history.value = responses[1].value.entries || [];
      error.value = responses.filter(r => r.status === 'rejected').map(r => r.reason.message).join('；');
    } else if (selected) {
      const response = await api(section === 'tasks' ? `accounts/${encodeURIComponent(selected)}/tasks` : `benefits/accounts/${encodeURIComponent(selected)}/rewards`);
      if (request !== version) return;
      if (section === 'tasks') { tasks.value = response.tasks || []; automatic.value = response.automatable_codes || []; }
      else rewards.value = response;
    }
  } catch (cause) { if (request === version && cause.name !== 'AbortError') error.value = cause.message; }
  finally { if (request === version) { loading.value = false; loadedAt.value = new Date(); } }
}
async function refresh() {
  if (working.value || loading.value) return;
  if (props.model.provider !== 'workbuddy') {
    try { await props.model.refreshBalances(); }
    catch { return; }
  }
  await load();
}
watch([() => props.section, () => props.model.provider], () => {
  uid.value = props.section === 'credits' ? '' : options.value[0]?.uid || '';
  scan.value = null; filter.value = 'all'; creditFilter.value = 'all'; search.value = ''; confirmation.value = null;
  load();
}, { immediate: true });
watch(() => options.value.map(a => a.uid).join(','), () => {
  if (props.section !== 'credits' && !account.value) { uid.value = options.value[0]?.uid || ''; load(); }
});
function selectAccount(value) { uid.value = value || ''; if (props.section !== 'credits') load(); }
async function pollQueue() {
  clearTimeout(queueTimer);
  try {
    const previous = queue.value.running;
    queue.value = await api('tasks/queue');
    if (previous && !queue.value.running) { await props.model.refreshOverview(); if (props.section === 'tasks') await load(); }
    if (queue.value.running) queueTimer = setTimeout(pollQueue, 2000);
  } catch (cause) { if (cause.name !== 'AbortError') { error.value = cause.message; queueTimer = setTimeout(pollQueue, 5000); } }
}
pollQueue();
onBeforeUnmount(() => { ++version; clearTimeout(queueTimer); abort.abort(); });
async function scanTasks() {
  if (working.value) return;
  working.value = true;
  try { scan.value = await api('tasks/scan_all', { method: 'POST' }); }
  catch (cause) { error.value = cause.message; }
  finally { working.value = false; }
}
async function execute(operation, label, payload = {}) {
  if (working.value || queue.value.running) return;
  const selected = uid.value, section = props.section, provider = props.model.provider;
  working.value = true; error.value = ''; confirmation.value = null;
  try {
    const response = operation === 'queue'
      ? await api('tasks/run_queue', { method: 'POST', body: JSON.stringify({ growth: true, concurrency: concurrency.value }) })
      : await api(section === 'tasks' ? `accounts/${encodeURIComponent(selected)}/tasks/${operation}` : `benefits/accounts/${encodeURIComponent(selected)}/rewards`, { method: 'POST', body: JSON.stringify(payload) });
    if (operation === 'queue') { await pollQueue(); result.value = response.message || '任务队列已启动'; return; }
    if (section === 'tasks' && operation !== 'accept') {
      try { await api(`accounts/${encodeURIComponent(selected)}/balance`, { method: 'POST' }); }
      catch { Message.warning('操作已返回，但余额刷新失败，请稍后刷新积分'); }
    }
    await props.model.refreshOverview();
    if (section === props.section && selected === uid.value && provider === props.model.provider) {
      await load();
      result.value = response.claim_error || response.claimable === false && operation === 'auto' && !response.claimed
        ? response.claim_error || response.message || '任务尚未确认完成，请稍后刷新'
        : response.message || (response.prize ? JSON.stringify(response.prize) : label + '成功');
    }
    if (response.claim_error || response.claimable === false && operation === 'auto' && !response.claimed) Message.warning(response.message || '任务尚未确认完成');
    else Message.success(response.message || label + '成功');
  } catch (cause) { if (cause.name !== 'AbortError') error.value = cause.message; }
  finally { working.value = false; }
}
function confirmTask(task) { confirmation.value = task ? { title: '执行任务', task } : { title: '执行全部待办' }; }
function confirmExecution() { if (confirmation.value?.rewards) return claimRewards(); const task = confirmation.value?.task; execute(task ? 'auto' : 'queue', '执行', task ? { task_code: task.task_code } : {}); }
async function claimRewards() {
  if (working.value || queue.value.running || !account.value || !claimCount.value) return;
  const selected = uid.value, provider = props.model.provider;
  const actions = [...availableTiers.value.map(t => ({ action: 'redeem', tier: t.tier })), ...(canCompensate.value ? [{ action: 'compensation' }] : [])];
  working.value = true; confirmation.value = null; error.value = '';
  let claimed = 0;
  const failures = [];
  try {
    for (const action of actions) {
      try { await api(`benefits/accounts/${encodeURIComponent(selected)}/rewards`, { method: 'POST', body: JSON.stringify(action) }); claimed++; }
      catch (cause) { if (cause.name === 'AbortError') return; failures.push(cause.message); }
    }
    await props.model.refreshOverview();
    if (uid.value === selected && props.section === 'rewards' && props.model.provider === provider) {
      await load(); result.value = `已领取 ${claimed} 项奖励`; error.value = failures.join('；');
    }
  } catch (cause) { if (cause.name !== 'AbortError') error.value = cause.message; }
  finally { working.value = false; }
}
function exportCredits() {
  const cell = value => { const text = String(value ?? ''); return '"' + (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""') + '"'; };
  const rows = [['时间', '账号', '变动', '变动前', '变动后'], ...visibleLedger.value.map(e => [date(e.time), e.account || e.uid, e.delta, e.before, e.after])];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'credits-' + new Date().toISOString().slice(0, 10) + '.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function jumpTo(element) { element?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
async function copy(value) { try { await navigator.clipboard.writeText(value); Message.success('已复制券码'); } catch { Message.error('复制失败'); } }
</script>

<template>
  <section :class="['benefits-view', 'benefits-' + section]">
    <header class="page-heading benefit-heading">
      <div>
        <div class="eyebrow">{{ { tasks: 'OPERATIONS', rewards: 'REWARDS', credits: 'BILLING' }[section] }} · {{ model.providerName }}</div>
        <h1>{{ names[section] }}</h1>
        <p>{{ section === 'tasks' ? '成长任务、活动任务与每日待办' : section === 'rewards' ? '官方补偿、连登奖励与活动券码' : '余额、到期批次与每一笔积分变动' }}</p>
      </div>
      <div class="heading-actions">
        <template v-if="section === 'tasks' && supported">
          <a-button :loading="working" :disabled="queue.running || !personal.length" @click="scanTasks"><template #icon><icon-search /></template>扫描全部待办</a-button>
          <a-button type="primary" :disabled="working || queue.running || !personal.length" @click="confirmTask(null)"><template #icon><icon-play-arrow /></template>执行全部待办</a-button>
        </template>
        <template v-else>
          <a-button v-if="section === 'credits'" :disabled="loading || !visibleLedger.length" @click="exportCredits"><template #icon><icon-download /></template>导出明细</a-button>
          <a-button :loading="loading" :disabled="working" @click="refresh"><template #icon><icon-refresh /></template>{{ section === 'credits' ? '刷新积分' : '刷新状态' }}</a-button>
          <a-button v-if="section === 'rewards' && supported" type="primary" :disabled="working || loading || queue.running || !claimCount" @click="confirmation = { title: '领取全部奖励', rewards: true }"><template #icon><icon-gift /></template>全部领取</a-button>
        </template>
      </div>
    </header>

    <a-alert v-if="error" type="error" class="benefit-notice">{{ error }}</a-alert>
    <a-alert v-if="result" type="info" class="benefit-notice">{{ result }}</a-alert>
    <a-alert v-if="section !== 'credits' && unsupportedAccounts.length" type="warning" class="benefit-notice"><div v-for="item in unsupportedAccounts" :key="item.uid">{{ model.accountName(item) }}：{{ item.benefits_reason || '当前登录身份暂不支持个人任务和活动奖励' }}</div></a-alert>

    <a-spin :loading="loading" class="benefit-content">
      <template v-if="section === 'tasks'">
        <a-empty v-if="!supported" :description="model.providerName + ' 暂未接入成长任务'" />
        <template v-else>
          <div class="stats-band benefit-stats">
            <div class="metric"><span class="metric-label">任务完成度</span><strong>{{ completedTasks }} / {{ tasks.length }}</strong><small>{{ Math.round(taskProgress * 100) }}% · 当前账号</small></div>
            <div class="metric"><span class="metric-label">待执行</span><strong class="warning-text">{{ tasks.filter(t => !t.claimed && !t.locked).length }}</strong><small>{{ tasks.filter(t => t.claimable).length }} 项可领取奖励</small></div>
            <div class="metric"><span class="metric-label">执行中</span><strong>{{ queue.items?.filter(i => i.status === 'running').length || 0 }}</strong><small>{{ queue.running ? '队列运行中' : '队列空闲' }}</small></div>
            <div class="metric"><span class="metric-label">待领取积分</span><strong class="accent-text">+{{ formatNumber(tasks.filter(t => t.claimable).reduce((sum, t) => sum + Number(t.credit || 0), 0)) }}</strong><small>当前账号 · 已达成任务</small></div>
          </div>

          <div class="benefit-layout">
            <section class="benefit-primary">
              <div class="benefit-panel-heading">
                <div class="benefit-panel-title"><h2>成长任务队列</h2><span>共 {{ tasks.length }} 项</span></div>
                <a-radio-group v-model="filter" type="button" size="small" aria-label="任务状态"><a-radio value="all">全部</a-radio><a-radio value="pending">待执行</a-radio><a-radio value="claimable">待领取</a-radio><a-radio value="claimed">已完成</a-radio><a-radio value="error">失败</a-radio></a-radio-group>
              </div>
              <div class="benefit-toolbar">
                <a-select :model-value="uid" :disabled="working" placeholder="选择账号" aria-label="查看账号" @change="selectAccount"><a-option v-for="item in options" :key="item.uid" :value="item.uid">{{ model.accountName(item) }}</a-option></a-select>
                <a-input v-model="search" allow-clear placeholder="搜索任务" aria-label="搜索任务"><template #prefix><icon-search /></template></a-input>
                <a-button :loading="loading" :disabled="working" aria-label="刷新任务" title="刷新任务" @click="refresh"><template #icon><icon-refresh /></template></a-button>
              </div>
              <div class="benefit-overall-progress"><div class="inline-between"><span>总体进度</span><strong>{{ completedTasks }} / {{ tasks.length }} · {{ Math.round(taskProgress * 100) }}%</strong></div><a-progress :percent="taskProgress" :show-text="false" /></div>
              <a-table class="benefit-task-table" :data="taskRows" row-key="task_code" :pagination="{ pageSize: 8, simple: true }" :scroll="{ x: 650 }" :bordered="false">
                <template #columns>
                  <a-table-column title="任务" :width="270"><template #cell="{ record }"><div class="task-identity"><span :class="['task-symbol', record.claimed ? 'complete' : record.claimable ? 'available' : '']"><icon-check v-if="record.claimed" /><icon-gift v-else-if="record.claimable" /><icon-thunderbolt v-else /></span><div><strong>{{ record.title || record.task_code }}</strong><small class="benefit-detail">{{ record.task_desc || record.description || record.task_code }}</small><small v-if="record.target" class="benefit-detail">进度 {{ record.current }} / {{ record.target }}</small></div></div></template></a-table-column>
                  <a-table-column title="奖励" :width="95" align="right"><template #cell="{ record }"><strong class="accent-text">+{{ formatNumber(record.credit) }}</strong><small class="benefit-detail">积分<span v-if="record.energy"> · {{ record.energy }} 能量</span></small></template></a-table-column>
                  <a-table-column title="状态" :width="100"><template #cell="{ record }"><a-tag :color="taskState(record).color">{{ taskState(record).label }}</a-tag></template></a-table-column>
                  <a-table-column title="操作" :width="140"><template #cell="{ record }"><a-button v-if="record.claimable" type="text" :disabled="working || queue.running" @click="execute('claim', '领取奖励', { task_code: record.task_code })"><template #icon><icon-gift /></template>领取</a-button><template v-else-if="!record.claimed && !record.locked"><a-button v-if="!record.accept_status || record.accept_status === 'not_accepted'" type="text" :disabled="working || queue.running" @click="execute('accept', '接受任务', { task_codes: [record.task_code] })">接受</a-button><a-button v-if="automatic.includes(record.task_code)" type="text" :disabled="working || queue.running" @click="confirmTask(record)"><template #icon><icon-play-arrow /></template>执行</a-button></template></template></a-table-column>
                </template>
                <template #empty><a-empty :description="account ? '暂无符合条件的任务' : '暂无可用的国内版个人账号'" /></template>
              </a-table>
              <div class="benefit-panel-footer"><span><i class="status-dot" />{{ loadedAt ? '最近查询 ' + date(loadedAt).split(' ')[1] : '等待查询' }}</span><span>{{ account ? model.accountName(account) : '未选择账号' }}</span></div>
            </section>

            <aside class="benefit-aside">
              <section class="benefit-side-section">
                <div class="inline-between"><h2>执行队列</h2><a-tag :color="queue.running ? 'arcoblue' : 'gray'">{{ queue.running ? '执行中' : '已结束' }} · {{ done }} / {{ queue.total || 0 }}</a-tag></div>
                <div class="benefit-overall-progress"><div class="inline-between"><span>本轮进度</span><strong>{{ done }} / {{ queue.total || 0 }}</strong></div><a-progress :percent="queue.total ? done / queue.total : 0" :show-text="false" /></div>
                <div v-for="(item, index) in queue.items || []" :key="index" class="queue-line"><div class="inline-between"><strong>{{ item.nickname || item.uid }}</strong><a-tag :color="item.status === 'error' ? 'red' : item.status === 'done' ? 'arcoblue' : 'gray'">{{ statusName(item.status) }}</a-tag></div><small>{{ item.code }}</small><small v-if="item.message">{{ item.message }}</small></div>
                <a-empty v-if="!queue.items?.length" description="暂无执行中的任务" />
                <a-select v-model="concurrency" aria-label="并行账号数" :disabled="queue.running || working"><a-option v-for="n in [1, 2, 3, 4]" :key="n" :value="n">{{ n }} 个账号并行</a-option></a-select>
                <a-button long type="primary" :disabled="working || queue.running || !personal.length" @click="confirmTask(null)"><template #icon><icon-play-arrow /></template>开始执行队列</a-button>
              </section>
              <section class="benefit-side-section">
                <div class="inline-between"><h2>账号覆盖</h2><a href="#accounts">查看账号 <icon-arrow-right /></a></div>
                <div v-for="item in coverage" :key="item.uid" class="coverage-line"><div class="inline-between"><span class="account-caption"><span class="account-initial">{{ model.accountName(item).slice(0, 1) }}</span><span>{{ model.accountName(item) }}</span></span><small>{{ item.uid === uid && tasks.length ? completedTasks + ' / ' + tasks.length : item.disabled ? '已停用' : !personal.some(a => a.uid === item.uid) ? '暂不支持' : item.pendingTasks?.growth_error ? '查询失败' : item.pendingTasks ? (item.pendingTasks.growth || []).length + ' 项待办' : '待扫描' }}</small></div><a-progress v-if="item.uid === uid && tasks.length" :percent="taskProgress" :show-text="false" /></div>
                <div class="benefit-side-note"><icon-info-circle />{{ personal.length }} 个账号可参与个人任务</div>
              </section>
              <section v-if="scan" class="benefit-side-section"><h2>全部账号待办 · {{ scan.pending_count || 0 }} 项</h2><div v-for="item in (scan.accounts || []).filter(a => a.uid)" :key="item.uid" class="scan-line"><strong>{{ item.nickname || item.uid }}</strong><span :class="{ 'danger-text': item.growth_error }">{{ item.growth_error || ((item.growth || []).length + ' 项待办') }}</span></div></section>
            </aside>
          </div>
        </template>
      </template>

      <template v-else-if="section === 'credits'">
        <div class="stats-band benefit-stats">
          <div class="metric"><span class="metric-label">当前余额</span><strong>{{ formatNumber(balance) }}</strong><small>{{ activeAccounts.length }} 个账号 · 合计</small></div>
          <div class="metric"><span class="metric-label">30 天内到期</span><strong class="warning-text">{{ supported ? formatNumber(expiringCredits) : '--' }}</strong><small>{{ supported ? expiring.length + ' 个批次' : '暂未返回批次数据' }}</small></div>
          <div class="metric"><span class="metric-label">本月获得</span><strong class="accent-text">{{ supported ? '+' + formatNumber(monthIncome) : '--' }}</strong><small>本地已记录的积分收入</small></div>
          <div class="metric"><span class="metric-label">本月消耗</span><strong>{{ supported ? formatNumber(monthExpense) : '--' }}</strong><small>本地已记录的积分支出</small></div>
        </div>

        <div class="benefit-layout">
          <section class="benefit-primary">
            <div class="benefit-panel-heading"><div class="benefit-panel-title"><h2>积分流水</h2><span>共 {{ ledger.length }} 条记录</span></div><a-radio-group v-model="creditFilter" type="button" size="small" aria-label="流水类型"><a-radio value="all">全部</a-radio><a-radio value="income">收入</a-radio><a-radio value="expense">消耗</a-radio></a-radio-group></div>
            <div class="benefit-toolbar"><a-select :model-value="uid" allow-clear :disabled="working" placeholder="全部账号" aria-label="查看账号" @change="selectAccount"><a-option v-for="item in options" :key="item.uid" :value="item.uid">{{ model.accountName(item) }}</a-option></a-select><span class="benefit-toolbar-hint">积分 · 北京时间</span></div>
            <a-table :data="visibleLedger" :pagination="{ pageSize: 10, simple: true }" :scroll="{ x: 620 }" :bordered="false">
              <template #columns><a-table-column title="时间" :width="165"><template #cell="{ record }">{{ date(record.time) }}</template></a-table-column><a-table-column title="账号" :width="140"><template #cell="{ record }">{{ record.account || record.uid }}</template></a-table-column><a-table-column title="类型" :width="70"><template #cell="{ record }"><a-tag :color="record.delta > 0 ? 'arcoblue' : 'gray'">{{ record.delta > 0 ? '收入' : record.delta < 0 ? '消耗' : '查询' }}</a-tag></template></a-table-column><a-table-column title="变动" :width="95" align="right"><template #cell="{ record }"><strong :class="record.delta > 0 ? 'accent-text' : 'danger-text'">{{ record.delta > 0 ? '+' : '' }}{{ formatNumber(record.delta) }}</strong></template></a-table-column><a-table-column title="余额" data-index="after" :width="95" align="right" /></template>
              <template #empty><a-empty :description="supported ? '暂无已记录的余额变动' : '当前平台接口未返回逐包明细与积分流水'" /></template>
            </a-table>
            <div class="benefit-panel-footer"><span>启用后记录 · 不补录平台历史</span><a-button type="text" size="mini" :disabled="!visibleLedger.length" @click="exportCredits">导出流水 <icon-arrow-right /></a-button></div>
          </section>

          <aside class="benefit-aside">
            <section class="benefit-side-section">
              <div class="inline-between"><h2>按账号</h2><span class="benefit-caption">合计 {{ formatNumber(balance) }}</span></div>
              <div v-for="item in activeAccounts" :key="item.uid" class="balance-line"><div class="inline-between"><span>{{ model.accountName(item) }}</span><strong>{{ accountCredits(item) }}</strong></div><a-progress :percent="balance > 0 ? Math.max(0, Number(item.credits || 0)) / balance : 0" :show-text="false" /></div>
              <div class="benefit-net"><span>本月净增</span><strong class="accent-text">{{ monthIncome + monthExpense > 0 ? '+' : '' }}{{ supported ? formatNumber(monthIncome + monthExpense) : '--' }} <small>分</small></strong><small>以本地积分流水为准</small></div>
            </section>
            <section class="benefit-side-section">
              <div class="inline-between"><h2>到期批次</h2><span class="benefit-caption">按到期时间排序</span></div>
              <div class="expiry-total"><strong>{{ supported ? formatNumber(expiringCredits) : '--' }}</strong><span>分 · 30 天内到期</span></div>
              <div v-for="item in expiring.slice(0, 4)" :key="item.key" class="expiry-line"><div><strong>{{ new Date(item.expires_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }) }}</strong><span>{{ item.account }}</span></div><div><strong>{{ formatNumber(item.remain) }} 分</strong><small>{{ Math.ceil((item.expires_at - Date.now()) / 86400000) }} 天后</small></div></div>
              <a-empty v-if="!expiring.length" :description="supported ? '暂无即将到期的积分包' : '暂未接入到期批次'" />
              <div class="benefit-side-note"><span>{{ validPackageCount }} 个有效积分包</span><a-button type="text" size="mini" @click="jumpTo(packageView)">查看全部 <icon-arrow-right /></a-button></div>
            </section>
          </aside>
        </div>

        <section v-if="supported" ref="packageView" class="benefit-packages">
          <div class="benefit-panel-heading"><h2>积分包明细</h2><a-checkbox v-model="includeExpired">包含已用完和已到期</a-checkbox></div>
          <a-alert v-for="item in packageErrors" :key="item.uid" type="warning" class="benefit-notice">{{ model.accountName(item) }}：{{ item.error }}</a-alert>
          <a-table :data="packageRows" row-key="key" :pagination="{ pageSize: 10, simple: true }" :scroll="{ x: 850 }" :bordered="false"><template #columns><a-table-column title="账号" data-index="account" :width="150" /><a-table-column title="积分来源" :width="210"><template #cell="{ record }"><strong>{{ record.name || record.sub_product_name || '积分包' }}</strong><small class="benefit-detail">{{ record.package_code }}</small></template></a-table-column><a-table-column title="剩余 / 面额" :width="130"><template #cell="{ record }">{{ formatNumber(record.remain) }} / {{ formatNumber(record.size) }}</template></a-table-column><a-table-column title="发放时间" :width="180"><template #cell="{ record }">{{ date(record.created_at) }}</template></a-table-column><a-table-column title="到期时间" :width="180"><template #cell="{ record }"><span :class="{ 'warning-text': record.expires_at > Date.now() && record.expires_at < Date.now() + 30 * 86400000 }">{{ date(record.expires_at || record.end_time) }}</span></template></a-table-column></template></a-table>
          <div class="benefit-panel-footer"><span>仅展示平台当前返回的积分包</span><span>{{ packageRows.length }} 个批次</span></div>
        </section>
      </template>

      <template v-else>
        <template v-if="model.provider === 'qoder'">
          <div class="reward-feature"><div><div class="eyebrow">DAILY REWARD · QODER</div><h2>每日 100 Credits</h2><p>领取状态以平台当前返回的结果为准</p></div><icon-gift class="reward-feature-icon" /></div>
          <div class="reward-grid"><article v-for="item in model.accounts" :key="item.uid" class="reward-item"><span class="reward-symbol"><icon-gift /></span><a-tag>{{ item.checkin_done ? '本轮已领取' : '本轮待领取' }}</a-tag><h3>{{ model.accountName(item) }}</h3><p>当前余额 {{ accountCredits(item) }} 积分</p><div class="reward-amount">+100 <small>Credits</small></div><a-button long :disabled="item.disabled || item.checkin_done" :loading="model.busy.has(item.uid + ':checkin')" @click="model.accountAction(item, 'checkin').catch(() => {})">领取奖励</a-button></article></div>
        </template>
        <a-empty v-else-if="!supported" :description="model.providerName + ' 暂未接入额外活动奖励'" />
        <template v-else>
          <div class="benefit-toolbar reward-account-select"><a-select :model-value="uid" :disabled="working" placeholder="选择账号" aria-label="查看账号" @change="selectAccount"><a-option v-for="item in options" :key="item.uid" :value="item.uid">{{ model.accountName(item) }}</a-option></a-select><span class="benefit-toolbar-hint">{{ account ? '当前账号 · ' + model.accountName(account) : '请选择国内版个人账号' }}</span></div>
          <a-alert v-for="(message, name) in rewards?.errors || {}" :key="name" type="warning" class="benefit-notice">{{ name }}：{{ message }}</a-alert>
          <div class="reward-feature">
            <div class="reward-feature-copy"><div class="eyebrow">OFFICIAL REWARD · 官方补偿</div><h2>{{ rewards?.compensation?.active ? '服务异常补偿' : '官方补偿' }}</h2><p>{{ !account ? '暂无可用的国内版个人账号' : !rewards?.compensation ? '暂未返回补偿状态' : rewards.compensation.active ? (rewards.compensation.claimed ? '本次补偿已领取' : '当前账号有可领取的官方补偿') : '当前无生效中的补偿活动' }}</p><div class="reward-feature-meta"><span v-if="rewards?.compensation?.end_time"><icon-clock-circle /> 截止 {{ rewards.compensation.end_time }}</span><a-button type="text" @click="jumpTo(rulesView)">查看规则 <icon-arrow-right /></a-button></div></div>
            <div class="reward-feature-value"><strong>{{ canCompensate ? '+' + formatNumber(rewards.compensation.credit_num) : '--' }}</strong><span>待领取积分</span><a-button :disabled="working || queue.running || !canCompensate" @click="execute('reward', '领取补偿', { action: 'compensation' })"><template #icon><icon-gift /></template>领取补偿</a-button></div>
          </div>
          <div class="reward-section-heading"><div><h2>可领取活动</h2><span>以当前账号活动状态为准</span></div><span class="accent-text">待领取 {{ formatNumber(rewardCredits) }} 积分</span></div>
          <div class="reward-grid">
            <article v-for="tier in rewards?.streak?.redemption_status?.tiers || []" :key="tier.tier" class="reward-item"><span class="reward-symbol warm"><icon-calendar /></span><a-tag :color="canRedeem(tier) ? 'orange' : 'gray'">{{ statusName(tierStatus(tier)) }}</a-tag><h3>{{ tier.days }} 天连登奖励</h3><p>连续 {{ rewards?.streak?.streak?.days ?? '--' }} 天 · 补签卡 {{ rewards?.streak?.makeup_cards?.balance ?? '--' }} 张</p><div class="reward-amount">+{{ formatNumber(tier.credit) }} <small>积分</small></div><div class="reward-item-meta">{{ tier.energy || 0 }} 能量 · {{ tier.chances || 0 }} 次抽奖</div><a-button long :disabled="working || queue.running || !canRedeem(tier)" @click="execute('reward', '兑换奖励', { action: 'redeem', tier: tier.tier })">兑换</a-button></article>
            <article class="reward-item"><span class="reward-symbol"><icon-gift /></span><a-tag :color="rewards?.chances > 0 ? 'arcoblue' : 'gray'">{{ rewards?.chances > 0 ? '可参与' : '暂无机会' }}</a-tag><h3>活动抽奖</h3><p>当前账号可用抽奖机会</p><div class="reward-amount">{{ rewards?.chances ?? '--' }} <small>次</small></div><div class="reward-item-meta">每次抽奖消耗 1 次机会</div><a-button long :disabled="working || queue.running || !(rewards?.chances > 0)" @click="execute('reward', '抽奖', { action: 'draw' })">抽奖一次</a-button></article>
          </div>
          <div class="benefit-layout reward-bottom">
            <section class="benefit-primary">
              <div class="benefit-panel-heading"><div class="benefit-panel-title"><h2>活动券码</h2><span>{{ rewards?.vouchers?.length || 0 }} 张</span></div></div>
              <div v-for="voucher in rewards?.vouchers || []" :key="voucher.grant_id" class="voucher-line"><span class="reward-symbol"><icon-gift /></span><div><strong>{{ voucher.prize_name || voucher.sku_code }}</strong><code>{{ voucher.code }}</code><small class="benefit-detail">有效期至 {{ voucher.valid_to || '--' }}</small></div><a-button aria-label="复制券码" title="复制券码" @click="copy(voucher.code)"><template #icon><icon-copy /></template></a-button></div>
              <a-empty v-if="!rewards?.vouchers?.length" description="暂无活动券码" />
            </section>
            <section ref="rulesView" class="benefit-side-section reward-rules"><h2>活动规则</h2><p><icon-info-circle /><span>奖励按当前账号的活动资格发放。</span></p><p><icon-clock-circle /><span>领取后的有效期以积分包明细为准。</span></p><p><icon-check /><span>已领取的档位不可重复兑换。</span></p><p v-if="rewards?.compensation?.end_time">补偿截止：{{ rewards.compensation.end_time }}</p><a href="#credits">查看积分明细 <icon-arrow-right /></a></section>
          </div>
        </template>
      </template>
    </a-spin>
    <a-modal :visible="!!confirmation" :title="confirmation?.title" :footer="false" :mask-closable="false" @cancel="confirmation = null">
      <template v-if="confirmation?.rewards"><p>为「{{ account ? model.accountName(account) : '' }}」领取 {{ claimCount }} 项奖励，共 {{ formatNumber(rewardCredits) }} 积分。</p><p class="modal-description">包含当前可兑换的连登奖励和官方补偿。</p></template>
      <template v-else><p>{{ confirmation?.task?.title || '全部国内版个人账号的可执行待办' }}</p><p class="modal-description">任务可能发起真实对话并消耗积分，完成后会尝试领取奖励。</p></template>
      <div class="modal-actions"><a-button @click="confirmation = null">取消</a-button><a-button type="primary" :loading="working" @click="confirmExecution"><template #icon><icon-play-arrow /></template>{{ confirmation?.rewards ? '确认领取' : '确认执行' }}</a-button></div>
    </a-modal>
  </section>
</template>
