-- Grupos públicos, suscripciones y valoraciones. Ver
-- docs/superpowers/specs/2026-09-26-public-groups-design.md
alter table public.groups add column if not exists public boolean not null default false;

-- A quién sigue quién. No copia el grupo: guarda una referencia a (owner_id, group_id).
create table if not exists public.group_subscriptions (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_id   uuid not null,
  group_id   text not null,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, owner_id, group_id),
  foreign key (owner_id, group_id) references public.groups(user_id, id) on delete cascade
);

-- Una fila por persona y grupo. La media se calcula en el cliente sobre las filas crudas.
create table if not exists public.group_ratings (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_id   uuid not null,
  group_id   text not null,
  stars      int  not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, owner_id, group_id),
  foreign key (owner_id, group_id) references public.groups(user_id, id) on delete cascade
);

alter table public.group_subscriptions enable row level security;
alter table public.group_ratings       enable row level security;

drop policy if exists "read public groups" on public.groups;
create policy "read public groups" on public.groups
  for select to authenticated using (public = true);

drop policy if exists "own subscriptions" on public.group_subscriptions;
create policy "own subscriptions" on public.group_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own ratings write" on public.group_ratings;
create policy "own ratings write" on public.group_ratings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "read all ratings" on public.group_ratings;
create policy "read all ratings" on public.group_ratings
  for select to authenticated using (true);

notify pgrst, 'reload schema';
