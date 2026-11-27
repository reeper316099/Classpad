package importers

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Local is the time zone calendar times in UTC are shown in (the computer's own). Tests set it.
var Local = time.Local

// ---------------- reading (what ical.js does for the parts Classpad uses) ----------------

type icsProp struct {
	name   string // lowercase
	params map[string]string
	value  string
}

type icsComp struct {
	name  string // lowercase
	props []icsProp
	comps []*icsComp
}

func (c *icsComp) first(name string) *icsProp {
	for i := range c.props {
		if c.props[i].name == name {
			return &c.props[i]
		}
	}
	return nil
}

// icsLines unfolds content lines exactly like ical.js's _eachLine: a line starting with a space or
// tab continues the one before it, empty lines are dropped, and only the last line is trimmed.
func icsLines(buf string) []string {
	lastPos := strings.IndexFunc(buf, func(r rune) bool { return r != ' ' && r != '\t' })
	if lastPos < 0 {
		return nil
	}
	var out []string
	line := ""
	for {
		pos := strings.IndexByte(buf[lastPos:], '\n')
		offset := 1
		if pos < 0 {
			pos, offset = len(buf), 0
		} else {
			pos += lastPos + 1
			if pos > 1 && buf[pos-2] == '\r' {
				offset = 2
			}
		}
		end := max(pos-offset, lastPos)
		if c := buf[lastPos]; c == ' ' || c == '\t' {
			line += buf[min(lastPos+1, end):end]
		} else {
			if line != "" {
				out = append(out, line)
			}
			line = buf[lastPos:end]
		}
		lastPos = pos
		if pos == len(buf) {
			break
		}
	}
	if t := jsTrim(line); t != "" {
		out = append(out, t)
	}
	return out
}

// parseICS builds the component tree, failing like ical.js does on lines it can't read.
func parseICS(text string) (*icsComp, error) {
	root := &icsComp{}
	stack := []*icsComp{root}
	for _, line := range icsLines(text) {
		colon := strings.IndexByte(line, ':')
		semi := strings.IndexByte(line, ';')
		if semi != -1 && colon != -1 && semi > colon {
			semi = -1
		}
		var name, value string
		params := map[string]string{}
		switch {
		case semi != -1:
			name = strings.ToLower(line[:semi])
			rest := line[semi:]
			i := 0
			for i < len(rest) && rest[i] == ';' {
				i++
				eq := strings.IndexByte(rest[i:], '=')
				if eq < 0 {
					return nil, fmt.Errorf("Invalid parameters in '%s'", line)
				}
				pname := strings.ToLower(rest[i : i+eq])
				i += eq + 1
				var pval string
				if i < len(rest) && rest[i] == '"' {
					q := strings.IndexByte(rest[i+1:], '"')
					if q < 0 {
						return nil, fmt.Errorf(`invalid line (no matching double quote) "%s"`, line)
					}
					pval = rest[i+1 : i+1+q]
					i += q + 2
				} else {
					e := strings.IndexAny(rest[i:], ";:")
					if e < 0 {
						return nil, fmt.Errorf("Missing parameter value in '%s'", line)
					}
					pval = rest[i : i+e]
					i += e
				}
				params[pname] = pval
			}
			if i >= len(rest) || rest[i] != ':' {
				return nil, fmt.Errorf("Missing parameter value in '%s'", line)
			}
			value = rest[i+1:]
		case colon != -1:
			name = strings.ToLower(line[:colon])
			value = line[colon+1:]
			switch name {
			case "begin":
				c := &icsComp{name: strings.ToLower(value)}
				parent := stack[len(stack)-1]
				parent.comps = append(parent.comps, c)
				stack = append(stack, c)
				continue
			case "end":
				if len(stack) == 1 {
					return nil, errors.New("END without BEGIN")
				}
				stack = stack[:len(stack)-1]
				continue
			}
		default:
			return nil, fmt.Errorf(`invalid line (no token ";" or ":") "%s"`, line)
		}
		cur := stack[len(stack)-1]
		cur.props = append(cur.props, icsProp{name: name, params: params, value: value})
	}
	if len(stack) > 1 {
		return nil, errors.New("invalid ical body. component began but did not end")
	}
	return root, nil
}

var textEscape = regexp.MustCompile(`\\([\\;,nN])`)

// icsText decodes a TEXT value.
func icsText(v string) string {
	return textEscape.ReplaceAllStringFunc(v, func(m string) string {
		if m[1] == 'n' || m[1] == 'N' {
			return "\n"
		}
		return m[1:]
	})
}

type icsTime struct {
	t      time.Time // wall time in UTC location
	isDate bool
	utc    bool
}

var errICSValue = errors.New("invalid date-time value")

func atoiStrict(s string) (int, bool) {
	n, err := strconv.Atoi(s)
	return n, err == nil
}

// icsTimeOf reads DTSTART/DTEND like ical.js: VALUE=DATE is a date; a trailing Z, or TZID UTC/Z/GMT,
// means UTC.
func icsTimeOf(p *icsProp) (icsTime, error) {
	v := p.value
	// ical.js parses calendars strictly: only VALUE=DATE makes a date (its first 8 characters); a
	// date-time shorter than YYYYMMDDTHHMMSS is an error that stops the whole import.
	if strings.EqualFold(p.params["value"], "date") {
		if len(v) < 8 {
			return icsTime{}, errICSValue
		}
		y, ok1 := atoiStrict(v[0:4])
		m, ok2 := atoiStrict(v[4:6])
		d, ok3 := atoiStrict(v[6:8])
		if !ok1 || !ok2 || !ok3 {
			return icsTime{}, errICSValue
		}
		return icsTime{t: time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC), isDate: true}, nil
	}
	if len(v) < 15 {
		return icsTime{}, errICSValue
	}
	nums := []string{v[0:4], v[4:6], v[6:8], v[9:11], v[11:13], v[13:15]}
	var n [6]int
	for i, s := range nums {
		x, ok := atoiStrict(s)
		if !ok {
			return icsTime{}, errICSValue
		}
		n[i] = x
	}
	tzid := p.params["tzid"]
	utc := len(v) > 15 && v[15] == 'Z' || tzid == "UTC" || tzid == "Z" || tzid == "GMT"
	return icsTime{t: time.Date(n[0], time.Month(n[1]), n[2], n[3], n[4], n[5], 0, time.UTC), utc: utc}, nil
}

