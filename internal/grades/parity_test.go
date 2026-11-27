package grades

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"testing"
)

// The TypeScript engine's answers for generated cases (scripts/grades-parity.mjs). Every result
// here must match them exactly: the numbers, the step breakdowns and the warnings.

type parityFile struct {
	GradeCases []struct {
		Scheme        Scheme                 `json:"scheme"`
		Items         []GradeItem            `json:"items"`
		Overrides     map[string]*ScoreInput `json:"overrides"`
		Needed        NeededOptions          `json:"needed"`
		IncludeGraded bool                   `json:"includeGraded"`
		Want          map[string]json.RawMessage
	} `json:"gradeCases"`
	GpaCases []struct {
		Scale   GpaScale    `json:"scale"`
		Courses []GpaCourse `json:"courses"`
		Options GpaOptions  `json:"options"`
		Plan    PlanInput   `json:"plan"`
		Want    map[string]json.RawMessage
	} `json:"gpaCases"`
	Scales map[string]json.RawMessage `json:"scales"`
}

func loadParity(t testing.TB) parityFile {
	t.Helper()
	path := "testdata/parity.json.gz"
	if p := os.Getenv("GRADES_PARITY_FILE"); p != "" {
		path = p // a bigger one-off set from scripts/grades-parity.mjs --out
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var p parityFile
	if err := json.NewDecoder(z).Decode(&p); err != nil {
		t.Fatal(err)
	}
	return p
}

// same compares got (a Go value) with want (the TypeScript JSON) as parsed JSON.
func same(t *testing.T, where string, got any, want json.RawMessage) {
	t.Helper()
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Errorf("%s differs at %s\n go: %s\n ts: %s", where, diffPath(g, w, ""), b, want)
	}
}

// diffPath names the first place two JSON values differ.
func diffPath(a, b any, path string) string {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok {
			return path
		}
		keys := map[string]bool{}
		for k := range x {
			keys[k] = true
		}
		for k := range y {
			keys[k] = true
		}
		var ks []string
		for k := range keys {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			if !reflect.DeepEqual(x[k], y[k]) {
				return diffPath(x[k], y[k], path+"."+k)
			}
		}
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return fmt.Sprintf("%s (length)", path)
		}
		for i := range x {
			if !reflect.DeepEqual(x[i], y[i]) {
				return diffPath(x[i], y[i], fmt.Sprintf("%s[%d]", path, i))
			}
		}
	}
	return fmt.Sprintf("%s: %v ≠ %v", path, a, b)
}

func TestParityWithTypeScript(t *testing.T) {
	p := loadParity(t)
	if len(p.GradeCases) == 0 || len(p.GpaCases) == 0 {
		t.Fatal("no cases")
	}
	for n, c := range p.GradeCases {
		where := func(what string) string { return fmt.Sprintf("grade case %d %s", n, what) }
		same(t, where("computeGrade"), ComputeGrade(c.Scheme, c.Items), c.Want["grade"])
		same(t, where("whatIf"), WhatIf(c.Scheme, c.Items, c.Overrides), c.Want["whatIf"])
		if r, err := NeededScore(c.Scheme, c.Items, c.Needed); err != nil {
			same(t, where("neededScore"), map[string]string{"error": err.Error()}, c.Want["needed"])
		} else {
			same(t, where("neededScore"), r, c.Want["needed"])
		}
		same(t, where("sensitivity"), Sensitivity(c.Scheme, c.Items, c.IncludeGraded), c.Want["sensitivity"])
		same(t, where("project"), Project(c.Scheme, c.Items), c.Want["projection"])
	}
	for n, c := range p.GpaCases {
		where := func(what string) string { return fmt.Sprintf("GPA case %d %s", n, what) }
		same(t, where("computeGpa"), ComputeGpa(c.Courses, c.Scale, c.Options), c.Want["gpa"])
		same(t, where("gpaReport"), GpaReportFor(c.Courses, c.Scale, c.Options), c.Want["report"])
		same(t, where("planGpa"), PlanGpa(c.Plan), c.Want["plan"])
	}
	scales := GpaScales()
	if len(scales) != len(p.Scales) {
		t.Fatalf("%d GPA scales, TypeScript has %d", len(scales), len(p.Scales))
	}
	for id, raw := range p.Scales {
		// TypeScript keeps these as plain numbers; read them as decimals to compare.
		var want NamedGpaScale
		if err := json.Unmarshal(raw, &want); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(want)
		same(t, "GPA scale "+id, scales[id], b)
	}
	t.Logf("%d grade cases and %d GPA cases match the TypeScript engine", len(p.GradeCases), len(p.GpaCases))
}
