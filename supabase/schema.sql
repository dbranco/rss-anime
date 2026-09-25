-- Series Tracker: ejecutar entero en Supabase → SQL Editor. Es idempotente.

-- Un registro por usuario: sus providers (JSON) y el token secreto de su feed RSS.
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

-- Bucket público donde el cron publica los feeds. Sin política de listado: solo se accede
-- conociendo la URL completa (que incluye el feed_token secreto).
insert into storage.buckets (id, name, public) values ('feeds', 'feeds', true)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
