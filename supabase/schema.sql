-- Series Tracker: ejecutar entero en Supabase → SQL Editor. Es idempotente.
-- Ruta sin CLI (para quien no quiera instalar la Supabase CLI). Si usas la CLI, aplica
-- supabase/migrations/ en su lugar (supabase db push) — mantén ambos en sync a mano.

-- Un registro por usuario: su token secreto de feed RSS (la columna providers ya no se usa, ver app_config).
create table if not exists public.user_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  providers  jsonb not null default '[]'::jsonb,
  feed_token text  not null unique default replace(gen_random_uuid()::text, '-', ''),
  updated_at timestamptz not null default now()
);

-- Lista de series de cada usuario. deleted = borrado lógico para propagarlo entre máquinas.
create table if not exists public.watchlist (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider_id text not null,
  slug        text not null,
  title       text not null,
  link        text,
  image       text,
  last        int  not null default 0,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, provider_id, slug)
);

-- Episodios detectados por el cron. Solo el cron (service_role) escribe aquí.
create table if not exists public.episodes_found (
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider_id text not null,
  slug        text not null,
  episode     int  not null,
  title       text not null,
  link        text not null,
  found_at    timestamptz not null default now(),
  primary key (user_id, provider_id, slug, episode)
);

-- Row Level Security: cada usuario solo ve y modifica lo suyo.
alter table public.user_settings  enable row level security;
alter table public.watchlist      enable row level security;
alter table public.episodes_found enable row level security;

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own watchlist" on public.watchlist;
create policy "own watchlist" on public.watchlist
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "read own episodes" on public.episodes_found;
create policy "read own episodes" on public.episodes_found
  for select to authenticated using (auth.uid() = user_id);

-- Grupos de orden de visionado (playlists). Ver docs/superpowers/specs/2026-09-25-watch-order-groups-design.md
create table if not exists public.groups (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null,               -- generado en el cliente (crypto.randomUUID())
  name       text not null,
  steps      jsonb not null default '[]'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.groups enable row level security;

drop policy if exists "own groups" on public.groups;
create policy "own groups" on public.groups
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Bucket público donde el cron publica los feeds. Sin política de listado: solo se accede
-- conociendo la URL completa (que incluye el feed_token secreto).
insert into storage.buckets (id, name, public) values ('feeds', 'feeds', true)
on conflict (id) do nothing;

-- Providers de la app (config compartida, no por usuario). Ver
-- docs/superpowers/specs/2026-09-26-app-wide-providers-design.md
create table if not exists public.app_config (
  id         int primary key default 1,
  providers  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.app_config enable row level security;
alter table public.admins     enable row level security;

drop policy if exists "read app config" on public.app_config;
create policy "read app config" on public.app_config
  for select to authenticated using (true);

drop policy if exists "admin insert app config" on public.app_config;
create policy "admin insert app config" on public.app_config
  for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "admin update app config" on public.app_config;
create policy "admin update app config" on public.app_config
  for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- Esta política es una dependencia real de las políticas de escritura de app_config: su
-- EXISTS se evalúa como el usuario que llama, así que necesita poder leer su propia fila aquí.
drop policy if exists "read own admin flag" on public.admins;
create policy "read own admin flag" on public.admins
  for select to authenticated using (auth.uid() = user_id);

notify pgrst, 'reload schema';
