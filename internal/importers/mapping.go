package importers

import (
	"fmt"
	"strings"
)

// RowFilter picks rows whose cell in Column equals (or contains) a value, ignoring case and spacing.
type RowFilter struct {
	Column   string  `json:"column"`
	Equals   *string `json:"equals,omitempty"`
	Contains *string `json:"contains,omitempty"`
}

// MappingColumns lists, per Classpad field, the source headers to look for (first match wins).
type MappingColumns struct {
	Title          []string `json:"title,omitempty"`
	Class          []string `json:"class,omitempty"`
	Due            []string `json:"due,omitempty"`
	Score          []string `json:"score,omitempty"`
	PointsPossible []string `json:"pointsPossible,omitempty"`
	Weight         []string `json:"weight,omitempty"`
	Status         []string `json:"status,omitempty"`
	Type           []string `json:"type,omitempty"`
	Notes          []string `json:"notes,omitempty"`
}

type WideOptions struct {
	StudentColumn  *string    `json:"studentColumn,omitempty"`
	StudentValue   *string    `json:"studentValue,omitempty"`
	SkipColumns    []string   `json:"skipColumns"`
	PointsRow      *RowFilter `json:"pointsRow,omitempty"`
	PointsInHeader bool       `json:"pointsInHeader"`
}

// MappingPlugin is a declarative gradebook format (already validated, defaults filled in).
type MappingPlugin struct {
	PluginVersion int            `json:"pluginVersion"`
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Description   string         `json:"description,omitempty"`
	Author        string         `json:"author,omitempty"`
	Kind          string         `json:"kind"`
	Layout        string         `json:"layout"`
	Columns       MappingColumns `json:"columns"`
	Wide          WideOptions    `json:"wide"`
	ScoreFormat   string         `json:"scoreFormat"`
	ClassName     string         `json:"className,omitempty"`
	SkipRows      []RowFilter    `json:"skipRows"`
}

func mapNorm(s string) string { return spaceRun.ReplaceAllString(strings.ToLower(jsTrim(s)), " ") }

var (
	fractionRe     = jsRe(`^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$`)
	pointsInHeader = jsRe(`(?i)^(.*?)\s*[([]\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?)?\s*[)\]]\s*$`)
	canonColumns   = []string{"title", "class", "due", "weight", "score", "points_possible", "status", "priority", "type", "link", "notes"}
	wideSkip       = map[string]bool{}
)

func init() {
	for _, s := range []string{"student", "name", "id", "student id", "sis user id", "sis login id", "section",
		"final grade", "final score", "current grade", "current score", "total", "overall", "letter grade"} {
		wideSkip[mapNorm(s)] = true
	}
}

func (f RowFilter) matches(v string) bool {
	x := mapNorm(v)
	if f.Equals != nil {
		return x == mapNorm(*f.Equals)
	}
	c := ""
	if f.Contains != nil {
		c = *f.Contains
	}
	return strings.Contains(x, mapNorm(c))
}

// readScore turns a score cell into Classpad's score and points possible, or explains why not.
func readScore(raw, pp, format string, warn func(string)) (string, string) {
	v := jsTrim(raw)
	if v == "" || v == "-" || v == "—" {
		return "", pp
	}
	if m := fractionRe.FindStringSubmatch(v); m != nil {
		return m[1], m[2]
	}
	if strings.HasSuffix(v, "%") {
		return v, pp
	}
	if numericCell.MatchString(v) {
		if format == "percent" {
			return v + "%", ""
		}
		if format == "points" && pp == "" {
			warn(fmt.Sprintf(`"%s" is in points but points possible is unknown; read as a percent`, v))
			return v + "%", ""
		}
		return v, pp
	}
	warn(fmt.Sprintf(`Score "%s" is not a number (excused or missing?); left ungraded`, v))
	return "", pp
}

func mappedCSV(rows []map[string]string) string {
	data := make([][]string, len(rows))
	for i, r := range rows {
		cells := make([]string, len(canonColumns))
		for j, f := range canonColumns {
			cells[j] = r[f]
		}
		data[i] = cells
	}
	return unparse(canonColumns, data)
}

