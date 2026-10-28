#!/usr/bin/env python3
"""Build a small, public preview bundle from private catalog backups.

Only run this with a reviewed list of currently visible paid catalog entries.
The generated file contains chapter titles and two sample questions per bank;
it never includes the complete paid bank.
"""

import argparse
import json
import re
from pathlib import Path


def eligible(question):
    stem = str(question.get('stem') or '').strip()
    options = question.get('options') or []
    answer = str(question.get('answer') or '').upper().strip()
    keys = {str(option.get('k') or '').upper() for option in options if isinstance(option, dict)}
    return (
        10 <= len(stem) <= 180
        and not re.search(r'下图|上图|如图|图中|如下图|上述|前述|下面的.*网络|说法的是|不可能能', stem)
        and 2 <= len(options) <= 6
        and not question.get('doubt')
        and bool(answer)
        and set(answer).issubset(keys)
        and all(isinstance(option, dict) and option.get('v') and len(str(option['v'])) < 140 for option in options)
    )


def make_preview(bank):
    chapters = [str(chapter.get('title') or chapter.get('name') or chapter.get('sec') or '').strip()
                for chapter in bank.get('chapters', [])]
    chapters = [title for title in chapters if title]
    candidates = []
    for chapter_index, chapter in enumerate(bank.get('chapters', [])):
        for question in chapter.get('qs', []):
            if eligible(question):
                candidates.append((chapter_index, question))
    if len(candidates) < 2:
        raise ValueError(f"{bank['id']}: fewer than two usable sample questions")

    positions = [max(0, len(candidates) // 5), min(len(candidates) - 1, len(candidates) * 4 // 5)]
    selected = []
    seen_stems = set()
    for position in positions:
        for chapter_index, question in candidates[position:] + candidates[:position]:
            stem = question['stem'].strip()
            if stem in seen_stems:
                continue
            seen_stems.add(stem)
            selected.append({
                'chapter': str(bank['chapters'][chapter_index].get('title') or bank['chapters'][chapter_index].get('name') or ''),
                'type': str(question.get('type') or ''),
                'stem': stem,
                'options': [{'k': str(option['k']), 'v': str(option['v'])} for option in question['options']],
                'answer': str(question['answer']).strip(),
            })
            break
    if len(selected) != 2:
        raise ValueError(f"{bank['id']}: could not choose two distinct questions")
    return {'chapters': chapters, 'samples': selected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--visible-catalog', required=True, type=Path)
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--extra-file', action='append', default=[], type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()

    visible = json.loads(args.visible_catalog.read_text(encoding='utf-8'))
    extras = {}
    for path in args.extra_file:
        bank = json.loads(path.read_text(encoding='utf-8'))
        extras[bank['id']] = bank
    previews = {}
    for entry in visible:
        if entry.get('kind') != 'paid':
            continue
        bank_id = entry['id']
        path = args.source_dir / f'{bank_id}.json'
        bank = extras.get(bank_id) if bank_id in extras else json.loads(path.read_text(encoding='utf-8'))
        if (bank['id'] != bank_id or bank.get('questionCount') != entry.get('questionCount')
                or bank.get('chapterCount') != entry.get('chapterCount')):
            raise ValueError(f'{bank_id}: backup does not match the visible catalog')
        previews[bank_id] = make_preview(bank)
    if not previews:
        raise ValueError('No visible paid banks found')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        '/* Public catalog previews: chapter titles and two sample questions per paid bank. */\n'
        'window.Q = window.Q || {};\n'
        'window.Q.catalogPreviews = ' + json.dumps(previews, ensure_ascii=False, separators=(',', ':')) + ';\n',
        encoding='utf-8',
    )
    print(f'Generated {len(previews)} paid previews and {sum(len(x["samples"]) for x in previews.values())} sample questions')


if __name__ == '__main__':
    main()
