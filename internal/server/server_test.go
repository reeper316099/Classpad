package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/reeper316099/classpad/internal/jsv"
)

func TestJSToFixed(t *testing.T) {
	cases := []struct {
		x    float64
		dp   int
		want string
	}{
		{1.005, 2, "1.00"}, // 1.005 is just below 1.005 in binary
		{0.125, 2, "0.13"}, // exact ties go up
		{2.5, 0, "3"},
		{-2.5, 0, "-3"},
		{-0.001, 2, "-0.00"},
		{1e-7, 2, "0.00"},
		{93.33333333333333, 2, "93.33"},
		{100, 2, "100.00"},
	}
	for _, c := range cases {
		if got := jsToFixed(c.x, c.dp); got != c.want {
			t.Errorf("jsToFixed(%v, %d) = %q, want %q", c.x, c.dp, got, c.want)
		}
	}
}

func TestUnb64(t *testing.T) {
	for in, want := range map[string]string{
		"aGVsbG8=":   "hello",
		"aGVsbG8":    "hello", // no padding
		"aGVs bG8=":  "hello", // whitespace skipped
		"aGVsbG8=xx": "hello", // stops at padding
		"-_8":        "\xfb\xff",
		"a":          "", // a lone trailing character is dropped
	} {
		if got := string(unb64(in)); got != want {
			t.Errorf("unb64(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDecodeURI(t *testing.T) {
	for in, want := range map[string]string{
		"a%20b":         "a b",
		"caf%C3%A9.png": "café.png",
		"a%2Fb%3F":      "a%2Fb%3F", // reserved characters stay escaped
		"plain":         "plain",
	} {
		got, ok := jsDecodeURI(in)
		if !ok || got != want {
			t.Errorf("jsDecodeURI(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"%", "%zz", "%C3", "%C3%28", "%FF"} {
		if _, ok := jsDecodeURI(bad); ok {
			t.Errorf("jsDecodeURI(%q) should fail", bad)
		}
	}
}

func TestEncodeURIComponent(t *testing.T) {
	if got := encodeURIComponent("my file (1)!*'~.txt/é"); got != "my%20file%20(1)!*'~.txt%2F%C3%A9" {
		t.Errorf("got %q", got)
	}
}

func TestApplyListSortAndFilter(t *testing.T) {
	items := []*jsv.Obj{
		jsv.O("id", "a", "name", "Item 10", "tags", []any{"x"}),
		jsv.O("id", "b", "name", "Item 9"),
		jsv.O("id", "c", "tags", []any{"y"}),
		jsv.O("id", "d", "name", "item 9"),
		jsv.O("id", "e"),
	}
	ids := func(v any) string {
		var out []string
		for _, x := range v.(*jsv.Obj).Arr("items") {
			out = append(out, x.(*jsv.Obj).Str("id"))
		}
		return strings.Join(out, "")
	}
	q := func(kv ...any) *jsv.Obj { return jsv.O(kv...) }
	v, err := applyList(items, q("sort", "name"))
	if err != nil || ids(v) != "dbace" { // numeric: 9 before 10; missing names last
		t.Fatalf("asc: %q %v", ids(v), err)
	}
	v, _ = applyList(items, q("sort", "name", "order", "desc"))
	if ids(v) != "ecabd" { // missing first, later ones before earlier ones
		t.Fatalf("desc: %q", ids(v))
	}
	v, _ = applyList(items, q("tags", "y"))
	if ids(v) != "c" {
		t.Fatalf("array filter: %q", ids(v))
	}
	v, _ = applyList(items, q("limit", "2", "offset", "1"))
	if ids(v) != "bc" || v.(*jsv.Obj).Num("total") != 5 {
		t.Fatalf("paging: %q", ids(v))
	}
	if _, err := applyList(items, q("limit", "0")); err == nil {
		t.Fatal("limit 0 should fail validation")
	}
}

func newTestApp(t *testing.T) *App {
	t.Helper()
	a, err := NewApp(AppOptions{DataDir: t.TempDir(), Token: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}

func call(a *App, method, path, body string, header map[string]string) (int, string) {
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Authorization", "Bearer secret")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range header {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func TestPipeline(t *testing.T) {
	a := newTestApp(t)
	check := func(status int, body string, wantStatus int, wantBody string) {
		t.Helper()
		if status != wantStatus || !strings.Contains(body, wantBody) {
			t.Errorf("got %d %s; want %d containing %s", status, body, wantStatus, wantBody)
		}
	}
	s, b := call(a, "GET", "/api/v1/health", "", map[string]string{"Authorization": ""})
	check(s, b, 401, `"UNAUTHORIZED"`)
	s, b = call(a, "GET", "/api/v1/health", "", nil)
	check(s, b, 200, `{"ok":true,"app":"Classpad"}`)
	s, b = call(a, "GET", "/api/v1/missing", "", nil)
	check(s, b, 404, `"route not found"`)
	s, b = call(a, "POST", "/api/v1/semesters", `{"name":`, nil)
	check(s, b, 400, `Body is not valid JSON`)
	s, b = call(a, "POST", "/api/v1/semesters", `{"name":""}`, nil)
	check(s, b, 422, `"path":"name"`)
	s, b = call(a, "POST", "/api/v1/semesters", `{"name":"Term","start":"2026-01-10","end":"2026-05-10"}`, nil)
	check(s, b, 200, `"slug":"term"`)
	s, b = call(a, "GET", "/api/v1/study-sessions/active", "", nil)
	check(s, b, 200, "null") // the fixed route wins over /:id
	s, _ = call(a, "DELETE", "/api/v1/demo", "", nil)
	if s != http.StatusNoContent {
		t.Errorf("DELETE /demo: %d", s)
	}

	a.SetPort(4321)                                  // listening: only loopback names on this port pass
	s, b = call(a, "GET", "/api/v1/health", "", nil) // httptest's Host is example.com
	check(s, b, 403, `"BAD_HOST"`)
	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	req.Host = "127.0.0.1:4321"
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("loopback host: %d", w.Code)
	}
}

func TestLockedAnswersOnlyLockRoutes(t *testing.T) {
	a := newTestApp(t)
	if s, b := call(a, "POST", "/api/v1/lock/setup", `{"passphrase":"long enough","collections":["notes"]}`, nil); s != 200 {
		t.Fatalf("setup: %d %s", s, b)
	}
	if s, _ := call(a, "POST", "/api/v1/lock/lock", `{}`, nil); s != 200 {
		t.Fatal("lock failed")
	}
	if s, b := call(a, "GET", "/api/v1/notes", "", nil); s != 423 {
		t.Fatalf("locked notes: %d %s", s, b)
	}
	if s, b := call(a, "POST", "/api/v1/lock/unlock", `{"passphrase":"wrong!"}`, nil); s != 403 {
		t.Fatalf("wrong passphrase: %d %s", s, b)
	}
	if s, b := call(a, "POST", "/api/v1/lock/unlock", `{"passphrase":"long enough"}`, nil); s != 200 {
		t.Fatalf("unlock: %d %s", s, b)
	}
	if s, _ := call(a, "GET", "/api/v1/notes", "", nil); s != 200 {
		t.Fatal("notes after unlock")
	}
}

func benchApp(b *testing.B) *App {
	a, err := NewApp(AppOptions{DataDir: b.TempDir(), Token: "secret"})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { a.Close() })
	if _, err := a.Ctx.LoadDemo(Now()); err != nil {
		b.Fatal(err)
	}
	return a
}

func benchRoute(b *testing.B, path string) {
	a := benchApp(b)
	b.ResetTimer()
	for range b.N {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer secret")
		w := httptest.NewRecorder()
		a.ServeHTTP(w, req)
		if w.Code != 200 {
			b.Fatal(w.Code)
		}
	}
}

func BenchmarkListSorted(b *testing.B) { benchRoute(b, "/api/v1/assignments?limit=100&sort=due") }
func BenchmarkGpa(b *testing.B)        { benchRoute(b, "/api/v1/gpa") }
func BenchmarkReport(b *testing.B)     { benchRoute(b, "/api/v1/export/report") }

func TestNewIDIsMonotonic(t *testing.T) {
	prev := NewID()
	for range 10_000 {
		id := NewID()
		if len(id) != 26 || id <= prev {
			t.Fatalf("%q after %q", id, prev)
		}
		prev = id
	}
}
