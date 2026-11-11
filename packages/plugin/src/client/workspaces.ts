import { createHostPairingPanel } from './pairing.js'
import { createServerNotice } from './server-notice.js'
import { renderBodyPortal } from './portal.js'
import QRCode from 'qrcode'
import { ArrowLeftRight, ChevronRight, FolderOpen, LogOut, Monitor, Plus, Power, RefreshCw, Search, Settings2, ShieldCheck, Smartphone, X } from 'lucide'
import type { Translate } from '../client-locale.js'
import type { OAuthProviderInfo } from '../server-api.js'
import type { StatusFeed } from '../status-stream.js'
import { compareVersions } from '../version-compare.js'
import { whaleMarkPath, whaleMarkViewBox } from './brand.js'
import { gptWorkspaceIcon } from './icons.js'
import { pendingWorkspaceSelectionKey } from './navigation.js'
import { connectedClientModeLabel, connectedProgress, connectionErrorMessage, displayRemoteAccount, formatPlatform, messageOf, startupErrorMessage } from './presentation.js'
import { createRemoteProgressView, runConnectHostProgress } from './progress.js'
import type {
  ClientReact,
  CodexWorkspaceView,
  CursorWorkspaceView,
  LoginMethod,
  OAuthProvider,
  OAuthQrPollResult,
  OAuthQrSession,
  RemoteConnectionProgress,
  RemoteDevice,
  RemoteDirectoryListing,
  RemoteStatus,
  RemoteWorkspaceView,
  PluginSettingsView,
  PortalRenderer,
  SidebarEntryPreference,
  SidebarEntryStyle,
} from './types.js'

function glyph(React: ClientReact, icon: typeof Monitor): unknown {
  return React.createElement('svg', {
    viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: false,
  }, ...(icon[2] ?? []).map(([tag, attributes], key) => React.createElement(tag, { ...attributes, key })))
}

function hostDeviceGlyph(React: ClientReact, platform: string): unknown {
  return glyph(React, /android|ios|iphone|ipad/i.test(platform) ? Smartphone : Monitor)
}

function footerAccountName(status: RemoteStatus | undefined, t: Translate): string {
  return status?.host?.account === undefined ? status?.deviceName ?? t('account') : displayRemoteAccount(status.host.account)
}

function accountInitial(label: string): string {
  const trimmed = label.trim()
  return trimmed.length === 0 ? '·' : trimmed.slice(0, 1).toUpperCase()
}

