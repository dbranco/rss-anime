-- Marca si una entrada de watchlist la añadió el usuario a propósito (true, por
-- defecto) o la creó automáticamente "Reparar"/suscribirse solo para poder llevar el
-- conteo de episodios de un paso de grupo (false) — estas últimas no deben aparecer
-- como si fueran media añadida deliberadamente.
alter table public.watchlist add column if not exists visible boolean not null default true;

notify pgrst, 'reload schema';
