package grades

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"testing"
)

// The same work as scripts/grades-bench.mjs times in the TypeScript engine.

type benchClass struct {
	Scheme Scheme      `json:"scheme"`
	Items  []GradeItem `json:"items"`
	Target Dec         `json:"target"`
}

func loadBench(b *testing.B) benchClass {
	f, err := os.Open("testdata/parity.json.gz")
	if err != nil {
		b.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		b.Fatal(err)
	}
	var p struct {
		Bench benchClass `json:"bench"`
	}
	if err := json.NewDecoder(z).Decode(&p); err != nil {
		b.Fatal(err)
	}
	return p.Bench
}

// BenchmarkClassPage: the grade, the sensitivity list and the projection for one class.
func BenchmarkClassPage(b *testing.B) {
	c := loadBench(b)
	for b.Loop() {
		ComputeGrade(c.Scheme, c.Items)
		Sensitivity(c.Scheme, c.Items, false)
		Project(c.Scheme, c.Items)
	}
}

// BenchmarkNeeded: the score needed for the target, overall and per remaining item.
func BenchmarkNeeded(b *testing.B) {
	c := loadBench(b)
	for b.Loop() {
		if _, err := NeededScore(c.Scheme, c.Items, NeededOptions{Target: ScoreTarget{Percent: &c.Target}, PerItem: true}); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkAllCases: every function on every generated case.
func BenchmarkAllCases(b *testing.B) {
	p := loadParity(b)
	for b.Loop() {
		for _, c := range p.GradeCases {
			ComputeGrade(c.Scheme, c.Items)
			WhatIf(c.Scheme, c.Items, c.Overrides)
			_, _ = NeededScore(c.Scheme, c.Items, c.Needed)
			Sensitivity(c.Scheme, c.Items, c.IncludeGraded)
			Project(c.Scheme, c.Items)
		}
		for _, c := range p.GpaCases {
			ComputeGpa(c.Courses, c.Scale, c.Options)
			GpaReportFor(c.Courses, c.Scale, c.Options)
			PlanGpa(c.Plan)
		}
	}
}
