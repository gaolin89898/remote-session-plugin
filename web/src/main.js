import { createApp } from 'vue';
import '@arco-design/web-vue/dist/arco.css';
import App from './App.vue';
import './style.css';
import './desktop.css';
import './benefits.css';
import { initializeDesktop } from './desktop';

initializeDesktop();
createApp(App).mount('#app');
