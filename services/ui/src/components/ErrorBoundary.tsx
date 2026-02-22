import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex items-center justify-center h-full p-8">
          <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 max-w-lg">
            <h2 className="text-red-400 font-semibold text-lg mb-2">Something went wrong</h2>
            <pre className="text-red-300 text-xs whitespace-pre-wrap break-words mb-4">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm hover:bg-red-600 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
