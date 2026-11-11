// Login page laid out like the design: brand panel on the left, account form on
// the right, single dark appearance (no theme switch).
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DesktopOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GithubOutlined,
  GlobalOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useState } from 'react'
import { api, type Account } from './api'

export function LoginPanel({
  onAuthSuccess,
  initialError,
  embedded = false,
}: {
  onAuthSuccess: (account: Account) => void
  initialError?: string
  embedded?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError ?? '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [keepSignedIn, setKeepSignedIn] = useState(true)
  const [showPassword, setShowPassword] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const result = await api<Account>('/auth/login', {
        email: email.trim(),
        password,
      })
      setPassword('')
      onAuthSuccess(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试。')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className={`dx-auth${embedded ? ' is-embedded' : ''}`}>
      {!embedded && (
        <aside className="dx-auth-brand">
          <div className="dx-brand-row">
            <a className="dx-brand-lockup" href="/" aria-label="DSH Remote 首页">
              <img src="/brand-whale.webp" alt="" width="26" height="19" />
              <span>DSH Remote</span>
            </a>
            <span className="dx-self-badge"><i />SELF-HOSTED</span>
          </div>

          <div className="dx-brand-message">
            <span className="dx-eyebrow">Welcome back</span>
            <h1>回到你的<em>工作现场。</em></h1>
            <p>用同一个账号登录所有客户端，接上那台一直在运行的 Harness。工作区留在原处，只把会话接过来。</p>

            <div className="dx-session">
              <div className="dx-session-head">
                <span>Secure session</span>
                <span className="dx-session-live"><i />ACTIVE</span>
              </div>
              <div className="dx-session-row">
                <DesktopOutlined />
                <span className="dx-session-copy">
                  <strong>MacBook Pro</strong>
                  <small>macOS · Host · 3 workspaces</small>
                </span>
                <span className="dx-session-pill">online</span>
              </div>
              <div className="dx-session-row">
                <GlobalOutlined />
                <span className="dx-session-copy">
                  <strong>iPhone 15 Pro</strong>
                  <small>Remote · 已连接 2 分钟</small>
                </span>
                <ArrowRightOutlined style={{ color: '#7a818e' }} />
              </div>
            </div>

            <ul className="dx-features">
              <li><SafetyCertificateOutlined />端到端加密</li>
              <li><ThunderboltOutlined />P2P 直连</li>
              <li><GlobalOutlined />多端同步</li>
            </ul>
          </div>

          <div className="dx-brand-foot">
            <span>DSH REMOTE · SELF-HOSTED</span>
            <span><i />ALL SYSTEMS NORMAL</span>
          </div>
        </aside>
      )}

      <section className="dx-auth-form">
        {!embedded && (
          <div className="dx-form-top">
            <a href="/"><ArrowLeftOutlined />返回首页</a>
            <div className="dx-form-top-actions">
              <a href="https://github.com/gaolin89898/remote-session-plugin" target="_blank" rel="noreferrer">
                <GithubOutlined />GitHub
              </a>
            </div>
          </div>
        )}

        <div className="dx-form-wrap">
          <span className="dx-eyebrow">Account access</span>
          <h2>账号登录</h2>
          <p>登录到你的 Remote 实例，管理已授权的 Host 与设备。</p>

          {error && <div className="dx-auth-error" role="alert">{error}</div>}

          <form onSubmit={submit} className="dx-form-fields">
            <div className="dx-field">
              <label htmlFor="dx-account">账号 / 邮箱</label>
              <input
                id="dx-account"
                className="dx-input"
                value={email}
                autoComplete="username"
                placeholder="请输入账号 / 邮箱"
                onChange={event => setEmail(event.target.value)}
              />
            </div>

            <div className="dx-field">
              <div className="dx-field-head">
                <label htmlFor="dx-password">密码</label>
                <small>ENCRYPTED</small>
              </div>
              <div className="dx-input-wrap">
                <input
                  id="dx-password"
                  className="dx-input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  onChange={event => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="dx-eye"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword(value => !value)}
                >
                  {showPassword ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                </button>
              </div>
            </div>

            <div className="dx-field-head">
              <label className="dx-check">
                <input
                  type="checkbox"
                  checked={keepSignedIn}
                  onChange={event => setKeepSignedIn(event.target.checked)}
                />
                保持登录状态
              </label>
              <small>30 DAYS</small>
            </div>

            <button className="dx-submit" type="submit" disabled={loading}>
              <LockOutlined />
              {loading ? '正在登录…' : '登录'}
              <ArrowRightOutlined />
            </button>
          </form>

          <p className="dx-note">
            <SafetyCertificateOutlined />
            此页面由你的自建服务提供，凭据不会发送给第三方。
          </p>

          <p className="dx-alt-action">
            还没有账号？<a href="https://github.com/gaolin89898/remote-session-plugin#readme" target="_blank" rel="noreferrer">查看自建指南<ArrowRightOutlined /></a>
          </p>
        </div>

        {!embedded && (
          <div className="dx-form-foot">
            <span>© 2025 DSH REMOTE · SELF-HOSTED</span>
            <nav>
              <a href="https://github.com/gaolin89898/remote-session-plugin/blob/main/docs" target="_blank" rel="noreferrer">文档</a>
              <a href="https://github.com/gaolin89898/remote-session-plugin" target="_blank" rel="noreferrer">GitHub</a>
              <a href="https://github.com/gaolin89898/remote-session-plugin/issues" target="_blank" rel="noreferrer">问题反馈</a>
            </nav>
          </div>
        )}
      </section>
    </main>
  )
}
