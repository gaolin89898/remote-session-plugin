<script setup>
import { ref } from 'vue';
import { Alert as AAlert, Button as AButton, Input as AInput, InputPassword as AInputPassword } from '@arco-design/web-vue';
import { IconExport, IconSafe } from '@arco-design/web-vue/es/icon';
const props = defineProps({ model: Object });
const tab = ref('login');
const quiet = promise => promise?.catch(() => {});
function selectTab(value) { props.model.stopQoderLogin(); tab.value = value; }
</script>

<template>
  <div class="dialog-tabs" role="tablist" aria-label="Qoder 添加方式"><button role="tab" :aria-selected="tab === 'login'" :class="{ active: tab === 'login' }" @click="selectTab('login')"><icon-export />浏览器授权</button><button role="tab" :aria-selected="tab === 'token'" :class="{ active: tab === 'token' }" @click="selectTab('token')"><icon-safe />访问令牌</button></div>
  <a-alert v-if="model.qoderDraft.uid" type="info">正在更新 {{ model.qoderDraft.nickname || model.qoderDraft.uid }}，请使用同一账号授权。</a-alert>
  <div v-if="tab === 'login'" class="login-panel" role="tabpanel">
    <p class="dialog-intro">Qoder 国内版 · 阿里云账号授权</p>
    <a-alert v-if="model.qoderLogin.error" type="error" class="login-error">{{ model.qoderLogin.error }}</a-alert>
    <a-button v-if="!model.qoderLogin.url || model.qoderLogin.error" type="primary" long size="large" :loading="model.busy.has('qoder-login')" @click="quiet(model.startQoderLogin())"><template #icon><icon-export /></template>{{ model.qoderLogin.error ? '重新获取授权链接' : '获取授权链接' }}</a-button>
    <div v-if="model.qoderLogin.url" class="authorization"><a class="authorization-link" :href="model.qoderLogin.url" target="_blank" rel="noopener noreferrer"><icon-export />打开 Qoder 授权页面</a><div class="inline-between"><span><i class="status-dot" />{{ model.qoderLogin.waiting ? '等待浏览器授权' : '授权已暂停' }}</span><a-button type="text" @click="model.stopQoderLogin()">取消本次授权</a-button></div></div>
    <p class="dialog-login-status">每日奖励 10:00 更新 · 每轮 100 Credits</p>
  </div>
  <form v-else class="key-form" @submit.prevent="quiet(model.addQoder())">
    <label>账号备注<a-input v-model="model.qoderDraft.nickname" :max-length="80" placeholder="选填" :input-attrs="{ 'aria-label': 'Qoder 账号备注' }" /></label>
    <label>Qoder PAT / 访问令牌<a-input-password v-model="model.qoderDraft.token" placeholder="pt- / dt- / jt-" :input-attrs="{ 'aria-label': 'Qoder 访问令牌', autocomplete: 'off' }" /></label>
    <div class="modal-actions"><a-button type="primary" html-type="submit" :disabled="!model.qoderDraft.token.trim()" :loading="model.busy.has('qoder-add')">验证并添加</a-button></div>
  </form>
</template>
