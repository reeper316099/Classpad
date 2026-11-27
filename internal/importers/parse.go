package importers

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Small, pure parsers for the messy cell formats found in database exports (packages/importers
// parse.ts).

type Weekday = string

var weekdays = []Weekday{"mon", "tue", "wed", "thu", "fri", "sat", "sun"}

func weekdayIndex(d Weekday) int {
	for i, w := range weekdays {
		if w == d {
			return i
		}
	}
	return -1
}

var dayAliases = map[string]Weekday{
	"mon": "mon", "monday": "mon", "m": "mon",
	"tue": "tue", "tues": "tue", "tuesday": "tue",
	"wed": "wed", "weds": "wed", "wednesday": "wed",
	"thu": "thu", "thur": "thu", "thurs": "thu", "thursday": "thu",
	"fri": "fri", "friday": "fri",
	"sat": "sat", "saturday": "sat",
	"sun": "sun", "sunday": "sun",
}

func ParseDay(s string) Weekday {
	return dayAliases[strings.NewReplacer(".", "", ":", "").Replace(strings.ToLower(jsTrim(s)))]
}

var daySep = regexp.MustCompile(`(?i)[,;/&]|\band\b`)

func ParseDays(cell string) []Weekday {
	seen := map[Weekday]bool{}
	out := []Weekday{}
	for _, p := range daySep.Split(cell, -1) {
		if d := ParseDay(p); d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return weekdayIndex(out[i]) < weekdayIndex(out[j]) })
	return out
}

var percentRe = jsRe(`^(-?\d+(?:\.\d+)?)\s*%?$`)

// ParsePercent reads "20%", "20" or " 0.5 % " as a number of percent; nil when blank or unreadable.
func ParsePercent(cell string) *float64 {
	s := strings.ReplaceAll(jsTrim(cell), ",", "")
	if s == "" {
		return nil
	}
	m := percentRe.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	return &f
}

// ParseNumber is Number(cell) for a non-blank, finite cell (commas ignored), else nil.
func ParseNumber(cell string) *float64 {
	s := strings.ReplaceAll(jsTrim(cell), ",", "")
	if s == "" {
		return nil
	}
	f := jsNumber(s)
	if !isFinite(f) {
		return nil
	}
	return &f
}

var boolRe = regexp.MustCompile(`(?i)^(yes|true|checked|x|1)$`)

func ParseBool(cell string) bool { return boolRe.MatchString(jsTrim(cell)) }

// ---------------- dates ----------------

var months = []string{"january", "february", "march", "april", "may", "june", "july", "august",
	"september", "october", "november", "december"}

// ParsedDate is an ISO date (YYYY-MM-DD) or local date-time (YYYY-MM-DDTHH:mm), maybe a range.
type ParsedDate struct {
	Start         string
	End           string
	HasTime       bool
	TimezoneLabel string
	tzSet         bool // a label was given, even an empty one "()"
}

var (
	tzSuffix  = jsRe(`\s*\(([^)]*)\)\s*$`)
	isoDate   = jsRe(`^(\d{4})-(\d{2})-(\d{2})(?:[T\s](.*))?$`)
	ymdSlash  = jsRe(`^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(.*)$`)
	mdySlash  = jsRe(`^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)$`)
	monthName = jsRe(`^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s*(.*)$`)
	clockTime = jsRe(`(?i)^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?$`)
	rangeSep  = jsRe(`\s*(?:→|->|—|–)\s*`)
)

