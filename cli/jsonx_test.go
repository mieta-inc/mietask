package main

import "testing"

// 台帳を読んで書き戻したとき、キーの順番も書式も変わらないこと（Python の json.dumps(indent=2, ensure_ascii=False) と同じ）。
func TestJSONRoundTrip(t *testing.T) {
	src := `{
  "version": 1,
  "tasks": [
    {
      "id": "t001",
      "title": "見積書を確認 \"引用\" と \\ と\n改行",
      "due": null,
      "stay_count": 2,
      "score": 1.5,
      "memos": [],
      "source": {},
      "flag": true
    }
  ],
  "z_last": "<&>/ \u0001"
}`
	v, err := ParseJSON([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if got := DumpJSON(v, 2); got != src {
		t.Errorf("書き戻しが変わった:\n%s", got)
	}
}

func TestObjOrder(t *testing.T) {
	o := NewObj()
	o.Set("b", 1)
	o.Set("a", 2)
	o.Set("b", 3) // 既存キーの更新は位置を変えない
	o.Delete("a")
	o.Set("a", 4) // 消してから足すと末尾
	if got := DumpJSON(o, 0); got != "{\n\"b\": 3,\n\"a\": 4\n}" {
		t.Errorf("got %q", got)
	}
}
