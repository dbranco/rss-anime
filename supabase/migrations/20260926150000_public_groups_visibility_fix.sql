-- La política "read public groups" original no excluía los grupos borrados
-- lógicamente: un grupo con deleted=true pero public=true seguía siendo
-- visible para siempre a quien ya estuviera suscrito, y seguía apareciendo
-- en Explorar. Ver docs/superpowers/specs/2026-09-26-public-groups-design.md
drop policy if exists "read public groups" on public.groups;
create policy "read public groups" on public.groups
  for select to authenticated using (public = true and deleted = false);

notify pgrst, 'reload schema';
