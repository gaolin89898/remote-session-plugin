/** Replace the old hand-drawn workspace styling with official-token equivalents. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(file, 'utf8');

const patches = [];

patches.push([`    var leftColumnStyle = {
      flex: '0 0 264px',
      width: 264,
      minWidth: 220,
      maxWidth: '42%',
      borderRight: '0.5px solid ' + BORDER,
      background: C.sidebarFill,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden',
      boxSizing: 'border-box',
      padding: '0 6px',
    };`, `    var leftColumnStyle = {
      flex: '0 0 280px',
      width: 280,
      minWidth: 240,
      maxWidth: '42%',
      borderRight: 'none',
      background: 'var(--dsw-specific-sidebar-fill, ' + C.sidebarFill + ')',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden',
      boxSizing: 'border-box',
      padding: '0 var(--dsh-sidebar-inline-padding, 8px) 8px',
    };`]);

patches.push([`    var columnHeaderStyle = {
      flex: '0 0 auto',
      padding: '12px 8px 4px',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.02em',
      color: C.labelCaption,
      whiteSpace: 'nowrap',
    };`, `    var columnHeaderStyle = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      height: 36,
      padding: '0 4px',
      marginTop: 2,
      marginBottom: 4,
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: 'normal',
      color: 'var(--dsw-alias-label-tertiary, ' + C.labelTertiary + ')',
      whiteSpace: 'nowrap',
      boxSizing: 'border-box',
    };`]);

patches.push([`        : h(
            'button',
            {
              type: 'button',
              onClick: props.onToggle,
              title: online ? displayName : displayName + '（离线）',
              onMouseEnter: hoverIn,
              onMouseLeave: function (event) {
                hoverOut(event);
              },
              style: merge(hostRowStyle, { opacity: online ? 1 : 0.55 }),
            },
            h(Chevron, { open: expanded }),
            h(Dot, { color: online ? SUCCESS : 'rgba(128, 128, 128, 0.6)', size: 7 }),
            h(
              'span',
              {
                style: {
                  flex: '1 1 auto',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              displayName,
            ),
            h('span', { style: merge(captionStyle, { flex: '0 0 auto' }) }, summary),
          );`, `        : h(
            'div',
            {
              role: 'button',
              tabIndex: 0,
              onClick: props.onToggle,
              title: online ? displayName : displayName + '（离线）',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                padding: '0 8px',
                boxSizing: 'border-box',
                fontSize: 12,
                lineHeight: '20px',
                color: 'var(--dsw-alias-label-tertiary, ' + C.labelTertiary + ')',
                cursor: 'pointer',
                opacity: online ? 1 : 0.55,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              },
            },
            h('span', { style: { flex: '0 0 auto', fontSize: 10, lineHeight: 1 } }, expanded ? '▾' : '▸'),
            h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, displayName),
            h('span', { style: { flex: '0 0 auto', opacity: 0.72 } }, summary),
          );`]);

patches.push([`                      : h(
                          'button',
                          {
                            type: 'button',
                            title: group.cwd || '该会话未记录工作区',
                            onClick: toggleGroup,
                            onMouseEnter: hoverIn,
                            onMouseLeave: function (event) {
                              hoverOut(event);
                            },
                            style: merge(workspaceHeaderStyle, { paddingLeft: 20, opacity: online ? 1 : 0.55 }),
                          },
                          h(Chevron, { open: !collapsed }),
                          h(FolderGlyph),
                          h(
                            'span',
                            {
                              style: {
                                flex: '1 1 auto',
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              },
                            },
                            group.label,
                          ),
                        );`, `                      : h(
                          'div',
                          {
                            role: 'button',
                            tabIndex: 0,
                            title: group.cwd || '该会话未记录工作区',
                            onClick: toggleGroup,
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              height: 34,
                              padding: '0 8px',
                              boxSizing: 'border-box',
                              borderRadius: 'var(--dsw-radius-md, 8px)',
                              fontSize: 14,
                              lineHeight: '20px',
                              color: 'var(--dsw-alias-label-primary, ' + C.labelPrimary + ')',
                              cursor: 'pointer',
                              opacity: online ? 1 : 0.55,
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                            },
                          },
                          h('span', { style: { flex: '0 0 auto', fontSize: 10, lineHeight: 1, opacity: 0.7 } }, collapsed ? '▸' : '▾'),
                          h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, group.label),
                        );`]);

patches.push([`                              return h(SessionRow, {
                                key: sessionId,
                                session: session,
                                online: online,
                                grouped: true,
                                selected: selected,
                                onSelect: openSession,
                              });`, `                              return h(
                                'div',
                                {
                                  key: sessionId,
                                  role: 'button',
                                  tabIndex: 0,
                                  title: (session && session.title) || sessionId,
                                  onClick: openSession,
                                  style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    height: 32,
                                    padding: '0 8px',
                                    paddingInlineStart: 24,
                                    boxSizing: 'border-box',
                                    borderRadius: 'var(--dsw-radius-md, 8px)',
                                    background: selected
                                      ? 'var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12))'
                                      : 'transparent',
                                    color: 'var(--dsw-alias-label-primary, ' + C.labelPrimary + ')',
                                    opacity: online ? 1 : 0.55,
                                    cursor: 'pointer',
                                    overflow: 'hidden',
                                    whiteSpace: 'nowrap',
                                  },
                                },
                                h(
                                  'span',
                                  { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 14, lineHeight: '20px' } },
                                  (session && session.title) || sessionId,
                                ),
                                h(
                                  'span',
                                  { style: { flex: '0 0 auto', fontSize: 10, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, ' + C.labelTertiary + ')' } },
                                  workspaceTime(session && session.updatedAt),
                                ),
                              );`]);

for (const [before, after] of patches) {
  if (!source.includes(before)) {
    console.warn('patch skipped (not found):', before.trim().slice(0, 60));
    continue;
  }
  source = source.replace(before, after);
}
fs.writeFileSync(file, source);
console.log('sidebar styles cleaned:', source.length, 'bytes');
