/**
 * Assinatura ad-hoc com o identifier correto.
 *
 * Sem Developer ID, o electron-builder deixa a assinatura "linker-signed" que
 * vem do binário do Electron — e o identifier dela é literalmente "Electron".
 * O macOS lê esse identifier ao registrar Itens de Início de Sessão, então o
 * app aparecia como "Electron" na lista, mesmo com CFBundleName correto.
 *
 * Reassinar ad-hoc com --identifier resolve. Não substitui notarização: é o
 * melhor possível enquanto não há certificado Developer ID (ver fase 4).
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const identifier = context.packager.config.appId

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', identifier, appPath], {
    stdio: 'inherit',
  })
  console.log(`  • assinado ad-hoc com identifier=${identifier}`)
}
