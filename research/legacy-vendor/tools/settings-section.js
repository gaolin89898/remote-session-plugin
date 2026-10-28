    // ── official Settings page section ──────────────────────────────────────
    var settingsSectionInputStyle = {
      height: 32,
      padding: '0 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.26))',
      background: 'var(--dsw-alias-button-elevated-fill, transparent)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      outline: 'none',
      boxSizing: 'border-box',
      width: '100%',
    };

    /** One labelled row inside the official Settings page. */
    function SettingsSectionField(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
        h('span', null, props.label),
        h('input', {
          type: props.secret ? 'password' : 'text',
          value: props.value || '',
          placeholder: props.placeholder || '',
          disabled: props.disabled,
          onChange: function (event) {
            props.onChange(event.target.value);
          },
          'aria-label': props.label,
          style: settingsSectionInputStyle,
        }),
        props.hint ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, props.hint) : null,
      );
    }

    /**
     * Official Settings page section for the relay connection. Registered into
     * the shell's `settings.section` list so the panel is configured next to
     * the other product settings.
     */
    function RemoteConnectionSettingsSection(props) {
      var injected = props.injected || {};
      var formState = React.useState({ relayUrl: '', token: '', instanceId: '', instanceName: '' });
      var form = formState[0];
      var setForm = formState[1];
      var metaState = React.useState(null);
      var meta = metaState[0];
      var setMeta = metaState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var load = function () {
        if (typeof injected.load !== 'function') return;
        setBusy(true);
        setError(null);
        injected.load().then(
          function (data) {
            setBusy(false);
            setMeta(data || null);
            setForm({
              relayUrl: data && data.relayUrl ? String(data.relayUrl) : '',
              token: '',
              instanceId: data && data.instanceId ? String(data.instanceId) : '',
              instanceName: data && data.instanceName ? String(data.instanceName) : '',
            });
          },
          function (loadError) {
            setBusy(false);
            setError(String((loadError && loadError.message) || loadError));
          },
        );
      };

      React.useEffect(load, []);

      var update = function (key) {
        return function (value) {
          setForm(function (previous) {
            var next = Object.assign({}, previous);
            next[key] = value;
            return next;
          });
        };
      };

      var save = function () {
        if (busy || typeof injected.save !== 'function') return;
        setBusy(true);
        setError(null);
        injected.save(form).then(
          function (saved) {
            setBusy(false);
            setMeta(saved || null);
            setForm(function (previous) {
              var next = Object.assign({}, previous);
              next.token = '';
              return next;
            });
          },
          function (saveError) {
            setBusy(false);
            setError(String((saveError && saveError.message) || saveError));
          },
        );
      };

      var connected = !!(meta && meta.relay && meta.relay.connected);
      return h(
        'div',
        {
          'aria-label': '远程会话设置',
          style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 },
        },
        h(
          'p',
          { style: { margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)' } },
          '设置本机连接的中转 relay。保存后立即重连；其它设备需使用同一个 relay 与令牌。',
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', {
            style: {
              width: 8,
              height: 8,
              borderRadius: 999,
              background: connected ? 'var(--dsw-alias-state-success-primary, #2da44e)' : 'var(--dsw-alias-state-warning-primary, #d4a72c)',
            },
          }),
          h('span', null, connected ? 'relay 已连接' : 'relay 未连接'),
          meta && meta.relay && meta.relay.lastError
            ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary, #d1242f)' } }, '· ' + String(meta.relay.lastError))
            : null,
        ),
        SettingsSectionField({
          label: 'Relay 地址',
          value: form.relayUrl,
          placeholder: 'http://127.0.0.1:3098',
          disabled: busy,
          onChange: update('relayUrl'),
        }),
        SettingsSectionField({
          label: '访问令牌',
          value: form.token,
          secret: true,
          placeholder: meta && meta.hasToken ? '已设置（留空保持不变）' : '填写 relay 令牌',
          disabled: busy,
          onChange: update('token'),
        }),
        SettingsSectionField({ label: '实例 ID', value: form.instanceId, placeholder: 'company', disabled: busy, onChange: update('instanceId') }),
        SettingsSectionField({ label: '实例名称', value: form.instanceName, placeholder: '公司', disabled: busy, onChange: update('instanceName') }),
        error ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d1242f)' } }, error) : null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: save,
              style: {
                height: 30,
                padding: '0 14px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-button-primary-fill, #4d6bfe)',
                background: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
                color: 'var(--dsw-alias-button-primary-label, #fff)',
                font: 'inherit',
                fontSize: 13,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            },
            busy ? '连接中…' : '保存并重连',
          ),
        ),
      );
    }
