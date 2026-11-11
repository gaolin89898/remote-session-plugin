// Devices console laid out like the design: topbar with section nav, page head,
// stat strip, endpoint card and a table + insights rail grid.
import { Popconfirm, message } from 'antd'
import {
  AndroidOutlined,
  AppleOutlined,
  CheckOutlined,
  CloudServerOutlined,
  CopyOutlined,
  DeleteOutlined,
  DesktopOutlined,
  EditOutlined,
  ExportOutlined,
  GithubOutlined,
  GlobalOutlined,
  LockOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WindowsOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiDelete, RequestError, type Device, type DeviceList } from './api'

function platformIcon(platform: string) {
  const p = (platform || '').toLowerCase()
  if (p.includes('win') || p === 'win32') return <WindowsOutlined />
  if (p.includes('darwin') || p.includes('mac') || p.includes('apple')) return <AppleOutlined />
  if (p.includes('android')) return <AndroidOutlined />
  if (p.includes('linux')) return <CloudServerOutlined />
  return <DesktopOutlined />
}

function platformName(platform: string) {
  const map: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' }
  return map[platform] ?? platform
}

export function DevicesPage({ account, onSignedOut, embedded = false }: { account: string; onSignedOut: () => void; embedded?: boolean }) {
  const [result, setResult] = useState<DeviceList>()
  const [loading, setLoading] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  const [renaming, setRenaming] = useState<Device>()
  const [newName, setNewName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api<DeviceList>('/account/devices')
      setResult(data)
      setUpdated(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    } catch (err) {
      if (err instanceof RequestError && err.status === 401) onSignedOut()
      else setError(err instanceof Error ? err.message : '加载失败，请重试。')
    } finally {
      setLoading(false)
    }
  }, [onSignedOut])

  useEffect(() => { void load() }, [load])

  async function submitRename() {
    if (!renaming) return
    const name = newName.trim()
    if (!name) { setError('设备名称不能为空'); return }
    setSavingName(true)
    setError('')
    try {
      await api(`/devices/${encodeURIComponent(renaming.deviceId)}/name`, { name })
      setRenaming(undefined)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '改名失败，请重试。')
    } finally {
      setSavingName(false)
    }
  }

  async function logout() {
    setLoggingOut(true)
    try {
      await api('/auth/logout', {})
      onSignedOut()
    } catch (err) {
      setError(err instanceof Error ? err.message : '退出失败，请重试。')
    } finally {
      setLoggingOut(false)
    }
  }

  async function copyAddress() {
    const url = result?.serverUrl
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      void message.success('已复制服务地址到剪贴板')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      void message.error('复制失败，请手动复制')
    }
  }

  async function removeDevice(device: Device) {
    setError('')
    try {
      await apiDelete(`/account/devices/${encodeURIComponent(device.deviceId)}`)
      await load()
      void message.success('设备已删除')
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败，请重试。')
    }
  }

  const devices = useMemo(
    () => [...(result?.items ?? [])].sort((a, b) => Number(b.online) - Number(a.online)),
    [result],
  )
  const online = devices.filter(d => d.online).length
  const total = devices.length
  const offline = total - online
  const onlinePercent = total === 0 ? 0 : Math.round((online / total) * 100)
  const transport = result?.transport ? result.transport.toUpperCase() : 'E2E'
  const accountInitial = account.trim().slice(0, 1).toUpperCase() || 'D'

  return (
    <div className="dx-console">
      {!embedded && (
        <header className="dx-topbar">
          <div className="dx-topbar-brand">
            <img src="/brand-whale.webp" alt="" width="22" height="16" />
            <strong>DSH Remote</strong>
            <i />
            <span>CONSOLE</span>
          </div>

          <div className="dx-topbar-actions">
            <span className="dx-sys"><i />系统正常</span>
            <i />
            <span className="dx-account">
              <span className="dx-account-avatar">{accountInitial}</span>
              <span className="dx-account-copy">
                <strong>{account}</strong>
                <small>verified</small>
              </span>
            </span>
            <Popconfirm title="确认退出登录？" okText="退出" cancelText="取消" onConfirm={() => void logout()}>
              <button type="button" className="dx-icon-btn" aria-label="退出登录" title="退出登录" disabled={loggingOut}>
                <LogoutOutlined />
              </button>
            </Popconfirm>
          </div>
        </header>
      )}

      <main className="dx-main" id="main-content">
        <div className="dx-page-head">
          <div>
            <span className="dx-eyebrow">Control center</span>
            <h1>我的设备</h1>
            <p>管理所有连接到此 Remote 实例的 Host 与客户端设备。</p>
          </div>
          <div className="dx-head-actions">
            <button type="button" className="dx-btn" onClick={() => void load()} disabled={loading}>
              <ReloadOutlined spin={loading} />刷新
            </button>
          </div>
        </div>

        {error && <div className="dx-alert" role="alert">{error}</div>}

        <section className="dx-stats" aria-label="设备概览">
          <div className="dx-stat">
            <div className="dx-stat-value">
              <strong className="is-green">{online}</strong>
              <span className="dx-pill is-green"><i />活跃</span>
            </div>
            <div className="dx-stat-label">在线设备</div>
            <div className="dx-stat-meta">/ {total} 台已注册</div>
          </div>
          <div className="dx-stat">
            <div className="dx-stat-value"><strong>{total}</strong></div>
            <div className="dx-stat-label">已注册设备</div>
            <div className="dx-stat-meta">{offline} 台离线</div>
          </div>
          <div className="dx-stat">
            <div className="dx-stat-value"><strong className="is-accent">{transport}</strong></div>
            <div className="dx-stat-label">加密通道</div>
            <div className="dx-stat-meta">WebRTC · DTLS</div>
          </div>
          <div className="dx-stat">
            <div className="dx-stat-value"><strong>{updated || '—'}</strong></div>
            <div className="dx-stat-label">最后同步</div>
            <div className="dx-stat-meta">点击刷新同步</div>
          </div>
        </section>

        <section className="dx-endpoint" aria-label="远程服务地址">
          <span className="dx-endpoint-icon"><GlobalOutlined /></span>
          <div className="dx-endpoint-copy">
            <div className="dx-endpoint-head">
              <strong>远程服务地址</strong>
              <span>HTTPS · 443</span>
            </div>
            <code className="dx-endpoint-url">{result?.serverUrl ?? '加载中…'}</code>
          </div>
          <div className="dx-endpoint-actions">
            <span className="dx-pill is-green"><i />运行中</span>
            <button type="button" className="dx-btn is-primary" onClick={() => void copyAddress()}>
              {copied ? <CheckOutlined /> : <CopyOutlined />}{copied ? '已复制' : '复制地址'}
            </button>
            {result?.serverUrl && (
              <a className="dx-icon-btn" href={result.serverUrl} target="_blank" rel="noreferrer" aria-label="打开服务地址" title="打开服务地址">
                <ExportOutlined />
              </a>
            )}
          </div>
        </section>
        <p className="dx-endpoint-tip">在需要受控或发起连接的主机插件配置及移动客户端中填入此地址，即可自动加入同一加密通信网络。</p>

        <div className="dx-grid">
          <section className="dx-card" aria-label="设备状态与列表">
            <div className="dx-card-head">
              <strong>设备状态与列表</strong>
              <span>{online} / {total} 台在线</span>
            </div>

            {devices.length === 0 ? (
              <div className="dx-empty">
                {loading ? '正在加载设备…' : '暂无已注册设备，请在客户端配置此服务地址完成绑定'}
              </div>
            ) : (
              <table className="dx-table">
                <thead>
                  <tr>
                    <th>设备</th>
                    <th>状态</th>
                    <th>角色</th>
                    <th>系统</th>
                    <th>版本</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {devices.map(device => (
                    <tr key={device.deviceId} className={device.online ? '' : 'is-dim'}>
                      <td>
                        {renaming?.deviceId === device.deviceId ? (
                          <div className="dx-rename">
                            <input
                              value={newName}
                              autoFocus
                              maxLength={80}
                              onChange={event => setNewName(event.target.value)}
                              onKeyDown={event => {
                                if (event.key === 'Enter') void submitRename()
                                if (event.key === 'Escape') setRenaming(undefined)
                              }}
                            />
                            <button type="button" className="is-primary" disabled={savingName} onClick={() => void submitRename()}>
                              {savingName ? '保存中' : '保存'}
                            </button>
                            <button type="button" onClick={() => setRenaming(undefined)}>取消</button>
                          </div>
                        ) : (
                          <div className="dx-device-cell">
                            <span className="dx-device-icon">{platformIcon(device.platform)}</span>
                            <span>
                              <strong>{device.name}</strong>
                              <small>{device.deviceId.slice(0, 12)}…</small>
                            </span>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`dx-pill ${device.online ? 'is-green' : 'is-grey'}`}>
                          <i />{device.online ? '在线' : '离线'}
                        </span>
                      </td>
                      <td>
                        <span className="dx-role-chips">
                          {(device.roles ?? [device.role]).map(role => (
                            <span key={role} className={`dx-chip${role === 'host' ? ' is-host' : ''}`}>
                              {role === 'host' ? <CloudServerOutlined /> : <DesktopOutlined />}
                              {role === 'host' ? 'Host' : '客户端'}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td><span className="dx-version">{platformName(device.platform)}</span></td>
                      <td>
                        <span className="dx-version">
                          {device.clientVersion ? `v${device.clientVersion}` : '—'}
                          {device.harnessVersion ? ` · v${device.harnessVersion}` : ''}
                        </span>
                      </td>
                      <td>
                        <span className="dx-row-actions">
                          <button
                            type="button"
                            className="dx-icon-btn"
                            aria-label="修改设备名称"
                            title="修改设备名称"
                            onClick={() => { setRenaming(device); setNewName(device.name) }}
                          >
                            <EditOutlined />
                          </button>
                          <Popconfirm
                            title="删除这个设备？"
                            description="删除后该设备需要重新登录才能再次接入。"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => void removeDevice(device)}
                          >
                            <button type="button" className="dx-icon-btn is-danger" aria-label="删除设备" title="删除设备">
                              <DeleteOutlined />
                            </button>
                          </Popconfirm>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <aside className="dx-rail">
            <section className="dx-card">
              <div className="dx-card-head">
                <strong>连接概览</strong>
                <span className="dx-pill is-green"><i />实时</span>
              </div>
              <div className="dx-rail-body">
                <div className="dx-quality-value">
                  <strong>{onlinePercent}</strong><span>%</span>
                </div>
                <div className="dx-quality-label">当前设备在线比例</div>
                <div className="dx-bars" aria-hidden="true">
                  {devices.length === 0
                    ? Array.from({ length: 12 }, (_, index) => <i key={index} className="is-off" />)
                    : devices.map(device => (
                      <i key={device.deviceId} className={device.online ? 'is-on' : 'is-off'} />
                    ))}
                </div>
                <div className="dx-kv"><span>在线</span><span>{online}</span></div>
                <div className="dx-kv"><span>离线</span><span>{offline}</span></div>
                <div className="dx-kv"><span>传输方式</span><span>{transport}</span></div>
              </div>
            </section>

            <section className="dx-card">
              <div className="dx-card-head">
                <strong>会话信息</strong>
                <a href="https://github.com/gaolin89898/remote-session-plugin" target="_blank" rel="noreferrer" style={{ color: 'var(--dx-accent)', fontSize: 10 }}>
                  GitHub ↗
                </a>
              </div>
              <div className="dx-rail-body">
                <div className="dx-kv"><span>账号</span><span>{account}</span></div>
                <div className="dx-kv"><span>最后同步</span><span>{updated || '—'}</span></div>
                <div className="dx-kv"><span>加密</span><span>端到端</span></div>
                <div className="dx-tip"><LockOutlined /><span><code>dsh plugin list</code> · 查看已安装插件</span></div>
              </div>
            </section>
          </aside>
        </div>

        <div className="dx-note-bar">
          <SafetyCertificateOutlined />
          <span>所有设备会话均在设备间端到端加密，自建服务无法读取内容。</span>
          <a href="https://github.com/gaolin89898/remote-session-plugin/blob/main/docs/protocol.md" target="_blank" rel="noreferrer">安全模型 →</a>
        </div>
      </main>

      {!embedded && (
        <footer className="dx-foot">
          <span>© 2025 DSH REMOTE · SELF-HOSTED</span>
          <nav>
            <span className="dx-foot-status"><i />ALL SYSTEMS NORMAL</span>
            <a href="https://github.com/gaolin89898/remote-session-plugin/blob/main/docs" target="_blank" rel="noreferrer">文档</a>
            <a href="https://github.com/gaolin89898/remote-session-plugin" target="_blank" rel="noreferrer"><GithubOutlined /> GitHub</a>
            <a href="https://github.com/gaolin89898/remote-session-plugin/issues" target="_blank" rel="noreferrer">支持</a>
          </nav>
        </footer>
      )}
    </div>
  )
}