var durationRe = regexp.MustCompile(`^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$`)

func addICSDuration(t icsTime, d string) icsTime {
	m := durationRe.FindStringSubmatch(strings.TrimSpace(d))
	if m == nil {
		return t
	}
	sign := 1
	if m[1] == "-" {
		sign = -1
	}
	w, _ := strconv.Atoi(m[2])
	days, _ := strconv.Atoi(m[3])
	h, _ := strconv.Atoi(m[4])
	mi, _ := strconv.Atoi(m[5])
	s, _ := strconv.Atoi(m[6])
	x := t.t
	t.t = time.Date(x.Year(), x.Month(), x.Day()+sign*(days+7*w), x.Hour()+sign*h, x.Minute()+sign*mi, x.Second()+sign*s, 0, time.UTC)
	return t
}

func (t icsTime) iso() string {
	x := t.t
	if t.isDate {
		return fmt.Sprintf("%d-%s-%s", x.Year(), padStart2(int(x.Month())), padStart2(x.Day()))
	}
	if t.utc {
		x = x.In(Local) // shown in local wall time
	}
	return fmt.Sprintf("%d-%s-%sT%s:%s", x.Year(), padStart2(int(x.Month())), padStart2(x.Day()), padStart2(x.Hour()), padStart2(x.Minute()))
}

// ICSOptions: events become tasks (the default) or assignments of a named class.
type ICSOptions struct {
	As        string `json:"as,omitempty"` // "tasks" or "assignments"
	ClassName string `json:"className,omitempty"`
}

