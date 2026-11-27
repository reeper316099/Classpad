// Package frontmatter writes YAML front matter exactly like the TypeScript code's
// stringifyFrontmatter (the npm "yaml" package, core schema, no line folding), so notes saved by
// the Go server are byte for byte what the TypeScript server wrote.
package frontmatter

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/reeper316099/classpad/internal/importers"
	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
)

// Parse reads a leading `---` YAML block (see importers.ParseFrontmatter).
func Parse(text string) (importers.Frontmatter, error) { return importers.ParseFrontmatter(text) }

// Stringify is stringifyFrontmatter(content, data): `---\n<yaml>---\n<content, ending in a newline>`.
func Stringify(content string, data *jsv.Obj) string {
	body := content
	if !strings.HasSuffix(content, "\n") && content != "" {
		body += "\n"
	}
	return "---\n" + Document(clean(data)) + "---\n" + body
}

// clean is JSON.parse(JSON.stringify(data)): undefined values go.
func clean(o *jsv.Obj) *jsv.Obj {
	v, err := jsv.Parse(jsv.Stringify(o, ""))
	if err != nil {
		return jsv.NewObj()
	}
	c, _ := v.(*jsv.Obj)
	if c == nil {
		return jsv.NewObj()
	}
	return c
}

// Document writes a mapping as a YAML document (with a final newline).
func Document(o *jsv.Obj) string {
	if o.Len() == 0 {
		return "{}\n"
	}
	var lines []string
	for _, k := range o.Keys() {
		lines = append(lines, pair(k, o.Get(k), ""))
	}
	return strings.Join(lines, "\n") + "\n"
}

func pair(key string, v any, indent string) string {
	k := scalarString(key, true, indent)
	inner := indent + "  "
	switch x := v.(type) {
	case []any:
		if len(x) == 0 {
			return indent + k + ": []"
		}
		var b strings.Builder
		b.WriteString(indent + k + ":")
		for _, e := range x {
			b.WriteString("\n" + inner + "- " + item(e, inner+"  "))
		}
		return b.String()
	case *jsv.Obj:
		if x.Len() == 0 {
			return indent + k + ": {}"
		}
		var b strings.Builder
		b.WriteString(indent + k + ":")
		for _, kk := range x.Keys() {
			b.WriteString("\n" + pair(kk, x.Get(kk), inner))
		}
		return b.String()
	}
	return indent + k + ": " + scalar(v, inner)
}

// item writes a sequence entry's value (after "- ").
func item(v any, indent string) string {
	switch x := v.(type) {
	case []any:
		if len(x) == 0 {
			return "[]"
		}
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = "- " + item(e, indent+"  ")
		}
		return strings.Join(parts, "\n"+indent)
	case *jsv.Obj:
		if x.Len() == 0 {
			return "{}"
		}
		var lines []string
		for i, k := range x.Keys() {
			p := pair(k, x.Get(k), indent)
			if i == 0 {
				p = strings.TrimPrefix(p, indent)
			}
			lines = append(lines, p)
		}
		return strings.Join(lines, "\n")
	}
	return scalar(v, indent)
}

func scalar(v any, indent string) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsonstore.JSNumber(x)
	case string:
		return scalarString(x, false, indent)
	}
	return "null"
}

var (
	forceDouble   = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f-\x{9f}]`)
	notPlain      = regexp.MustCompile("^[\n\t ,\\[\\]{}#&*!|>'\"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$")
	docMarker     = regexp.MustCompile(`(?m)^(%|---|\.\.\.)`)
	wsAroundBreak = regexp.MustCompile(`[ \t]\n|\n[ \t]`)
	breakAtEnd    = regexp.MustCompile(`\n[\t ]+$`)
	// Plain strings that the YAML 1.2 core schema would read as something else.
	coreNonString = []*regexp.Regexp{
		regexp.MustCompile(`^(?:~|[Nn]ull|NULL)?$`),
		regexp.MustCompile(`^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$`),
		regexp.MustCompile(`^0o[0-7]+$`),
		regexp.MustCompile(`^[-+]?[0-9]+$`),
		regexp.MustCompile(`^0x[0-9a-fA-F]+$`),
		regexp.MustCompile(`^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$`),
		regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$`),
		regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$`),
	}
)

func scalarString(value string, implicitKey bool, indent string) string {
	if forceDouble.MatchString(value) || hasSurrogateEscape(value) {
		return doubleQuoted(value, implicitKey, indent)
	}
	return plain(value, implicitKey, indent)
}

func hasSurrogateEscape(string) bool { return false } // Go strings can't hold lone surrogates

func plain(value string, implicitKey bool, indent string) string {
	if implicitKey && strings.Contains(value, "\n") {
		return quoted(value, implicitKey, indent)
	}
	if notPlain.MatchString(value) {
		if implicitKey || !strings.Contains(value, "\n") {
			return quoted(value, implicitKey, indent)
		}
		return block(value, implicitKey, indent, false)
	}
	if !implicitKey && strings.Contains(value, "\n") {
		return block(value, implicitKey, indent, false)
	}
	if docMarker.MatchString(value) {
		if indent == "" {
			return block(value, implicitKey, indent, true)
		}
		if implicitKey && indent == "  " {
			return quoted(value, implicitKey, indent)
		}
	}
	for _, re := range coreNonString {
		if re.MatchString(value) {
			return quoted(value, implicitKey, indent)
		}
	}
	return value
}

func quoted(value string, implicitKey bool, indent string) string {
	hasDouble, hasSingle := strings.Contains(value, `"`), strings.Contains(value, "'")
	if hasDouble && !hasSingle {
		return singleQuoted(value, implicitKey, indent)
	}
	return doubleQuoted(value, implicitKey, indent)
}

