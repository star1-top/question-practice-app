-- Run only in the protected SQL console after reviewing the original screenshot.
-- This function applies a final answer and/or stem to exactly one catalog question.
create or replace function public.quiz_apply_question_report(
  p_report_id uuid,
  p_final_answer text default null,
  p_final_stem text default null
) returns void language plpgsql security invoker as $$
declare
  r public.quiz_question_reports%rowtype;
  v_chapters jsonb;
  v_question jsonb;
  v_path text[];
  v_matches integer := 0;
  v_letter text;
  i integer;
  j integer;
begin
  if nullif(trim(coalesce(p_final_answer, '')), '') is null
     and nullif(trim(coalesce(p_final_stem, '')), '') is null then
    raise exception 'Provide a reviewed answer or stem';
  end if;
  select * into r from public.quiz_question_reports where id = p_report_id for update;
  if not found or r.status not in ('open', 'verified') or r.catalog_id is null then
    raise exception 'Report is unavailable for catalog correction';
  end if;
  select chapters::jsonb into v_chapters from public.quiz_catalog_banks
    where catalog_id = r.catalog_id for update;
  if v_chapters is null then raise exception 'Catalog bank is unavailable'; end if;

  for i in 0..jsonb_array_length(v_chapters) - 1 loop
    for j in 0..jsonb_array_length(coalesce(v_chapters->i->'qs', '[]'::jsonb)) - 1 loop
      v_question := v_chapters->i->'qs'->j;
      if v_question->>'stem' = r.stem
         and coalesce(v_question->>'answer', '') = coalesce(r.answer, '') then
        v_matches := v_matches + 1;
        v_path := array[i::text, 'qs', j::text];
      end if;
    end loop;
  end loop;
  if v_matches <> 1 then
    raise exception 'Expected one matching question, found %; review manually', v_matches;
  end if;
  v_question := v_chapters #> v_path;
  if nullif(trim(coalesce(p_final_answer, '')), '') is not null then
    if char_length(trim(p_final_answer)) > 8 then raise exception 'Answer is too long'; end if;
    if v_question->>'type' = '判断题' then
      if trim(p_final_answer) not in ('√', 'X') then raise exception 'Invalid judgment answer'; end if;
    else
      for v_letter in select regexp_split_to_table(upper(trim(p_final_answer)), '') loop
        if not exists (select 1 from jsonb_array_elements(coalesce(v_question->'options', '[]'::jsonb)) option_row
                       where upper(option_row->>'k') = v_letter) then
          raise exception 'Answer option % is not in the question', v_letter;
        end if;
      end loop;
    end if;
    v_question := jsonb_set(v_question, '{answer}', to_jsonb(trim(p_final_answer)));
  end if;
  if nullif(trim(coalesce(p_final_stem, '')), '') is not null then
    v_question := jsonb_set(v_question, '{stem}', to_jsonb(trim(p_final_stem)));
  end if;
  v_chapters := jsonb_set(v_chapters, v_path, v_question);
  update public.quiz_catalog_banks set chapters = v_chapters where catalog_id = r.catalog_id;
  update public.quiz_question_reports set status = 'fixed', before_answer = r.answer,
    after_answer = coalesce(nullif(trim(p_final_answer), ''), r.answer), reviewed_at = now()
    where id = p_report_id;
end;
$$;

revoke all on function public.quiz_apply_question_report(uuid, text, text) from public, anon, authenticated;

-- Example after human verification:
-- select public.quiz_apply_question_report('REPORT_UUID'::uuid, 'AC', null);