export function createRemoteWorkspaceAction(React: ClientReact, portal?: PortalRenderer) {
  const ServerNotice = createServerNotice(React)
  const HostPairingPanel = createHostPairingPanel(React)
  const RemoteProgressView = createRemoteProgressView(React)

  /**
   * Renders the Compact entry at the end of the host account row. The host
   * exposes no slot there, so the button is portalled into the settings row; the
   * Standard entry stays in place until that row exists, so nothing is lost when
   * the sidebar is collapsed.
   */
  function RemoteAccountEntry(props: {
    portal: PortalRenderer | undefined
    fallback: unknown
    children: unknown
  }): unknown {
    const [container, setContainer] = React.useState<Element | null>(null)
    const { portal } = props
    React.useEffect(() => {
      if (portal === undefined) return undefined
      let attempt = 0
      let timer: number | undefined
      let host: HTMLElement | undefined
      let observer: MutationObserver | undefined
      const attach = (): void => {
        const row = document.querySelector('[class*="settingsArea"] [class*="triggerRow"]')
        if (row === null) {
          // The row mounts with the footer area; give the host a moment before
          // settling for the Standard entry.
          if (attempt < 40) {
            attempt += 1
            timer = window.setTimeout(attach, 50)
          }
          return
        }
        host = document.createElement('span')
        // The host re-renders its row without React knowing about this node, so
        // put it back whenever it is dropped.
        observer = new MutationObserver(() => {
          if (host !== undefined && !host.isConnected) row.append(host)
        })
        observer.observe(row, { childList: true })
        row.append(host)
        setContainer(host)
      }
      attach()
      return () => {
        if (timer !== undefined) window.clearTimeout(timer)
        observer?.disconnect()
        host?.remove()
      }
    }, [portal])
    if (typeof portal !== 'function' || container === null) return props.fallback
    // The Compact entry is portalled into a host-owned row, so a stale or
    // detached container must not blank the sidebar; fall back in place.
    try {
      return portal(props.children, container)
    } catch {
      return props.fallback
    }
  }

  function RemoteWorkspaceAction(props: {
    wide: boolean
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    statusFeed: StatusFeed<RemoteStatus>
    subscribeOpen: (listener: () => void) => () => void
    preferredQrProvider: OAuthProvider
    sidebarEntry: SidebarEntryPreference
    portal?: PortalRenderer
    t: Translate
    openSettings?: () => void
  }): unknown {
    const { t } = props
    const connectionErrorMessageFor = (reason: unknown, translate: Translate): string => {
      if (typeof reason === 'object' && reason !== null && 'code' in reason) {
        const code = (reason as { code?: unknown }).code
        if (typeof code === 'string') return connectionErrorMessage(code, translate)
      }
      return messageOf(reason, translate)
    }
    const [open, setOpen] = React.useState(false)
    const [status, setStatus] = React.useState<RemoteStatus | undefined>(undefined)
    const [devices, setDevices] = React.useState<RemoteDevice[]>([])
    const [hostFilter, setHostFilter] = React.useState('all')
    const [hostFilterOpen, setHostFilterOpen] = React.useState(false)
    const [accountMenuOpen, setAccountMenuOpen] = React.useState(false)
    const [workspaceSearch, setWorkspaceSearch] = React.useState('')
    const [discoveryUnavailable, setDiscoveryUnavailable] = React.useState(false)
    const [selectedHost, setSelectedHost] = React.useState<RemoteDevice | undefined>(undefined)
    // The Host being connected right now: its row stays visible as a collapsed
    // summary so the progress panel below it is on screen without scrolling.
    const [connectingHost, setConnectingHost] = React.useState<RemoteDevice | undefined>(undefined)
    const [workspaces, setWorkspaces] = React.useState<RemoteWorkspaceView[]>([])
    const [codexWorkspaces, setCodexWorkspaces] = React.useState<CodexWorkspaceView[]>([])
    const [cursorWorkspaces, setCursorWorkspaces] = React.useState<CursorWorkspaceView[]>([])
    const [antigravityWorkspaces, setAntigravityWorkspaces] = React.useState<CursorWorkspaceView[]>([])
    const [piWorkspaces, setPiWorkspaces] = React.useState<CursorWorkspaceView[]>([])
    const [opencodeWorkspaces, setOpencodeWorkspaces] = React.useState<CursorWorkspaceView[]>([])
    const [claudeWorkspaces, setClaudeWorkspaces] = React.useState<CursorWorkspaceView[]>([])
    const [hermesWorkspaces, setHermesWorkspaces] = React.useState<CursorWorkspaceView[]>([])
    const [workspaceBackend, setWorkspaceBackend] = React.useState<'harness' | 'codex' | 'cursor' | 'antigravity' | 'pi' | 'opencode' | 'claude' | 'hermes'>('harness')
    const [codexWorkspaceId, setCodexWorkspaceId] = React.useState<string | undefined>(undefined)
    const [cursorWorkspaceId, setCursorWorkspaceId] = React.useState<string | undefined>(undefined)
    const [antigravityWorkspaceId, setAntigravityWorkspaceId] = React.useState<string | undefined>(undefined)
    const [piWorkspaceId, setPiWorkspaceId] = React.useState<string | undefined>(undefined)
    const [opencodeWorkspaceId, setOpencodeWorkspaceId] = React.useState<string | undefined>(undefined)
    const [claudeWorkspaceId, setClaudeWorkspaceId] = React.useState<string | undefined>(undefined)
    const [hermesWorkspaceId, setHermesWorkspaceId] = React.useState<string | undefined>(undefined)
    const [directory, setDirectory] = React.useState<RemoteDirectoryListing | undefined>(undefined)
    const [path, setPath] = React.useState('')
    // The folder highlighted in the directory browser: it is the workspace the
    // confirm button will open, while `directory` keeps tracking the level the
    // user is browsing (the design separates picking from descending).
    const [pickedDirectoryPath, setPickedDirectoryPath] = React.useState<string | undefined>(undefined)
    const [addingWorkspace, setAddingWorkspace] = React.useState(false)
    const [showAllWorkspaces, setShowAllWorkspaces] = React.useState(false)
    const [showAllCodexWorkspaces, setShowAllCodexWorkspaces] = React.useState(false)
    const [devicesOpen, setDevicesOpen] = React.useState(false)
    const [restartingHost, setRestartingHost] = React.useState<string | undefined>(undefined)
    const [showAllCursorWorkspaces, setShowAllCursorWorkspaces] = React.useState(false)
    const [showAllAntigravityWorkspaces, setShowAllAntigravityWorkspaces] = React.useState(false)
    const [showAllPiWorkspaces, setShowAllPiWorkspaces] = React.useState(false)
    const [showAllOpencodeWorkspaces, setShowAllOpencodeWorkspaces] = React.useState(false)
    const [showAllClaudeWorkspaces, setShowAllClaudeWorkspaces] = React.useState(false)
    const [showAllHermesWorkspaces, setShowAllHermesWorkspaces] = React.useState(false)
    const workspaceListId = 'dsh-remote-workspace-list'
    const codexWorkspaceHeadingId = 'dsh-remote-codex-workspace-heading'
    const codexWorkspaceListId = 'dsh-remote-codex-workspace-list'
    const cursorWorkspaceHeadingId = 'dsh-remote-cursor-workspace-heading'
    const cursorWorkspaceListId = 'dsh-remote-cursor-workspace-list'
    const antigravityWorkspaceHeadingId = 'dsh-remote-antigravity-workspace-heading'
    const piWorkspaceHeadingId = 'dsh-remote-pi-workspace-heading'
    const opencodeWorkspaceHeadingId = 'dsh-remote-opencode-workspace-heading'
    const claudeWorkspaceHeadingId = 'dsh-remote-claude-workspace-heading'
    const hermesWorkspaceHeadingId = 'dsh-remote-hermes-workspace-heading'
    const antigravityWorkspaceListId = 'dsh-remote-antigravity-workspace-list'
    const piWorkspaceListId = 'dsh-remote-pi-workspace-list'
    const opencodeWorkspaceListId = 'dsh-remote-opencode-workspace-list'
    const claudeWorkspaceListId = 'dsh-remote-claude-workspace-list'
    const hermesWorkspaceListId = 'dsh-remote-hermes-workspace-list'
    const [busy, setBusy] = React.useState(false)
    // Remain undecided until local credentials or an explicit auth rejection
    // establish that login is required. Network failures are not sign-outs.
    const [needsAuthorization, setNeedsAuthorization] = React.useState<boolean | undefined>(undefined)
    const [email, setEmail] = React.useState('')
    const [password, setPassword] = React.useState('')
    const [loginServerUrl, setLoginServerUrl] = React.useState('https://remote.gaolin.ink')
    const [editingServer, setEditingServer] = React.useState(false)
    const [savingServer, setSavingServer] = React.useState(false)
    const serverDirty = loginServerUrl.trim() !== (status?.serverUrl ?? '')
    const [loginMethod, setLoginMethod] = React.useState<LoginMethod | 'device_pairing'>('password')
    const loginMethodManuallySelected = React.useRef(false)
    const [oauthProviders, setOAuthProviders] = React.useState<OAuthProviderInfo[]>([])
    const [providersLoading, setProvidersLoading] = React.useState(false)
    const [providersFailed, setProvidersFailed] = React.useState(false)
    const [pairingServerUrl, setPairingServerUrl] = React.useState<string | undefined>(undefined)
    const pairingAvailable = pairingServerUrl !== undefined && pairingServerUrl === status?.serverUrl
    const [providerReload, setProviderReload] = React.useState(0)
    const providerRequestRun = React.useRef(0)
    const [qrSession, setQrSession] = React.useState<OAuthQrSession | undefined>(undefined)
    const [qrImage, setQrImage] = React.useState<string | undefined>(undefined)
    const [qrExpired, setQrExpired] = React.useState(false)
    const [hostEmail, setHostEmail] = React.useState('')
    const [hostPassword, setHostPassword] = React.useState('')
    const [hostRegistrationCode, setHostRegistrationCode] = React.useState('')
    const [progress, setProgress] = React.useState<RemoteConnectionProgress | undefined>(undefined)
    const progressRun = React.useRef(0)
    const qrFlowRun = React.useRef(0)
    const pageRef = React.useRef<HTMLElement | null>(null)
    const hostFilterMenuRef = React.useRef<HTMLDivElement | null>(null)
    const hostFilterTriggerRef = React.useRef<HTMLButtonElement | null>(null)
    const accountMenuPanelRef = React.useRef<HTMLDivElement | null>(null)

    // Listbox semantics: opening moves focus to the highlighted option so
    // arrows and Enter work immediately, like a native select dropdown.
    React.useEffect(() => {
      if (!hostFilterOpen) return
      const frame = window.requestAnimationFrame(() => {
        hostFilterMenuRef.current
          ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
          ?.focus()
      })
      return () => window.cancelAnimationFrame(frame)
    }, [hostFilterOpen])
    const [notice, setNotice] = React.useState<string | undefined>(undefined)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const [sidebarEntry, setSidebarEntry] = React.useState<SidebarEntryStyle>(() => props.sidebarEntry.read())

    // The settings page publishes the saved style, so the entry moves without a
    // reload; the first fetch below seeds it for a fresh page.
    React.useEffect(
      () => props.sidebarEntry.subscribe(() => setSidebarEntry(props.sidebarEntry.read())),
      [props.sidebarEntry],
    )
    React.useEffect(() => {
      void props.control<PluginSettingsView>('settings.get')
        .then(view => props.sidebarEntry.publish(view.config.sidebar?.entry ?? 'standard'))
        .catch(() => undefined)
    }, [props.control, props.sidebarEntry])

    React.useEffect(() => {
      if (!open) {
        setDevicesOpen(false)
        qrFlowRun.current += 1
        setBusy(false)
      }
    }, [open])

    React.useEffect(() => {
      if (!open) return
      const frame = window.requestAnimationFrame(() => pageRef.current?.focus())
      return () => window.cancelAnimationFrame(frame)
    }, [open])

    React.useEffect(() => {
      if (!open) return
      const closeOnEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        if (accountMenuOpen) {
          event.stopPropagation()
          setAccountMenuOpen(false)
          return
        }
        if (hostFilterOpen) {
          event.stopPropagation()
          setHostFilterOpen(false)
          return
        }
        if (devicesOpen) {
          event.stopPropagation()
          setDevicesOpen(false)
          return
        }
        setOpen(false)
      }
      window.addEventListener('keydown', closeOnEscape)
      return () => window.removeEventListener('keydown', closeOnEscape)
    }, [open, devicesOpen, hostFilterOpen, accountMenuOpen])

    React.useEffect(() => {
      if (!devicesOpen) return
      const closeOnPointer = (event: MouseEvent): void => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest('.dshRemoteConnectedMenu') !== null) return
        setDevicesOpen(false)
      }
      window.addEventListener('mousedown', closeOnPointer)
      return () => window.removeEventListener('mousedown', closeOnPointer)
    }, [devicesOpen])

    // The custom host-filter dropdown mirrors the connected-devices menu: any
    // press outside the control closes it, and a stale open state must not
    // survive the panel being closed and reopened. The account menu follows
    // the same contract.
    React.useEffect(() => {
      if (!hostFilterOpen) return
      const closeOnPointer = (event: MouseEvent): void => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest('.dshRemoteHostFilter') !== null) return
        setHostFilterOpen(false)
      }
      window.addEventListener('mousedown', closeOnPointer)
      return () => window.removeEventListener('mousedown', closeOnPointer)
    }, [hostFilterOpen])

    React.useEffect(() => {
      if (!accountMenuOpen) return
      const closeOnPointer = (event: MouseEvent): void => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest('.dshRemoteAccountMenu') !== null) return
        setAccountMenuOpen(false)
      }
      window.addEventListener('mousedown', closeOnPointer)
      return () => window.removeEventListener('mousedown', closeOnPointer)
    }, [accountMenuOpen])

    React.useEffect(() => {
      if (open) return
      setHostFilterOpen(false)
      setAccountMenuOpen(false)
      // Closing the panel while a Host is selected falls back to the host
      // list, so reopening always starts at host selection — the same place
      // the picker's cancel button lands.
      if (selectedHost !== undefined) {
        cancelAddingWorkspace()
        chooseAnotherHost()
      }
    }, [open])

    // Opening the account menu moves focus to its first item, so Enter and
    // Escape work immediately without hunting for the row.
    React.useEffect(() => {
      if (!accountMenuOpen) return
      const frame = window.requestAnimationFrame(() => {
        accountMenuPanelRef.current
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
          ?.focus()
      })
      return () => window.cancelAnimationFrame(frame)
    }, [accountMenuOpen])

    React.useEffect(() => {
      if ((status?.host?.connectedClients?.length ?? 0) === 0) setDevicesOpen(false)
    }, [status?.host?.connectedClients?.length])

    React.useEffect(() => {
      void props.control<RemoteStatus>('status').then(setStatus).catch(() => undefined)
    }, [])

    React.useEffect(() => {
      if (status?.serverUrl !== undefined) {
        setLoginServerUrl(status.serverUrl)
      }
      setPairingServerUrl(undefined)
      setLoginMethod(current => current === 'device_pairing' ? 'password' : current)
    }, [status?.serverUrl])

    React.useEffect(() => {
      const remoteActive = status?.mode === 'remote'
      document.documentElement.classList.toggle('dshRemoteTargetActive', remoteActive)
      return () => {
        if (remoteActive) document.documentElement.classList.remove('dshRemoteTargetActive')
      }
    }, [status?.mode])

    const startQrLogin = async (provider: OAuthProvider): Promise<void> => {
      const run = ++qrFlowRun.current
      setBusy(true)
      setError(undefined)
      setQrExpired(false)
      try {
        const session = await props.control<OAuthQrSession>('client.account.qr.start', { provider })
        const image = await QRCode.toDataURL(session.scanUrl, {
          width: 184,
          margin: 1,
          errorCorrectionLevel: 'L',
        })
        if (run !== qrFlowRun.current) return
        setQrSession(session)
        setQrImage(image)
      } catch (reason) {
        if (run === qrFlowRun.current) setError(messageOf(reason, t))
      } finally {
        if (run === qrFlowRun.current) setBusy(false)
      }
    }

    React.useEffect(() => {
      if (!open || !needsAuthorization || savingServer || serverDirty) return
      let active = true
      const run = ++providerRequestRun.current
      qrFlowRun.current += 1
      setBusy(false)
      setQrSession(undefined)
      setQrImage(undefined)
      setQrExpired(false)
      setOAuthProviders([])
      setProvidersLoading(true)
      setProvidersFailed(false)
      void props.control<OAuthProviderInfo[]>('client.account.providers').then(items => {
        if (!active || run !== providerRequestRun.current) return
        const pairingSupported = items.some(item => item.devicePairing === true)
        setPairingServerUrl(pairingSupported ? status?.serverUrl : undefined)
        const available = items.filter(item => item.qrStartUrl != null)
        setOAuthProviders(available)
        setLoginMethod(current => {
          if (loginMethodManuallySelected.current && (current === 'password' || current === 'device_pairing' && pairingSupported
            || available.some(item => `oauth:${item.id}` === current))) return current
          const preferred = available.find(item => item.id === props.preferredQrProvider) ?? available[0]
          return preferred === undefined ? 'password' : `oauth:${preferred.id}`
        })
      }).catch(() => {
        if (!active || run !== providerRequestRun.current) return
        setProvidersFailed(true)
        setLoginMethod(current => loginMethodManuallySelected.current && current === 'device_pairing' ? current : 'password')
      }).finally(() => {
        if (active && run === providerRequestRun.current) setProvidersLoading(false)
      })
      return () => { active = false }
    }, [open, needsAuthorization, status?.serverUrl, props.preferredQrProvider, providerReload, savingServer, serverDirty])

    React.useEffect(() => {
      if (!open || !needsAuthorization || savingServer || serverDirty || providersLoading || loginMethod === 'password'
        || !oauthProviders.some(item => `oauth:${item.id}` === loginMethod) || qrSession !== undefined || qrExpired) return
      void startQrLogin(loginMethod.slice(6))
    }, [open, needsAuthorization, providersLoading, oauthProviders, loginMethod, qrSession, qrExpired, savingServer, serverDirty])

    React.useEffect(() => {
      if (!open || savingServer || serverDirty || loginMethod === 'password' || qrSession === undefined) return
      let active = true
      let polling = false
      let settled = false
      const run = qrFlowRun.current
      let timer: number | undefined
      const poll = (): void => {
        if (polling || settled) return
        polling = true
        void props.control<OAuthQrPollResult>('client.account.qr.poll', { qrId: qrSession.qrId }).then(async result => {
          if (!active || settled || run !== qrFlowRun.current) return
          if (result.status === 'complete') {
            settled = true
            if (timer !== undefined) window.clearInterval(timer)
            setBusy(true)
            setError(undefined)
            setQrExpired(false)
            try {
              const [nextDevices, nextStatus] = await Promise.all([
                props.control<RemoteDevice[]>('devices'),
                props.control<RemoteStatus>('status'),
              ])
              if (active && run === qrFlowRun.current) {
                setDevices(nextDevices)
                setStatus(nextStatus)
                setNeedsAuthorization(false)
              }
            } catch (reason) {
              if (active && run === qrFlowRun.current) setError(connectionErrorMessageFor(reason, t))
            } finally {
              if (run === qrFlowRun.current) {
                setQrSession(undefined)
                setQrImage(undefined)
                setBusy(false)
              }
            }
          } else if (result.status === 'expired') {
            settled = true
            if (timer !== undefined) window.clearInterval(timer)
            setQrExpired(true)
            setQrSession(undefined)
            setQrImage(undefined)
          }
        }).catch(reason => {
          if (active && !settled && run === qrFlowRun.current) setError(messageOf(reason, t))
        }).finally(() => {
          polling = false
        })
      }
      poll()
      timer = window.setInterval(poll, 1_500)
      return () => {
        active = false
        if (timer !== undefined) window.clearInterval(timer)
      }
    }, [open, loginMethod, qrSession, savingServer, serverDirty])

    const selectLoginMethod = (method: LoginMethod | 'device_pairing'): void => {
      loginMethodManuallySelected.current = true
      if (method === loginMethod) return
      qrFlowRun.current += 1
      setLoginMethod(method)
      setQrSession(undefined)
      setQrImage(undefined)
      setQrExpired(false)
      setError(undefined)
    }

    const orderedQrProviders = [...oauthProviders].sort((a, b) =>
      Number(b.id === props.preferredQrProvider) - Number(a.id === props.preferredQrProvider))
    const selectedProvider = oauthProviders.find(item => `oauth:${item.id}` === loginMethod)
    const scanLabel = t('scanWithProvider', { provider: selectedProvider?.displayName ?? '' })
    const passwordVisible = !savingServer && !serverDirty && loginMethod === 'password' && (
      loginMethodManuallySelected.current || (!providersLoading && oauthProviders.length === 0)
    )

    const qrLoginTab = (provider: OAuthProviderInfo): unknown => React.createElement('button', {
      key: provider.id, type: 'button', role: 'tab', id: `dsh-remote-oauth:${provider.id}-tab`,
      'aria-selected': loginMethod === `oauth:${provider.id}`, 'aria-controls': `dsh-remote-oauth:${provider.id}-panel`,
      className: loginMethod === `oauth:${provider.id}` ? 'isActive' : '', disabled: busy,
      onClick: () => selectLoginMethod(`oauth:${provider.id}`),
    }, t('providerLogin', { provider: provider.displayName }))

    const selectHost = async (host: RemoteDevice): Promise<void> => {
      setWorkspaceSearch('')
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      setConnectingHost(host)
      setCodexWorkspaces([])
      setCursorWorkspaces([])
      setAntigravityWorkspaces([])
      setPiWorkspaces([])
      setOpencodeWorkspaces([])
      setClaudeWorkspaces([])
      setHermesWorkspaces([])
      setShowAllWorkspaces(false)
      setShowAllCodexWorkspaces(false)
      setShowAllCursorWorkspaces(false)
      setShowAllAntigravityWorkspaces(false)
      setShowAllPiWorkspaces(false)
      setShowAllOpencodeWorkspaces(false)
      setShowAllClaudeWorkspaces(false)
      setShowAllHermesWorkspaces(false)
      try {
        const result = await runConnectHostProgress(
          status?.preferredTransports,
          host.deviceId,
          props.control,
          { label: 'remoteProgressLoadingWorkspaces', detail: 'remoteProgressLoadingWorkspacesDetail' },
          setProgress,
          progressRun,
          async () => {
            // The first request establishes the selected Host connection.
            // Keep optional probes on that same connection instead of racing
            // multiple initial handshakes for one target.
            const nextWorkspaces = await props.control<RemoteWorkspaceView[]>('workspaces.list', {
              targetDeviceId: host.deviceId,
            })
            // The selected Host connection is established by workspaces.list.
            // Optional backend catalogs are independent reads; running them
            // together keeps an unavailable or slow ACP backend from delaying
            // CodeX discovery and the picker transition.
            const [nextCodexWorkspaces, nextCursorWorkspaces, nextAntigravityWorkspaces,
              nextPiWorkspaces, nextOpencodeWorkspaces, nextClaudeWorkspaces, nextHermesWorkspaces, nextStatus] = await Promise.all([
              props.control<CodexWorkspaceView[]>('codex.workspaces.list', { targetDeviceId: host.deviceId }).catch(() => []),
              props.control<CursorWorkspaceView[]>('cursor.workspaces.list', { targetDeviceId: host.deviceId }).catch(() => []),
              props.control<CursorWorkspaceView[]>('antigravity.workspaces.list', { targetDeviceId: host.deviceId }).catch(() => []),
              props.control<CursorWorkspaceView[]>('pi.workspaces.list', { targetDeviceId: host.deviceId }).catch(() => []),
              props.control<CursorWorkspaceView[]>('opencode.workspaces.list', { targetDeviceId: host.deviceId }).catch(() => []),
              props.control<CursorWorkspaceView[]>('claude.workspaces.list', { targetDeviceId: host.deviceId }).catch(() => []),
              props.control<CursorWorkspaceView[]>('hermes.workspaces.list', { targetDeviceId: host.deviceId }).catch(() => []),
              props.control<RemoteStatus>('status').catch(() => undefined),
            ])
            if (nextStatus !== undefined) setStatus(nextStatus)
            return {
              workspaces: nextWorkspaces,
              codexWorkspaces: nextCodexWorkspaces,
              cursorWorkspaces: nextCursorWorkspaces,
              antigravityWorkspaces: nextAntigravityWorkspaces,
              piWorkspaces: nextPiWorkspaces,
              opencodeWorkspaces: nextOpencodeWorkspaces,
              claudeWorkspaces: nextClaudeWorkspaces,
              hermesWorkspaces: nextHermesWorkspaces,
              status: nextStatus,
            }
          },
          result => connectedProgress(result.status),
        )
        setWorkspaces(result.workspaces)
        setCodexWorkspaces(result.codexWorkspaces)
        setCursorWorkspaces(result.cursorWorkspaces)
        setAntigravityWorkspaces(result.antigravityWorkspaces)
        setPiWorkspaces(result.piWorkspaces)
        setOpencodeWorkspaces(result.opencodeWorkspaces)
        setClaudeWorkspaces(result.claudeWorkspaces)
        setHermesWorkspaces(result.hermesWorkspaces)
        setWorkspaceBackend('harness')
        setCodexWorkspaceId(undefined)
        setCursorWorkspaceId(undefined)
        setAntigravityWorkspaceId(undefined)
        setPiWorkspaceId(undefined)
        setOpencodeWorkspaceId(undefined)
        setClaudeWorkspaceId(undefined)
        setHermesWorkspaceId(undefined)
        setSelectedHost(host)
        setPath('')
        setAddingWorkspace(false)
        setDirectory(undefined)
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        // A failed attempt expands the full Host list again; a successful one
        // is represented by `selectedHost`.
        setConnectingHost(undefined)
        setBusy(false)
      }
    }

    const browseDirectory = async (nextPath?: string): Promise<void> => {
      if (selectedHost === undefined) return
      setBusy(true)
      setError(undefined)
      try {
        const listing = await props.control<RemoteDirectoryListing>('directory.list', {
          targetDeviceId: selectedHost.deviceId,
          ...(nextPath === undefined ? {} : { path: nextPath }),
        })
        setDirectory(listing)
        setCodexWorkspaceId(undefined)
        setCursorWorkspaceId(undefined)
        setAntigravityWorkspaceId(undefined)
        setPiWorkspaceId(undefined)
        setOpencodeWorkspaceId(undefined)
        setClaudeWorkspaceId(undefined)
        setHermesWorkspaceId(undefined)
        setPickedDirectoryPath(undefined)
        setPath(listing.path)
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const startAddingWorkspace = (backend: 'harness' | 'codex' | 'cursor' | 'antigravity' | 'pi' | 'opencode' | 'claude' | 'hermes'): void => {
      setAddingWorkspace(true)
      setWorkspaceBackend(backend)
      setCodexWorkspaceId(undefined)
      setCursorWorkspaceId(undefined)
      setAntigravityWorkspaceId(undefined)
      setPiWorkspaceId(undefined)
      setOpencodeWorkspaceId(undefined)
      setClaudeWorkspaceId(undefined)
      setHermesWorkspaceId(undefined)
      setShowAllWorkspaces(false)
      setShowAllCodexWorkspaces(false)
      setShowAllCursorWorkspaces(false)
      setShowAllAntigravityWorkspaces(false)
      setShowAllPiWorkspaces(false)
      setShowAllOpencodeWorkspaces(false)
      setShowAllClaudeWorkspaces(false)
      setShowAllHermesWorkspaces(false)
      setDirectory(undefined)
      setPickedDirectoryPath(undefined)
      setPath('')
      void browseDirectory()
    }

    const cancelAddingWorkspace = (): void => {
      setAddingWorkspace(false)
      setWorkspaceBackend('harness')
      setCodexWorkspaceId(undefined)
      setCursorWorkspaceId(undefined)
      setAntigravityWorkspaceId(undefined)
      setPiWorkspaceId(undefined)
      setOpencodeWorkspaceId(undefined)
      setClaudeWorkspaceId(undefined)
      setHermesWorkspaceId(undefined)
      setDirectory(undefined)
      setPickedDirectoryPath(undefined)
      setPath('')
    }

    const refreshRemote = async (): Promise<void> => {
      setBusy(true)
      setNotice(undefined)
      setError(undefined)
      try {
        const nextStatus = await props.control<RemoteStatus>('status')
        setStatus(nextStatus)
        if (nextStatus.controlUnavailable) {
          setNeedsAuthorization(undefined)
          setError(t('remoteControlUnavailable'))
          return
        }
        if (nextStatus.startupError !== undefined) {
          setDevices([])
          setNeedsAuthorization(undefined)
          setSelectedHost(undefined)
          setWorkspaces([])
          setCodexWorkspaces([])
          setCursorWorkspaces([])
          setAntigravityWorkspaces([])
          setPiWorkspaces([])
          setOpencodeWorkspaces([])
          setClaudeWorkspaces([])
          setHermesWorkspaces([])
          setShowAllWorkspaces(false)
          setShowAllCodexWorkspaces(false)
          setShowAllCursorWorkspaces(false)
          setShowAllAntigravityWorkspaces(false)
          setShowAllPiWorkspaces(false)
          setShowAllOpencodeWorkspaces(false)
          setShowAllClaudeWorkspaces(false)
          setShowAllHermesWorkspaces(false)
          setWorkspaceBackend('harness')
          setCodexWorkspaceId(undefined)
          setCursorWorkspaceId(undefined)
          setAntigravityWorkspaceId(undefined)
          setPiWorkspaceId(undefined)
          setOpencodeWorkspaceId(undefined)
          setClaudeWorkspaceId(undefined)
          setHermesWorkspaceId(undefined)
          setPath('')
          setAddingWorkspace(false)
          setDirectory(undefined)
          setError(startupErrorMessage(nextStatus.startupError, t))
          return
        }
        if (nextStatus.host?.pairingHostOnly) {
          // Host credentials establish an inbound-only signed-in view. Never
          // query/derive a Client identity or discover controllable Hosts here.
          setNeedsAuthorization(!nextStatus.host.authorized || nextStatus.host.accountRequired)
          setDevices([])
          setDiscoveryUnavailable(false)
          chooseAnotherHost()
          return
        }
        if (!nextStatus.available) {
          setDevices([])
          setNeedsAuthorization(false)
          setSelectedHost(undefined)
          setWorkspaces([])
          setCodexWorkspaces([])
          setCursorWorkspaces([])
          setAntigravityWorkspaces([])
          setPiWorkspaces([])
          setOpencodeWorkspaces([])
          setClaudeWorkspaces([])
          setHermesWorkspaces([])
          setShowAllWorkspaces(false)
          setShowAllCodexWorkspaces(false)
          setShowAllCursorWorkspaces(false)
          setShowAllAntigravityWorkspaces(false)
          setShowAllPiWorkspaces(false)
          setShowAllOpencodeWorkspaces(false)
          setShowAllClaudeWorkspaces(false)
          setShowAllHermesWorkspaces(false)
          setWorkspaceBackend('harness')
          setCodexWorkspaceId(undefined)
          setCursorWorkspaceId(undefined)
          setAntigravityWorkspaceId(undefined)
          setPiWorkspaceId(undefined)
          setOpencodeWorkspaceId(undefined)
          setClaudeWorkspaceId(undefined)
          setHermesWorkspaceId(undefined)
          setPath('')
          setAddingWorkspace(false)
          setDirectory(undefined)
          return
        }
        try {
          if (nextStatus.clientAuthRequired) {
            throw Object.assign(new Error('Sign in again.'), { code: 'AUTH_INVALID' })
          }
          const authorization = await props.control<{ hasCredentials: boolean }>('client.authorization.status')
          if (!authorization.hasCredentials) {
            throw Object.assign(new Error('Remote account authorization is required.'), { code: 'ACCOUNT_AUTH_REQUIRED' })
          }
          // Local credentials establish the signed-in view even when Server
          // discovery is unavailable. Local peer status remains authoritative.
          setNeedsAuthorization(false)
          const nextDevices = await props.control<RemoteDevice[]>('devices')
          setDevices(nextDevices)
          setDiscoveryUnavailable(false)
          if (selectedHost !== undefined) {
            const nextSelectedHost = nextDevices.find(device => device.deviceId === selectedHost.deviceId)
            if (nextSelectedHost === undefined) {
              setSelectedHost(undefined)
              setWorkspaces([])
              setCodexWorkspaces([])
              setCursorWorkspaces([])
              setAntigravityWorkspaces([])
              setPiWorkspaces([])
              setOpencodeWorkspaces([])
              setClaudeWorkspaces([])
              setHermesWorkspaces([])
              setShowAllWorkspaces(false)
              setShowAllCodexWorkspaces(false)
              setShowAllCursorWorkspaces(false)
              setShowAllAntigravityWorkspaces(false)
              setShowAllPiWorkspaces(false)
              setShowAllOpencodeWorkspaces(false)
              setShowAllClaudeWorkspaces(false)
              setShowAllHermesWorkspaces(false)
              setWorkspaceBackend('harness')
              setCodexWorkspaceId(undefined)
              setCursorWorkspaceId(undefined)
              setAntigravityWorkspaceId(undefined)
              setPiWorkspaceId(undefined)
              setOpencodeWorkspaceId(undefined)
              setClaudeWorkspaceId(undefined)
              setHermesWorkspaceId(undefined)
              setPath('')
              setAddingWorkspace(false)
              setDirectory(undefined)
            } else {
              setSelectedHost(nextSelectedHost)
              void props.control<RemoteWorkspaceView[]>('workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setWorkspaces(w)).catch(() => undefined)
              void props.control<CodexWorkspaceView[]>('codex.workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setCodexWorkspaces(w)).catch(() => undefined)
              void props.control<CursorWorkspaceView[]>('cursor.workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setCursorWorkspaces(w)).catch(() => undefined)
              void props.control<CursorWorkspaceView[]>('antigravity.workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setAntigravityWorkspaces(w)).catch(() => undefined)
              void props.control<CursorWorkspaceView[]>('pi.workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setPiWorkspaces(w)).catch(() => undefined)
              void props.control<CursorWorkspaceView[]>('opencode.workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setOpencodeWorkspaces(w)).catch(() => undefined)
              void props.control<CursorWorkspaceView[]>('claude.workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setClaudeWorkspaces(w)).catch(() => undefined)
              void props.control<CursorWorkspaceView[]>('hermes.workspaces.list', { targetDeviceId: nextSelectedHost.deviceId })
                .then(w => setHermesWorkspaces(w)).catch(() => undefined)
            }
          }
        } catch (reason) {
          // A transient Server outage is not a sign-out. Keep the last known
          // device/session view and only show login for explicit auth failures.
          const code = typeof reason === 'object' && reason !== null && 'code' in reason
            ? String((reason as { code: unknown }).code)
            : ''
          if (['ACCOUNT_AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'DEVICE_REVOKED', 'DEVICE_OWNERSHIP_REQUIRED'].includes(code)) {
            setDevices([])
            setNeedsAuthorization(true)
            setSelectedHost(undefined)
            setWorkspaces([])
            setCodexWorkspaces([])
            setCursorWorkspaces([])
            setAntigravityWorkspaces([])
            setPiWorkspaces([])
            setOpencodeWorkspaces([])
            setClaudeWorkspaces([])
            setHermesWorkspaces([])
            setShowAllWorkspaces(false)
            setShowAllCodexWorkspaces(false)
            setShowAllCursorWorkspaces(false)
            setShowAllAntigravityWorkspaces(false)
            setShowAllPiWorkspaces(false)
            setShowAllOpencodeWorkspaces(false)
            setShowAllClaudeWorkspaces(false)
            setShowAllHermesWorkspaces(false)
            setWorkspaceBackend('harness')
            setCodexWorkspaceId(undefined)
            setCursorWorkspaceId(undefined)
            setAntigravityWorkspaceId(undefined)
            setPiWorkspaceId(undefined)
            setOpencodeWorkspaceId(undefined)
            setClaudeWorkspaceId(undefined)
            setHermesWorkspaceId(undefined)
            setPath('')
            setAddingWorkspace(false)
            setDirectory(undefined)
          } else {
            const unavailable = code === 'CONNECTION_FAILED' || messageOf(reason, t) === t('serverUnavailableError')
            if (unavailable) {
              setDiscoveryUnavailable(true)
            } else setError(messageOf(reason, t))
          }
        }
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    /**
     * Restart the selected Host's Harness through its own platform supervisor
     * (systemd on Linux, DSH Desktop relaunch on Windows). The Host answers
     * before it stops, so the row is refreshed after a short grace period.
     */
    const restartHost = async (device: RemoteDevice): Promise<void> => {
      if (restartingHost !== undefined) return
      if (!window.confirm(t('restartHostConfirm', { name: device.name }))) return
      setRestartingHost(device.deviceId)
      setError(undefined)
      setNotice(undefined)
      try {
        await props.control('host.restart', { targetDeviceId: device.deviceId })
        // The restarting row's own badge carries the in-progress state; no
        // separate page notice is added on top of it.
        // Presence comes back at the Host's own pace: re-read after a grace
        // period and retry once, so a transient failure cannot leave the list
        // holding the pre-restart snapshot.
        window.setTimeout(() => {
          let attempts = 0
          const refresh = (): void => {
            attempts += 1
            void Promise.all([
              props.control<RemoteDevice[]>('devices'),
              props.control<RemoteStatus>('status'),
            ]).then(([nextDevices, nextStatus]) => {
              setDevices(nextDevices)
              setStatus(nextStatus)
              setRestartingHost(undefined)
            }).catch(() => {
              if (attempts < 2) window.setTimeout(refresh, 10000)
              else setRestartingHost(undefined)
            })
          }
          refresh()
        }, 8000)
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
        setRestartingHost(undefined)
      }
    }

    const show = async (): Promise<void> => {
      setShowAllWorkspaces(false)
      setShowAllCodexWorkspaces(false)
      setShowAllCursorWorkspaces(false)
      setShowAllAntigravityWorkspaces(false)
      setShowAllPiWorkspaces(false)
      setShowAllOpencodeWorkspaces(false)
      setShowAllClaudeWorkspaces(false)
      setShowAllHermesWorkspaces(false)
      setOpen(true)
      await refreshRemote()
    }

    React.useEffect(() => props.subscribeOpen(() => { void show() }), [props.subscribeOpen, show])

    React.useEffect(() => {
      // The pushed status drives the sidebar entry (update badge, remote mode)
      // and the open modal alike; the subscription replays the latest status
      // immediately, so the entry reflects the startup registry check without
      // waiting for the modal to be opened.
      return props.statusFeed.subscribe(next => {
        setStatus(next)
        if (next.host?.pairingHostOnly) {
          setNeedsAuthorization(!next.host.authorized || next.host.accountRequired)
          setDevices([])
          setSelectedHost(undefined)
          setConnectingHost(undefined)
        }
        if (next.host?.online) {
          setDiscoveryUnavailable(false)
        }
      })
    }, [props.statusFeed])

    const chooseAnotherHost = (): void => {
      setWorkspaceSearch('')
      setSelectedHost(undefined)
      setWorkspaces([])
      setCodexWorkspaces([])
      setCursorWorkspaces([])
      setAntigravityWorkspaces([])
      setPiWorkspaces([])
      setOpencodeWorkspaces([])
      setClaudeWorkspaces([])
      setHermesWorkspaces([])
      setShowAllWorkspaces(false)
      setShowAllCodexWorkspaces(false)
      setShowAllCursorWorkspaces(false)
      setShowAllAntigravityWorkspaces(false)
      setShowAllPiWorkspaces(false)
      setShowAllOpencodeWorkspaces(false)
      setShowAllClaudeWorkspaces(false)
      setShowAllHermesWorkspaces(false)
      setWorkspaceBackend('harness')
      setCodexWorkspaceId(undefined)
      setCursorWorkspaceId(undefined)
      setAntigravityWorkspaceId(undefined)
      setPiWorkspaceId(undefined)
      setOpencodeWorkspaceId(undefined)
      setClaudeWorkspaceId(undefined)
      setHermesWorkspaceId(undefined)
      setDirectory(undefined)
      setPath('')
      setAddingWorkspace(false)
      setError(undefined)
    }

    const resetLoginFlow = (): void => {
      providerRequestRun.current += 1
      qrFlowRun.current += 1
      setQrSession(undefined)
      setQrImage(undefined)
      setQrExpired(false)
      setOAuthProviders([])
      setPairingServerUrl(undefined)
      setProvidersFailed(false)
      setProvidersLoading(false)
      setLoginMethod('password')
      loginMethodManuallySelected.current = false
      setPassword('')
      setError(undefined)
      setNotice(undefined)
    }

    const saveLoginServer = async (serverUrlOverride?: string): Promise<void> => {
      const nextServerUrl = (serverUrlOverride ?? loginServerUrl).trim()
      if (nextServerUrl === '' || savingServer) return
      resetLoginFlow()
      setSavingServer(true)
      setBusy(true)
      try {
        const view = await props.control<PluginSettingsView>('settings.server.set', { serverUrl: nextServerUrl })
        if (view.applies !== 'live') {
          setNotice(t('serverSaved'))
          return
        }
        const nextStatus = await props.control<RemoteStatus>('status')
        setStatus(nextStatus)
        setLoginServerUrl(nextStatus.serverUrl ?? loginServerUrl.trim())
        setEditingServer(false)
        setProviderReload(value => value + 1)
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setSavingServer(false)
        setBusy(false)
      }
    }

    const signInClient = async (): Promise<void> => {
      if (serverDirty || savingServer || email.trim() === '' || password === '' || loginServerUrl.trim() === '') return
      setBusy(true)
      setError(undefined)
      try {
        if (status?.clientAuthRequired) {
          await props.control('client.account.login', { email: email.trim(), password })
        } else {
          await props.control('settings.configure', {
            role: 'client',
            serverUrl: loginServerUrl.trim(),
            email: email.trim(),
            password,
          })
        }
        setDevices(await props.control<RemoteDevice[]>('devices'))
        setStatus(await props.control<RemoteStatus>('status'))
        setNeedsAuthorization(false)
        setPassword('')
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const authorizeHost = async (kind: 'account' | 'code'): Promise<void> => {
      if (kind === 'account' && (hostEmail.trim() === '' || hostPassword === '')) return
      if (kind === 'code' && hostRegistrationCode.trim() === '') return
      setBusy(true)
      setError(undefined)
      try {
        if (kind === 'account') {
          await props.control('host.account.login', { email: hostEmail.trim(), password: hostPassword })
          setHostPassword('')
        } else {
          await props.control('host.registration-code.submit', { code: hostRegistrationCode.trim() })
          setHostRegistrationCode('')
        }
        setStatus(await props.control<RemoteStatus>('status'))
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const openLocalWorkspaces = async (): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        await props.control('mode.set', { mode: 'local' })
        window.location.reload()
      } catch (reason) {
        setError(messageOf(reason, t))
        setBusy(false)
      }
    }

    const setCurrentDeviceControl = async (enabled: boolean): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('host.authorization.set', { enabled }))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const logoutRemote = async (): Promise<void> => {
      qrFlowRun.current += 1
      progressRun.current += 1
      setBusy(true)
      setError(undefined)
      try {
        await props.control('settings.logout')
        setDevices([])
        setSelectedHost(undefined)
        setConnectingHost(undefined)
        setWorkspaces([])
        setCodexWorkspaces([])
        setCursorWorkspaces([])
        setAntigravityWorkspaces([])
        setPiWorkspaces([])
        setOpencodeWorkspaces([])
        setClaudeWorkspaces([])
        setHermesWorkspaces([])
        setDirectory(undefined)
        setPath('')
        setPassword('')
        setProgress(undefined)
        setNeedsAuthorization(true)
        setQrSession(undefined)
        setQrImage(undefined)
        setQrExpired(false)
        setStatus(await props.control<RemoteStatus>('status'))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const openWorkspace = async (selection?:
      | { backend: 'harness'; path: string }
      | { backend: 'codex'; path: string; workspaceId: string }
      | { backend: 'cursor'; path: string; workspaceId?: string }
      | { backend: 'antigravity'; path: string; workspaceId?: string }
      | { backend: 'pi'; path: string; workspaceId?: string }
      | { backend: 'opencode'; path: string; workspaceId?: string }
      | { backend: 'claude'; path: string; workspaceId?: string }
      | { backend: 'hermes'; path: string; workspaceId?: string }): Promise<void> => {
      const targetBackend = selection?.backend ?? workspaceBackend
      const targetPath = (selection?.path ?? path).trim()
      const targetCodexWorkspaceId = selection?.backend === 'codex'
        ? selection.workspaceId
        : selection === undefined ? codexWorkspaceId : undefined
      const targetCursorWorkspaceId = selection?.backend === 'cursor'
        ? selection.workspaceId
        : selection === undefined ? cursorWorkspaceId : undefined
      const targetAntigravityWorkspaceId = selection?.backend === 'antigravity'
        ? selection.workspaceId
        : selection === undefined ? antigravityWorkspaceId : undefined
      const targetPiWorkspaceId = selection?.backend === 'pi'
        ? selection.workspaceId
        : selection === undefined ? piWorkspaceId : undefined
      const targetOpencodeWorkspaceId = selection?.backend === 'opencode'
        ? selection.workspaceId
        : selection === undefined ? opencodeWorkspaceId : undefined
      const targetClaudeWorkspaceId = selection?.backend === 'claude'
        ? selection.workspaceId
        : selection === undefined ? claudeWorkspaceId : undefined
      const targetHermesWorkspaceId = selection?.backend === 'hermes'
        ? selection.workspaceId
        : selection === undefined ? hermesWorkspaceId : undefined
      const createWorkspace = selection === undefined && addingWorkspace
      if (selectedHost === undefined
        || targetPath === ''
        || !createWorkspace && targetBackend === 'codex' && targetCodexWorkspaceId === undefined
        || !createWorkspace && targetBackend === 'cursor' && targetCursorWorkspaceId === undefined && targetPath === ''
        || !createWorkspace && targetBackend === 'antigravity' && targetAntigravityWorkspaceId === undefined && targetPath === '') return
      setBusy(true)
      setError(undefined)
      try {
        const nextStatus = await (targetBackend === 'codex'
          ? createWorkspace
            ? props.control<RemoteStatus>('codex.workspace.create', {
              targetDeviceId: selectedHost.deviceId,
              path: targetPath,
            })
            : props.control<RemoteStatus>('codex.workspace.open', {
              targetDeviceId: selectedHost.deviceId,
              workspaceId: targetCodexWorkspaceId,
            })
          : targetBackend !== 'harness'
            ? (() => {
              const workspaceId = { cursor: targetCursorWorkspaceId, antigravity: targetAntigravityWorkspaceId,
                pi: targetPiWorkspaceId, opencode: targetOpencodeWorkspaceId, claude: targetClaudeWorkspaceId,
                hermes: targetHermesWorkspaceId }[targetBackend]
              return createWorkspace || workspaceId === undefined
                ? props.control<RemoteStatus>(`${targetBackend}.workspace.create`, { targetDeviceId: selectedHost.deviceId, path: targetPath })
                : props.control<RemoteStatus>(`${targetBackend}.workspace.open`, { targetDeviceId: selectedHost.deviceId, workspaceId })
            })()
                  : props.control<RemoteStatus>('workspace.open', {
                    targetDeviceId: selectedHost.deviceId,
                    path: targetPath,
                  }))
        setStatus(nextStatus)
        if (nextStatus.workspaceSelection !== undefined) {
          window.sessionStorage.setItem(pendingWorkspaceSelectionKey, JSON.stringify(nextStatus.workspaceSelection))
        }
        window.location.reload()
      } catch (reason) {
        setError(messageOf(reason, t))
        setBusy(false)
      }
    }

    const reauth = status?.clientAuthRequired === true
    const remoteLabel = reauth ? t('clientSignInAgain') : status?.mode === 'remote'
      ? t('activeRemote', { name: status.target?.name ?? t('host') })
      : t('remoteEntry')
    const remoteActionLabel = !reauth && status?.mode === 'remote'
      ? `${remoteLabel} · ${t('exitRemote')}`
      : remoteLabel
    const query = workspaceSearch.trim().toLocaleLowerCase()
    const matchingWorkspaces = <T extends { title: string; path: string }>(rows: T[], expanded: boolean): T[] => {
      if (query !== '') return rows.filter(row => `${row.title}\n${row.path}`.toLocaleLowerCase().includes(query))
      return expanded ? rows : rows.slice(0, 3)
    }
    const visibleWorkspaces = matchingWorkspaces(workspaces, showAllWorkspaces)
    const visibleCodexWorkspaces = matchingWorkspaces(codexWorkspaces, showAllCodexWorkspaces)
    const visibleCursorWorkspaces = matchingWorkspaces(cursorWorkspaces, showAllCursorWorkspaces)
    const visibleAntigravityWorkspaces = matchingWorkspaces(antigravityWorkspaces, showAllAntigravityWorkspaces)
    const visiblePiWorkspaces = matchingWorkspaces(piWorkspaces, showAllPiWorkspaces)
    const visibleOpencodeWorkspaces = matchingWorkspaces(opencodeWorkspaces, showAllOpencodeWorkspaces)
    const visibleClaudeWorkspaces = matchingWorkspaces(claudeWorkspaces, showAllClaudeWorkspaces)
    const visibleHermesWorkspaces = matchingWorkspaces(hermesWorkspaces, showAllHermesWorkspaces)
    // Runtime features already validate both negotiated capabilities and
    // workspace readiness, including the existing CodeX legacy fallback.
    const codexAvailable = status?.remoteFeatures?.codex === true
    const cursorAvailable = status?.remoteFeatures?.cursor === true
    const antigravityAvailable = status?.remoteFeatures?.antigravity === true
    const piAvailable = status?.remoteFeatures?.pi === true
    const opencodeAvailable = status?.remoteFeatures?.opencode === true
    const claudeAvailable = status?.remoteFeatures?.claude === true
    const hermesAvailable = status?.remoteFeatures?.hermes === true
    // The status payload crosses the loopback SSE wire; a malformed update
    // field reads as "no update info" rather than feeding render-time parsing.
    const rawUpdate = status?.update
    const updateInfo = rawUpdate !== undefined
      && typeof rawUpdate.currentVersion === 'string'
      && typeof rawUpdate.latestVersion === 'string'
      ? rawUpdate
      : undefined
    const localUpdateAvailable = updateInfo !== undefined
      && compareVersions(updateInfo.currentVersion, updateInfo.latestVersion) < 0
    const updateNotice = updateInfo !== undefined && localUpdateAvailable
      ? t('updateAvailable', { latest: updateInfo.latestVersion, current: updateInfo.currentVersion })
      : undefined
    const deviceUpdateAvailable = (device: RemoteDevice): boolean =>
      updateInfo !== undefined
      && device.clientVersion !== undefined
      && compareVersions(device.clientVersion, updateInfo.latestVersion) < 0
    const connectedClients = status?.host?.connectedClients ?? []
    const connectedCount = connectedClients.length
    const connectedCountLabel = t('connectedClientCount', { count: connectedCount })
    const connectedMenu = !needsAuthorization && status?.hostAuthorizationAvailable === true
      ? React.createElement('div', {
        className: `dshRemoteConnectedMenu${devicesOpen ? ' isOpen' : ''}`,
      },
        React.createElement('a', {
          href: connectedCount > 0 ? '#connected-devices' : undefined,
          className: `dshRemoteConnectedCount${connectedCount > 0 ? ' isOnline isInteractive' : ''}`,
          'aria-expanded': connectedCount > 0 ? devicesOpen : undefined,
          'aria-haspopup': connectedCount > 0 ? 'dialog' : undefined,
          title: connectedCountLabel,
          'aria-label': connectedCountLabel,
          onClick: (event: Event) => {
            event.preventDefault()
            if (connectedCount === 0) return
            setDevicesOpen(current => !current)
          },
        }, connectedCountLabel),
        devicesOpen && connectedCount > 0
          ? React.createElement('div', {
            className: 'dshRemoteConnectedPanel',
            id: 'connected-devices',
            role: 'dialog',
            'aria-label': t('currentConnectedDevices'),
          },
            React.createElement('div', { className: 'dshRemoteConnectedPanelHeader' },
              React.createElement('strong', { className: 'dshRemoteConnectedPanelTitle' }, t('currentConnectedDevices')),
              React.createElement(ServerNotice, {
                countdownOnly: true,
                offline: status?.host?.online === false && status.host.reconnecting,
                linked: connectedCount > 0, expiresAt: status?.host?.recoveryExpiresAt, t,
              })),
            React.createElement(
              'div',
              { className: 'dshRemoteClientList', 'aria-label': t('currentConnectedDevices') },
              ...connectedClients.map(client => React.createElement('div', {
                key: client.deviceId,
                className: 'dshRemoteClientRow',
              },
                React.createElement('span', null,
                  React.createElement('span', { className: 'dshRemoteHostNameLine' },
                    React.createElement('strong', null, client.name.trim() === '' ? t('unknownDevice') : client.name),
                    null),
                  React.createElement('small', null, [
                    client.platform === undefined ? undefined : formatPlatform(client.platform),
                    connectedClientModeLabel(client.mode, t),
                  ].filter(Boolean).join(' · '))),
                React.createElement('small', { className: 'dshRemoteClientOnline' }, t('connected')))),
            ))
          : null)
      : null

    // While a Host is connecting only that row stays listed, so the progress
    // panel below the list is visible without scrolling past every device.
    const serverUnavailable = discoveryUnavailable || (status?.host?.online === false
      && status.host.reconnecting && (status.host.lastActiveAt !== undefined || status.host.error === 'CONNECTION_FAILED'))
    const listedHosts = status?.host?.pairingHostOnly ? [] : connectingHost === undefined
      ? devices.filter(device => hostFilter === 'all' || (hostFilter === 'online' ? device.online && !serverUnavailable : !device.online || serverUnavailable))
      : [connectingHost]
    const hostFilterOptions = [
      { value: 'all', label: t('allHosts') },
      { value: 'online', label: t('onlineHosts') },
      { value: 'offline', label: t('offlineHosts') },
    ]
    const renderAccount = (): unknown => React.createElement('footer', { className: 'dshRemoteAccountFooter' },
      React.createElement('div', { className: `dshRemoteAccountIdentity dshRemoteAccountMenu${accountMenuOpen ? ' isOpen' : ''}` },
        React.createElement('button', {
          type: 'button', className: 'dshRemoteAccountTrigger',
          'aria-haspopup': 'menu', 'aria-expanded': accountMenuOpen,
          'aria-label': footerAccountName(status, t),
          onClick: () => setAccountMenuOpen(current => !current),
        },
          React.createElement('span', { className: 'dshRemoteAccountAvatar', 'aria-hidden': true }, accountInitial(footerAccountName(status, t))),
          React.createElement('span', { className: 'dshRemoteAccountCopy' },
            React.createElement('strong', null, footerAccountName(status, t))),
          React.createElement('svg', {
            className: 'dshRemoteAccountChevron', viewBox: '0 0 24 24', width: 11, height: 11,
            fill: 'none', stroke: 'currentColor', strokeWidth: 2,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          }, React.createElement('path', { d: 'm6 9 6 6 6-6' }))),
        accountMenuOpen ? React.createElement('div', {
          className: 'dshRemoteAccountMenuPanel', role: 'menu', ref: accountMenuPanelRef,
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key === 'Tab') setAccountMenuOpen(false)
          },
        },
          React.createElement('button', {
            type: 'button', role: 'menuitem', className: 'dshRemoteAccountMenuItem', disabled: busy,
            onClick: () => {
              setAccountMenuOpen(false)
              void logoutRemote()
            },
          }, glyph(React, LogOut), React.createElement('span', null, t('exitRemoteAccount')))) : null),
      updateNotice === undefined ? null : React.createElement('a', {
        className: 'dshRemoteAccountUpdate', href: 'https://github.com/gaolin89898/remote-session-plugin/releases',
        target: '_blank', rel: 'noreferrer', title: updateNotice,
      }, t('updateAvailableShort', { version: updateInfo?.latestVersion ?? '' })),
      props.openSettings === undefined ? null : React.createElement('button', {
        type: 'button', className: 'dshRemoteAccountSettings', onClick: props.openSettings,
        'aria-label': t('settings'), title: t('settings'),
      }, glyph(React, Settings2)))

    const workspaceHeading = React.createElement('div', { className: 'dshRemoteWorkspaceSourceHeading' },
      React.createElement('strong', null, t('existingWorkspaces')),
      React.createElement('button', {
        type: 'button', className: 'dshRemoteAddWorkspace', disabled: busy,
        title: t('addRemoteWorkspace'), 'aria-label': t('addRemoteWorkspace'),
        onClick: () => startAddingWorkspace('harness'),
      }, glyph(React, Plus)))
    const workspaceIcon = React.createElement('svg', {
      className: 'dshRemoteWorkspaceIcon', viewBox: whaleMarkViewBox, fill: 'currentColor', 'aria-hidden': true, focusable: false,
    }, React.createElement('path', { d: whaleMarkPath }))

    const computerIcon = React.createElement('svg', {
      className: 'dshRemoteComputerIcon',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
      React.createElement('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }),
      React.createElement('path', { d: 'M8 21h8M12 17v4' }))
    const remoteActive = status?.mode === 'remote'
    // Wide entry: the label keeps the host name on the left and the computer
    // icon button sits at the right end of the row, matching the Compact entry
    // that hangs off the account row. The icon button carries the action (exit
    // when Remote mode is active, open the Remote panel otherwise) and its
    // tooltip keeps the host name plus the exit hint. The update suffix keeps
    // the host's own update-indicator look; the icon-only rail/compact entries
    // get the official 6px brand dot instead.
    const updateSuffix = localUpdateAvailable && props.wide
      ? React.createElement('span', {
        className: 'dshRemoteUpdateSuffix',
        title: updateNotice, 'aria-hidden': true,
      }, t('updateShort', { version: updateInfo?.latestVersion ?? '' }))
      : null
    const updateDot = localUpdateAvailable
      ? React.createElement('span', { className: 'dshRemoteUpdateDot', title: t('updateBadge'), 'aria-hidden': true })
      : null
    const entry = React.createElement('div', { className: `dshRemoteSidebarEntry${remoteActive ? ' isActive' : ''}${props.wide ? ' isWide' : ' isRail'}${localUpdateAvailable ? ' hasUpdate' : ''}` },
      props.wide
        ? React.createElement('span', { className: 'dshRemoteSidebarLabel', title: remoteActionLabel }, remoteLabel)
        : null,
      props.wide ? updateSuffix : null,
      React.createElement('button', {
        type: 'button',
        className: 'dshRemoteModeButton',
        disabled: remoteActive && busy,
        title: remoteActionLabel,
        'aria-label': props.wide ? remoteLabel : remoteActionLabel,
        onClick: () => void (remoteActive && !reauth ? openLocalWorkspaces() : show()),
      }, computerIcon, props.wide ? null : updateDot))
    // The Compact style drops the label and lives in the account row, so it is
    // always a plain icon button regardless of the current Remote mode.
    const accountEntry = React.createElement('div', { className: `dshRemoteAccountEntry${remoteActive ? ' isActive' : ''}` },
      React.createElement('button', {
        type: 'button',
        className: 'dshRemoteAccountEntryButton',
        disabled: remoteActive && busy,
        title: remoteActionLabel,
        'aria-label': remoteActionLabel,
        onClick: () => void (remoteActive && !reauth ? openLocalWorkspaces() : show()),
      }, computerIcon, updateDot))
    const compact = sidebarEntry === 'compact' && props.wide && props.portal !== undefined

    return React.createElement(React.Fragment, null,
      compact
        ? React.createElement(RemoteAccountEntry, { portal: props.portal, fallback: entry }, accountEntry)
        : entry,
      !open ? null : renderBodyPortal(portal, React.createElement('div', {
        className: 'dshRemoteBackdrop',
        role: 'presentation',
        onMouseDown: (event: MouseEvent) => { if (event.target === event.currentTarget) setOpen(false) },
      }, React.createElement('section', {
        className: `dshRemotePage${needsAuthorization === false ? ' isWorkbench' : ''}${selectedHost === undefined ? '' : ' hasSelectedHost'}`,
        role: 'dialog',
        'aria-modal': true,
        'aria-label': selectedHost === undefined ? t('remoteTitle') : t('chooseWorkspace'),
        tabIndex: -1,
        ref: pageRef,
      },
        React.createElement('header', { className: 'dshRemotePageHeader' },
          React.createElement('div', { className: 'dshRemotePageIntro' },
            React.createElement('div', { className: 'dshRemotePageTitleRow' },
              React.createElement('span', { className: 'dshRemoteBrandMark', 'aria-hidden': true },
                React.createElement('svg', {
                  viewBox: whaleMarkViewBox, fill: 'currentColor', 'aria-hidden': true, focusable: false,
                }, React.createElement('path', { d: whaleMarkPath }))),
              React.createElement('div', { className: 'dshRemotePageTitles' },
                React.createElement('div', { className: 'dshRemotePageEyebrow' },
                  React.createElement('span', { className: 'dshRemotePageEyebrowLabel' }, 'DSH Remote'),
                  selectedHost === undefined ? null : React.createElement(React.Fragment, null,
                    glyph(React, ChevronRight), React.createElement('span', { className: 'dshRemoteBreadcrumbHost', title: selectedHost.name }, selectedHost.name)),
                  selectedHost === undefined ? React.createElement('a', {
                    className: 'dshRemoteStarLink',
                    href: 'https://github.com/gaolin89898/remote-session-plugin',
                    target: '_blank',
                    rel: 'noreferrer',
                  }, t('starProject')) : null),
                React.createElement('strong', null, t(selectedHost === undefined ? 'remoteTitle' : 'chooseWorkspace'))))),
          React.createElement('div', { className: 'dshRemotePageActions' },
            selectedHost === undefined ? null : React.createElement('button', {
              type: 'button',
              className: 'dshRemotePageBack',
              disabled: busy,
              title: t('backToHosts'),
              'aria-label': t('backToHosts'),
              onClick: chooseAnotherHost,
            }, glyph(React, ArrowLeftRight), React.createElement('span', null, t('backToHosts'))),
            React.createElement('button', {
              type: 'button',
              className: 'dshRemotePageRefresh',
              disabled: busy,
              title: t('refreshRemote'),
              'aria-label': t('refreshRemote'),
              onClick: () => void refreshRemote(),
            }, glyph(React, RefreshCw)),
            React.createElement('button', { type: 'button', className: 'dshRemotePageClose', onClick: () => setOpen(false), 'aria-label': t('close'), title: t('close') }, glyph(React, X)))),
        React.createElement('main', { className: 'dshRemotePageBody' },
          status?.mode === 'remote' ? React.createElement('button', {
            type: 'button',
            className: 'dshRemoteLocalLink',
            disabled: busy,
            onClick: () => void openLocalWorkspaces(),
          }, t('openLocalWorkspaces')) : null,
          React.createElement(React.Fragment, null,
            needsAuthorization === undefined && busy
              ? React.createElement('p', null, t('checkingConnection')) : null,
            needsAuthorization ? React.createElement('section', { className: 'dshRemoteEnable' },
              React.createElement('div', { className: 'dshRemoteLoginHeading' },
                React.createElement('a', {
                  href: 'https://github.com/gaolin89898/remote-session-plugin',
                  target: '_blank', rel: 'noopener noreferrer',
                },
                  React.createElement('strong', { className: 'dshRemoteLoginTitle' }, t('signInClient')),
                  React.createElement('span', null, t('signInClientDescription')))),
              React.createElement('div', { className: 'dshRemoteLoginTabs', role: 'tablist' },
                pairingAvailable && status?.hostAuthorizationAvailable ? React.createElement('button', {
                  type: 'button', role: 'tab', id: 'dsh-remote-pairing-tab',
                  'aria-selected': loginMethod === 'device_pairing', 'aria-controls': 'dsh-remote-pairing-panel',
                  className: loginMethod === 'device_pairing' ? 'isActive' : '', disabled: busy || savingServer,
                  onClick: () => selectLoginMethod('device_pairing'),
                }, t('pairingLoginTab')) : null,
                ...orderedQrProviders.map(qrLoginTab),
                React.createElement('button', {
                  type: 'button', role: 'tab', id: 'dsh-remote-password-tab',
                  'aria-selected': passwordVisible, 'aria-controls': 'dsh-remote-password-panel',
                  className: passwordVisible ? 'isActive' : '', disabled: busy || savingServer || serverDirty,
                  onClick: () => selectLoginMethod('password'),
                }, t('accountPasswordLogin'))),
              React.createElement('div', { className: 'dshRemoteLoginContent' },
              providersLoading && loginMethod !== 'device_pairing' ? React.createElement('p', { role: 'status' }, t('loadingLoginProviders')) : null,
              providersFailed ? React.createElement('p', { role: 'status' },
                t('noLoginProviders'), ' ', React.createElement('button', {
                  type: 'button', disabled: busy || savingServer || serverDirty,
                  onClick: () => setProviderReload(value => value + 1),
                }, t('retryLoginProviders'))) : null,
              !savingServer && !serverDirty && !providersLoading && !providersFailed && oauthProviders.length === 0 && loginMethod !== 'device_pairing'
                ? React.createElement('p', { role: 'status' }, t('noLoginProviders')) : null,
              loginMethod === 'device_pairing' && pairingAvailable && status?.hostAuthorizationAvailable
                ? React.createElement('div', { role: 'tabpanel', id: 'dsh-remote-pairing-panel', 'aria-labelledby': 'dsh-remote-pairing-tab', className: 'dshRemotePanelPairing' },
                  React.createElement(HostPairingPanel, { key: status.serverUrl ?? '', control: props.control,
                    serverUrl: status.serverUrl ?? '', disabled: busy || savingServer || serverDirty, t,
                    onComplete: () => { void refreshRemote() } }))
                : passwordVisible
                ? React.createElement('div', {
                  className: 'dshRemoteClientLogin', role: 'tabpanel', id: 'dsh-remote-password-panel',
                  'aria-labelledby': 'dsh-remote-password-tab',
                },
                  React.createElement('input', {
                    type: 'email', value: email, disabled: busy, autoComplete: 'username', placeholder: t('account'),
                    'aria-label': t('account'), onChange: (event: Event) => setEmail((event.target as HTMLInputElement).value),
                  }),
                  React.createElement('input', {
                    type: 'password', value: password, disabled: busy, autoComplete: 'current-password', placeholder: t('password'),
                    'aria-label': t('password'), onChange: (event: Event) => setPassword((event.target as HTMLInputElement).value),
                  }),
                  React.createElement('button', { type: 'button', disabled: busy || savingServer || serverDirty || loginServerUrl.trim() === '' || email.trim() === '' || password === '', onClick: () => void signInClient() }, t(busy ? 'signingIn' : 'startSignIn')),
                  React.createElement('p', { className: 'dshRemotePasswordHint' }, t('passwordHint')))
                : selectedProvider !== undefined
                  ? React.createElement('div', {
                    className: 'dshRemoteQrLogin', role: 'tabpanel', id: `dsh-remote-${loginMethod}-panel`,
                    'aria-labelledby': `dsh-remote-${loginMethod}-tab`,
                  },
                    qrImage === undefined
                      ? React.createElement('div', { className: 'dshRemoteQrPlaceholder', 'aria-busy': busy },
                        qrExpired ? React.createElement('p', null, t('qrLoginExpired')) : React.createElement('span', null, t('checkingConnection')))
                      : qrSession !== undefined
                        ? React.createElement('a', {
                          className: 'dshRemoteQrOpen', href: qrSession.scanUrl,
                          target: '_blank', rel: 'noopener noreferrer',
                          'aria-label': t('openInBrowser'),
                        },
                          React.createElement('img', {
                            src: qrImage, width: 184, height: 184,
                            alt: scanLabel,
                          }),
                          React.createElement('span', null, t('openInBrowser'), ' ↗'))
                        : null,
                    React.createElement('strong', null, scanLabel),
                    React.createElement('p', null, t('scanLoginHint')),
                    qrExpired ? React.createElement('button', {
                      type: 'button', disabled: busy, onClick: () => setQrExpired(false),
                    }, t('refreshQrCode')) : null)
                  : null,
              ),
              React.createElement('div', { className: 'dshRemoteServiceAddress' },
                React.createElement('span', null, t('currentServiceAddress')),
                editingServer
                  ? React.createElement('form', {
                    className: 'dshRemoteLoginServer',
                    onSubmit: (event: Event) => { event.preventDefault(); void saveLoginServer() },
                  },
                    React.createElement('input', {
                      id: 'dsh-remote-login-server', type: 'url', required: true,
                      'aria-label': t('serverUrl'), value: loginServerUrl,
                      disabled: busy || savingServer, autoComplete: 'url',
                      placeholder: t('serverUrl'), onChange: (event: Event) => {
                        resetLoginFlow()
                        setLoginServerUrl((event.target as HTMLInputElement).value)
                      },
                    }),
                    React.createElement('button', {
                      type: 'submit', disabled: busy || savingServer || loginServerUrl.trim() === '',
                    }, t(savingServer ? 'saving' : 'save')),
                    React.createElement('button', {
                      type: 'button', disabled: busy || savingServer,
                      onClick: () => { resetLoginFlow(); setLoginServerUrl('https://remote.gaolin.ink'); void saveLoginServer('https://remote.gaolin.ink') },
                    }, t('restoreDefaultServiceAddress')),
                    React.createElement('button', {
                      type: 'button', disabled: busy || savingServer,
                      onClick: () => {
                        setLoginServerUrl(status?.serverUrl ?? 'https://remote.gaolin.ink')
                        setEditingServer(false)
                      },
                    }, t('cancelServiceAddressEdit')))
                  : React.createElement(React.Fragment, null,
                    React.createElement('a', {
                      href: status?.serverUrl ?? loginServerUrl, target: '_blank', rel: 'noreferrer',
                    }, status?.serverUrl ?? loginServerUrl),
                    React.createElement('button', {
                      type: 'button', className: 'dshRemoteServiceAddressEdit',
                      disabled: busy || savingServer,
                      title: t('editServiceAddress'), 'aria-label': t('editServiceAddress'),
                      onClick: () => setEditingServer(true),
                    }, React.createElement('svg', {
                      viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
                      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
                      'aria-hidden': true,
                    }, React.createElement('path', { d: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z' })))))) : null,
            needsAuthorization !== false ? null : React.createElement(React.Fragment, null,
              selectedHost === undefined ? React.createElement('section', { className: 'dshRemoteHosts', 'aria-label': t('chooseHost') },
                status?.hostAuthorizationAvailable && status.host?.accountRequired
                  ? React.createElement('section', { className: 'dshRemoteHostAccount' },
                    React.createElement('strong', null, t('thisMachineHost')),
                    React.createElement('p', null, t('hostSignInHint')),
                    React.createElement('div', { className: 'dshRemoteLogin' },
                      React.createElement('input', { type: 'email', value: hostEmail, disabled: busy, autoComplete: 'username', placeholder: t('serverAccountEmail'), 'aria-label': t('serverAccountEmail'), onChange: (event: Event) => setHostEmail((event.target as HTMLInputElement).value) }),
                      React.createElement('input', { type: 'password', value: hostPassword, disabled: busy, autoComplete: 'current-password', placeholder: t('serverAccountPassword'), 'aria-label': t('serverAccountPassword'), onChange: (event: Event) => setHostPassword((event.target as HTMLInputElement).value) }),
                      React.createElement('button', { type: 'button', disabled: busy || hostEmail.trim() === '' || hostPassword === '', onClick: () => void authorizeHost('account') }, t(busy ? 'signingIn' : 'signInRegisterHost')),
                      React.createElement('input', { value: hostRegistrationCode, disabled: busy, autoComplete: 'one-time-code', placeholder: t('hostRegistrationCode'), 'aria-label': t('hostRegistrationCode'), onChange: (event: Event) => setHostRegistrationCode((event.target as HTMLInputElement).value) }),
                      React.createElement('button', { type: 'button', disabled: busy || hostRegistrationCode.trim() === '', onClick: () => void authorizeHost('code') }, t(busy ? 'registering' : 'useRegistrationCode'))))
                  : null,
                status?.hostAuthorizationAvailable ? React.createElement('div', { className: 'dshRemotePermissionRow' },
                  React.createElement('span', { className: 'dshRemotePermissionIcon', 'aria-hidden': true }, glyph(React, ShieldCheck)),
                  React.createElement('label', { className: 'dshRemoteHostControlToggle' },
                      React.createElement('span', null, t('allowControlDevice')),
                      React.createElement('input', {
                        type: 'checkbox', role: 'switch', disabled: busy,
                        'aria-label': t('allowControlDevice'),
                        checked: status.host?.authorized === true,
                        onChange: (event: Event) => void setCurrentDeviceControl((event.target as HTMLInputElement).checked),
                      })), connectedMenu) : null,
                React.createElement('div', { className: 'dshRemoteSectionHeading' },
                  React.createElement('div', { className: 'dshRemoteSectionTitle' },
                    React.createElement('strong', null, t(status?.host?.pairingHostOnly ? 'thisMachineHost' : 'chooseHost')),
                    status?.host?.pairingHostOnly ? null : React.createElement('span', { className: 'dshRemoteOnlineCount' },
                      t('onlineHostCount', { count: serverUnavailable ? 0 : devices.filter(device => device.online).length }))),
                  status?.host?.pairingHostOnly ? null : React.createElement('div',
                    { className: `dshRemoteHostFilter${hostFilterOpen ? ' isOpen' : ''}` },
                    React.createElement('button', {
                      type: 'button', className: 'dshRemoteHostFilterTrigger', disabled: busy,
                      'aria-haspopup': 'listbox', 'aria-expanded': hostFilterOpen,
                      'aria-label': t('hostFilterLabel'), ref: hostFilterTriggerRef,
                      onClick: () => setHostFilterOpen(current => !current),
                      onKeyDown: (event: KeyboardEvent) => {
                        // Enter/Space fall through to the button's own click
                        // toggle; only the arrows open the listbox explicitly.
                        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                        event.preventDefault()
                        setHostFilterOpen(true)
                      },
                    },
                      hostFilterOptions.find(option => option.value === hostFilter)?.label ?? t('allHosts'),
                      React.createElement('svg', {
                        className: 'dshRemoteHostFilterChevron', viewBox: '0 0 24 24', width: 11, height: 11,
                        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
                        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
                      }, React.createElement('path', { d: 'm6 9 6 6 6-6' }))),
                    hostFilterOpen ? React.createElement('div', {
                      className: 'dshRemoteHostFilterMenu', role: 'listbox',
                      'aria-label': t('hostFilterLabel'), ref: hostFilterMenuRef,
                      onKeyDown: (event: KeyboardEvent) => {
                        const menu = event.currentTarget
                        if (!(menu instanceof Element)) return
                        const options = Array.from(menu.querySelectorAll('.dshRemoteHostFilterOption')) as HTMLButtonElement[]
                        if (event.key === 'Escape' || event.key === 'Tab') {
                          setHostFilterOpen(false)
                          if (event.key === 'Escape') {
                            event.stopPropagation()
                            hostFilterTriggerRef.current?.focus()
                          }
                          return
                        }
                        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
                        event.preventDefault()
                        const index = options.findIndex(option => option === document.activeElement)
                        const next = event.key === 'Home' ? 0
                          : event.key === 'End' ? options.length - 1
                          : event.key === 'ArrowDown' ? index + 1
                          : index - 1
                        options[(next + options.length) % options.length]?.focus()
                      },
                    }, hostFilterOptions.map(option => React.createElement('button', {
                      type: 'button', key: option.value, role: 'option',
                      'aria-selected': option.value === hostFilter,
                      className: `dshRemoteHostFilterOption${option.value === hostFilter ? ' isSelected' : ''}`,
                      onClick: () => {
                        setHostFilterOpen(false)
                        if (option.value !== hostFilter) setHostFilter(option.value)
                      },
                    }, option.label))) : null)),
                React.createElement('div', {
                  className: `dshRemoteHostList${connectingHost === undefined ? '' : ' isCollapsed'}`,
                  'aria-busy': connectingHost === undefined ? undefined : true,
                }, listedHosts.length === 0
                  ? (error !== undefined ? null : React.createElement('p', null, busy ? t('checkingConnection') : t(status?.host?.pairingHostOnly ? 'pairingHostOnly' : devices.length > 0 ? 'noHostMatches' : 'noRemoteHosts')))
                  : listedHosts.map(device => {
                    // A restarting Host is on its way down: keep the row
                    // listed but non-clickable, so a press can neither open a
                    // doomed connection nor collapse the list onto it.
                    const rowRestarting = restartingHost === device.deviceId
                    const rowDisabled = busy || serverUnavailable || !device.online || rowRestarting
                    return React.createElement('div', {
                      key: device.deviceId,
                      // A real row button cannot hold the restart action: nested
                      // buttons are invalid, so the row is a div with button
                      // semantics and the action keeps its own native button.
                      className: `dshRemoteHostRow${rowDisabled ? ' isDisabled' : ''}`,
                      role: 'button',
                      tabIndex: rowDisabled ? -1 : 0,
                      'aria-disabled': rowDisabled ? true : undefined,
                      'aria-current': connectingHost?.deviceId === device.deviceId ? 'true' : undefined,
                      onClick: () => { if (!rowDisabled) void selectHost(device) },
                      onKeyDown: (event: KeyboardEvent) => {
                        if (rowDisabled || (event.key !== 'Enter' && event.key !== ' ')) return
                        event.preventDefault()
                        void selectHost(device)
                      },
                    },
                    React.createElement('span', { className: 'dshRemoteHostItemLeft' },
                      React.createElement('span', { className: 'dshRemoteHostItemIcon', 'aria-hidden': true },
                        hostDeviceGlyph(React, device.platform)),
                      React.createElement('span', { className: 'dshRemoteHostItemText' },
                        React.createElement('strong', null, device.name),
                        React.createElement('small', null, [
                          formatPlatform(device.platform),
                          device.harnessVersion === undefined ? undefined : t('harnessVersion', { version: device.harnessVersion }),
                          device.clientVersion === undefined ? undefined : t('pluginVersion', { version: device.clientVersion }),
                          deviceUpdateAvailable(device) ? t('updateAvailableTag') : undefined,
                        ].filter(Boolean).join(' · ')))),
                    React.createElement('span', { className: 'dshRemoteHostItemRight' },
                      !rowDisabled ? React.createElement('button', {
                        type: 'button',
                        className: `dshRemoteHostRestart${restartingHost === device.deviceId ? ' isBusy' : ''}`,
                        disabled: busy || restartingHost !== undefined,
                        title: t('restartHostTitle', { name: device.name }),
                        'aria-label': t('restartHostTitle', { name: device.name }),
                        onClick: (event: Event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void restartHost(device)
                        },
                      }, glyph(React, Power)) : null,
                      React.createElement('small', {
                        className: `dshRemoteHostStatus${rowRestarting ? ' isRestarting' : serverUnavailable || !device.online ? ' isOffline' : ' isOnline'}`,
                        'aria-busy': rowRestarting ? true : undefined,
                      }, rowRestarting
                        ? t('hostRestartingBadge')
                        : t(serverUnavailable ? 'unavailable' : device.online ? 'online' : 'offline')),
                      React.createElement('span', { className: 'dshRemoteHostItemChevron', 'aria-hidden': true }, glyph(React, ChevronRight)))
                    )
                  }))) : null,
              React.createElement(RemoteProgressView, { progress, t }),
              selectedHost === undefined
                ? (connectingHost === undefined ? renderAccount() : null)
                : React.createElement('div', { className: 'dshRemotePickerLayout' },
                  React.createElement('aside', { className: 'dshRemoteHostRail', 'aria-label': selectedHost.name },
                    React.createElement('div', { className: 'dshRemoteRailHost' },
                      React.createElement('span', { className: 'dshRemoteHostItemIcon', 'aria-hidden': true }, hostDeviceGlyph(React, selectedHost.platform)),
                      React.createElement('div', null,
                        React.createElement('strong', { title: selectedHost.name }, selectedHost.name),
                        React.createElement('small', { className: `dshRemoteRailStatus${status?.connected ? ' isOnline' : ''}` }, t(status?.connected ? 'connected' : 'offline')))),
                    React.createElement('dl', { className: 'dshRemoteHostSpecs' },
                      React.createElement('div', null, React.createElement('dt', null, t('platform')), React.createElement('dd', null, formatPlatform(selectedHost.platform))),
                      selectedHost.harnessVersion === undefined ? null : React.createElement('div', null,
                        React.createElement('dt', null, 'Harness'), React.createElement('dd', null, selectedHost.harnessVersion)),
                      selectedHost.clientVersion === undefined ? null : React.createElement('div', null,
                        React.createElement('dt', null, t('pluginVersion', { version: '' })),
                        React.createElement('dd', null, selectedHost.clientVersion,
                          deviceUpdateAvailable(selectedHost) ? React.createElement('small', null, t('updateAvailableTag')) : null))),
                    React.createElement('div', { className: `dshRemoteSelectedDirectory${path === '' ? '' : ' hasSelection'}` },
                      React.createElement('span', null, glyph(React, FolderOpen), t('currentDirectory')),
                      React.createElement('strong', { title: path || undefined }, path || '—')),
                    renderAccount()),
                  React.createElement('section', { className: 'dshRemoteBrowser', 'aria-label': t('chooseDirectory') },
                  addingWorkspace ? null : React.createElement('label', { className: 'dshRemoteWorkspaceSearch' },
                    glyph(React, Search), React.createElement('input', {
                      type: 'search', value: workspaceSearch, placeholder: t('searchWorkspaces'), 'aria-label': t('searchWorkspaces'),
                      onChange: (event: Event) => setWorkspaceSearch((event.target as HTMLInputElement).value),
                    })),
                  !addingWorkspace ? null : React.createElement('div', { className: 'dshRemoteSectionHeading dshRemoteWorkspaceHeading' },
                    React.createElement('div', { className: 'dshRemoteAddTitle' },
                      React.createElement('strong', null, t(workspaceBackend === 'codex'
                        ? 'addCodexWorkspace'
                        : workspaceBackend === 'cursor'
                          ? 'addCursorWorkspace'
                          : workspaceBackend === 'antigravity'
                            ? 'addAntigravityWorkspace'
                            : workspaceBackend === 'pi'
                              ? 'addPiWorkspace'
                              : workspaceBackend === 'claude' ? 'addClaudeWorkspace' : workspaceBackend === 'hermes' ? 'addHermesWorkspace'
                              : workspaceBackend === 'opencode'
                                ? 'addOpencodeWorkspace'
                                : 'addRemoteWorkspace')),
                      React.createElement('small', null, t('browseFolderHint'))),
                    directory === undefined ? null : React.createElement('span', { className: 'dshRemoteDirectoryCount' },
                      React.createElement('svg', {
                        viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none', stroke: 'currentColor',
                        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
                      }, React.createElement('path', { d: 'M12 3 3 8l9 5 9-5-9-5Z' }),
                        React.createElement('path', { d: 'm3 13 9 5 9-5' })),
                      t('directoryCount', { count: directory.entries.filter(entry => !entry.hidden).length }))),
                  addingWorkspace
                    ? React.createElement('div', { className: 'dshRemoteFolderBrowser' },
                      directory === undefined
                        ? React.createElement('p', null, t('loadingDirectory'))
                        : React.createElement(React.Fragment, null,
                          React.createElement('nav', { className: 'dshRemoteCrumbs', 'aria-label': t('currentDirectory') },
                            React.createElement('button', {
                              type: 'button', key: 'host', disabled: busy || directory.path === directory.home,
                              onClick: () => void browseDirectory(),
                            }, selectedHost.name),
                            ...directory.crumbs.filter(crumb => crumb.path !== directory.home).map(crumb => React.createElement('button', {
                              type: 'button', key: crumb.path, disabled: busy || crumb.path === directory.path,
                              onClick: () => void browseDirectory(crumb.path),
                            }, crumb.name))),
                          React.createElement('div', { className: 'dshRemoteFolderList' }, directory.entries.filter(entry => !entry.hidden).length === 0
                            ? React.createElement('p', null, t('emptyDirectory'))
                            : directory.entries.filter(entry => !entry.hidden).map(entry => React.createElement('button', {
                              type: 'button', key: entry.path, disabled: busy,
                              className: pickedDirectoryPath === entry.path ? 'isSelected' : '',
                              'aria-pressed': pickedDirectoryPath === entry.path,
                              // The first press picks the folder (the confirm
                              // button opens it); pressing the picked row, or
                              // double-clicking, descends into it.
                              onClick: () => {
                                if (pickedDirectoryPath === entry.path) void browseDirectory(entry.path)
                                else setPickedDirectoryPath(entry.path)
                              },
                            },
                              glyph(React, FolderOpen),
                              React.createElement('span', null, entry.name),
                              React.createElement('span', { className: 'dshRemoteFolderRowEnd', 'aria-hidden': true },
                                pickedDirectoryPath === entry.path
                                  ? React.createElement('span', { className: 'dshRemoteFolderRowCheck' },
                                    React.createElement('svg', {
                                      viewBox: '0 0 24 24', width: 10, height: 10, fill: 'none', stroke: 'currentColor',
                                      strokeWidth: 3.2, strokeLinecap: 'round', strokeLinejoin: 'round',
                                    }, React.createElement('path', { d: 'm5 13 4 4 10-10' })))
                                  : glyph(React, ChevronRight))))),
                          directory.truncated ? React.createElement('small', null, t('directoryTruncated')) : null))
                    : React.createElement('div', { className: 'dshRemoteWorkspaceLists' },
                      React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' }, workspaceHeading,
                        React.createElement('div', { id: workspaceListId, className: 'dshRemoteDirectoryList' }, visibleWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noRemoteWorkspaces' : 'noWorkspaceMatches'))
                          : visibleWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button', key: workspace.workspaceId, disabled: busy,
                            className: workspaceBackend === 'harness' && path === workspace.path ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'harness' && path === workspace.path,
                            onClick: () => { setWorkspaceBackend('harness'); setCodexWorkspaceId(undefined); setCursorWorkspaceId(undefined); setPath(workspace.path) },
                            onDoubleClick: () => void openWorkspace({ backend: 'harness', path: workspace.path }),
                          }, workspaceIcon,
                            React.createElement('span', null, workspace.title), React.createElement('small', null, workspace.path))),
                          query !== '' || workspaces.length <= 3 || showAllWorkspaces ? null : React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteWorkspaceMore',
                            disabled: busy,
                            'aria-controls': workspaceListId,
                            'aria-label': t('showAllWorkspaces'),
                            onClick: () => setShowAllWorkspaces(true),
                          }, React.createElement('span', { 'aria-hidden': true }, '…')))),
                      !codexAvailable ? null : React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' },
                        React.createElement('div', {
                          id: codexWorkspaceHeadingId,
                          className: 'dshRemoteWorkspaceSourceHeading',
                        }, React.createElement('span', { className: 'dshRemoteWorkspaceSourceText' },
                          React.createElement('strong', null, t('codexVirtualWorkspace'))),
                          !codexAvailable ? null : React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteAddWorkspace',
                            disabled: busy,
                            title: t('addCodexWorkspace'),
                            'aria-label': t('addCodexWorkspace'),
                            onClick: () => startAddingWorkspace('codex'),
                          }, glyph(React, Plus))),
                        React.createElement('div', {
                          id: codexWorkspaceListId,
                          className: 'dshRemoteDirectoryList dshRemoteCodexWorkspaceList',
                          'aria-labelledby': codexWorkspaceHeadingId,
                        }, visibleCodexWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noCodexWorkspaces' : 'noWorkspaceMatches'))
                          : visibleCodexWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button',
                            key: workspace.workspaceId,
                            disabled: busy,
                            className: workspaceBackend === 'codex' && codexWorkspaceId === workspace.workspaceId ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'codex' && codexWorkspaceId === workspace.workspaceId,
                            onClick: () => {
                              setWorkspaceBackend('codex')
                              setCodexWorkspaceId(workspace.workspaceId)
                              setCursorWorkspaceId(undefined)
                              setPath(workspace.path)
                            },
                            onDoubleClick: () => void openWorkspace({
                              backend: 'codex',
                              path: workspace.path,
                              workspaceId: workspace.workspaceId,
                            }),
                          }, React.createElement('img', { className: 'dshRemoteWorkspaceIcon isGpt', src: gptWorkspaceIcon, alt: '', 'aria-hidden': true }),
                            React.createElement('span', null, workspace.title),
                            React.createElement('small', null, `${workspace.path} · ${workspace.sessionCount}`)))),
                        query !== '' || codexWorkspaces.length <= 3 || showAllCodexWorkspaces ? null : React.createElement('button', {
                          type: 'button',
                          className: 'dshRemoteWorkspaceMore',
                          disabled: busy,
                          'aria-controls': codexWorkspaceListId,
                          'aria-label': t('showAllCodexWorkspaces'),
                          onClick: () => setShowAllCodexWorkspaces(true),
                        }, React.createElement('span', { 'aria-hidden': true }, '…'))),
                      !cursorAvailable ? null : React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' },
                        React.createElement('div', {
                          id: cursorWorkspaceHeadingId,
                          className: 'dshRemoteWorkspaceSourceHeading',
                        }, React.createElement('span', { className: 'dshRemoteWorkspaceSourceText' },
                          React.createElement('strong', null, t('cursorVirtualWorkspace'))),
                          !cursorAvailable ? null : React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteAddWorkspace',
                            disabled: busy,
                            title: t('addCursorWorkspace'),
                            'aria-label': t('addCursorWorkspace'),
                            onClick: () => startAddingWorkspace('cursor'),
                          }, glyph(React, Plus))),
                        React.createElement('div', {
                          id: cursorWorkspaceListId,
                          className: 'dshRemoteDirectoryList dshRemoteCodexWorkspaceList',
                          'aria-labelledby': cursorWorkspaceHeadingId,
                        }, visibleCursorWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noCursorWorkspaces' : 'noWorkspaceMatches'))
                          : visibleCursorWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button',
                            key: workspace.workspaceId,
                            disabled: busy,
                            className: workspaceBackend === 'cursor' && cursorWorkspaceId === workspace.workspaceId ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'cursor' && cursorWorkspaceId === workspace.workspaceId,
                            onClick: () => {
                              setWorkspaceBackend('cursor')
                              setCursorWorkspaceId(workspace.workspaceId)
                              setCodexWorkspaceId(undefined)
                              setAntigravityWorkspaceId(undefined)
                              setPiWorkspaceId(undefined)
                              setOpencodeWorkspaceId(undefined)
                              setClaudeWorkspaceId(undefined)
                              setHermesWorkspaceId(undefined)
                              setPath(workspace.path)
                            },
                            onDoubleClick: () => void openWorkspace({
                              backend: 'cursor',
                              path: workspace.path,
                              workspaceId: workspace.workspaceId,
                            }),
                          }, workspaceIcon,
                            React.createElement('span', null, workspace.title),
                            React.createElement('small', null, `${workspace.path} · ${workspace.sessionCount}`)))),
                        query !== '' || cursorWorkspaces.length <= 3 || showAllCursorWorkspaces ? null : React.createElement('button', {
                          type: 'button',
                          className: 'dshRemoteWorkspaceMore',
                          disabled: busy,
                          'aria-controls': cursorWorkspaceListId,
                          'aria-label': t('showAllCursorWorkspaces'),
                          onClick: () => setShowAllCursorWorkspaces(true),
                        }, React.createElement('span', { 'aria-hidden': true }, '…'))),
                      !antigravityAvailable ? null : React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' },
                        React.createElement('div', {
                          id: antigravityWorkspaceHeadingId,
                          className: 'dshRemoteWorkspaceSourceHeading',
                        }, React.createElement('span', { className: 'dshRemoteWorkspaceSourceText' },
                          React.createElement('strong', null, t('antigravityVirtualWorkspace'))),
                          !antigravityAvailable ? null : React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteAddWorkspace',
                            disabled: busy,
                            title: t('addAntigravityWorkspace'),
                            'aria-label': t('addAntigravityWorkspace'),
                            onClick: () => startAddingWorkspace('antigravity'),
                          }, glyph(React, Plus))),
                        React.createElement('div', {
                          id: antigravityWorkspaceListId,
                          className: 'dshRemoteDirectoryList dshRemoteCodexWorkspaceList',
                          'aria-labelledby': antigravityWorkspaceHeadingId,
                        }, visibleAntigravityWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noAntigravityWorkspaces' : 'noWorkspaceMatches'))
                          : visibleAntigravityWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button',
                            key: workspace.workspaceId,
                            disabled: busy,
                            className: workspaceBackend === 'antigravity' && antigravityWorkspaceId === workspace.workspaceId ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'antigravity' && antigravityWorkspaceId === workspace.workspaceId,
                            onClick: () => {
                              setWorkspaceBackend('antigravity')
                              setAntigravityWorkspaceId(workspace.workspaceId)
                              setPiWorkspaceId(undefined)
                              setOpencodeWorkspaceId(undefined)
                              setClaudeWorkspaceId(undefined)
                              setHermesWorkspaceId(undefined)
                              setCodexWorkspaceId(undefined)
                              setCursorWorkspaceId(undefined)
                              setPath(workspace.path)
                            },
                            onDoubleClick: () => void openWorkspace({
                              backend: 'antigravity',
                              path: workspace.path,
                              workspaceId: workspace.workspaceId,
                            }),
                          }, workspaceIcon,
                            React.createElement('span', null, workspace.title),
                            React.createElement('small', null, `${workspace.path} · ${workspace.sessionCount}`)))),
                        query !== '' || antigravityWorkspaces.length <= 3 || showAllAntigravityWorkspaces ? null : React.createElement('button', {
                          type: 'button',
                          className: 'dshRemoteWorkspaceMore',
                          disabled: busy,
                          'aria-controls': antigravityWorkspaceListId,
                          'aria-label': t('showAllAntigravityWorkspaces'),
                          onClick: () => setShowAllAntigravityWorkspaces(true),
                        }, React.createElement('span', { 'aria-hidden': true }, '…'))),
                      !piAvailable ? null : React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' },
                        React.createElement('div', {
                          id: piWorkspaceHeadingId,
                          className: 'dshRemoteWorkspaceSourceHeading',
                        }, React.createElement('span', { className: 'dshRemoteWorkspaceSourceText' },
                          React.createElement('strong', null, t('piVirtualWorkspace'))),
                          !piAvailable ? null : React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteAddWorkspace',
                            disabled: busy,
                            title: t('addPiWorkspace'),
                            'aria-label': t('addPiWorkspace'),
                            onClick: () => startAddingWorkspace('pi'),
                          }, glyph(React, Plus))),
                        React.createElement('div', {
                          id: piWorkspaceListId,
                          className: 'dshRemoteDirectoryList dshRemoteCodexWorkspaceList',
                          'aria-labelledby': piWorkspaceHeadingId,
                        }, visiblePiWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noPiWorkspaces' : 'noWorkspaceMatches'))
                          : visiblePiWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button',
                            key: workspace.workspaceId,
                            disabled: busy,
                            className: workspaceBackend === 'pi' && piWorkspaceId === workspace.workspaceId ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'pi' && piWorkspaceId === workspace.workspaceId,
                            onClick: () => {
                              setWorkspaceBackend('pi')
                              setPiWorkspaceId(workspace.workspaceId)
                              setAntigravityWorkspaceId(undefined)
                              setCodexWorkspaceId(undefined)
                              setCursorWorkspaceId(undefined)
                              setPath(workspace.path)
                            },
                            onDoubleClick: () => void openWorkspace({
                              backend: 'pi',
                              path: workspace.path,
                              workspaceId: workspace.workspaceId,
                            }),
                          }, workspaceIcon,
                            React.createElement('span', null, workspace.title),
                            React.createElement('small', null, `${workspace.path} · ${workspace.sessionCount}`)))),
                        query !== '' || piWorkspaces.length <= 3 || showAllPiWorkspaces ? null : React.createElement('button', {
                          type: 'button',
                          className: 'dshRemoteWorkspaceMore',
                          disabled: busy,
                          'aria-controls': piWorkspaceListId,
                          'aria-label': t('showAllPiWorkspaces'),
                          onClick: () => setShowAllPiWorkspaces(true),
                        }, React.createElement('span', { 'aria-hidden': true }, '…'))),
                      !opencodeAvailable ? null : React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' },
                        React.createElement('div', {
                          id: opencodeWorkspaceHeadingId,
                          className: 'dshRemoteWorkspaceSourceHeading',
                        },
                          React.createElement('span', { className: 'dshRemoteWorkspaceSourceText' }, React.createElement('strong', null, t('opencodeVirtualWorkspace'))),
                          React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteAddWorkspace',
                            disabled: busy,
                            title: t('addOpencodeWorkspace'),
                            'aria-label': t('addOpencodeWorkspace'),
                            onClick: () => startAddingWorkspace('opencode'),
                          }, glyph(React, Plus))),
                        React.createElement('div', {
                          id: opencodeWorkspaceListId,
                          className: 'dshRemoteDirectoryList dshRemoteCodexWorkspaceList',
                          'aria-labelledby': opencodeWorkspaceHeadingId,
                        }, visibleOpencodeWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noOpencodeWorkspaces' : 'noWorkspaceMatches'))
                          : visibleOpencodeWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button',
                            key: workspace.workspaceId,
                            disabled: busy,
                            className: workspaceBackend === 'opencode' && opencodeWorkspaceId === workspace.workspaceId ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'opencode' && opencodeWorkspaceId === workspace.workspaceId,
                            onClick: () => {
                              setWorkspaceBackend('opencode')
                              setOpencodeWorkspaceId(workspace.workspaceId)
                              setPiWorkspaceId(undefined)
                              setClaudeWorkspaceId(undefined)
                              setHermesWorkspaceId(undefined)
                              setAntigravityWorkspaceId(undefined)
                              setCodexWorkspaceId(undefined)
                              setCursorWorkspaceId(undefined)
                              setPath(workspace.path)
                            },
                            onDoubleClick: () => void openWorkspace({
                              backend: 'opencode',
                              path: workspace.path,
                              workspaceId: workspace.workspaceId,
                            }),
                          }, workspaceIcon,
                            React.createElement('span', null, workspace.title),
                            React.createElement('small', null, `${workspace.path} · ${workspace.sessionCount}`)))),
                        query !== '' || opencodeWorkspaces.length <= 3 || showAllOpencodeWorkspaces ? null : React.createElement('button', {
                          type: 'button',
                          className: 'dshRemoteWorkspaceMore',
                          disabled: busy,
                          'aria-controls': opencodeWorkspaceListId,
                          'aria-label': t('showAllOpencodeWorkspaces'),
                          onClick: () => setShowAllOpencodeWorkspaces(true),
                        }, React.createElement('span', { 'aria-hidden': true }, '…'))),
                      !hermesAvailable ? null : React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' },
                        React.createElement('div', {
                          id: hermesWorkspaceHeadingId,
                          className: 'dshRemoteWorkspaceSourceHeading',
                        },
                          React.createElement('span', { className: 'dshRemoteWorkspaceSourceText' }, React.createElement('strong', null, t('hermesVirtualWorkspace'))),
                          React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteAddWorkspace',
                            disabled: busy,
                            title: t('addHermesWorkspace'),
                            'aria-label': t('addHermesWorkspace'),
                            onClick: () => startAddingWorkspace('hermes'),
                          }, glyph(React, Plus))),
                        React.createElement('div', {
                          id: hermesWorkspaceListId,
                          className: 'dshRemoteDirectoryList dshRemoteCodexWorkspaceList',
                          'aria-labelledby': hermesWorkspaceHeadingId,
                        }, visibleHermesWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noHermesWorkspaces' : 'noWorkspaceMatches'))
                          : visibleHermesWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button',
                            key: workspace.workspaceId,
                            disabled: busy,
                            className: workspaceBackend === 'hermes' && hermesWorkspaceId === workspace.workspaceId ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'hermes' && hermesWorkspaceId === workspace.workspaceId,
                            onClick: () => {
                              setWorkspaceBackend('hermes')
                              setClaudeWorkspaceId(undefined)
                              setHermesWorkspaceId(workspace.workspaceId)
                              setPiWorkspaceId(undefined)
                              setOpencodeWorkspaceId(undefined)
                              setAntigravityWorkspaceId(undefined)
                              setCodexWorkspaceId(undefined)
                              setCursorWorkspaceId(undefined)
                              setPath(workspace.path)
                            },
                            onDoubleClick: () => void openWorkspace({
                              backend: 'hermes',
                              path: workspace.path,
                              workspaceId: workspace.workspaceId,
                            }),
                          }, workspaceIcon,
                            React.createElement('span', null, workspace.title),
                            React.createElement('small', null, `${workspace.path} · ${workspace.sessionCount}`)))),
                        query !== '' || hermesWorkspaces.length <= 3 || showAllHermesWorkspaces ? null : React.createElement('button', {
                          type: 'button',
                          className: 'dshRemoteWorkspaceMore',
                          disabled: busy,
                          'aria-controls': hermesWorkspaceListId,
                          'aria-label': t('showAllHermesWorkspaces'),
                          onClick: () => setShowAllHermesWorkspaces(true),
                        }, React.createElement('span', { 'aria-hidden': true }, '…'))),
                      !claudeAvailable ? null : React.createElement('section', { className: 'dshRemoteCodexWorkspaceGroup' },
                        React.createElement('div', {
                          id: claudeWorkspaceHeadingId,
                          className: 'dshRemoteWorkspaceSourceHeading',
                        },
                          React.createElement('span', { className: 'dshRemoteWorkspaceSourceText' }, React.createElement('strong', null, t('claudeVirtualWorkspace'))),
                          React.createElement('button', {
                            type: 'button',
                            className: 'dshRemoteAddWorkspace',
                            disabled: busy,
                            title: t('addClaudeWorkspace'),
                            'aria-label': t('addClaudeWorkspace'),
                            onClick: () => startAddingWorkspace('claude'),
                          }, glyph(React, Plus))),
                        React.createElement('div', {
                          id: claudeWorkspaceListId,
                          className: 'dshRemoteDirectoryList dshRemoteCodexWorkspaceList',
                          'aria-labelledby': claudeWorkspaceHeadingId,
                        }, visibleClaudeWorkspaces.length === 0
                          ? React.createElement('p', null, t(query === '' ? 'noClaudeWorkspaces' : 'noWorkspaceMatches'))
                          : visibleClaudeWorkspaces.map(workspace => React.createElement('button', {
                            type: 'button',
                            key: workspace.workspaceId,
                            disabled: busy,
                            className: workspaceBackend === 'claude' && claudeWorkspaceId === workspace.workspaceId ? 'isSelected' : '',
                            'aria-pressed': workspaceBackend === 'claude' && claudeWorkspaceId === workspace.workspaceId,
                            onClick: () => {
                              setWorkspaceBackend('claude')
                              setClaudeWorkspaceId(workspace.workspaceId)
                              setHermesWorkspaceId(undefined)
                              setPiWorkspaceId(undefined)
                              setOpencodeWorkspaceId(undefined)
                              setAntigravityWorkspaceId(undefined)
                              setCodexWorkspaceId(undefined)
                              setCursorWorkspaceId(undefined)
                              setPath(workspace.path)
                            },
                            onDoubleClick: () => void openWorkspace({
                              backend: 'claude',
                              path: workspace.path,
                              workspaceId: workspace.workspaceId,
                            }),
                          }, workspaceIcon,
                            React.createElement('span', null, workspace.title),
                            React.createElement('small', null, `${workspace.path} · ${workspace.sessionCount}`)))),
                        query !== '' || claudeWorkspaces.length <= 3 || showAllClaudeWorkspaces ? null : React.createElement('button', {
                          type: 'button',
                          className: 'dshRemoteWorkspaceMore',
                          disabled: busy,
                          'aria-controls': claudeWorkspaceListId,
                          'aria-label': t('showAllClaudeWorkspaces'),
                          onClick: () => setShowAllClaudeWorkspaces(true),
                        }, React.createElement('span', { 'aria-hidden': true }, '…')))),
                      React.createElement('footer', { className: 'dshRemoteOpenBar' },
                    connectedMenu,
                    React.createElement('div', { className: 'dshRemoteOpenActions' },
                    React.createElement('button', { type: 'button', className: 'dshRemotePickerCancel', onClick: () => { cancelAddingWorkspace(); chooseAnotherHost() } }, t('cancelAddWorkspace')),
                    React.createElement('button', {
                      type: 'button',
                      disabled: busy || path.trim() === ''
                        || !addingWorkspace && workspaceBackend === 'codex' && codexWorkspaceId === undefined
                        || !addingWorkspace && workspaceBackend === 'cursor' && cursorWorkspaceId === undefined && path === ''
                        || !addingWorkspace && workspaceBackend === 'antigravity' && antigravityWorkspaceId === undefined && path === ''
                        || !addingWorkspace && workspaceBackend === 'pi' && piWorkspaceId === undefined && path === ''
                        || !addingWorkspace && workspaceBackend === 'opencode' && opencodeWorkspaceId === undefined && path === ''
                        || !addingWorkspace && workspaceBackend === 'claude' && claudeWorkspaceId === undefined && path === ''
                        || !addingWorkspace && workspaceBackend === 'hermes' && hermesWorkspaceId === undefined && path === '',
                      onClick: () => void openWorkspace(),
                    }, glyph(React, FolderOpen), t(busy ? 'openingWorkspace' : addingWorkspace ? 'confirmAddWorkspace' : 'openWorkspace')))))))),
          notice === undefined ? null : React.createElement('p', { className: 'dshRemoteNotice', role: 'status' }, notice),
              error === undefined || (serverUnavailable && error === t('serverUnavailableError')) ? null : React.createElement('p', { className: 'dshRemoteError', role: 'alert' }, error))))))
  }

  return RemoteWorkspaceAction
}