type oneDate struct {
	iso     string
	hasTime bool
	tz      string
	hasTZ   bool
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func parseOne(raw string) *oneDate {
	s := jsTrim(raw)
	if s == "" {
		return nil
	}
	var tz string
	hasTZ := false
	if loc := tzSuffix.FindStringSubmatchIndex(s); loc != nil {
		tz, hasTZ = s[loc[2]:loc[3]], true
		s = jsTrim(s[:loc[0]])
	}
	var y, mo, d int
	rest := ""
	if m := isoDate.FindStringSubmatch(s); m != nil {
		y, mo, d, rest = atoi(m[1]), atoi(m[2]), atoi(m[3]), m[4]
	} else if m := ymdSlash.FindStringSubmatch(s); m != nil {
		y, mo, d, rest = atoi(m[1]), atoi(m[2]), atoi(m[3]), m[4]
	} else if m := mdySlash.FindStringSubmatch(s); m != nil {
		mo, d, y, rest = atoi(m[1]), atoi(m[2]), atoi(m[3]), m[4]
	} else if m := monthName.FindStringSubmatch(s); m != nil {
		name := strings.ToLower(m[1])
		idx := -1
		for i, n := range months {
			// JavaScript: n.startsWith(name.slice(0, 3)) && n.startsWith(name.slice(0, max(3, len))),
			// which is n.startsWith(name).
			if strings.HasPrefix(n, name) {
				idx = i
				break
			}
		}
		if idx < 0 {
			return nil
		}
		mo, d, y, rest = idx+1, atoi(m[2]), atoi(m[3]), m[4]
	} else {
		return nil
	}
	if mo < 1 || mo > 12 || d < 1 || d > 31 {
		return nil
	}
	date := strconv.Itoa(y) + "-" + padStart2(mo) + "-" + padStart2(d)
	rest = jsTrim(rest)
	t := clockTime.FindStringSubmatch(rest)
	if rest == "" || t == nil {
		return &oneDate{iso: date, tz: tz, hasTZ: hasTZ}
	}
	h := atoi(t[1])
	mer := strings.ToLower(t[3])
	if mer == "p" && h < 12 {
		h += 12
	}
	if mer == "a" && h == 12 {
		h = 0
	}
	return &oneDate{iso: date + "T" + padStart2(h) + ":" + t[2], hasTime: true, tz: tz, hasTZ: hasTZ}
}

// ParseNotionDate reads "August 28, 2026", "… 3:00 PM (EST)", ISO, US numeric dates and "A → B"
// ranges.
func ParseNotionDate(cell string) *ParsedDate {
	s := jsTrim(cell)
	if s == "" {
		return nil
	}
	parts := rangeSep.Split(s, -1)
	a := parseOne(parts[0])
	if a == nil {
		return nil
	}
	var b *oneDate
	if len(parts) > 1 && parts[1] != "" {
		b = parseOne(parts[1])
	}
	p := &ParsedDate{Start: a.iso, HasTime: a.hasTime}
	if b != nil {
		p.End = b.iso
		p.HasTime = p.HasTime || b.hasTime
	}
	switch {
	case a.hasTZ:
		p.TimezoneLabel, p.tzSet = a.tz, true
	case b != nil && b.hasTZ:
		p.TimezoneLabel, p.tzSet = b.tz, true
	}
	return p
}

// FormatInterval is the due-date convention: one value, or "start/end".
func FormatInterval(d *ParsedDate) string {
	if d.End != "" {
		return d.Start + "/" + d.End
	}
	return d.Start
}

// ---------------- times ----------------

type Meeting struct {
	Day   Weekday `json:"day"`
	Start string  `json:"start"`
	End   string  `json:"end"`
}

var timeRange = jsRe(`(?i)(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?`)

// ParseTimeRange reads "11:50a-1:10p", "9-10:15", "11-1p"… as 24-hour start and end.
func ParseTimeRange(s string) (start, end string, ok bool) {
	m := timeRange.FindStringSubmatch(s)
	if m == nil {
		return "", "", false
	}
	sh, sm, eh, em := atoi(m[1]), atoi(m[2]), atoi(m[4]), atoi(m[5])
	sMer, eMer := strings.ToLower(m[3]), strings.ToLower(m[6])
	to24 := func(h int, mer string) int {
		switch mer {
		case "p":
			return h%12 + 12
		case "a":
			return h % 12
		}
		return h
	}
	if sh > 24 || eh > 24 || sm > 59 || em > 59 {
		return "", "", false
	}
	endH := to24(eh, eMer)
	startMer := sMer
	if startMer == "" {
		startMer = eMer
	}
	startH := to24(sh, startMer)
	if sMer == "" && eMer == "" && sh <= 12 && eh <= 12 && startH >= endH {
		// ambiguous 12-hour times without am/pm
		if eh < 8 {
			endH = eh + 12
		} else {
			endH = eh
		}
	}
	// "11-1p": the inferred start (pm) lands after the end, so it must be am
	if sMer == "" && startH*60+sm >= endH*60+em && sh <= 12 {
		startH = sh % 12
	}
	return padStart2(startH) + ":" + padStart2(sm), padStart2(endH) + ":" + padStart2(em), true
}

var (
	timeLineSep = regexp.MustCompile(`\r?\n|;`)
	leadingDay  = jsRe(`^([A-Za-z]+)\.?\s*[:,-]?\s*(.*)$`)
)

// ParseTimes reads one compact range for every day, or one line per day ("Mon 10:00 AM - 11:15 AM").
func ParseTimes(times string, days []Weekday) ([]Meeting, []string) {
	warnings := []string{}
	meetings := []Meeting{}
	type rng struct{ start, end string }
	var unprefixed []rng
	for _, l := range timeLineSep.Split(times, -1) {
		line := jsTrim(l)
		if line == "" {
			continue
		}
		lead := ""
		body := line
		if m := leadingDay.FindStringSubmatch(line); m != nil {
			if lead = ParseDay(m[1]); lead != "" {
				body = m[2]
			}
		}
		st, en, ok := ParseTimeRange(body)
		if !ok {
			warnings = append(warnings, `Could not read time "`+line+`"`)
			continue
		}
		if lead != "" {
			meetings = append(meetings, Meeting{lead, st, en})
		} else {
			unprefixed = append(unprefixed, rng{st, en})
		}
	}
	switch {
	case len(unprefixed) == 1:
		if len(days) == 0 {
			warnings = append(warnings, "Time given without any days")
		}
		for _, d := range days {
			meetings = append(meetings, Meeting{d, unprefixed[0].start, unprefixed[0].end})
		}
	case len(unprefixed) > 1:
		if len(unprefixed) == len(days) {
			warnings = append(warnings, "Several time lines paired to days by weekday order")
			for i, d := range days {
				meetings = append(meetings, Meeting{d, unprefixed[i].start, unprefixed[i].end})
			}
		} else {
			warnings = append(warnings, strconv.Itoa(len(unprefixed))+" time lines but "+strconv.Itoa(len(days))+" days; could not pair")
		}
	}
	sort.SliceStable(meetings, func(i, j int) bool {
		a, b := meetings[i], meetings[j]
		if x, y := weekdayIndex(a.Day), weekdayIndex(b.Day); x != y {
			return x < y
		}
		return a.Start < b.Start
	})
	return meetings, warnings
}

// ---------------- options ----------------

func isInvisible(r rune) bool {
	return r >= 0x200b && r <= 0x200f || r >= 0x202a && r <= 0x202f || r >= 0x2060 && r <= 0x2069 ||
		r == 0xa0 || r == 0x2007 || r == 0xfeff || r == 0xad
}

// CleanLabel turns invisible direction marks and odd spaces into spaces, collapses runs of
// whitespace and trims.
func CleanLabel(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if isInvisible(r) || isJSSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// lettersLower keeps only letters, lowercased (the option words the normalizers match on).
func lettersLower(cell string) string {
	var b strings.Builder
	for _, r := range CleanLabel(cell) {
		if isLetter(r) {
			b.WriteRune(r)
		}
	}
	return strings.ToLower(b.String())
}

// Priority is important, mid or low, with the cleaned label the export used.
type Priority struct {
	Value string
	Label string
}

var (
	priImportant = regexp.MustCompile(`^(important|high|urgent|critical)`)
	priMid       = regexp.MustCompile(`^(mid|medium|normal|moderate)`)
	priLow       = regexp.MustCompile(`^(low|minor|someday)`)
)

func NormalizePriority(cell string) *Priority {
	label := CleanLabel(cell)
	if label == "" {
		return nil
	}
	w := lettersLower(label)
	switch {
	case priImportant.MatchString(w):
		return &Priority{"important", label}
	case priMid.MatchString(w):
		return &Priority{"mid", label}
	case priLow.MatchString(w):
		return &Priority{"low", label}
	}
	return nil
}

var (
	asgDone     = regexp.MustCompile(`^(complete|completed|done|finished|submitted|graded|turnedin|handedin|sent)`)
	asgDoing    = regexp.MustCompile(`^(inprogress|doing|started|working|wip|ongoing|drafting|inreview|review|active)`)
	asgTodo     = regexp.MustCompile(`^(notstarted|todo|backlog|planned|pending|upcoming|new|late|overdue|missing|open)`)
	readDone    = regexp.MustCompile(`^(complete|completed|done|finished|read)$`)
	readReading = regexp.MustCompile(`^(reading|inprogress|started|current|currentlyreading|ongoing)`)
	readTodo    = regexp.MustCompile(`^(toread|notstarted|todo|wantto|wishlist|queued|backlog|planned|unread)`)
)

// NormalizeAssignmentStatus maps Notion's many status wordings; known is false for anything else.
func NormalizeAssignmentStatus(cell string) (value string, known bool) {
	w := lettersLower(cell)
	switch {
	case w == "":
		return "not_started", true
	case asgDone.MatchString(w):
		return "complete", true
	case asgDoing.MatchString(w):
		return "in_progress", true
	case asgTodo.MatchString(w):
		return "not_started", true
	}
	return "not_started", false
}

func NormalizeReadingStatus(cell string) (value string, known bool) {
	w := lettersLower(cell)
	switch {
	case w == "":
		return "to_read", true
	case readDone.MatchString(w):
		return "complete", true
	case readReading.MatchString(w):
		return "reading", true
	case readTodo.MatchString(w):
		return "to_read", true
	}
	return "to_read", false
}

func NormalizeTaskPriority(cell string) string {
	p := NormalizePriority(cell)
	if p == nil {
		return ""
	}
	switch p.Value {
	case "important":
		return "high"
	case "mid":
		return "medium"
	}
	return "low"
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// SlugOption: "In-Class" → in_class, "Group Project" → group_project.
func SlugOption(s string) string {
	return strings.Trim(nonAlnum.ReplaceAllString(strings.ToLower(CleanLabel(s)), "_"), "_")
}

func SplitMulti(cell string) []string {
	out := []string{}
	for _, p := range strings.Split(cell, ",") {
		if c := CleanLabel(p); c != "" {
			out = append(out, c)
		}
	}
	return out
}

// ---------------- relations ----------------

type RelationRef struct {
	Title string
	Path  string
	ID    string
	URL   string
}

var (
	relationLink   = jsRe(`\(([^()]*?\.md|https?:\/\/[^()\s]*)\)`)
	leadingSpComma = jsRe(`^[\s,]+`)
	pathID         = regexp.MustCompile(`([0-9a-f]{32})(?:\.md)?$`)
	isURL          = regexp.MustCompile(`(?i)^https?:`)
)

// urlID is /([0-9a-f]{32})(?=[?#]|$)/: the first 32-hex run followed by ?, # or the end.
func urlID(s string) string {
	isHex := func(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' }
	for i := 0; i+32 <= len(s); i++ {
		ok := true
		for k := i; k < i+32; k++ {
			if !isHex(s[k]) {
				ok = false
				break
			}
		}
		if ok && (i+32 == len(s) || s[i+32] == '?' || s[i+32] == '#') {
			return s[i : i+32]
		}
	}
	return ""
}

// ParseRelation reads `Title (url%20encoded/path.md), Other (path.md)`, or a plain comma list.
func ParseRelation(cell string) []RelationRef {
	s := jsTrim(cell)
	if s == "" {
		return nil
	}
	var out []RelationRef
	last := 0
	for _, m := range relationLink.FindAllStringSubmatchIndex(s, -1) {
		title := jsTrim(leadingSpComma.ReplaceAllString(s[last:m[0]], ""))
		p := s[m[2]:m[3]]
		last = m[1]
		if isURL.MatchString(p) {
			out = append(out, RelationRef{Title: title, URL: p, ID: urlID(p)})
			continue
		}
		if dec, ok := decodeURIComponent(p); ok {
			p = dec
		}
		id := ""
		if mm := pathID.FindStringSubmatch(p); mm != nil {
			id = mm[1]
		}
		out = append(out, RelationRef{Title: title, Path: p, ID: id})
	}
	if len(out) == 0 {
		for _, t := range strings.Split(s, ",") {
			if t = jsTrim(t); t != "" {
				out = append(out, RelationRef{Title: t})
			}
		}
	}
	return out
}

// NormTitle is a title reduced for matching: lowercase ASCII letters and digits, single spaces.
func NormTitle(s string) string {
	t := norm.NFKD.String(strings.ToLower(CleanLabel(s)))
	t = strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, t)
	return strings.TrimSpace(nonAlnum.ReplaceAllString(t, " "))
}

var nameWithID = jsRe(`^(.*?)\s*([0-9a-f]{32})(.*)$`)

// SplitName splits "Name 0123…(32 hex)<suffix>" file names.
func SplitName(file string) (base, id, suffix string) {
	if m := nameWithID.FindStringSubmatch(file); m != nil {
		return m[1], m[2], m[3]
	}
	return file, "", ""
}
