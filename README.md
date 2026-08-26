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

## Navegação

A tela inicial lista **Logic Apps**, não runs — com dezenas de workflows, uma lista plana de falhas não diz onde está o problema. Cada linha mostra saúde (verde/vermelho), quantos workflows estão falhando, o total de runs falhos e quando foi a última falha. Falhando primeiro, ignorados por último.

```
Logic Apps  →  workflows do app  →  runs falhos  →  detalhe do run
```

**Agrupamento.** O Azure não tem um conceito único de "Logic App" que sirva aos dois sabores: no Standard o grupo é o App Service, e os workflows vivem dentro dele; no Consumption cada workflow é um recurso independente, sem pai — esses são agrupados por **resource group**, que é como o portal organiza e como ambientes costumam ser separados (prd, dev, financeiro).

**Escolher o que observar.** O ícone de olho em cada linha liga/desliga o monitoramento, tanto de um Logic App inteiro quanto de um workflow específico. O que não é observado não notifica, não aparece na contagem e **não é consultado** — o poller filtra antes da chamada, então ignorar economiza quota do ARM.

Se muitos apps ficarem silenciados, um aviso no topo da lista diz quantos são e oferece **Reativar todos** — sem ele, silenciar tudo produzia uma tela idêntica à de "não encontrei nada", e reativar um a um era inviável.

A seleção é *opt-out*: por padrão tudo é monitorado, e o que se guarda é a lista do que foi ignorado. É deliberado — um Logic App novo aparecendo no Azure deve ser monitorado sem exigir ação. O contrário faria o app silenciosamente deixar de avisar sobre coisas que não existiam quando a seleção foi feita, que é o pior modo de falhar para um monitor. Itens ignorados continuam visíveis na lista (marcados "Não monitorado") para poderem ser reativados.

## Interação

**Listagem de runs** — clicar na linha abre a tela de detalhes. Abrir no portal virou um botão explícito (ícone de link externo, aparece no hover), ao lado do descartar. A troca é deliberada: a mensagem de erro na lista vem truncada em uma linha, e mandar o usuário ao navegador só para ler o motivo era um caminho longo demais.

**Detalhes** — mensagem de erro completa (sem truncar), código do erro, horários, duração, run name e correlation ID. Quando o Azure devolve um payload que a normalização não cobre, um "Ver retorno do Azure" mostra o JSON cru.

A tela também lista os **últimos 5 runs do workflow, com sucessos e falhas**. Sucessos entram de propósito: três falhas seguidas contam uma história diferente de uma falha isolada entre sucessos, e a listagem principal não mostra isso. Esses dados saem do que o poller já coletou — abrir os detalhes não gera chamada nova ao Azure.

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

## Validado contra um tenant real

Testado em 26/08/2026 contra um tenant com **33 Logic Apps Standard e 298 workflows**. Descoberta completa em ~18s; 76 runs falhos encontrados, todos com mensagem de erro preenchida.

Três coisas só apareceram com dado real e mudaram o código:

**1. Runs de Standard não existem no ARM.** O SDK `@azure/arm-appservice` expõe `workflowRuns.list`, mas `.../sites/{site}/workflows/{wf}/runs` devolve 404. O histórico fica atrás do proxy `hostruntime`, que encaminha para o runtime do próprio App Service:

```
.../sites/{site}/hostruntime/runtime/webhooks/workflow/api/management/workflows/{wf}/runs
```

`azure/standard.ts` foi reescrito para falar HTTP direto com esse endpoint. Antes, o adapter não teria retornado run nenhum.

**2. O `name` do workflow vem prefixado com o site.** A listagem do ARM devolve `"la-trux/wf-PostPayment"`, enquanto o `id` usa o nome puro (`.../workflows/wf-PostPayment`). Montar URL a partir do `name` quebra; o runtime, por sua vez, já devolve o nome limpo.

**3. O deep link de run no Standard não é confiável.** O recurso do workflow existe no ARM, mas o run como sub-resource dá 404 — então não há como validar um link para a blade do run específico. O app aponta para a **lista de runs** do workflow e marca como fallback; o botão diz "Abrir runs no portal", não "Abrir run". Um link inventado que abre 404 seria pior que um clique a mais.

Sobre a mensagem de erro: no tenant testado, 69 dos 76 runs falhos trazem o genérico `ActionFailed — "An action failed. No dependent actions succeeded."`. Conferimos que buscar as ações do run (`/runs/{id}/actions`) devolve a mesma mensagem genérica, então a chamada extra não ajudaria. O payload cru fica disponível em "Ver retorno do Azure".

## Ressalvas conhecidas

**Deep link do run específico não foi validado contra o portal.** O plano (seção 13) pede abrir um run falho real, copiar a URL e derivar o template. Isso exige uma sessão no portal, que não estava disponível. O que existe hoje:

- A URL da **lista de runs** usa o formato estável e documentado — essa parte é confiável.
- A URL do **run específico** segue o formato derivado do resource ID, e está isolada em duas funções no topo de `portal-url.ts`, comentadas com `VALIDAR`. Se o formato estiver errado, o conserto é editar só essas linhas.
- Existe fallback: qualquer falha na construção cai na lista de runs do workflow, nunca num 404.

**A extração da mensagem de erro é a parte com maior chance de precisar de ajuste.** O SDK tipa `WorkflowRun.error` como `any` e o formato varia na prática (plano, aninhado em `error.error`, com o motivo só em `details[]`, ou string solta). `azure/run-error.ts` tenta os formatos conhecidos em ordem e sempre guarda o payload cru — então mesmo se a normalização errar, o "Ver retorno do Azure" mostra o que realmente chegou. Se aparecer um formato novo, é lá que se acrescenta, e há testes cobrindo cada caso.

**O caminho Consumption continua sem validação real.** O tenant testado só tem Logic Apps Standard, então `consumption.ts` e o agrupamento por resource group nunca foram exercitados contra dado de verdade — seguem cobertos apenas por tipos e testes.

## Distribuição

`electron-builder.yml` está configurado (dmg + zip, hardened runtime, entitlements, `LSUIElement`), mas **sem assinatura**: falta um certificado Developer ID. Para habilitar, defina `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID` e troque `afterSign` por notarização. Sem isso o Gatekeeper bloqueia na primeira abertura.

Fase 4 do plano (MSAL no lugar do Azure CLI, safeStorage, auto-update) não foi implementada.
