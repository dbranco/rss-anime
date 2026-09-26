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