func singleQuoted(value string, implicitKey bool, indent string) string {
	if (implicitKey && strings.Contains(value, "\n")) || wsAroundBreak.MatchString(value) {
		return doubleQuoted(value, implicitKey, indent)
	}
	ind := indent
	if ind == "" && docMarker.MatchString(value) {
		ind = "  "
	}
	v := strings.ReplaceAll(value, "'", "''")
	v = regexp.MustCompile(`\n+`).ReplaceAllStringFunc(v, func(m string) string { return m + "\n" + ind })
	return "'" + v + "'"
}

func doubleQuoted(value string, implicitKey bool, indent string) string {
	b, _ := json.Marshal(value)
	js := jsonEscape(value, string(b))
	ind := indent
	if ind == "" && docMarker.MatchString(value) {
		ind = "  "
	}
	var out strings.Builder
	start := 0
	for i := 0; i < len(js); i++ {
		ch := js[i]
		if ch == ' ' && i+2 < len(js) && js[i+1] == '\\' && js[i+2] == 'n' {
			out.WriteString(js[start:i] + `\ `)
			i++
			start = i
			ch = '\\'
		}
		if ch != '\\' || i+1 >= len(js) {
			continue
		}
		switch js[i+1] {
		case 'u':
			out.WriteString(js[start:i])
			code := js[i+2 : i+6]
			switch code {
			case "0000":
				out.WriteString(`\0`)
			case "0007":
				out.WriteString(`\a`)
			case "000b":
				out.WriteString(`\v`)
			case "001b":
				out.WriteString(`\e`)
			case "0085":
				out.WriteString(`\N`)
			case "00a0":
				out.WriteString(`\_`)
			case "2028":
				out.WriteString(`\L`)
			case "2029":
				out.WriteString(`\P`)
			default:
				if strings.HasPrefix(code, "00") {
					out.WriteString(`\x` + code[2:])
				} else {
					out.WriteString(js[i : i+6])
				}
			}
			i += 5
			start = i + 1
		case 'n':
			if implicitKey || (i+2 < len(js) && js[i+2] == '"') || len(js) < 40 {
				i++
			} else {
				out.WriteString(js[start:i] + "\n\n")
				for i+4 < len(js) && js[i+2] == '\\' && js[i+3] == 'n' && js[i+4] != '"' {
					out.WriteString("\n")
					i += 2
				}
				out.WriteString(ind)
				if i+2 < len(js) && js[i+2] == ' ' {
					out.WriteString(`\`)
				}
				i++
				start = i + 1
			}
		default:
			i++
		}
	}
	if start == 0 {
		return js
	}
	return out.String() + js[start:]
}

// jsonEscape is JSON.stringify(value): Go's encoder escapes <, >, & and U+2028/2029 differently.
func jsonEscape(value, _ string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				const hex = "0123456789abcdef"
				b.WriteString(`\u00` + string(hex[r>>4]) + string(hex[r&0xF]))
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func block(value string, implicitKey bool, indent string, forceIndent bool) string {
	if breakAtEnd.MatchString(value) {
		return quoted(value, implicitKey, indent)
	}
	ind := indent
	if ind == "" && (forceIndent || docMarker.MatchString(value)) {
		ind = "  "
	}
	if value == "" {
		return "|\n"
	}
	// chomping from the whitespace at the end
	endStart := len(value)
	for endStart > 0 {
		ch := value[endStart-1]
		if ch != '\n' && ch != '\t' && ch != ' ' {
			break
		}
		endStart--
	}
	end := value[endStart:]
	var chomp string
	switch nl := strings.IndexByte(end, '\n'); {
	case nl == -1:
		chomp = "-"
	case value == end || nl != len(end)-1:
		chomp = "+"
	}
	if end != "" {
		value = value[:len(value)-len(end)]
		end = strings.TrimSuffix(end, "\n")
		end = indentBreakRuns(end, ind)
	}
	// indentation indicator from the whitespace at the start
	startWithSpace := false
	startNl := -1
	startEnd := 0
	for ; startEnd < len(value); startEnd++ {
		ch := value[startEnd]
		if ch == ' ' {
			startWithSpace = true
		} else if ch == '\n' {
			startNl = startEnd
		} else {
			break
		}
	}
	cut := startEnd
	if startNl < startEnd {
		cut = startNl + 1
	}
	start := value[:cut]
	if start != "" {
		value = value[len(start):]
		start = regexp.MustCompile(`\n+`).ReplaceAllStringFunc(start, func(m string) string { return m + ind })
	}
	size := "1"
	if ind != "" {
		size = "2"
	}
	header := chomp
	if startWithSpace {
		header = size + chomp
	}
	value = regexp.MustCompile(`\n+`).ReplaceAllStringFunc(value, func(m string) string { return m + ind })
	return "|" + header + "\n" + ind + start + value + end
}

// indentBreakRuns is end.replace(/(^|(?<!\n))\n+(?!\n|$)/g, `$&${indent}`): every run of line
// breaks that is followed by more (non-break) text gets the indent after it.
func indentBreakRuns(s, indent string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '\n' {
			b.WriteByte(s[i])
			i++
			continue
		}
		j := i
		for j < len(s) && s[j] == '\n' {
			j++
		}
		b.WriteString(s[i:j])
		if j < len(s) {
			b.WriteString(indent)
		}
		i = j
	}
	return b.String()
}
