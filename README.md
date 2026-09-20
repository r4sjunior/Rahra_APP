# Rahra Semijoias · Painel de vendas online

O mesmo painel de vendas e indicadores, agora com **login (Clerk)** e **banco de dados (Neon Postgres)**,
para toda a equipe ver e lançar os mesmos dados. Hospedagem: Vercel.

## Quem pode o quê

| Papel | Vê painéis e relatórios | Lança valores na aba Semanal | Cadastros, metas, backup | Usuários |
|---|:-:|:-:|:-:|:-:|
| **Administrador** | sim | sim | sim | sim |
| **Lança valores** (`editor`) | sim | sim | não | não |
| **Só consulta** (`viewer`) | sim | não | não | não |
| **Aguardando liberação** (`pending`) | não | não | não | não |

- `gestaolojarahra@gmail.com` entra **sempre como administrador** (variável `ADMIN_EMAILS`), desde que o e-mail esteja verificado no Clerk.
- Qualquer outra pessoa que fizer login cai em *Aguardando liberação* e não vê nenhum dado até o administrador escolher o acesso dela na aba **Usuários**.
- Todas as regras são conferidas **no servidor**; travar campos na tela é só conforto.

## Como colocar no ar

1. **Neon** (neon.tech): crie um projeto **novo e só deste painel** (não reaproveite o banco de outro app) e copie a *connection string*.
2. **Criar as tabelas** (uma vez):
   ```bash
   cd painel-online
   npm install
   DATABASE_URL="postgresql://..." npm run db:setup      # PowerShell: $env:DATABASE_URL="..."; npm run db:setup
   ```
   Pode rodar de novo à vontade: o script só cria o que falta.
3. **Clerk** (clerk.com): crie um aplicativo com login por **e-mail** (código ou senha). Em *API keys*, copie a *Publishable key* e a *Secret key*.
   Sugestão: em *Restrictions*, deixe o cadastro restrito/por convite, ou mantenha aberto, pois quem não for liberado não vê nada.
4. **Vercel**: importe esta pasta (`painel-online`) como projeto e cadastre as variáveis do `.env.example`
   (`DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ADMIN_EMAILS`, e depois `APP_ORIGIN`). Faça o deploy.
5. Abra o site, entre com `gestaolojarahra@gmail.com` e cadastre consultoras e semanas.
   No painel do Clerk, adicione o domínio da Vercel em *Domains* se ele pedir.

## Como funciona

```
navegador (public/index.html + Clerk)
   └─ Authorization: Bearer <token da sessão>
        └─ api/*.js  (funções da Vercel)  ──►  lib/core.js  ──►  Neon Postgres
```

- `GET  /api/state` estado completo · `PUT /api/state` cadastros (admin, com controle de versão) ·
  `PATCH /api/entries` só as células lançadas · `GET/PATCH /api/users` usuários (admin) · `GET /api/me` papel do usuário.
- **Lançamentos vão célula a célula.** Duas consultoras lançando ao mesmo tempo não se sobrescrevem.
- **Cadastros têm versão.** Se dois administradores mexerem ao mesmo tempo, o segundo é avisado e a tela recarrega.
- A tela busca sozinha, a cada 30 s, o que outras pessoas lançaram (sem interromper quem está digitando).
- `audit_log` guarda quem gravou o quê; `entries.updated_by` guarda quem lançou cada valor.
- Esquema completo em `db/schema.sql`.

## Testes

```bash
npm test
```
Roda 15 testes das regras num Postgres de verdade (PGlite) e 11 verificações ponta a ponta no Chrome
(login simulado, papéis, lançamento, conflito). Precisa do Chrome instalado
(`CHROME_PATH` se não estiver no caminho padrão do Windows).
**Não** falam com o Clerk nem com o Neon reais: isso só se confirma com as suas chaves, no passo 5.

## Migrar dados do painel antigo (arquivo)

Baixe o backup no painel antigo (aba Cadastros > *Baixar backup*) e, logado como administrador aqui,
use *Restaurar backup*. Isso substitui tudo, inclusive os lançamentos.
