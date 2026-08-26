interface FooterProps {
  readonly runCount: number
}

export default function Footer({ runCount }: FooterProps): React.JSX.Element {
  function handleQuit(): void {
    window.runbar.quit()
  }

  return (
    <footer className="app-footer">
      <span className="app-footer__count">
        {runCount === 0 ? 'Nenhuma falha' : runCount === 1 ? '1 falha' : `${runCount} falhas`}
      </span>
      <button type="button" className="link-button" onClick={handleQuit}>
        Sair
      </button>
    </footer>
  )
}
