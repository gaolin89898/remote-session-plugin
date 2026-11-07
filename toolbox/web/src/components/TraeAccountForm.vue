<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton, Input as AInput, InputPassword as AInputPassword } from '@arco-design/web-vue';
import { IconExport, IconFile, IconUpload, IconSafe } from '@arco-design/web-vue/es/icon';
const props = defineProps({ model: Object });
const mode = ref('browser'), fileInput = ref(null), file = ref(null), password = ref(''), result = ref(null);
onMounted(() => props.model.checkTraeLoginAvailable());
onBeforeUnmount(() => props.model.stopTraeLogin());
watch(mode, () => props.model.stopTraeLogin());
const quiet = promise => promise?.catch(() => {});
function selected(event) { file.value = event.target.files?.[0] || null; result.value = null; }
async function importFile(model) {
  try { result.value = await model.importTrae(file.value, password.value); password.value = ''; file.value = null; }
  catch { /* The shared action displays the error and keeps the form for retry. */ }
}
</script>

<template>
  <div class="trae-account-form">
    <p class="dialog-intro">管理 Trae 国内版账号，支持每日签到和积分查询。</p>
    <div class="dialog-tabs trae-login-tabs" role="tablist" aria-label="Trae 添加方式"><button role="tab" :aria-selected="mode === 'browser'" :class="{ active: mode === 'browser' }" @click="mode = 'browser'"><icon-export />直接登录</button><button role="tab" :aria-selected="mode === 'credential'" :class="{ active: mode === 'credential' }" @click="mode = 'credential'"><icon-safe />登录凭证</button><button role="tab" :aria-selected="mode === 'backup'" :class="{ active: mode === 'backup' }" @click="mode = 'backup'"><icon-file />备份导入</button></div>
    <div v-if="mode === 'browser'" class="trae-browser-login" role="tabpanel">
      <div class="trae-login-mark"><icon-export /></div>
      <h3>{{ model.traeExpectedUID ? '重新授权 Trae 账号' : '使用 Trae 账号授权登录' }}</h3>
      <p>打开独立登录窗口，完成 Trae 授权后自动保存账号及独立设备身份。</p>
      <a-alert v-if="model.traeExpectedUID" type="info">请登录当前所选账号，授权成功后会更新其登录凭证和设备绑定。</a-alert>
      <a-alert v-if="model.traeLogin.error" type="error">{{ model.traeLogin.error }}</a-alert>
      <a-alert v-if="model.traeLogin.available === false" type="warning">{{ model.traeLogin.message }}</a-alert>
      <template v-if="model.traeLogin.waiting"><div class="trae-login-waiting" role="status"><i class="status-dot" />{{ model.traeLogin.status }}</div><a-button long @click="model.stopTraeLogin()">取消本次登录</a-button></template>
      <a-button v-else type="primary" long size="large" :disabled="model.traeLogin.available !== true" :loading="model.busy.has('trae-login') || model.traeLogin.available === null" @click="quiet(model.startTraeLogin())">{{ model.traeLogin.error ? '重新打开 Trae 登录' : '打开 Trae 登录窗口' }}</a-button>
      <small>每次授权使用独立设备身份，登录、续期与签到保持一致。</small>
    </div>
    <form v-else-if="mode === 'credential'" class="trae-credential-fields" @submit.prevent="quiet(model.addTrae())">
      <a href="https://www.trae.cn/" target="_blank" rel="noopener noreferrer" class="trae-login-link">打开 Trae 官网登录<icon-export /></a>
      <label><span>账号名称 <small>选填</small></span><a-input v-model="model.traeDraft.nickname" :max-length="80" placeholder="例如：Trae 主账号" :input-attrs="{ 'aria-label': 'Trae 账号名称', autocomplete: 'off' }" /></label>
      <label><span>Session Cookie <small>推荐，可自动续期 Token</small></span><a-input-password v-model="model.traeDraft.session" placeholder="X-Cloudide-Session 的值" :input-attrs="{ 'aria-label': 'Trae Session', autocomplete: 'off' }" /></label>
      <details class="credential-help"><summary>如何获取 Session？</summary><p>在 Trae 官网登录后按 F12，打开「应用 / Application → Cookies → trae.cn」，复制 X-Cloudide-Session 的值。若会话过期，在官网重新登录并更新这里的凭证。</p></details>
      <label><span>Token <small>无 Session 时可填写，过期需重新更新</small></span><a-input-password v-model="model.traeDraft.token" placeholder="Cloud-IDE-Token / Cloud-IDE-JWT" :input-attrs="{ 'aria-label': 'Trae Token', autocomplete: 'off' }" /></label>
      <label><span>设备号 <small>选填，建议使用此账号客户端的真实设备号</small></span><a-input v-model="model.traeDraft.device_id" :max-length="20" placeholder="12 至 20 位数字 x-device-id" :input-attrs="{ 'aria-label': 'Trae 设备号', inputmode: 'numeric', autocomplete: 'off' }" /></label>
      <a-button type="primary" long size="large" html-type="submit" :disabled="!model.traeDraft.session.trim() && !model.traeDraft.token.trim()" :loading="model.busy.has('trae-add')">验证并保存 Trae 账号</a-button>
    </form>
    <div v-else class="trae-backup-fields">
      <p>选择 TraeTools 导出的加密账号备份，也支持包含 Accounts 的原始配置 JSON。</p>
      <input ref="fileInput" type="file" accept=".json,application/json" aria-label="选择 TraeTools 备份文件" class="file-input" @change="selected">
      <button class="file-drop" @click="fileInput.click()"><icon-upload /><strong>{{ file?.name || '选择 TraeTools JSON 文件' }}</strong><small>最大 8 MB · 支持加密备份</small></button>
      <label><span>备份口令 <small>加密备份必填</small></span><a-input-password v-model="password" placeholder="导出备份时设置的口令" :input-attrs="{ 'aria-label': 'TraeTools 备份口令', autocomplete: 'off' }" /></label>
      <a-alert v-if="result" :type="result.errors?.length ? 'warning' : 'success'">新增 {{ result.imported }} 个 · 更新 {{ result.updated }} 个 · 跳过 {{ result.skipped }} 个<div v-for="(error, index) in result.errors || []" :key="index">{{ error }}</div><div>导入后请刷新积分，以检查凭证有效性。</div></a-alert>
      <a-button type="primary" long size="large" :disabled="!file" :loading="model.busy.has('trae-import')" @click="importFile(model)">导入 Trae 账号</a-button>
    </div>
  </div>
</template>
