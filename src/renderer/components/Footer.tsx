interface FooterProps {
  readonly runCount: number
}

export default function Footer({ runCount }: FooterProps): React.JSX.Element {
  function handleQuit(): void {
    window.azmd.quit()
  }

  return (
    <footer className="app-footer">
      <span className="app-footer__count">
        {runCount === 0 ? 'No failures' : runCount === 1 ? '1 failure' : `${runCount} failures`}
      </span>
      <button type="button" className="link-button" onClick={handleQuit}>
        Quit
      </button>
    </footer>
  )
}
