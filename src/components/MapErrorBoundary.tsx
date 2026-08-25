import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class MapErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('Map error boundary caught:', error)
    console.error('Component stack:', errorInfo.componentStack)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900">
          <div className="text-center p-8">
            <h2 className="text-xl font-bold text-white mb-4">The map encountered an error</h2>
            <p className="text-slate-400 mb-6">Please try reloading the map.</p>
            <button
              onClick={this.handleReload}
              className="px-6 py-2 rounded-lg text-white font-medium"
              style={{ background: 'var(--viridian)' }}
            >
              Reload map
            </button>
            {this.state.error && (
              <details className="mt-6 text-left">
                <summary className="text-slate-500 cursor-pointer text-sm">Error details</summary>
                <pre className="mt-2 text-xs text-slate-600 overflow-auto max-h-40">
                  {this.state.error.toString()}
                </pre>
              </details>
            )}
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
