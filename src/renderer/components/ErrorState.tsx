import { useState } from 'react'
import type { AppError } from '../../shared/types.js'

interface ErrorStateProps {
  readonly error: AppError
}

interface ErrorCopy {
  readonly title: string
  readonly actionLabel?: string
  readonly onAction?: () => void
}

function copyFor(error: AppError): ErrorCopy {
  switch (error.kind) {
    case 'auth':
      return {
        title: 'Could not connect to Azure — check your session',
        actionLabel: 'Reconnect',
        onAction: () => window.azmd.refreshNow(),
      }
    case 'permission':
      return {
        title: 'Your account does not have permission (RBAC) to read these Azure resources',
      }
    case 'throttled':
      return {
        title: 'Too many requests to Azure — we will try again shortly',
      }
    case 'network':
      return {
        title: 'No connection — check your network',
      }
    case 'unknown':
      return {
        title: error.message || 'An unexpected error occurred',
      }
  }
}

export default function ErrorState({ error }: ErrorStateProps): React.JSX.Element {
  const [showDetails, setShowDetails] = useState(false)
  const copy = copyFor(error)

  return (
    <div className="state-view state-view--error">
      <svg
        className="state-view__glyph state-view__glyph--error"
        width="36"
        height="36"
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="18" cy="18" r="16.5" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <path d="M18 11v9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="18" cy="24" r="1.1" fill="currentColor" />
      </svg>

      <p className="state-view__title">{copy.title}</p>

      {copy.actionLabel && copy.onAction && (
        <button type="button" className="primary-button" onClick={copy.onAction}>
          {copy.actionLabel}
        </button>
      )}

      {error.detail && (
        <div className="error-details">
          <button
            type="button"
            className="link-button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          {showDetails && <pre className="error-details__content">{error.detail}</pre>}
        </div>
      )}
    </div>
  )
}
