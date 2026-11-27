package importers

import (
	"regexp"
	"strconv"
	"strings"
)

// Table is a CSV file read with a header row.
type Table struct {
	Fields []string
	Rows   []Row
}

// Row maps header to cell. A header missing from a short row is absent; cells beyond the header
// are in Extra.
type Row struct {
	Cells map[string]string
	Extra []string
}

// Get is row[key] ?? "".
func (r Row) Get(key string) string { return r.Cells[key] }

// Has reports whether the row has the key (JavaScript: r[key] !== undefined).
func (r Row) Has(key string) bool {
	_, ok := r.Cells[key]
	return ok
}

// Str is `${row[key]}`: "undefined" when the row has no such cell.
func (r Row) Str(key string) string {
	if v, ok := r.Cells[key]; ok {
		return v
	}
	return "undefined"
}

const bom = "\uFEFF"

// ParseCSV reads CSV text the way the TypeScript importers do: papaparse 5.7 with header: true,
// skipEmptyLines: 'greedy' and header cells trimmed, including its guesses of the line ending and
// delimiter.
func ParseCSV(text string) Table {
	text = strings.TrimPrefix(text, bom) // the importer's own BOM strip
	text = strings.TrimPrefix(text, bom) // and papaparse's
	newline := guessLineEndings(text)
	delim, ok := guessDelimiter(text, newline)
	if !ok {
		delim = ","
	}
	data := parseRows(text, delim, newline, 0, true)
	var nonEmpty [][]string
	for _, r := range data {
		if !emptyLine(r) {
			nonEmpty = append(nonEmpty, r)
		}
	}
	t := Table{Fields: []string{}, Rows: []Row{}}
	if len(nonEmpty) == 0 {
		return t
	}
	fields := nonEmpty[0]
	for _, r := range nonEmpty[1:] {
		row := Row{Cells: make(map[string]string, len(fields))}
		for j, v := range r {
			if j >= len(fields) {
				row.Extra = append(row.Extra, v)
			} else {
				row.Cells[fields[j]] = v
			}
		}
		t.Rows = append(t.Rows, row)
	}
	for _, f := range fields {
		if f != "" {
			t.Fields = append(t.Fields, f)
		}
	}
	return t
}

func emptyLine(r []string) bool { return jsTrim(strings.Join(r, "")) == "" }

var quotedSpan = regexp.MustCompile(`(?s)"(.*?)"`)

func guessLineEndings(input string) string {
	input = jsSlice(input, 1024*1024)
	input = quotedSpan.ReplaceAllString(input, "")
	r := strings.Split(input, "\r")
	n := strings.Split(input, "\n")
	nFirst := len(n) > 1 && utf16Len(n[0]) < utf16Len(r[0])
	if len(r) == 1 || nFirst {
		return "\n"
	}
	withN := 0
	for _, x := range r {
		if strings.HasPrefix(x, "\n") {
			withN++
		}
	}
	if float64(withN) >= float64(len(r))/2 {
		return "\r\n"
	}
	return "\r"
}

