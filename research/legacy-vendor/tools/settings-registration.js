          mountWhenDeclared('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'remote-session',
                order: 90,
                label: function () {
                  return '远程会话';
                },
                inject: function () {
                  return {
                    load: function () {
                      return post('settings', {});
                    },
                    save: function (form) {
                      return post('settings-save', {
                        relayUrl: form.relayUrl,
                        token: form.token,
                        instanceId: form.instanceId,
                        instanceName: form.instanceName,
                      });
                    },
                  };
                },
              },
              RemoteConnectionSettingsSection,
            );
          });
