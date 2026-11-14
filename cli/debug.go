package main

// 試験用の隠しコマンド。返信の読み取り結果を JSON で出す。
// 以前の Python 版と出力を突き合わせて、読み取りのルールが変わっていないことを確かめるのに使う。
//
//	echo '{"cases":[{"texts":["1完了"],"mapping":{"1":"t001"}}],"today":"2026-11-14"}' | mietask _parse

import (
	"fmt"
	"io"
	"os"
	"time"
)

func cmdDebugParse() error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return err
	}
	in := orObj(v)
	today, _ := time.Parse("2006-01-02", str(in.Val("today")))
	cases, _ := in.Val("cases").([]any)
	out := []any{}
	for _, c := range cases {
		co := orObj(c)
		var texts []string
		arr, _ := co.Val("texts").([]any)
		for _, t := range arr {
			texts = append(texts, str(t))
		}
		mapping := orObj(co.Val("mapping"))
		rest, adds := splitAdds(texts)
		done, stay, memos, unres := parseReplies(rest, mapping)
		r := NewObj()
		r.Set("done", strList(done))
		r.Set("stay", strList(stay))
		ml := []any{}
		for _, m := range memos {
			ml = append(ml, []any{m[0], m[1]})
		}
		r.Set("memos", ml)
		r.Set("unresolved", strList(unres))
		al := []any{}
		for _, a := range adds {
			title, due := parseAdd(a, today)
			var d any
			if due != "" {
				d = due
			}
			al = append(al, []any{a, title, d})
		}
		r.Set("adds", al)
		out = append(out, r)
	}
	fmt.Println(DumpJSON(out, 0))
	return nil
}

func strList(s []string) []any {
	out := make([]any, len(s))
	for i, x := range s {
		out[i] = x
	}
	return out
}
