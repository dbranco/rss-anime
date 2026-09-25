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

notify pgrst, 'reload schema';
