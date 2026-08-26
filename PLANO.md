# Runbar — Plano de Projeto

App de menu bar para macOS que monitora runs de Azure Logic Apps, notifica falhas nativamente e abre o run no portal com um clique.

---

## 1. Objetivo

Hoje descobrir uma falha em Logic App exige abrir o portal, navegar até o recurso e olhar o run history. O Runbar inverte isso: a falha vem até você, e o caminho até o diagnóstico é um clique.

**Critério de sucesso da v1:** uma run falha no Azure e, em menos de 60 segundos, aparece uma notificação nativa no Mac. Clicar nela abre o run exato no navegador.

---

## 2. Escopo

### Dentro da v1

- Ícone permanente na menu bar com indicador de estado (ok / falhas pendentes / erro de conexão)
- Popover com a lista de runs que falharam, mais recente primeiro
- Notificação nativa do macOS por run que falha, com deduplicação
- Clique na notificação ou na linha da lista → abre o run no portal do Azure
- Suporte a Logic Apps **Consumption** e **Standard**
- Seleção de quais subscriptions / resource groups / workflows monitorar
- Início automático no login

### Fora da v1 (backlog explícito)

- Resubmit / cancel de runs pelo app
- Windows e Linux
- Histórico persistente além das últimas 24–48h
- Visualização de inputs/outputs das actions dentro do app
- Métricas agregadas e gráficos

---

## 3. Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Shell | Electron | O main process é Node, então os SDKs do Azure rodam direto |
| Popover | `menubar` (ou `Tray` + `BrowserWindow`) | Boilerplate de janela ancorada no ícone |
| Build | `electron-vite` + TypeScript | HMR no renderer, bundling do main |
| UI | React + CSS próprio | Nenhum design system pronto — ver seção 8 |
| Auth | `@azure/identity` | `AzureCliCredential` no dev, MSAL depois |
| Azure (Consumption) | `@azure/arm-logic` | `LogicManagementClient.workflowRuns` |
| Azure (Standard) | `@azure/arm-appservice` | `WebSiteManagementClient.workflowRuns` |
| Descoberta | `@azure/arm-resourcegraph` | Uma query cobre várias subscriptions |
| Config | `electron-store` | Preferências não sensíveis |
| Segredos | `safeStorage` (Keychain) | Tokens nunca em texto plano |
| Packaging | `electron-builder` | Assinatura Developer ID + notarização |

---

## 4. Arquitetura

Três processos, com fronteira rígida entre eles.

**Main process** — dono de tudo que é sensível. Autenticação, chamadas ao ARM, agendador de polling, estado dos runs conhecidos, disparo de notificações, `shell.openExternal`. Nenhuma credencial cruza para o renderer.

**Preload** — ponte via `contextBridge`, com `contextIsolation: true` e `nodeIntegration: false`. Expõe um contrato mínimo e explícito:

```ts
interface RunbarAPI {
  getFailedRuns(): Promise<FailedRun[]>
  onRunsUpdated(cb: (runs: FailedRun[]) => void): () => void
  openRunInPortal(runId: string): Promise<void>
  refreshNow(): Promise<void>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<void>
}
```

**Renderer** — só desenha. Recebe estado pronto, não sabe o que é ARM.

### Estrutura de pastas

```
runbar/
├─ src/
│  ├─ main/
│  │  ├─ index.ts              # bootstrap, tray, ciclo de vida
│  │  ├─ auth/                 # credential providers
│  │  ├─ azure/
│  │  │  ├─ adapter.ts         # interface comum
│  │  │  ├─ consumption.ts     # @azure/arm-logic
│  │  │  ├─ standard.ts        # @azure/arm-appservice
│  │  │  └─ discovery.ts       # resource graph
│  │  ├─ poller.ts             # agendador + cursores
│  │  ├─ notifier.ts           # notificações + dedupe
│  │  └─ portal-url.ts         # construção de deep links
│  ├─ preload/
│  └─ renderer/
├─ design/
│  └─ mockup.html
└─ PLANO.md
```

---

## 5. Camada Azure

### O ponto crítico: Consumption e Standard são APIs diferentes

Logic Apps Consumption são recursos `Microsoft.Logic/workflows` de primeira classe. Standard vivem *dentro* de um App Service (`Microsoft.Web/sites` com `kind` contendo `workflowapp`), então o caminho é outro SDK inteiro. Ignorar isso no começo custa uma refatoração dolorosa depois.

A solução é um adapter com interface única:

```ts
interface LogicAppAdapter {
  listWorkflows(scope: Scope): Promise<WorkflowRef[]>
  listRuns(wf: WorkflowRef, since: Date): Promise<Run[]>
  buildPortalUrl(run: Run): string
}
```

Consumption:
```ts
client.workflowRuns.list(resourceGroup, workflowName, {
  filter: `status eq 'Failed' and startTime ge ${since.toISOString()}`
})
```

Standard:
```ts
client.workflowRuns.list(resourceGroup, siteName, workflowName)
```
Standard tem filtragem mais limitada — filtrar por status do lado do cliente quando necessário.

### Descoberta

Uma query no Resource Graph resolve o inventário inicial em vez de N chamadas por subscription:

```kql
resources
| where type =~ 'microsoft.logic/workflows'
   or (type =~ 'microsoft.web/sites' and kind contains 'workflowapp')
| project id, name, type, kind, resourceGroup, subscriptionId, location
```

