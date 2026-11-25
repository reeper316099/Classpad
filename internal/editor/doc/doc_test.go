package doc

import (
	"reflect"
	"testing"
)

func TestUTF16(t *testing.T) {
	s := "a😀b"
	if Len16(s) != 4 {
		t.Fatalf("len %d", Len16(s))
	}
	if Slice16(s, 1, 3) != "😀" || Slice16(s, 3, 4) != "b" || Slice16(s, 0, 1) != "a" {
		t.Fatal("slice")
	}
}

func TestComposeInsertDeleteFormat(t *testing.T) {
	base := Delta{}.Insert("Hello world", nil)
	got := base.Compose(Delta{}.Retain(5, nil).Insert(",", nil))
	if got.Text() != "Hello, world" {
		t.Fatal(got.Text())
	}
	got = got.Compose(Delta{}.Retain(7, nil).Retain(5, Attrs{"bold": true}))
	want := Delta{}.Insert("Hello, ", nil).Insert("world", Attrs{"bold": true})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%#v", got)
	}
	got = got.Compose(Delta{}.Delete(7))
	if got.Text() != "world" || got[0].Attrs["bold"] != true {
		t.Fatalf("%#v", got)
	}
}

func TestInvertRoundTrip(t *testing.T) {
	base := Delta{}.Insert("ab", nil).Insert("cd", Attrs{"italic": true}).Insert("ef", nil)
	changes := []Delta{
		Delta{}.Retain(1, nil).Delete(3).Insert("XY", Attrs{"code": true}),
		Delta{}.Retain(2, nil).Retain(3, Attrs{"italic": nil, "bold": true}),
		Delta{}.Insert("😀", nil),
	}
	for i, c := range changes {
		after := base.Compose(c)
		back := after.Compose(c.Invert(base))
		if !reflect.DeepEqual(back, base) {
			t.Fatalf("case %d: %#v", i, back)
		}
	}
}

func TestEmbedsDoNotMerge(t *testing.T) {
	d := Delta{}.Insert(Embed, Attrs{"formula": "x"}).Insert(Embed, Attrs{"formula": "x"})
	if len(d) != 2 || d.Len() != 2 {
		t.Fatalf("%#v", d)
	}
}

func TestCommonAttrs(t *testing.T) {
	d := Delta{}.Insert("ab", Attrs{"bold": true, "italic": true}).Insert("cd", Attrs{"bold": true})
	if c := d.CommonAttrs(0, 4); len(c) != 1 || c["bold"] != true {
		t.Fatalf("%v", c)
	}
}

func TestPathShift(t *testing.T) {
	if got := (Path{2, 1}).AfterInsert(Path{1}, 2); !got.Equal(Path{4, 1}) {
		t.Fatal(got)
	}
	if got := (Path{0, 3}).AfterInsert(Path{1}, 2); !got.Equal(Path{0, 3}) {
		t.Fatal(got)
	}
	if _, ok := (Path{1, 0}).AfterDelete(Path{1}, 1); ok {
		t.Fatal("deleted path survived")
	}
	if got, _ := (Path{3}).AfterDelete(Path{1}, 2); !got.Equal(Path{1}) {
		t.Fatal(got)
	}
}

func TestTransactionUndo(t *testing.T) {
	d := New(Text(Paragraph, "one", nil), Text(Paragraph, "two", nil))
	before := d.Clone()
	tr := NewTransaction(d, Caret(Path{0}, 0))
	tr.InsertText(Path{0}, 3, "!", nil)
	tr.SetType(Path{1}, Heading, Attrs{AttrLevel: 2})
	tr.InsertNodes(Path{1}, Text(Bulleted, "mid", nil))
	tr.DeleteNodes(Path{0}, 1)
	if tr.Err() != nil {
		t.Fatal(tr.Err())
	}
	if d.NodeAt(Path{1}).Type != Heading || d.NodeAt(Path{0}).Delta.Text() != "mid" {
		t.Fatal("apply")
	}
	for _, op := range tr.Inverse() {
		if err := op.Apply(d); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(d, before) {
		t.Fatal("undo did not restore the document")
	}
}
