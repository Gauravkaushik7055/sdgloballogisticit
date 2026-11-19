import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class FirestoreErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    let readable = error?.message || 'An unexpected error occurred.';
    try {
      const parsed = JSON.parse(readable);
      if (parsed?.error) {
        readable = `Cloud database operation (${parsed.operationType || 'access'}) failed: ${parsed.error}`;
      }
    } catch {
      // plain error message
    }
    return { hasError: true, message: readable };
  }

  componentDidCatch(error: Error) {
    console.error('Application ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-6">
          <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900 rounded-2xl p-6 space-y-4 shadow-sm">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-display font-bold text-slate-900 dark:text-white">
                  Application Recovery Notice
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed break-words">
                  {this.state.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  this.setState({ hasError: false, message: '' });
                  window.location.reload();
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reload Workspace
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
