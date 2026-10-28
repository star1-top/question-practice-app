-- Base table for authenticated question corrections. Run before later migrations.
create table if not exists public.quiz_question_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  catalog_id text,
  bank_id uuid,
  question_id text not null,
  stem text not null,
  answer text,
  reason text not null,
  status text not null default 'open' check (status in ('open','verified','fixed','rejected')),
  before_answer text,
  after_answer text,
  evidence text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (char_length(reason) between 5 and 500)
);
alter table public.quiz_question_reports enable row level security;
revoke all on public.quiz_question_reports from anon;
grant insert, select on public.quiz_question_reports to authenticated;
drop policy if exists quiz_reports_insert_own on public.quiz_question_reports;
create policy quiz_reports_insert_own on public.quiz_question_reports for insert to authenticated
with check (owner_id = auth.uid());
drop policy if exists quiz_reports_read_own on public.quiz_question_reports;
create policy quiz_reports_read_own on public.quiz_question_reports for select to authenticated
using (owner_id = auth.uid());
