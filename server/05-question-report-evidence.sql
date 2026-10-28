-- Apply in the hosted database before publishing screenshot-based correction reports.
-- Existing reports and review states remain intact.
alter table public.quiz_question_reports
  add column if not exists issue_type text not null default 'other',
  add column if not exists suggested_answer text,
  add column if not exists suggested_text text,
  add column if not exists question_snapshot jsonb,
  add column if not exists evidence_path text,
  add column if not exists ai_extract jsonb;

alter table public.quiz_question_reports
  drop constraint if exists quiz_reports_issue_type_valid;
alter table public.quiz_question_reports
  add constraint quiz_reports_issue_type_valid
  check (issue_type in ('answer', 'stem', 'missing', 'duplicate', 'other'));

alter table public.quiz_question_reports
  drop constraint if exists quiz_reports_suggestions_bounded;
alter table public.quiz_question_reports
  add constraint quiz_reports_suggestions_bounded check (
    char_length(coalesce(suggested_answer, '')) <= 8
    and char_length(coalesce(suggested_text, '')) <= 2000
    and octet_length(coalesce(question_snapshot::text, '')) <= 8000
    and octet_length(coalesce(ai_extract::text, '')) <= 12000
  );

-- A user may insert only an open report about their own evidence path.
drop policy if exists quiz_reports_insert_own on public.quiz_question_reports;
create policy quiz_reports_insert_own on public.quiz_question_reports
  for insert to authenticated with check (
    owner_id = auth.uid()
    and status = 'open'
    and before_answer is null and after_answer is null and reviewed_at is null
    and (evidence_path is null or evidence_path like 'users/' || auth.uid()::text || '/question-reports/%')
  );

-- Review in the protected SQL console. Treat ai_extract and suggested fields as untrusted.
-- select id, catalog_id, question_id, stem, answer, issue_type,
--        suggested_answer, suggested_text, question_snapshot,
--        evidence_path, ai_extract, reason, status, created_at
-- from public.quiz_question_reports where status = 'open' order by created_at;
