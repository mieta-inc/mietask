#!/usr/bin/env python3
"""巡回結果を tasks.json に登録し、Slackスレッドへの返信を反映する。

返信で受けるもの:

  1完了        → done にする。翌日から出ない
  2ステイ      → 明日もそのまま出す（相手待ち・保留中のものも翌朝は必ず出す）
  3 メモ本文   → そのタスクにメモを残し、翌朝の一覧に「前回のメモ」として出す
  2ステイ 来週の会議で決める  → ステイ＋メモ
  追加 見積書を作る 11/20まで → 新しいタスクとして足す（Slackや議事録に出てこない仕事を手で入れる）

毎朝の流れ:

  1. complete  前日のスレッド返信を読んで、完了・ステイ・メモを反映する
  2. upsert    今日の巡回結果を tasks.json に登録し、表示番号 → task.id を記録する
  3. (投稿)    post_slack.py で #マイ-タスク に投げる
  4. record    投稿したスレッドの ts を控える（翌朝これを読む）

使い方:

    python3 scripts/task_sync.py complete --replies /tmp/task-replies.json
    python3 scripts/task_sync.py upsert   --findings /tmp/task-findings.json
    python3 scripts/task_sync.py record   --ts 1794411398.212869
    python3 scripts/task_sync.py thread

**tasks.json は唯一の正。** 壊さないために:
- 書き込み前に必ずバックアップを取る
- 一時ファイルに書いてから置き換える（途中で死んでも元が残る）
- done / dropped のタスクを open に戻すことは絶対にしない
- 解決できなかった返信は黙って捨てず、必ず報告する
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths  # noqa: E402

# データはプラグインの中ではなくユーザーのホームに置く（理由は paths.py）。
# 呼び出し時点で解決する。環境変数の上書きを効かせるため、import時に固定しない。
TASKS = paths.tasks_path()
STATE = paths.state_path()

JST = dt.timezone(dt.timedelta(hours=9))

# 完了として扱う status。ここに入っているものは巡回で復活させない。
CLOSED = {"done", "dropped"}

# 「本人が動かすと決めたもの」。巡回で再発見されなくても毎朝出し直す。
# later（今週はやらない）と blocked（相手待ち）は、巡回が拾ったときだけ出す。
ACTIONABLE = {"next", "open", "doing"}

# 区分 → 新規タスクの初期 status
SECTION_STATUS = {
    "overdue": "next",
    "today": "next",
    "week": "next",
    "watch": "later",
    "waiting": "blocked",
}

# 「1完了」「t091 完了」「3 済」「2 done」などを拾う。
# 番号だけ / taskId のどちらでも受ける。
#
# 直前は行頭か空白・句読点に限る。「明日1完了」のように数字が語中に続く場合を弾くため。
# 末尾の否定先読みは、未来の意思表明を完了と誤読しないためのもの:
#   「1完了させます」「2完了します」「3完了予定」は完了ではない。
#   「1完了しました」「2完了した」は完了。
# （2026-11-12 追加。誤って done にすると本人が気づけないため、迷ったら拾わない側に倒す）
RE_DONE = re.compile(
    r"(?:^|[\s、,。])"
    r"(?P<key>t\d{3,}|\d{1,3})"
    r"\s*(?:番)?\s*"
    r"(?P<verb>完了|かんりょう|済み|済|おわり|終わり|done|DONE|Done)"
    r"(?!させ|したい|する|しない|せず|します|しとく|しておく|予定|次第|したら|すれば)",
)

# 「2ステイ」「t091 stay」。明日もそのまま出す、の意味（2026-11-14 河村さん）。
# 「継続」「そのまま」はメモの文中に普通に出てくるので拾わない。
RE_STAY = re.compile(
    r"(?:^|[\s、,。])"
    r"(?P<key>t\d{3,}|\d{1,3})"
    r"\s*(?:番)?\s*"
    r"(?P<verb>ステイ|すてい|stay|STAY|Stay)",
)

# 「3 山田さんに電話済み」のような、番号で始まる行をメモとして拾う。
# 番号のあとは空白・句読点・括弧に限る。「11/20に…」「3:00に…」「3件…」を
# 番号指定と取り違えないため。区切りなしの「3山田さん…」は拾わない（迷ったら拾わない）。
RE_MEMO_LINE = re.compile(
    r"^\s*(?P<key>t\d{3,}|\d{1,3})\s*(?:番)?"
    r"(?:\s+|[.．、,)）]\s*|[:：](?!\d)\s*)"
    r"(?P<rest>\S.*)$",
)

# 指定のあとに付く語尾。メモの判定から外す
CMD_TAIL = r"(?:しました|しましたー|した|です|でした|ました|でーす|中|しています|してます)?"

# 「追加 見積書を作る 11/20まで」。Slackやメール・議事録に出てこない仕事を手で足すための行（2026-11-14 河村さん）。
# 行頭だけを見る。この行は完了・ステイ・メモの読み取りから外す（「追加 3完了の報告書」で3が完了にならないように）。
RE_ADD = re.compile(r"^\s*(?:追加|タスク追加|タスク化|\+|＋)\s*[:：]?\s*(?P<body>\S.*)$")
# 追加の行に書かれた期限。「11/20」「11/20まで」「（11/20）」
RE_ADD_DUE = re.compile(r"[（(]?\s*(?P<m>\d{1,2})\s*/\s*(?P<d>\d{1,2})\s*(?:まで|〆|締切|締め切り)?\s*[）)]?")

# メモから落とす前後の記号
MEMO_STRIP = " \t　、,。.．:：・-ー"


class SyncError(RuntimeError):
    """処理を続けると壊れる状況。必ず原因をメッセージに入れる。"""


def now() -> str:
    return dt.datetime.now(JST).replace(microsecond=0).isoformat()


def load(path: Path) -> Dict[str, Any]:
    if not path.exists():
        # 初回に素の「見つかりません」を出すと何をすればいいか分からない。
        raise SyncError(
            f"見つかりません: {path}\n"
            "  まだセットアップが済んでいないかもしれません。\n"
            "  Claude Code で /mietask:setup と打ってください。"
        )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SyncError(f"{path} のJSONが壊れています: {e}") from e


def save(path: Path, data: Dict[str, Any], dry_run: bool = False) -> None:
    """バックアップしてから、一時ファイル経由で置き換える。"""
    if dry_run:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        stamp = dt.datetime.now(JST).strftime("%m%d-%H%M%S")
        shutil.copy2(path, path.with_suffix(f".json.bak_{stamp}"))
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def next_task_id(tasks: List[Dict[str, Any]]) -> int:
    """既存の最大IDの次を返す。tasks.json の next_id は古いことがあるので信用しない。"""
    nums = [int(re.sub(r"\D", "", t["id"]) or 0) for t in tasks]
    return (max(nums) + 1) if nums else 1


def by_ref(tasks: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for t in tasks:
        ref = (t.get("source") or {}).get("ref")
        if ref and ref not in out:
            out[ref] = t
    return out


def get_thread(state: Dict[str, Any]) -> Dict[str, Any]:
    return state.setdefault("slack_thread", {})


def dismissed_refs(*sources: Dict[str, Any]) -> set:
    """却下済みrefを集める。

    state.json は {"ref":…, "reason":…, "at":…} の辞書、tasks.json は文字列と
    形が違う。どちらも受けられるようにしておく（2026-11-12 実データで確認）。
    """
    out = set()
    for src in sources:
        for item in src.get("dismissed_refs") or []:
            if isinstance(item, str):
                out.add(item)
            elif isinstance(item, dict) and item.get("ref"):
                out.add(item["ref"])
    return out


# ---------------------------------------------------------------- upsert


def cmd_upsert(args: argparse.Namespace) -> int:
    findings = json.loads(Path(args.findings).read_text(encoding="utf-8"))
    if not isinstance(findings, list):
        raise SyncError("findings はタスクのリストである必要があります。")

    data = load(TASKS)
    state = load(STATE)
    tasks: List[Dict[str, Any]] = data["tasks"]
    index = by_ref(tasks)
    dismissed = dismissed_refs(data, state)

    nid = next_task_id(tasks)
    stamp = now()
    mapping: Dict[str, str] = {}
    created: List[str] = []
    updated: List[str] = []
    skipped: List[str] = []
    number = 0

    for f in findings:
        src = f.get("source") or {}
        ref = src.get("ref")
        if not ref:
            raise SyncError(f"source.ref がありません: {f.get('title')!r}")

        if ref in dismissed:
            skipped.append(f"{f.get('title')} ← 対応不要として却下済み")
            continue

        hit = index.get(ref)
        if hit and hit.get("status") in CLOSED:
            skipped.append(f"{f.get('title')} ← {hit['id']} は {hit['status']} 済み")
            continue

        number += 1
        if hit:
            # 既存。status は触らない（本人が決めたものを巡回で戻さない）。
            hit["last_seen_at"] = stamp
            for k in ("due", "due_confidence", "priority", "next_action"):
                if f.get(k) not in (None, ""):
                    hit[k] = f[k]
            mapping[str(number)] = hit["id"]
            updated.append(hit["id"])
        else:
            tid = f"t{nid:03d}"
            nid += 1
            tasks.append(
                {
                    "id": tid,
                    "title": f.get("title", ""),
                    "due": f.get("due"),
                    "due_confidence": f.get("due_confidence", "inferred"),
                    "status": SECTION_STATUS.get(f.get("section", ""), "next"),
                    "priority": f.get("priority", "P3"),
                    "source": src,
                    "notes": f.get("notes", ""),
                    "next_action": f.get("next_action", ""),
                    "project": f.get("project"),
                    "detected_at": stamp,
                    "last_seen_at": stamp,
                }
            )
            mapping[str(number)] = tid
            created.append(tid)

    # 巡回で再発見されなかった既存タスクを拾い直す。
    # 巡回はSlack・Gmail・カレンダーを見るだけなので、これが無いと
    # 「tasks.json にあるが今日は誰も触れていない」タスクが永久に沈む。
    # 期限超過を落とすのは最悪なので、既定で有効にしてある（2026-11-12 追加）。
    carried: List[Dict[str, Any]] = []
    if args.carry_over:
        today = dt.datetime.now(JST).date().isoformat()
        mapped = set(mapping.values())
        for t in tasks:
            if t["id"] in mapped or t.get("status") in CLOSED:
                continue
            # ステイ指定は相手待ち・保留中でも翌朝は必ず出す（そのまま出す、の約束）
            if t.get("status") not in ACTIONABLE and not t.get("stay_pending"):
                continue
            due = t.get("due")
            if t.get("status") == "blocked":
                section = "waiting"
            elif due and due < today:
                section = "overdue"
            elif due == today:
                section = "today"
            else:
                section = "week"
            number += 1
            mapping[str(number)] = t["id"]
            carried.append({**t, "_section": section, "_number": number})

    # ステイの約束は「翌朝1回出す」まで。出したら外す。
    shown = set(mapping.values())
    for t in tasks:
        if t["id"] in shown:
            t.pop("stay_pending", None)

    data["next_id"] = nid
    data["updated_at"] = stamp

    thread = get_thread(state)
    thread["mapping"] = mapping
    thread["mapped_at"] = stamp
    # 新しい投稿の ts はまだ無い。record で入るまで前日のものを残さない。
    thread.pop("ts", None)
    state["last_sweep_at"] = stamp

    save(TASKS, data, args.dry_run)
    save(STATE, state, args.dry_run)

    tag = "[dry-run] " if args.dry_run else ""
    print(
        f"{tag}新規 {len(created)}件 / 既存更新 {len(updated)}件 / "
        f"繰り越し {len(carried)}件 / 除外 {len(skipped)}件"
    )
    if created:
        print("  新規:", ", ".join(created))
    for s in skipped:
        print("  除外:", s)

    if carried:
        # 繰り越し分は findings に無いので、投稿に載せるための情報をここで出す。
        print("\n巡回では拾われなかったが、未完了なので一覧に載せるもの:")
        for c in carried:
            due = c.get("due") or "期限なし"
            print(
                f"  {c['_number']}. [{c['_section']}] {c['id']} {c.get('priority','')} "
                f"{c.get('title','')}  期限 {due}"
            )
            if c.get("next_action"):
                print(f"      → 次の一手: {c['next_action']}")

    # 前回のメモとステイ回数。投稿のタスク行の下に添える。
    by_id = {t["id"]: t for t in tasks}
    notes = []
    for n, tid in mapping.items():
        t = by_id.get(tid) or {}
        memo = t.get("last_memo") or {}
        stays = t.get("stay_count") or 0
        if memo.get("text") or stays:
            notes.append((n, tid, memo, stays))
    if notes:
        print("\n前回のメモ・ステイ（タスク行の下に添える）:")
        for n, tid, memo, stays in notes:
            parts = []
            if memo.get("text"):
                parts.append(f"📝 {memo_date(memo.get('at'))}のメモ: {memo['text']}")
            if stays:
                parts.append(f"↻ ステイ{stays}回")
            print(f"  {n} → {tid}  " + "  ".join(parts))

    print("\n表示番号 → task.id")
    for n, tid in mapping.items():
        print(f"  {n} → {tid}")
    return 0


def memo_date(at: Optional[str]) -> str:
    """'2026-11-14T18:02:00+09:00' → '11/14'。読めなければ空。"""
    try:
        d = dt.datetime.fromisoformat(at or "")
        return f"{d.month}/{d.day}"
    except ValueError:
        return ""


# ---------------------------------------------------------------- complete


def parse_done(texts: List[str], mapping: Dict[str, str]) -> Tuple[List[str], List[str]]:
    """返信から完了指定を拾う。解決できたIDと、できなかった生テキストを返す。"""
    ids: List[str] = []
    unresolved: List[str] = []
    known = set(mapping.values())

    for text in texts:
        hits = list(RE_DONE.finditer(text or ""))
        if not hits:
            continue
        for m in hits:
            key = m.group("key")
            if key.startswith("t"):
                tid = key if key in known or re.fullmatch(r"t\d{3,}", key) else None
            else:
                tid = mapping.get(key)
            if tid:
                if tid not in ids:
                    ids.append(tid)
            else:
                unresolved.append(m.group(0).strip())
    return ids, unresolved


def split_adds(texts: List[str]) -> Tuple[List[str], List[str]]:
    """「追加 …」の行を抜き出す。残りの本文と、追加の中身を返す。"""
    rest: List[str] = []
    adds: List[str] = []
    for text in texts:
        keep: List[str] = []
        for line in (text or "").splitlines():
            m = RE_ADD.match(line)
            if m:
                adds.append(m.group("body").strip())
            else:
                keep.append(line)
        rest.append("\n".join(keep))
    return rest, adds


def parse_add(body: str, today: dt.date) -> Tuple[str, Optional[str]]:
    """「見積書を作る 11/20まで」→ (タイトル, '2026-11-20')。期限が無ければ None。

    年は書かれないので補う。今日より60日以上前の日付になるなら来年とみなす（12月に「1/10」と書いた場合）。
    月日として成り立たない数字（13/40 など）は期限として扱わず、タイトルに残す。
    """
    due: Optional[str] = None
    title = body
    m = RE_ADD_DUE.search(body)
    if m:
        try:
            d = dt.date(today.year, int(m.group("m")), int(m.group("d")))
            if d < today - dt.timedelta(days=60):
                d = dt.date(today.year + 1, d.month, d.day)
            due = d.isoformat()
            title = (body[: m.start()] + body[m.end():]).strip(MEMO_STRIP)
        except ValueError:
            pass
    return (title or body).strip(), due


def resolve(key: str, mapping: Dict[str, str]) -> Optional[str]:
    if key.startswith("t"):
        return key if re.fullmatch(r"t\d{3,}", key) else None
    return mapping.get(key)


def parse_replies(
    texts: List[str], mapping: Dict[str, str]
) -> Tuple[List[str], List[str], List[Tuple[str, str]], List[str]]:
    """返信から 完了・ステイ・メモ を拾う。

    返り値: (done_ids, stay_ids, [(task_id, memo)], unresolved)
    メモは1行ずつ見る。行から完了・ステイの指定を取り除いて、まだ文が残っていればメモ。
    「1完了、2完了」は何も残らないのでメモにならない。
    """
    done_ids, unresolved = parse_done(texts, mapping)
    stay_ids: List[str] = []
    memos: List[Tuple[str, str]] = []

    for text in texts:
        for m in RE_STAY.finditer(text or ""):
            tid = resolve(m.group("key"), mapping)
            if tid:
                if tid not in stay_ids:
                    stay_ids.append(tid)
            else:
                unresolved.append(m.group(0).strip())

        for line in (text or "").splitlines():
            # 「3 メモ」の形か、「4ステイ メモ」「1完了 メモ」のように指定で始まる形
            lm = RE_MEMO_LINE.match(line)
            head = RE_STAY.match(line) or RE_DONE.match(line)
            if lm:
                key = lm.group("key")
            elif head:
                key = head.group("key")
            else:
                continue
            # 完了・ステイの指定を行から抜く
            rest = line
            for rx in (RE_DONE, RE_STAY):
                # 「完了しました」「ステイです」の語尾もいっしょに抜く。残すとメモに見える
                rest = re.sub(rx.pattern + CMD_TAIL, " ", rest)
            rest = rest.strip()
            # 先頭に番号だけ残っていれば外す（「3 山田さんに…」の 3）
            rest = re.sub(rf"^{re.escape(key)}\s*(?:番)?(?:[.．、,)）:：])?", "", rest)
            memo = rest.strip(MEMO_STRIP)
            if not memo:
                continue
            tid = resolve(key, mapping)
            if tid:
                memos.append((tid, memo))
            else:
                unresolved.append(line.strip())

    return done_ids, stay_ids, memos, unresolved


def cmd_complete(args: argparse.Namespace) -> int:
    replies = json.loads(Path(args.replies).read_text(encoding="utf-8"))
    if isinstance(replies, dict):
        replies = replies.get("replies", [])

    # Botが投げた子スレッド自身を読み返して誤爆しないよう、本人の発言だけに絞る。
    # 各要素は文字列でも {"text":…, "user":…} でもよい。user が分かるなら必ず入れること。
    texts: List[str] = []
    dropped_others = 0
    for r in replies:
        if isinstance(r, str):
            texts.append(r)
            continue
        user = r.get("user") or ""
        if r.get("bot_id") or (args.only_user and user and user != args.only_user):
            dropped_others += 1
            continue
        texts.append(r.get("text", ""))
    if dropped_others:
        print(f"（本人以外の発言 {dropped_others}件は読み飛ばしました）")

    state = load(STATE)
    mapping = get_thread(state).get("mapping") or {}
    if not mapping and not args.allow_no_mapping:
        raise SyncError(
            "番号 → task.id の対応がありません。前回の upsert が走っていない可能性があります。\n"
            "  番号指定を無視してIDだけ拾うなら --allow-no-mapping を付けてください。"
        )

    texts, adds = split_adds(texts)
    ids, stay_ids, memos, unresolved = parse_replies(texts, mapping)
    if not (ids or stay_ids or memos or unresolved or adds):
        print("完了・ステイ・メモ・追加の返信はありませんでした。")
        return 0
    thread_ts = get_thread(state).get("ts") or ""

    data = load(TASKS)
    index = {t["id"]: t for t in data["tasks"]}
    stamp = now()
    done: List[str] = []
    already: List[str] = []
    missing: List[str] = []

    for tid in ids:
        t = index.get(tid)
        if t is None:
            missing.append(tid)
            continue
        if t.get("status") in CLOSED:
            already.append(f"{tid}（すでに {t['status']}）")
            continue
        t["status"] = "done"
        t["completed_at"] = stamp
        done.append(f"{tid} {t.get('title','')}")

    # ステイ: status は変えない。翌朝必ず出す印を付け、回数を数える。
    # 同じスレッドを二度読んでも回数が増えないよう、スレッドの ts で重複を弾く。
    stayed: List[str] = []
    for tid in stay_ids:
        t = index.get(tid)
        if t is None:
            missing.append(tid)
            continue
        if t.get("status") in CLOSED:
            already.append(f"{tid}（すでに {t['status']}。ステイは効きません）")
            continue
        if tid in {d.split()[0] for d in done}:
            continue  # 同じ返信で完了とステイが両方あれば完了を優先
        t["stay_pending"] = True
        if not thread_ts or t.get("last_stay_ts") != thread_ts:
            t["stay_count"] = int(t.get("stay_count") or 0) + 1
            t["last_stay_ts"] = thread_ts
        t["last_stay_at"] = stamp
        stayed.append(f"{tid} {t.get('title','')}（{t['stay_count']}回目）")

    # メモ: 同じスレッドの同じ文は二度足さない。
    noted: List[str] = []
    for tid, memo in memos:
        t = index.get(tid)
        if t is None:
            missing.append(tid)
            continue
        history = t.setdefault("memos", [])
        if any(h.get("text") == memo and h.get("thread_ts") == thread_ts for h in history):
            continue
        entry = {"at": stamp, "text": memo, "thread_ts": thread_ts}
        history.append(entry)
        t["last_memo"] = entry
        noted.append(f"{tid} 📝 {memo}")

    # 追加: 新しいタスクとして足す。ref はスレッドと本文から作るので、同じスレッドを二度読んでも二重にならない。
    added: List[str] = []
    if adds:
        refs = by_ref(data["tasks"])
        nid = next_task_id(data["tasks"])
        today = dt.datetime.now(JST).date()
        for body in adds:
            h = hashlib.sha1(body.encode("utf-8")).hexdigest()[:10]
            ref = f"manual:{thread_ts or 'nothread'}:{h}"
            if ref in refs:
                continue
            title, due = parse_add(body, today)
            tid = f"t{nid:03d}"
            nid += 1
            task = {
                "id": tid,
                "title": title,
                "due": due,
                "due_confidence": "explicit" if due else None,
                "status": "next",
                "priority": "P2" if due else "P3",
                "source": {"app": "manual", "ref": ref, "url": "", "from": "本人が追加"},
                "notes": "",
                "next_action": "",
                "project": None,
                "detected_at": stamp,
                "last_seen_at": stamp,
            }
            data["tasks"].append(task)
            refs[ref] = task
            added.append(f"{tid} {title}" + (f"（期限 {due}）" if due else "（期限なし）"))
        data["next_id"] = nid

    if done or stayed or noted or added:
        data["updated_at"] = stamp
        save(TASKS, data, args.dry_run)

    tag = "[dry-run] " if args.dry_run else ""
    print(f"{tag}完了 {len(done)}件 / ステイ {len(stayed)}件 / メモ {len(noted)}件 / 追加 {len(added)}件")
    for d in done:
        print("  done:", d)
    for st in stayed:
        print("  ステイ:", st)
    for nt in noted:
        print("  メモ:", nt)
    for ad in added:
        print("  追加:", ad)
    # 握りつぶさない。拾えなかったものは必ず出す。
    for a in already:
        print("  変更なし:", a)
    for m in missing:
        print("  ⚠ 該当なし:", m, "← tasks.json にこのIDがありません")
    for u in unresolved:
        print("  ⚠ 解決できず:", u, "← 番号が前回の一覧にありません")
    return 0


# ---------------------------------------------------------------- status


# 本人が手で動かしてよい status。done はここに無い。
# 完了は「N完了」の返信から complete で入れる道だけにしてある
# （完了の記録が「いつ・どの返信で」に紐づかなくなるのを防ぐため）。
SETTABLE = {"next", "open", "doing", "later", "blocked", "dropped"}


def cmd_status(args: argparse.Namespace) -> int:
    if args.status not in SETTABLE:
        raise SyncError(
            f"{args.status} には変えられません。指定できるのは: "
            + " / ".join(sorted(SETTABLE))
            + "\n  完了は complete（スレッドの「N完了」）から入れてください。"
        )

    data = load(TASKS)
    index = {t["id"]: t for t in data["tasks"]}
    stamp = now()
    changed: List[str] = []
    missing: List[str] = []
    blocked: List[str] = []

    for tid in args.id:
        t = index.get(tid)
        if t is None:
            missing.append(tid)
            continue
        old = t.get("status")
        if old in CLOSED and not args.reopen:
            # done / dropped を黙って開け直さない。戻すなら意思表示を要求する。
            blocked.append(f"{tid}（{old} のまま。戻すなら --reopen）")
            continue
        if old == args.status:
            changed.append(f"{tid} 変更なし（すでに {old}）")
            continue
        t["status"] = args.status
        t["status_changed_at"] = stamp
        if args.note:
            t["notes"] = (t.get("notes") or "").rstrip()
            t["notes"] = f"{t['notes']}\n{stamp[:10]} {args.note}".strip()
        changed.append(f"{tid} {old} → {args.status}  {t.get('title','')}")

    if any("→" in c for c in changed):
        data["updated_at"] = stamp
        save(TASKS, data, args.dry_run)

    tag = "[dry-run] " if args.dry_run else ""
    print(f"{tag}{len(args.id)}件を処理")
    for c in changed:
        print("  ", c)
    # 握りつぶさない。
    for b in blocked:
        print("  ⚠ 変更せず:", b)
    for m in missing:
        print("  ⚠ 該当なし:", m, "← tasks.json にこのIDがありません")
    return 1 if (missing or blocked) else 0


# ---------------------------------------------------------------- record / thread


def cmd_record(args: argparse.Namespace) -> int:
    state = load(STATE)
    thread = get_thread(state)
    thread["ts"] = args.ts
    thread["channel"] = args.channel
    thread["posted_at"] = now()
    save(STATE, state, args.dry_run)
    tag = "[dry-run] " if args.dry_run else ""
    print(f"{tag}スレッドを記録: {args.channel} / {args.ts}")
    return 0


def cmd_thread(args: argparse.Namespace) -> int:
    thread = get_thread(load(STATE))
    if not thread.get("ts"):
        print("前回のスレッドは記録されていません（初回、または record が走っていない）。")
        return 0
    print(json.dumps(thread, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------- main


def main() -> int:
    p = argparse.ArgumentParser(description="tasks.json と Slackスレッドを同期する")
    p.add_argument("--dry-run", action="store_true", help="書き込まず、やることだけ表示")
    sub = p.add_subparsers(dest="cmd", required=True)

    u = sub.add_parser("upsert", help="巡回結果を tasks.json に登録する")
    u.add_argument("--findings", required=True)
    u.add_argument(
        "--no-carry-over",
        dest="carry_over",
        action="store_false",
        help="巡回で拾われなかった未完了タスクを一覧に出さない（既定は出す）",
    )
    u.set_defaults(func=cmd_upsert, carry_over=True)

    c = sub.add_parser("complete", help="スレッド返信の「N完了」を反映する")
    c.add_argument("--replies", required=True)
    c.add_argument("--allow-no-mapping", action="store_true")
    c.add_argument(
        "--only-user",
        default=paths.owner_slack_id(),
        help="このユーザーの発言だけを読む（既定: config.json の本人）。空文字で全員",
    )
    c.set_defaults(func=cmd_complete)

    s = sub.add_parser("status", help="タスクの status を変える")
    s.add_argument("id", nargs="+", help="task.id（複数可）")
    s.add_argument("--status", required=True, help=" / ".join(sorted(SETTABLE)))
    s.add_argument("--note", help="notes に一行足す（理由を残す用）")
    s.add_argument(
        "--reopen",
        action="store_true",
        help="done / dropped のものも動かす。既定では拒否する",
    )
    s.set_defaults(func=cmd_status)

    r = sub.add_parser("record", help="投稿したスレッドの ts を控える")
    r.add_argument("--ts", required=True)
    r.add_argument("--channel", default=paths.post_channel())
    r.set_defaults(func=cmd_record)

    t = sub.add_parser("thread", help="前回のスレッド情報を表示する")
    t.set_defaults(func=cmd_thread)

    args = p.parse_args()
    try:
        return args.func(args)
    except SyncError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
