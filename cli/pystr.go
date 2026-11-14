package main

// Python の文字列操作（strip・splitlines・repr）を同じ結果になるように再現する。
// 返信の読み取りやタイトルの整形が Python 版と1文字でもずれると、台帳の中身が変わってしまうため。

import (
	"strings"
	"unicode"
)

// pyIsSpace は Python の str.isspace() と同じ判定。
func pyIsSpace(r rune) bool {
	if r >= 0x1c && r <= 0x1f {
		return true
	}
	return unicode.IsSpace(r)
}

func pyStrip(s string) string { return strings.TrimFunc(s, pyIsSpace) }

func pyRstrip(s string) string { return strings.TrimRightFunc(s, pyIsSpace) }

func pyStripChars(s, chars string) string {
	return strings.TrimFunc(s, func(r rune) bool { return strings.ContainsRune(chars, r) })
}

// pySplitlines は Python の str.splitlines()。
func pySplitlines(s string) []string {
	var out []string
	r := []rune(s)
	start := 0
	for i := 0; i < len(r); i++ {
		switch r[i] {
		case '\n', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\u0085', ' ', ' ':
			out = append(out, string(r[start:i]))
			start = i + 1
		case '\r':
			out = append(out, string(r[start:i]))
			if i+1 < len(r) && r[i+1] == '\n' {
				i++
			}
			start = i + 1
		}
	}
	if start < len(r) {
		out = append(out, string(r[start:]))
	}
	return out
}

func joinLines(lines []string) string { return strings.Join(lines, "\n") }

// pySplitFirst は Python の s.split()[0]（空白で区切った最初の語）。
func pySplitFirst(s string) string {
	f := strings.FieldsFunc(s, pyIsSpace)
	if len(f) == 0 {
		return ""
	}
	return f[0]
}

// pyRepr は Python の repr(v)。エラーメッセージにタイトルを出すときに使う。
func pyRepr(v any) string {
	s, ok := v.(string)
	if !ok {
		return pyStr(v)
	}
	q := "'"
	if strings.Contains(s, "'") && !strings.Contains(s, `"`) {
		q = `"`
	}
	var b strings.Builder
	b.WriteString(q)
	for _, r := range s {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case string(r) == q:
			b.WriteString(`\` + q)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteString(q)
	return b.String()
}
