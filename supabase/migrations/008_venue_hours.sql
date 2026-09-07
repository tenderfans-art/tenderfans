alter table public.venues add column if not exists regular_hours jsonb not null default '{}'::jsonb;
