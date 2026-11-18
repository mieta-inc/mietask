package main

// 自分用の投稿内容から、チームのまとめチャンネル向けの投稿内容を作る。
//
// 変えるのは2点だけ:
//   - 親の先頭に名前を付け、「詳細はスレッドに…」の案内行を落とす（返信するのは本人だけなので）
//   - 返信案の子スレッドを落とす（本人用の下書きで、管理者に見せるものではない）
//
// タスクの一覧・期限・次の一手・メモは自分用と同じものを出す。管理者が1on1で同じものを見るため。
// LLMに組み立て直させないのは、自分用とまとめ用で中身がずれないようにするため。

import (
	"errors"
	"os"
	"strings"
)

// 自分用の親にだけある、本人向けの案内
var ownerOnlyMarkers = []string{"詳細はスレッドに", "このスレッドにそのまま書いて"}

// 本人用の下書き。まとめには出さない
var draftMarkers = []string{"返信案"}

func containsAny(s string, subs []string) bool {
	for _, m := range subs {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

func buildTeamPayload(own *Obj, name string) (*Obj, error) {
	parent, ok := own.Val("parent").(string)
	if !ok || pyStrip(parent) == "" {
		return nil, errors.New("payload に parent がありません。")
	}
	rv := own.Val("replies")
	var replies []any
	if truthy(rv) {
		replies, ok = rv.([]any)
		if !ok {
			return nil, errors.New("payload の replies はリストである必要があります。")
		}
	}
	var lines []string
	for _, ln := range pySplitlines(parent) {
		if !containsAny(ln, ownerOnlyMarkers) {
			lines = append(lines, ln)
		}
	}
	for len(lines) > 0 && pyStrip(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	teamParent := ":bust_in_silhouette: *" + name + "*\n" + joinLines(lines)

	kept := []any{}
	for _, r := range replies {
		s := str(r)
		head := ""
		if st := pyStrip(s); st != "" {
			head = pySplitlines(st)[0]
		}
		if containsAny(head, draftMarkers) {
			continue
		}
		kept = append(kept, r)
	}
	out := NewObj()
	out.Set("parent", teamParent)
	out.Set("replies", kept)
	return out, nil
}

func cmdTeamPayload(payloadPath, name string) error {
	raw, err := os.ReadFile(payloadPath)
	if err != nil {
		return err
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return err
	}
	own, ok := v.(*Obj)
	if !ok {
		return errors.New("payload のトップレベルはオブジェクトである必要があります。")
	}
	out, err := buildTeamPayload(own, pyStrip(name))
	if err != nil {
		return err
	}
	os.Stdout.WriteString(DumpJSON(out, 1) + "\n")
	return nil
}