// ErrICS is returned for calendars the TypeScript importer could not read at all (it threw).
var ErrICS = errors.New("calendar could not be read")

// PreviewICS turns calendar events into tasks or assignments. Recurring events import once.
func PreviewICS(text string, o ICSOptions) (*ImportPreview, error) {
	out := emptyPreview("ics")
	root, err := parseICS(text)
	if err != nil {
		out.warn("ICS_PARSE", "Could not read calendar: "+err.Error(), "")
		return out, nil
	}
	if len(root.comps) != 1 {
		return nil, ErrICS // ical.js can't build a component from this
	}
	cal := root.comps[0]
	as := o.As
	if as == "" {
		as = "tasks"
	}
	seen := newRefSet()
	recurring := 0
	for _, ev := range cal.comps {
		if ev.name != "vevent" {
			continue
		}
		summary := ""
		if p := ev.first("summary"); p != nil {
			summary = icsText(p.value)
		}
		title := jsTrim(summary)
		if title == "" {
			out.warn("EMPTY_EVENT", "Event without a title skipped", "")
			continue
		}
		uid := title
		if p := ev.first("uid"); p != nil && icsText(p.value) != "" {
			uid = icsText(p.value)
		}
		var start, end string
		var st *icsTime
		if p := ev.first("dtstart"); p != nil {
			t, err := icsTimeOf(p)
			if err != nil {
				return nil, ErrICS
			}
			st = &t
			start = t.iso()
		}
		switch p := ev.first("dtend"); {
		case p != nil:
			t, err := icsTimeOf(p)
			if err != nil {
				return nil, ErrICS
			}
			end = t.iso()
		case st == nil:
			return nil, ErrICS // ical.js: no start to compute the end from
		default:
			e := *st
			if d := ev.first("duration"); d != nil {
				e = addICSDuration(e, d.value)
			} else if e.isDate {
				e.t = e.t.AddDate(0, 0, 1)
			}
			end = e.iso()
		}
		due := start
		if start != "" && end != "" && end != start && strings.Contains(start, "T") {
			due = start + "/" + end
		}
		if ev.first("rrule") != nil {
			recurring++
		}
		ref := seen.unique("ics:" + as + ":" + NormTitle(uid))
		description := ""
		if p := ev.first("description"); p != nil {
			description = jsTrim(icsText(p.value))
		}
		if o.As == "assignments" {
			a := DraftAssignment{Ref: ref, Title: title, Type: []string{}, Status: "not_started", Due: due,
				QuickNotes: description, FilePaths: []string{}}
			if o.ClassName != "" {
				a.ClassRef = NameRef("class", o.ClassName)
			}
			out.Assignments = append(out.Assignments, a)
		} else {
			out.Tasks = append(out.Tasks, DraftTask{Ref: ref, Title: title, Date: due, Priority: "medium"})
		}
	}
	if recurring > 0 {
		out.warn("RECURRING", fmt.Sprintf("%d recurring event(s) were imported once (first occurrence only)", recurring), "")
	}
	return out, nil
}

// ---------------- writing ----------------

func icsEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	// The TypeScript writer's ';' escape is a no-op ('\;' is just ';' in JavaScript); kept as is.
	s = strings.ReplaceAll(s, ",", `\,`)
	return crlfOrLF.ReplaceAllString(s, `\n`)
}

var crlfOrLF = regexp.MustCompile(`\r?\n`)

// Fold folds a content line at 75 octets (RFC 5545), never splitting a UTF-8 character.
func Fold(line string) string {
	if len(line) <= 75 {
		return line
	}
	var out []string
	cur, bytes := "", 0
	for _, r := range line {
		n := len(string(r))
		if bytes+n > 75 {
			out = append(out, cur)
			cur, bytes = " ", 1
		}
		cur += string(r)
		bytes += n
	}
	out = append(out, cur)
	return strings.Join(out, "\r\n")
}

