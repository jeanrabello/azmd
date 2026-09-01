/** Estado feliz: nada de errado nas últimas horas. Precisa parecer intencional
 * e calmo, não uma tela em branco por falta de dados. */
export default function EmptyState(): React.JSX.Element {
  return (
    <div className="state-view">
      <svg
        className="state-view__glyph"
        width="36"
        height="36"
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="18" cy="18" r="16.5" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <path
          d="M11.5 18.5l4.2 4.2 9-9.4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p className="state-view__title">No failures in the last 24 hours</p>
      <p className="state-view__subtitle">Everything is running normally.</p>
    </div>
  )
}
