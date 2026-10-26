import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * Keeps a render error inside one screen instead of blanking the whole app.
 * On a phone a white page is unrecoverable without clearing site data, so the
 * fallback offers a reload and a way to reset the local cache.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('SmartSplit crashed:', error, info.componentStack)
  }

  private reload = () => {
    window.location.reload()
  }

  private reset = () => {
    try {
      const keep = new Set(['smartsplit-token', 'smartsplit-user'])
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key && key.startsWith('smartsplit-') && !keep.has(key)) keys.push(key)
      }
      keys.forEach((key) => localStorage.removeItem(key))
    } catch {
      // Storage can be blocked; reloading is still worth a try.
    }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="app-shell">
        <div className="crash-screen">
          <p className="eyebrow">SMARTSPLIT</p>
          <h1>Something went wrong</h1>
          <p className="muted">
            The screen hit an error while rendering. Your groups and history are still saved on this
            device.
          </p>
          <div className="crash-actions">
            <button type="button" className="primary-button" onClick={this.reload}>
              Reload
            </button>
            <button type="button" className="ghost-button" onClick={this.reset}>
              Reset local data
            </button>
          </div>
          <pre className="crash-detail">{this.state.error.message}</pre>
        </div>
      </div>
    )
  }
}