func guessDelimiter(input, newline string) (string, bool) {
	best := ""
	bestDelta, maxFields := -1, 0.0
	for _, delim := range []string{",", "\t", "|", ";", "\x1e", "\x1f"} {
		delta, sum, empties := 0, 0, 0
		prev := -1
		preview := parseRows(input, delim, newline, 10, false)
		for _, r := range preview {
			if emptyLine(r) {
				empties++
				continue
			}
			n := len(r)
			sum += n
			if prev < 0 {
				prev = n
				continue
			}
			if n > 0 {
				delta += abs(n - prev)
				prev = n
			}
		}
		avg := float64(sum)
		if len(preview) > 0 {
			avg /= float64(len(preview) - empties) // NaN when every line is empty, like JavaScript
		}
		if avg > 1.99 && (bestDelta < 0 || delta < bestDelta || (delta == bestDelta && avg > maxFields)) {
			best, bestDelta, maxFields = delim, delta, avg
		}
	}
	return best, best != ""
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// parseRows is papaparse's Parser.parse. With header, the first row's cells are renamed the way
// papaparse does: BOM stripped, trimmed, and duplicates given _1, _2… suffixes.
func parseRows(input, delim, newline string, preview int, header bool) [][]string {
	var data [][]string
	if input == "" {
		return data
	}
	done := func() [][]string {
		if header && len(data) > 0 {
			renameHeaders(data[0])
		}
		return data
	}
	if !strings.Contains(input, `"`) {
		rows := strings.Split(input, newline)
		for i, row := range rows {
			data = append(data, strings.Split(row, delim))
			if preview > 0 && i >= preview {
				data = data[:preview]
				return done()
			}
		}
		return done()
	}
	idx := func(sub string, from int) int {
		if from > len(input) {
			return -1
		}
		if k := strings.Index(input[from:], sub); k >= 0 {
			return from + k
		}
		return -1
	}
	unescape := func(s string) string { return strings.ReplaceAll(s, `""`, `"`) }
	cursor := 0
	var row []string
	nextDelim := idx(delim, 0)
	nextNewline := idx(newline, 0)
	quoteSearch := idx(`"`, 0)
	extraSpaces := func(index int) int {
		if index == -1 || quoteSearch+1 > index {
			return 0
		}
		between := input[quoteSearch+1 : index]
		if between != "" && jsTrim(between) == "" {
			return len(between)
		}
		return 0
	}
	saveRow := func(newCursor int) {
		cursor = newCursor
		data = append(data, row)
		row = nil
		nextNewline = idx(newline, cursor)
	}
	finish := func(value string, has bool) [][]string {
		if !has {
			value = input[min(cursor, len(input)):]
		}
		row = append(row, value)
		data = append(data, row)
		return done()
	}
	for {
		if cursor < len(input) && input[cursor] == '"' {
			quoteSearch = cursor
			cursor++
			for {
				quoteSearch = idx(`"`, quoteSearch+1)
				if quoteSearch == -1 {
					return finish("", false)
				}
				if quoteSearch == len(input)-1 {
					return finish(unescape(input[cursor:quoteSearch]), true)
				}
				if input[quoteSearch+1] == '"' {
					quoteSearch++
					continue
				}
				if nextDelim != -1 && nextDelim < quoteSearch+1 {
					nextDelim = idx(delim, quoteSearch+1)
				}
				if nextNewline != -1 && nextNewline < quoteSearch+1 {
					nextNewline = idx(newline, quoteSearch+1)
				}
				checkUpTo := nextDelim
				if nextNewline != -1 {
					checkUpTo = min(nextDelim, nextNewline)
				}
				sp := extraSpaces(checkUpTo)
				if at := quoteSearch + 1 + sp; strings.HasPrefix(input[min(at, len(input)):], delim) {
					row = append(row, unescape(input[cursor:quoteSearch]))
					cursor = at + len(delim)
					if cursor >= len(input) || input[cursor] != '"' {
						quoteSearch = idx(`"`, cursor)
					}
					nextDelim = idx(delim, cursor)
					nextNewline = idx(newline, cursor)
					break
				}
				spn := extraSpaces(nextNewline)
				if at := quoteSearch + 1 + spn; strings.HasPrefix(input[min(at, len(input)):], newline) {
					row = append(row, unescape(input[cursor:quoteSearch]))
					saveRow(at + len(newline))
					nextDelim = idx(delim, cursor)
					quoteSearch = idx(`"`, cursor)
					if preview > 0 && len(data) >= preview {
						return done()
					}
					break
				}
				// A stray quote inside a quoted field: keep looking for the real closing quote.
				quoteSearch++
			}
			continue
		}
		if nextDelim != -1 && (nextDelim < nextNewline || nextNewline == -1) {
			row = append(row, input[cursor:nextDelim])
			cursor = nextDelim + len(delim)
			nextDelim = idx(delim, cursor)
			continue
		}
		if nextNewline != -1 {
			row = append(row, input[cursor:nextNewline])
			saveRow(nextNewline + len(newline))
			if preview > 0 && len(data) >= preview {
				return done()
			}
			continue
		}
		break
	}
	return finish("", false)
}

// renameHeaders applies papaparse 5.7's header handling to the first row.
func renameHeaders(result []string) {
	count := map[string]int{}
	used := map[string]bool{}
	for _, h := range result {
		used[h] = true
	}
	for i := range result {
		h := strings.TrimPrefix(result[i], bom)
		h = jsTrim(h)
		if count[h] == 0 {
			count[h] = 1
			result[i] = h
		} else {
			n := count[h]
			var nh string
			for {
				nh = h + "_" + strconv.Itoa(n)
				n++
				if !used[nh] {
					break
				}
			}
			used[nh] = true
			result[i] = nh
			count[h]++
		}
		used[h] = true
	}
}

// ToCSV writes rows for spreadsheets, neutralizing formulas (a leading = + - @ tab or CR gets a
// quote mark) unless the value is a plain number.
func ToCSV(headers []string, rows []map[string]string) string {
	cell := func(s string) string {
		if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) && !plainNumber.MatchString(s) {
			s = "'" + s
		}
		if strings.ContainsAny(s, "\",\n\r") {
			return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
		}
		return s
	}
	var b strings.Builder
	b.WriteString(strings.Join(headers, ","))
	for _, r := range rows {
		b.WriteString("\r\n")
		for i, h := range headers {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(cell(r[h]))
		}
	}
	b.WriteString("\r\n")
	return b.String()
}

var plainNumber = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// unparse is Papa.unparse with its defaults: quotes only when needed, CRLF between rows, no
// trailing newline.
func unparse(fields []string, rows [][]string) string {
	quote := func(s string) string {
		if s == "" {
			return s
		}
		if strings.ContainsAny(s, "\",\r\n") || s[0] == ' ' || s[len(s)-1] == ' ' || strings.Contains(s, bom) {
			return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
		}
		return s
	}
	lines := make([]string, 0, len(rows)+1)
	head := make([]string, len(fields))
	for i, f := range fields {
		head[i] = quote(f)
	}
	lines = append(lines, strings.Join(head, ","))
	if len(rows) == 0 {
		// papaparse wraps an empty data list as one empty row: the header, then a line break.
		return lines[0] + "\r\n"
	}
	for _, r := range rows {
		cells := make([]string, len(r))
		for i, c := range r {
			cells[i] = quote(c)
		}
		lines = append(lines, strings.Join(cells, ","))
	}
	return strings.Join(lines, "\r\n")
}
