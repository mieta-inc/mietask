package main

// 台帳（tasks.json / state.json）を、キーの順番を保ったまま読み書きする。
//
// Go の encoding/json は map のキーを並べ替えてしまい、書き戻すたびに台帳の差分が荒れる。
// 以前の Python 版（json.dumps(ensure_ascii=False, indent=2)）と1文字も違わない形で
// 書き出すため、順序付きの値と専用の書き出しを持つ。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Obj はキーの順番を保つ JSON オブジェクト。新しいキーは末尾に足される（Python の dict と同じ）。
type Obj struct {
	keys []string
	m    map[string]any
}

func NewObj() *Obj { return &Obj{m: map[string]any{}} }

func (o *Obj) Get(k string) (any, bool) {
	v, ok := o.m[k]
	return v, ok
}

// Val はキーが無ければ nil を返す（Python の dict.get(k)）。
func (o *Obj) Val(k string) any { return o.m[k] }

func (o *Obj) Has(k string) bool { _, ok := o.m[k]; return ok }

func (o *Obj) Set(k string, v any) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
}

func (o *Obj) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *Obj) Keys() []string { return append([]string(nil), o.keys...) }

// SetDefaultObj は Python の dict.setdefault(k, {}) 。
func (o *Obj) SetDefaultObj(k string) *Obj {
	if v, ok := o.m[k].(*Obj); ok {
		return v
	}
	if _, ok := o.m[k]; ok {
		// 中身がオブジェクト以外なら Python と同じくそのまま返す相手が無いので作り直さない
		return NewObj()
	}
	n := NewObj()
	o.Set(k, n)
	return n
}

// Copy は浅いコピー（{**t} 相当）。
func (o *Obj) Copy() *Obj {
	n := NewObj()
	for _, k := range o.keys {
		n.Set(k, o.m[k])
	}
	return n
}

// ---------------------------------------------------------------- 読み込み

func ParseJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("JSONの後ろに余計な文字があります")
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := NewObj()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("オブジェクトのキーが文字列ではありません")
				}
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("想定外の区切り %v", t)
	default:
		return tok, nil // string / json.Number / bool / nil
	}
}

// ---------------------------------------------------------------- 書き出し

// DumpJSON は Python の json.dumps(v, ensure_ascii=False, indent=indent) と同じ文字列を返す。
func DumpJSON(v any, indent int) string {
	var b strings.Builder
	writeValue(&b, v, indent, 0)
	return b.String()
}

func writeValue(b *strings.Builder, v any, indent, level int) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		b.WriteString(string(x))
	case int:
		fmt.Fprintf(b, "%d", x)
	case int64:
		fmt.Fprintf(b, "%d", x)
	case float64:
		b.WriteString(pyFloat(x))
	case string:
		writeString(b, x)
	case *Obj:
		if len(x.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{")
		for i, k := range x.keys {
			if i > 0 {
				b.WriteString(",")
			}
			newline(b, indent, level+1)
			writeString(b, k)
			b.WriteString(": ")
			writeValue(b, x.m[k], indent, level+1)
		}
		newline(b, indent, level)
		b.WriteString("}")
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[")
		for i, e := range x {
			if i > 0 {
				b.WriteString(",")
			}
			newline(b, indent, level+1)
			writeValue(b, e, indent, level+1)
		}
		newline(b, indent, level)
		b.WriteString("]")
	case []string:
		arr := make([]any, len(x))
		for i, s := range x {
			arr[i] = s
		}
		writeValue(b, arr, indent, level)
	default:
		writeString(b, fmt.Sprint(x))
	}
}

func newline(b *strings.Builder, indent, level int) {
	b.WriteString("\n")
	b.WriteString(strings.Repeat(" ", indent*level))
}

// writeString は ensure_ascii=False の書き方。エスケープするのは " \ と制御文字だけ。
func writeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

func pyFloat(f float64) string {
	s := fmt.Sprintf("%v", f)
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	return s
}

// ---------------------------------------------------------------- Python の値の扱い

// truthy は Python の bool(v)。
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, err := x.Float64()
		return err != nil || f != 0
	case int:
		return x != 0
	case int64:
		return x != 0
	case float64:
		return x != 0
	case *Obj:
		return len(x.keys) > 0
	case []any:
		return len(x) > 0
	}
	return true
}

// pyStr は Python の str(v)（f文字列に埋め込んだときの見え方）。
func pyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case string:
		return x
	case json.Number:
		return string(x)
	case int:
		return fmt.Sprint(x)
	case int64:
		return fmt.Sprint(x)
	case float64:
		return pyFloat(x)
	}
	return fmt.Sprint(v)
}

// str は値が文字列ならそれを、そうでなければ空を返す（台帳の文字列欄を読むとき用）。
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// getDefault は Python の d.get(k, default)。キーがあれば値が null でもそれを返す。
func getDefault(o *Obj, k string, def any) any {
	if o == nil {
		return def
	}
	if v, ok := o.Get(k); ok {
		return v
	}
	return def
}

// asObj は値がオブジェクトならそれを、そうでなければ nil を返す。
func asObj(v any) *Obj {
	o, _ := v.(*Obj)
	return o
}

// orObj は Python の (x or {})。
func orObj(v any) *Obj {
	if o, ok := v.(*Obj); ok && o != nil {
		return o
	}
	return NewObj()
}

// pyInt は Python の int(v or 0)。読めなければ 0。
func pyInt(v any) int {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return int(i)
		}
		if f, err := x.Float64(); err == nil {
			return int(f)
		}
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case bool:
		if x {
			return 1
		}
	case string:
		var i int
		if _, err := fmt.Sscan(strings.TrimSpace(x), &i); err == nil {
			return i
		}
	}
	return 0
}

// pyEqual は Python の == を、台帳に出てくる型の範囲で再現する。
func pyEqual(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case json.Number:
		switch y := b.(type) {
		case json.Number:
			fx, e1 := x.Float64()
			fy, e2 := y.Float64()
			return e1 == nil && e2 == nil && fx == fy
		}
	}
	return false
}
