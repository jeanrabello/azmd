# Runbar

App de menu bar para macOS que monitora runs de Azure Logic Apps, notifica falhas nativamente e abre o run no portal com um clique.

Implementação do `PLANO_1.md` — fases 1 a 3.

## Rodando

```bash
nvm use          # Node 24 (ver .nvmrc)
npm install
npm run dev
```

O app sobe **em modo demo**, com dados mockados. Ele aparece na menu bar, não no Dock.

| Comando | O que faz |
|---|---|
| `npm run dev` | Desenvolvimento com HMR no renderer |
| `npm run build` | Typecheck + bundle de main, preload e renderer |
| `npm test` | Suíte de testes (vitest) |
| `npm run typecheck` | Só a verificação de tipos |
| `npm run pack:mac` | Gera .dmg/.zip (sem assinatura — ver Distribuição) |

## Modo demo × modo Azure

O toggle fica em **⚙︎ → Fonte de dados**, e é o mecanismo que permite rodar e testar o app inteiro sem credencial nenhuma.

- **Demo** (padrão) — `DemoAdapter` produz runs falhos determinísticos com a mesma estrutura que o Azure retorna. Um badge `DEMO` fica visível no cabeçalho o tempo todo, para nunca confundir dado fictício com dado real.
- **Azure** — consulta o ARM de verdade. Exige credencial: `az login`, `azd auth login` ou as variáveis do `EnvironmentCredential`. Sem isso o app mostra um erro acionável, não uma tela vazia.

A troca é total: modo demo não instancia SDK do Azure, e nada além de `AppController.#buildAdapters` sabe que existem dois modos. Poller, dedupe, notificação, IPC e UI são idênticos nos dois casos — é o que garante que o que você testa em demo é o mesmo código que roda em produção.

## Arquitetura

```
src/
├─ shared/types.ts        # contratos entre os três processos — fonte da verdade
├─ main/
│  ├─ index.ts            # bootstrap, IPC, ciclo de vida
│  ├─ app-controller.ts   # dono do estado; o toggle demo/azure mora aqui
│  ├─ poller.ts           # cursores, dedupe, backoff por workflow
│  ├─ notifier.ts         # notificações nativas + agregação
│  ├─ tray.ts             # ícone template + popover ancorado
│  ├─ portal-url.ts       # deep links (ver Ressalvas)
│  ├─ settings-store.ts   # preferências, com sanitização na fronteira
│  ├─ safe-open.ts        # único ponto que abre URL externa (allowlist)
│  ├─ auth/credential.ts  # cadeia de credenciais
│  └─ azure/
│     ├─ adapter.ts       # interface LogicAppAdapter
│     ├─ consumption.ts   # @azure/arm-logic
│     ├─ standard.ts      # @azure/arm-appservice
│     ├─ discovery.ts     # Resource Graph
│     ├─ discovered.ts    # adapters reais + inventário do Resource Graph
│     └─ demo.ts          # mocks
├─ preload/index.ts       # contextBridge, contrato mínimo
└─ renderer/              # React; não conhece Azure
```

O renderer nunca vê credencial, SDK ou URL não validada. Recebe `AppState` pronto e devolve intenções (`openRunInPortal(runId)`), nunca ações.

## Segurança

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP restritiva no renderer. `shell.openExternal` só aceita URLs validadas contra uma allowlist de hosts do portal. Nenhum token é gravado pelo app — hoje quem detém a credencial é o Azure CLI.

## Ressalvas conhecidas

**Deep link do run específico não foi validado contra o portal.** O plano (seção 13) pede abrir um run falho real, copiar a URL e derivar o template. Isso exige uma sessão no portal, que não estava disponível. O que existe hoje:

- A URL da **lista de runs** usa o formato estável e documentado — essa parte é confiável.
- A URL do **run específico** segue o formato derivado do resource ID, e está isolada em duas funções no topo de `portal-url.ts`, comentadas com `VALIDAR`. Se o formato estiver errado, o conserto é editar só essas linhas.
- Existe fallback: qualquer falha na construção cai na lista de runs do workflow, nunca num 404.

**A camada Azure não foi exercitada contra um tenant real** — não havia credencial nesta máquina. Os caminhos de erro (sem credencial, sem permissão, throttling) foram testados; os caminhos de sucesso foram verificados por tipos e testes, não por rede. Pontos que merecem conferência no primeiro uso real estão comentados em `standard.ts` e `discovery.ts`.

## Distribuição

`electron-builder.yml` está configurado (dmg + zip, hardened runtime, entitlements, `LSUIElement`), mas **sem assinatura**: falta um certificado Developer ID. Para habilitar, defina `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID` e troque `afterSign` por notarização. Sem isso o Gatekeeper bloqueia na primeira abertura.

Fase 4 do plano (MSAL no lugar do Azure CLI, safeStorage, auto-update) não foi implementada.