// MapGradebook rewrites someone else's gradebook CSV into Classpad's own assignments CSV.
func MapGradebook(text string, p MappingPlugin, className string) (string, []Warning) {
	warnings := []Warning{}
	warn := func(code, message, where string) {
		warnings = append(warnings, Warning{Code: code, Message: message, Where: where})
	}
	t := ParseCSV(text)
	byName := map[string]string{}
	for _, f := range t.Fields {
		byName[mapNorm(f)] = f // a later column with the same name wins, like new Map(entries)
	}
	cell := func(r Row, header string) string { return r.Get(byName[mapNorm(header)]) }
	has := func(h string) bool { _, ok := byName[mapNorm(h)]; return ok }
	if className = jsTrim(className); className == "" {
		className = p.ClassName
	}
	var rows []map[string]string
	skipped := func(r Row) bool {
		for _, f := range p.SkipRows {
			if has(f.Column) && f.matches(cell(r, f.Column)) {
				return true
			}
		}
		return false
	}

	if p.Layout == "long" {
		pick := func(hs []string) string {
			for _, h := range hs {
				if has(h) {
					return h
				}
			}
			return ""
		}
		c := p.Columns
		h := struct{ title, class, due, score, pp, weight, status, typ, notes string }{
			pick(c.Title), pick(c.Class), pick(c.Due), pick(c.Score), pick(c.PointsPossible),
			pick(c.Weight), pick(c.Status), pick(c.Type), pick(c.Notes),
		}
		if h.title == "" {
			list := strings.Join(c.Title, ", ")
			if list == "" {
				list = "none set"
			}
			warn("MISSING_COLUMN", fmt.Sprintf("None of the title columns (%s) are in the file", list), "")
			return mappedCSV(nil), warnings
		}
		mapped := map[string]bool{}
		for _, x := range []string{h.title, h.class, h.due, h.score, h.pp, h.weight, h.status, h.typ, h.notes} {
			if x != "" {
				mapped[mapNorm(x)] = true
			}
		}
		for _, f := range t.Fields {
			if !mapped[mapNorm(f)] {
				warn("COLUMN", fmt.Sprintf(`Column "%s" is not used by this format and was ignored`, f), "")
			}
		}
		get := func(r Row, header string) string {
			if header == "" {
				return ""
			}
			return cell(r, header)
		}
		for i, r := range t.Rows {
			if skipped(r) {
				continue
			}
			title := jsTrim(get(r, h.title))
			if title == "" {
				continue
			}
			where := fmt.Sprintf("row %d", i+2)
			score, pp := readScore(get(r, h.score), get(r, h.pp), p.ScoreFormat, func(m string) { warn("SCORE", m, where) })
			status := get(r, h.status)
			if status == "" {
				status = "not_started"
				if score != "" {
					status = "complete"
				}
			}
			cls := jsTrim(get(r, h.class))
			if cls == "" {
				cls = className
			}
			rows = append(rows, map[string]string{
				"title": title, "class": cls, "due": get(r, h.due), "weight": get(r, h.weight),
				"score": score, "points_possible": pp, "status": status, "priority": "",
				"type": get(r, h.typ), "link": "", "notes": get(r, h.notes),
			})
		}
	} else {
		w := p.Wide
		var candidates []Row
		for _, r := range t.Rows {
			if !skipped(r) && !(w.PointsRow != nil && w.PointsRow.matches(cell(r, w.PointsRow.Column))) {
				candidates = append(candidates, r)
			}
		}
		var row *Row
		if len(candidates) > 0 {
			row = &candidates[0]
		}
		if w.StudentColumn != nil && *w.StudentColumn != "" && w.StudentValue != nil {
			row = nil
			for i := range candidates {
				if mapNorm(cell(candidates[i], *w.StudentColumn)) == mapNorm(*w.StudentValue) {
					row = &candidates[i]
					break
				}
			}
		} else if len(candidates) > 1 {
			warn("MULTIPLE_ROWS", fmt.Sprintf("The file has %d student rows; the first was used. Set wide.studentColumn and wide.studentValue to pick one.", len(candidates)), "")
		}
		if row == nil {
			warn("NO_ROW", "Could not find the student row in this file", "")
			return mappedCSV(nil), warnings
		}
		var ptsRow *Row
		if w.PointsRow != nil {
			for i := range t.Rows {
				if w.PointsRow.matches(cell(t.Rows[i], w.PointsRow.Column)) {
					ptsRow = &t.Rows[i]
					break
				}
			}
		}
		skip := map[string]bool{}
		for k := range wideSkip {
			skip[k] = true
		}
		for _, c := range w.SkipColumns {
			skip[mapNorm(c)] = true
		}
		if w.StudentColumn != nil && *w.StudentColumn != "" {
			skip[mapNorm(*w.StudentColumn)] = true
		}
		for _, f := range t.Fields {
			if skip[mapNorm(f)] {
				continue
			}
			title := jsTrim(f)
			pp := ""
			if ptsRow != nil {
				pp = jsTrim(ptsRow.Get(f))
			}
			if m := pointsInHeader.FindStringSubmatch(title); w.PointsInHeader && m != nil && m[1] != "" {
				title = jsTrim(m[1])
				if pp == "" {
					pp = m[2]
				}
			}
			if title == "" {
				continue
			}
			where := `"` + f + `"`
			score, spp := readScore(jsTrim(row.Get(f)), pp, p.ScoreFormat, func(m string) { warn("SCORE", m, where) })
			status := "not_started"
			if score != "" {
				status = "complete"
			}
			rows = append(rows, map[string]string{
				"title": title, "class": className, "due": "", "weight": "", "score": score,
				"points_possible": spp, "status": status, "priority": "", "type": "", "link": "", "notes": "",
			})
		}
		if className == "" {
			warn("NO_CLASS", "No class name was given; assignments will be imported without a class", "")
		}
	}
	if len(rows) == 0 {
		warn("EMPTY", "No assignments were found in this file", "")
	}
	return mappedCSV(rows), warnings
}

