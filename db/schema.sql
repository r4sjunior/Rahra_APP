-- Rahra Semijoias · Painel de vendas · esquema do banco (Postgres / Neon)
-- Pode ser executado várias vezes: tudo usa "if not exists".

-- Usuários que entraram pelo Clerk e o papel de cada um.
--   admin   : tudo, inclusive liberar usuários
--   editor  : lança valores semanais (vendas e indicadores)
--   viewer  : só consulta
--   pending : entrou, mas ainda não foi liberado (não vê nada)
create table if not exists app_users (
  clerk_id     text primary key,
  email        text not null,
  name         text,
  role         text not null default 'pending'
               check (role in ('admin','editor','viewer','pending')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create unique index if not exists app_users_email_key on app_users (lower(email));

-- Configurações da loja (uma única linha). "version" sobe a cada alteração de cadastro
-- e protege contra dois administradores sobrescreverem um ao outro.
create table if not exists settings (
  id         smallint primary key default 1 check (id = 1),
  yellow     integer not null default 90 check (yellow between 1 and 100),
  def_tm     numeric not null default 190,
  def_pa     numeric not null default 2,
  def_conv   numeric not null default 30,
  version    integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into settings (id) values (1) on conflict (id) do nothing;

create table if not exists consultants (
  id       text primary key,
  name     text not null,
  active   boolean not null default true,
  goal     numeric not null default 0 check (goal >= 0),
  position integer not null default 0
);

create table if not exists weeks (
  id         text primary key,
  start_date date not null,
  end_date   date not null,
  month      char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  goal_tm    numeric not null,
  goal_pa    numeric not null,
  goal_conv  numeric not null
);
create index if not exists weeks_month_idx on weeks (month);
create index if not exists weeks_start_idx on weeks (start_date);

-- Meta de vendas de cada consultora em cada semana.
create table if not exists week_goals (
  week_id       text not null references weeks (id) on delete cascade,
  consultant_id text not null references consultants (id) on delete cascade,
  goal          numeric not null check (goal >= 0),
  primary key (week_id, consultant_id)
);

-- Meta de vendas do mês de cada consultora.
create table if not exists month_goals (
  month         char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  consultant_id text not null references consultants (id) on delete cascade,
  goal          numeric not null check (goal >= 0),
  primary key (month, consultant_id)
);

-- Lançamentos semanais: vendas (fat), ticket médio (tm), PA (pa) e conversão em % (conv).
create table if not exists entries (
  week_id       text not null references weeks (id) on delete cascade,
  consultant_id text not null references consultants (id) on delete cascade,
  fat           numeric check (fat  >= 0),
  tm            numeric check (tm   >= 0),
  pa            numeric check (pa   >= 0),
  conv          numeric check (conv >= 0 and conv <= 100),
  updated_at    timestamptz not null default now(),
  updated_by    text,
  primary key (week_id, consultant_id)
);

-- Resultado real (não é meta) de ticket médio, PA e conversão. Esses três indicadores são médias/proporções
-- (valor ÷ nº de vendas, peças ÷ nº de vendas, nº de vendas ÷ nº de atendimentos) que não dá para reconstruir
-- somando os resultados semanais das consultoras, então quem lança digita o valor real de cada nível.
-- Vendas (fat) continuam sendo sempre a soma, por isso não têm uma tabela de "resultado real" própria.
create table if not exists week_actuals (
  week_id    text primary key references weeks (id) on delete cascade,
  tm         numeric check (tm >= 0),
  pa         numeric check (pa >= 0),
  conv       numeric check (conv >= 0 and conv <= 100),
  updated_at timestamptz not null default now(),
  updated_by text
);
create table if not exists month_actuals (
  month         char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  consultant_id text not null references consultants (id) on delete cascade,
  tm            numeric check (tm >= 0),
  pa            numeric check (pa >= 0),
  conv          numeric check (conv >= 0 and conv <= 100),
  updated_at    timestamptz not null default now(),
  updated_by    text,
  primary key (month, consultant_id)
);
create table if not exists month_store_actuals (
  month      char(7) primary key check (month ~ '^\d{4}-\d{2}$'),
  tm         numeric check (tm >= 0),
  pa         numeric check (pa >= 0),
  conv       numeric check (conv >= 0 and conv <= 100),
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Quem mudou o quê (uma linha por gravação).
create table if not exists audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_email text,
  role       text,
  action     text not null,
  detail     jsonb
);
create index if not exists audit_log_at_idx on audit_log (at desc);