type ICSDeadline struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Due       string `json:"due"`
	ClassName string `json:"className,omitempty"`
	Notes     string `json:"notes,omitempty"`
}

type ICSMeeting struct {
	ClassID   string  `json:"classId"`
	ClassName string  `json:"className"`
	Day       Weekday `json:"day"`
	Start     string  `json:"start"`
	End       string  `json:"end"`
	Location  string  `json:"location,omitempty"`
	From      string  `json:"from"`
	Until     string  `json:"until"`
}

var byDay = map[string]string{"mon": "MO", "tue": "TU", "wed": "WE", "thu": "TH", "fri": "FR", "sat": "SA", "sun": "SU"}

func compactISO(s string) string { return strings.NewReplacer("-", "", ":", "").Replace(s) }

func nextDay(d string) string {
	t, err := time.Parse("2006-01-02", d)
	if err != nil {
		return d
	}
	return t.AddDate(0, 0, 1).Format("2006-01-02")
}

// BuildICS writes deadlines (all-day or timed) and weekly class meetings as a calendar.
func BuildICS(deadlines []ICSDeadline, meetings []ICSMeeting, now time.Time, name string) string {
	stamp := now.UTC().Format("20060102T150405Z")
	if name == "" {
		name = "Classpad"
	}
	L := []string{"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Classpad//Export//EN", "CALSCALE:GREGORIAN",
		"X-WR-CALNAME:" + icsEscape(name)}
	for _, d := range deadlines {
		a, b, hasB := strings.Cut(d.Due, "/")
		L = append(L, "BEGIN:VEVENT", "UID:"+d.ID+"@classpad", "DTSTAMP:"+stamp, "SUMMARY:"+icsEscape(d.Title))
		if strings.Contains(a, "T") {
			endV := a
			if hasB {
				endV = b
			}
			L = append(L, "DTSTART:"+compactISO(a)+"00", "DTEND:"+compactISO(endV)+"00")
		} else {
			endV := nextDay(a)
			if hasB {
				endV = nextDay(b)
			}
			L = append(L, "DTSTART;VALUE=DATE:"+compactISO(a), "DTEND;VALUE=DATE:"+compactISO(endV))
		}
		var desc []string
		if d.ClassName != "" {
			desc = append(desc, "Class: "+d.ClassName)
		}
		if d.Notes != "" {
			desc = append(desc, d.Notes)
		}
		if len(desc) > 0 {
			L = append(L, "DESCRIPTION:"+icsEscape(strings.Join(desc, "\n")))
		}
		if d.ClassName != "" {
			L = append(L, "CATEGORIES:"+icsEscape(d.ClassName))
		}
		L = append(L, "END:VEVENT")
	}
	dow := []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}
	for _, m := range meetings {
		first, err := time.Parse("2006-01-02", m.From)
		if err != nil {
			continue
		}
		for i := 0; i < 7 && dow[first.Weekday()] != m.Day; i++ {
			first = first.AddDate(0, 0, 1)
		}
		day := first.Format("20060102")
		L = append(L, "BEGIN:VEVENT",
			"UID:"+m.ClassID+"-"+m.Day+"-"+strings.Replace(m.Start, ":", "", 1)+"@classpad",
			"DTSTAMP:"+stamp, "SUMMARY:"+icsEscape(m.ClassName),
			"DTSTART:"+day+"T"+strings.Replace(m.Start, ":", "", 1)+"00",
			"DTEND:"+day+"T"+strings.Replace(m.End, ":", "", 1)+"00",
			"RRULE:FREQ=WEEKLY;BYDAY="+byDay[m.Day]+";UNTIL="+compactISO(m.Until)+"T235959")
		if m.Location != "" {
			L = append(L, "LOCATION:"+icsEscape(m.Location))
		}
		L = append(L, "END:VEVENT")
	}
	L = append(L, "END:VCALENDAR")
	for i := range L {
		L[i] = Fold(L[i])
	}
	return strings.Join(L, "\r\n") + "\r\n"
}