// PreviewGradebook maps a gradebook CSV and previews it as assignments.
func PreviewGradebook(text string, p MappingPlugin, className string) *ImportPreview {
	csv, warnings := MapGradebook(text, p, className)
	out := PreviewCSV(csv, "assignments")
	out.Warnings = append(warnings, out.Warnings...)
	return out
}

func strp(s string) *string { return &s }

// BuiltinMappings are the formats Classpad ships, written like user plugins.
var BuiltinMappings = []MappingPlugin{
	{
		PluginVersion: 1, ID: "gradebook-rows", Name: "Gradebook: one row per assignment",
		Description: "Common LMS/gradebook export with columns like Assignment, Score and Points Possible.",
		Kind:        "gradebook-csv", Layout: "long",
		Columns: MappingColumns{
			Title:          []string{"Assignment", "Assignment Name", "Title", "Name", "Item"},
			Class:          []string{"Course", "Class", "Course Name"},
			Due:            []string{"Due", "Due Date", "Due At"},
			Score:          []string{"Score", "Points", "Points Earned", "Earned", "Current Score", "Grade"},
			PointsPossible: []string{"Points Possible", "Out Of", "Max Points", "Total Points", "Possible", "Max"},
			Weight:         []string{"Weight", "Weight %", "Group Weight", "Percent of Grade"},
			Status:         []string{"Status"},
			Type:           []string{"Type", "Category", "Group", "Assignment Group"},
			Notes:          []string{"Comments", "Notes"},
		},
		Wide:        WideOptions{SkipColumns: []string{}, PointsInHeader: true},
		ScoreFormat: "auto", SkipRows: []RowFilter{},
	},
	{
		PluginVersion: 1, ID: "gradebook-columns", Name: "Gradebook: one column per assignment",
		Description: `Wide export where each assignment is a column and your row holds the scores. Points possible may be in the header, e.g. "Essay 1 (50)".`,
		Kind:        "gradebook-csv", Layout: "wide",
		Wide:        WideOptions{SkipColumns: []string{}, PointsInHeader: true},
		ScoreFormat: "auto", SkipRows: []RowFilter{},
	},
}