### Permissões

Mínimo necessário: `Microsoft.Logic/workflows/runs/read` (Consumption) e o equivalente em `Microsoft.Web/sites/workflows/runs/read` (Standard). A role `Logic App Operator` cobre o caso Consumption sem dar permissão de escrita.

---

## 6. Motor de polling

Polling simples, mas com três cuidados que evitam dor:

**Cursor por workflow.** Guardar o `startTime` do run mais recente já visto. Cada ciclo pede só `startTime ge cursor`. Sem isso você relê o histórico inteiro toda vez e queima quota.

**Deduplicação por `runId`.** Um `Set` de IDs já notificados, com TTL de 48h. É o que impede notificação repetida quando um run aparece em duas janelas de polling.

**Backoff no 429.** O ARM throttla. Respeitar `Retry-After` e aplicar backoff exponencial com jitter por workflow, não global — um workflow ruidoso não deve travar os outros.

Intervalo padrão: 45s, configurável entre 15s e 5min. Pausar o polling quando a máquina estiver em sleep (`powerMonitor`) e fazer um catch-up no resume.

### Alternativa considerada

Azure Monitor alert rule → Action Group → webhook eliminaria o polling e notificaria em segundos. Foi descartada para a v1 porque exige endpoint público e infra a manter. Fica registrado como caminho de evolução se a latência de 45s incomodar.

---

## 7. Notificações e deep links

```ts
const n = new Notification({
  title: `${run.workflowName} falhou`,
  body: run.errorMessage ?? 'Run terminou com status Failed',
  silent: false,
})
n.on('click', () => shell.openExternal(buildPortalUrl(run)))
n.show()
```

Para a URL do portal: o formato estável para a lista de runs é

```
https://portal.azure.com/#@{tenantId}/resource{resourceId}/runs
```

O formato da blade de um run **específico** varia entre versões do portal. **Tarefa de validação antes de codar:** abrir um run falho manualmente no navegador, copiar a URL real e derivar o template a partir dela — para Consumption e para Standard separadamente. Não confiar em formato assumido.

Fallback: se o deep link do run específico falhar, abrir a lista de runs do workflow. Sempre melhor que um 404.

---

## 8. UI

O brief é claro: parecer nativo. Isso significa seguir a linguagem visual do macOS, não inventar uma identidade própria.

- Popover de ~380px, `vibrancy: 'popover'`, `visualEffectState: 'active'`
- `font-family: -apple-system` com a escala de tamanhos do sistema (13px corpo, 11px secundário)
- Seleção de linha no estilo sidebar do Finder: preenchimento accent, raio 6px
- Ícone da menu bar como **Template Image** monocromático (`IconTemplate.png` + `@2x`) — é o detalhe que mais determina se parece nativo
- Dark mode via `nativeTheme`, não via media query isolada
- `LSUIElement: true` no Info.plist para não aparecer no Dock

Estados vazios e de erro são parte do design, não afterthought: "Nenhuma falha nas últimas 24 horas" e "Não foi possível conectar ao Azure — verifique sua sessão" com ação de reconectar.

Ver `design/mockup.html`.

---

## 9. Segurança

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` no renderer
- Tokens em `safeStorage` (Keychain do macOS), nunca em `electron-store` ou arquivo
- Nenhum secret exposto ao renderer, em nenhuma circunstância
- `shell.openExternal` só com URLs validadas contra allowlist de `portal.azure.com`
- CSP restritiva no renderer

---

## 10. Distribuição

- `electron-builder` com target `dmg` + `zip`
- Assinatura Developer ID e notarização — sem isso o Gatekeeper bloqueia na primeira abertura
- Auto-update via `electron-updater` (fase 3)
- Entitlements mínimos; hardened runtime ligado

---

## 11. Fases

**Fase 1 — Provar o caminho crítico (1 sessão)**
Electron + menubar rodando, `AzureCliCredential`, uma chamada hardcoded que lista runs falhos de um workflow Consumption e imprime no console. Sem UI. O objetivo é validar auth e formato de resposta antes de investir em qualquer outra coisa.

**Fase 2 — Loop completo**
Poller com cursor e dedupe, notificação nativa, deep link validado manualmente, popover com a lista real. Neste ponto o app já é útil.

**Fase 3 — Configuração**
Tela de settings, descoberta via Resource Graph, seleção de escopo, adapter Standard, intervalo configurável, login item.

**Fase 4 — Distribuição**
MSAL no lugar do Azure CLI, safeStorage, assinatura, notarização, auto-update.

---

## 12. Riscos

| Risco | Mitigação |
|---|---|
| Formato do deep link do run quebrar | Fallback para lista de runs; validação manual antes de codar |
| Throttling do ARM com muitos workflows | Cursores, backoff por workflow, intervalo configurável |
| Divergência Consumption / Standard maior que o previsto | Adapter desde a fase 1, mesmo com só um lado implementado |
| Notarização travar a distribuição | Resolver assinatura na fase 4 com build de teste antes de precisar |
| App "parecer Electron" | Template image, vibrancy e tipografia do sistema tratados como requisito, não polimento |

---

## 13. Primeira tarefa

Antes de escrever código: abrir um run falho no portal, para um Logic App Consumption e um Standard, e anotar as duas URLs reais. Elas definem `portal-url.ts` e são a única parte do plano que depende de informação que não dá para assumir.
