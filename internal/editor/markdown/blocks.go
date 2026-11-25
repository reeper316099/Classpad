package markdown

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/reeper316099/classpad/internal/editor/doc"
)

var (
	reHeading  = regexp.MustCompile(`^(#{1,6})(?:[ \t]+|$)(.*)$`)
	reTodo     = regexp.MustCompile(`^([-*+])[ \t]+\[( |x|X)\](?:[ \t]+|$)`)
	reBullet   = regexp.MustCompile(`^([-*+])(?:[ \t]+|$)`)
	reNumber   = regexp.MustCompile(`^(\d{1,9})([.)])(?:[ \t]+|$)`)
	reFence    = regexp.MustCompile("^(`{3,}|~{3,})[ \t]*([^`]*)$")
	reDivider  = regexp.MustCompile(`^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$`)
	reImage    = regexp.MustCompile(`^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$`)
	reDetails  = regexp.MustCompile(`(?i)^<details( open)?>$`)
	reSummary  = regexp.MustCompile(`(?i)^<summary>(.*)</summary>$`)
	reSummaryH = regexp.MustCompile(`(?i)^<h([1-3])>(.*)</h[1-3]>$`)
	reDetailsX = regexp.MustCompile(`(?i)^</details>$`)
	reTableSep = regexp.MustCompile(`^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$`)
	reHTML     = regexp.MustCompile(`^<(?:[a-zA-Z][\w-]*|!--)`)
	reRefDef   = regexp.MustCompile(`^\[[^\]]+\]:`)
	reEmoji    = regexp.MustCompile(`^((?:\p{So}|[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}])\x{FE0F}?)[ \t]+`)
)

// Decode parses a note's Markdown body into a block document.
func Decode(md string) *doc.Document {
	md = strings.ReplaceAll(md, "\r\n", "\n")
	md = strings.NewReplacer("\r", "\n", "\f", " ", "\v", " ").Replace(md)
	md = strings.TrimSuffix(md, "\n")
	var lines []string
	if md != "" {
		lines = strings.Split(md, "\n")
	}
	blocks := parseBlocks(lines)
	if len(blocks) == 0 {
		blocks = []*doc.Node{doc.Text(doc.Paragraph, "", nil)}
	}
	return doc.New(blocks...)
}

func blank(s string) bool { return strings.TrimSpace(s) == "" }

func indentOf(s string) int {
	n := 0
	for _, r := range s {
		switch r {
		case ' ':
			n++
		case '\t':
			n += 4 - n%4
		default:
			return n
		}
	}
	return n
}

// dedent removes up to n columns of leading whitespace.
func dedent(s string, n int) string {
	col := 0
	for i, r := range s {
		if col >= n || (r != ' ' && r != '\t') {
			return s[i:]
		}
		if r == '\t' {
			col += 4 - col%4
		} else {
			col++
		}
	}
	return ""
}

func emptyPara() *doc.Node { return doc.Text(doc.Paragraph, "", nil) }

// parseBlocks parses a run of lines. Extra blank lines become empty paragraphs so they survive a round trip:
// k blank lines at the start give k, between blocks k-1, at the end k-1.
func parseBlocks(lines []string) []*doc.Node {
	var out []*doc.Node
	i := 0
	first := true
	for i < len(lines) {
		k := 0
		for i < len(lines) && blank(lines[i]) {
			k++
			i++
		}
		empties := k - 1
		if first {
			empties = k
		}
		for ; empties > 0; empties-- {
			out = append(out, emptyPara())
		}
		if i >= len(lines) {
			break
		}
		first = false
		n, next := parseBlock(lines, i)
		out = append(out, n...)
		i = next
	}
	return out
}

func listMarker(line string) (typ string, attrs doc.Attrs, width int, ok bool) {
	if m := reTodo.FindStringSubmatch(line); m != nil {
		return doc.Todo, doc.Attrs{doc.AttrChecked: m[2] != " "}, 2, true
	}
	if reDivider.MatchString(strings.TrimSpace(line)) {
		return "", nil, 0, false
	}
	if m := reBullet.FindString(line); m != "" {
		return doc.Bulleted, nil, 2, true
	}
	if m := reNumber.FindStringSubmatch(line); m != nil {
		n, _ := strconv.Atoi(m[1])
		return doc.Numbered, doc.Attrs{doc.AttrNumber: n}, len(m[1]) + 2, true
	}
	return "", nil, 0, false
}

// startsBlock reports whether a line begins a non-paragraph block (so a paragraph stops before it).
func startsBlock(line string) bool {
	t := strings.TrimLeft(line, " \t")
	if indentOf(line) >= 4 {
		return false
	}
	if _, _, _, ok := listMarker(t); ok {
		return true
	}
	return reHeading.MatchString(t) || reFence.MatchString(t) || strings.HasPrefix(t, ">") ||
		reDivider.MatchString(strings.TrimSpace(t)) || strings.HasPrefix(t, "$$") ||
		reDetails.MatchString(strings.TrimSpace(t)) || reImage.MatchString(strings.TrimSpace(t)) ||
		(strings.HasPrefix(t, "|") && strings.Count(t, "|") >= 2)
}

func parseBlock(lines []string, i int) ([]*doc.Node, int) {
	line := lines[i]
	ind := indentOf(line)
	t := strings.TrimLeft(line, " \t")
	tt := strings.TrimSpace(t)

	// indented code or anything indented 4+ outside a list: keep verbatim
	if ind >= 4 {
		j := i
		for j < len(lines) && (blank(lines[j]) || indentOf(lines[j]) >= 4) {
			j++
		}
		for j > i && blank(lines[j-1]) {
			j--
		}
		return []*doc.Node{rawNode(lines[i:j])}, j
	}

	if m := reFence.FindStringSubmatch(t); m != nil {
		fence := m[1]
		var body []string
		j := i + 1
		for ; j < len(lines); j++ {
			c := strings.TrimSpace(lines[j])
			if strings.HasPrefix(c, fence[:1]) && run(c, fence[0]) >= len(fence) && strings.Trim(c, fence[:1]) == "" {
				break
			}
			body = append(body, dedent(lines[j], ind))
		}
		if j >= len(lines) {
			// unclosed fence: not a code block, keep the text
			return []*doc.Node{rawNode(lines[i:])}, len(lines)
		}
		n := doc.Text(doc.Code, strings.Join(body, "\n"), doc.Attrs{doc.AttrLanguage: strings.TrimSpace(m[2])})
		return []*doc.Node{n}, j + 1
	}

	if strings.HasPrefix(tt, "$$") {
		if len(tt) > 4 && strings.HasSuffix(tt, "$$") {
			return []*doc.Node{doc.NewNode(doc.MathBlock, doc.Attrs{doc.AttrFormula: strings.TrimSpace(tt[2 : len(tt)-2])}, nil)}, i + 1
		}
		if tt == "$$" {
			for j := i + 1; j < len(lines); j++ {
				if strings.TrimSpace(lines[j]) == "$$" {
					f := strings.Join(lines[i+1:j], "\n")
					return []*doc.Node{doc.NewNode(doc.MathBlock, doc.Attrs{doc.AttrFormula: f}, nil)}, j + 1
				}
			}
		}
	}

	if m := reDetails.FindStringSubmatch(tt); m != nil && i+1 < len(lines) {
		if s := reSummary.FindStringSubmatch(strings.TrimSpace(lines[i+1])); s != nil {
			if end := closeDetails(lines, i+2); end >= 0 {
				title, level := s[1], 0
				if h := reSummaryH.FindStringSubmatch(strings.TrimSpace(title)); h != nil {
					level, _ = strconv.Atoi(h[1])
					title = h[2]
				}
				body := make([]string, 0, end-i-2)
				for _, l := range lines[i+2 : end] {
					body = append(body, dedent(l, ind))
				}
				if len(body) > 0 && blank(body[0]) {
					body = body[1:] // the blank line after <summary> is part of the toggle syntax
				}
				n := doc.NewNode(doc.Toggle, doc.Attrs{doc.AttrLevel: level, doc.AttrCollapse: m[1] == ""},
					ParseInline(title), trimEmpties(parseBlocks(body))...)
				return []*doc.Node{n}, end + 1
			}
		}
	}

	if h := reHeading.FindStringSubmatch(t); h != nil {
		text := strings.TrimSpace(regexp.MustCompile(`[ \t]+#+[ \t]*$`).ReplaceAllString(h[2], ""))
		n := doc.NewNode(doc.Heading, doc.Attrs{doc.AttrLevel: len(h[1])}, ParseInline(text))
		return []*doc.Node{n}, i + 1
	}

	if reDivider.MatchString(tt) {
		return []*doc.Node{doc.NewNode(doc.Divider, nil, nil)}, i + 1
	}

	if m := reImage.FindStringSubmatch(tt); m != nil {
		return []*doc.Node{doc.NewNode(doc.Image, doc.Attrs{doc.AttrURL: m[2], doc.AttrAlt: m[1]}, nil)}, i + 1
	}

	if strings.HasPrefix(t, ">") {
		var body []string
		j := i
		for ; j < len(lines); j++ {
			l := strings.TrimLeft(lines[j], " \t")
			if !strings.HasPrefix(l, ">") {
				break
			}
			l = strings.TrimPrefix(l, ">")
			l = strings.TrimPrefix(l, " ")
			body = append(body, l)
		}
		text := strings.Join(body, "\n")
		if m := reEmoji.FindStringSubmatch(text); m != nil {
			return []*doc.Node{doc.NewNode(doc.Callout, doc.Attrs{doc.AttrIcon: m[1]}, ParseInline(text[len(m[0]):]))}, j
		}
		return []*doc.Node{doc.NewNode(doc.Quote, nil, ParseInline(text))}, j
	}

	if strings.HasPrefix(t, "|") && i+1 < len(lines) && reTableSep.MatchString(strings.TrimSpace(lines[i+1])) {
		rows := [][]string{splitRow(t)}
		j := i + 2
		for ; j < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[j]), "|"); j++ {
			rows = append(rows, splitRow(strings.TrimSpace(lines[j])))
		}
		cols := len(rows[0])
		for r := range rows {
			for len(rows[r]) < cols {
				rows[r] = append(rows[r], "")
			}
			rows[r] = rows[r][:cols]
		}
		return []*doc.Node{doc.NewNode(doc.Table, doc.Attrs{doc.AttrRows: rows}, nil)}, j
	}

	if typ, attrs, width, ok := listMarker(t); ok {
		return parseList(lines, i, ind, typ, attrs, width)
	}

	if reHTML.MatchString(tt) || reRefDef.MatchString(tt) || reSummary.MatchString(tt) || reDetailsX.MatchString(tt) {
		j := i
		for j < len(lines) && !blank(lines[j]) {
			j++
		}
		return []*doc.Node{rawNode(lines[i:j])}, j
	}

	// paragraph: lines until a blank line or another block starts
	body := []string{tt}
	j := i + 1
	for j < len(lines) && !blank(lines[j]) && !startsBlock(lines[j]) {
		body = append(body, strings.TrimSpace(lines[j]))
		j++
	}
	return []*doc.Node{doc.NewNode(doc.Paragraph, nil, ParseInline(strings.Join(body, "\n")))}, j
}

// parseList reads one list item: its text, continuation lines, and nested children (lines indented past the
// marker).
func parseList(lines []string, i, ind int, typ string, attrs doc.Attrs, width int) ([]*doc.Node, int) {
	t := strings.TrimLeft(lines[i], " \t")
	var text string
	switch typ {
	case doc.Todo:
		text = t[len(reTodo.FindString(t)):]
	case doc.Bulleted:
		text = t[len(reBullet.FindString(t)):]
	default:
		text = t[len(reNumber.FindString(t)):]
	}
	body := []string{strings.TrimSpace(text)}
	j := i + 1
	// lazy continuation lines (not blank, not a new block, not deeper-indented child content)
	for j < len(lines) && !blank(lines[j]) && !startsBlock(lines[j]) && indentOf(lines[j]) > ind && indentOf(lines[j]) < ind+width+4 {
		if _, _, _, isItem := listMarker(strings.TrimLeft(lines[j], " \t")); isItem {
			break
		}
		body = append(body, strings.TrimSpace(lines[j]))
		j++
	}
	// children: following lines indented past the marker (blank lines in between allowed)
	childIndent := ind + width
	var child []string
	k := j
	for k < len(lines) {
		if blank(lines[k]) {
			// a blank line only continues the item if indented content follows
			m := k
			for m < len(lines) && blank(lines[m]) {
				m++
			}
			if m >= len(lines) || indentOf(lines[m]) < childIndent || indentOf(lines[m]) <= ind {
				break
			}
			for ; k < m; k++ {
				child = append(child, "")
			}
			continue
		}
		if indentOf(lines[k]) <= ind {
			break
		}
		child = append(child, dedent(lines[k], min(childIndent, indentOf(lines[k]))))
		k++
	}
	if attrs != nil && typ == doc.Numbered && attrs[doc.AttrNumber] == 1 {
		attrs = nil
	}
	n := doc.NewNode(typ, attrs, ParseInline(strings.Join(body, "\n")), trimEmpties(parseBlocks(child))...)
	return []*doc.Node{n}, k
}

// trimEmpties drops empty paragraphs at the end of a nested run (blank lines before the parent's next sibling).
func trimEmpties(ns []*doc.Node) []*doc.Node {
	for len(ns) > 0 {
		last := ns[len(ns)-1]
		if last.Type == doc.Paragraph && last.Delta.Len() == 0 && len(last.Children) == 0 {
			ns = ns[:len(ns)-1]
			continue
		}
		break
	}
	return ns
}

func closeDetails(lines []string, from int) int {
	depth := 1
	fence := ""
	for j := from; j < len(lines); j++ {
		t := strings.TrimSpace(lines[j])
		if m := reFence.FindStringSubmatch(t); m != nil || (fence != "" && strings.HasPrefix(t, fence)) {
			if fence == "" {
				fence = m[1]
			} else if strings.HasPrefix(t, fence) && strings.Trim(t, fence[:1]) == "" {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		if reDetails.MatchString(t) {
			depth++
		} else if reDetailsX.MatchString(t) {
			depth--
			if depth == 0 {
				return j
			}
		}
	}
	return -1
}

func splitRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	if strings.HasSuffix(line, "|") && !strings.HasSuffix(line, `\|`) {
		line = line[:len(line)-1]
	}
	var cells []string
	var cur strings.Builder
	for i := 0; i < len(line); i++ {
		if line[i] == '\\' && i+1 < len(line) && line[i+1] == '|' {
			cur.WriteString(`\|`)
			i++
			continue
		}
		if line[i] == '|' {
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
			continue
		}
		cur.WriteByte(line[i])
	}
	return append(cells, strings.TrimSpace(cur.String()))
}

func rawNode(lines []string) *doc.Node {
	return doc.NewNode(doc.Raw, doc.Attrs{doc.AttrText: strings.Join(lines, "\n")}, nil)
}

// ---- encoding ----

// Encode writes a document back to Markdown (with a trailing newline).
// Empty paragraphs at the very end (the editor's "click below to write" line) are not written.
func Encode(d *doc.Document) string {
	ns := d.Root.Children
	for len(ns) > 0 && isEmptyPara(ns[len(ns)-1]) {
		ns = ns[:len(ns)-1]
	}
	s := encodeBlocks(ns, "")
	if s == "" {
		return ""
	}
	return s + "\n"
}

func listFamily(t string) string {
	switch t {
	case doc.Bulleted, doc.Todo:
		return "-"
	case doc.Numbered:
		return "1"
	}
	return ""
}

func isEmptyPara(n *doc.Node) bool {
	return n.Type == doc.Paragraph && n.Delta.Len() == 0 && len(n.Children) == 0
}

func encodeBlocks(ns []*doc.Node, indent string) string {
	var b strings.Builder
	number := 1
	for i, n := range ns {
		if i > 0 {
			prev := ns[i-1]
			switch {
			case isEmptyPara(prev):
				b.WriteString("\n")
			case listFamily(prev.Type) != "" && listFamily(prev.Type) == listFamily(n.Type):
				b.WriteString("\n")
			default:
				b.WriteString("\n\n")
			}
		}
		if n.Type == doc.Numbered {
			if i == 0 || ns[i-1].Type != doc.Numbered {
				number = n.Int(doc.AttrNumber, 1)
			} else {
				number++
			}
		}
		if isEmptyPara(n) {
			continue
		}
		b.WriteString(prefixLines(encodeBlock(n, number), indent))
	}
	return b.String()
}

// prefixLines indents every non-empty line.
func prefixLines(s, indent string) string {
	if indent == "" {
		return s
	}
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = indent + l
		}
	}
	return strings.Join(lines, "\n")
}

// hangLines joins a multi-line block text, indenting continuation lines.
func hangLines(s, pad string) string {
	return strings.ReplaceAll(s, "\n", "\n"+pad)
}

// escapeLines makes sure no line of a block's text reads as the start of another block when parsed again
// (a paragraph line "# x" would become a heading).
func escapeLines(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		t := strings.TrimLeft(l, " \t")
		lines[i] = t
		if t == "" || !(startsBlock(t) || (i == 0 && reHTML.MatchString(t)) || reRefDef.MatchString(t)) {
			continue
		}
		if m := reNumber.FindStringSubmatch(t); m != nil {
			lines[i] = m[1] + "\\" + t[len(m[1]):]
		} else if strings.ContainsRune("#-*+>|$`~<![_=", rune(t[0])) {
			lines[i] = "\\" + t
		}
	}
	return strings.Join(lines, "\n")
}

func encodeBlock(n *doc.Node, number int) string {
	text := escapeLines(RenderInline(n.Delta))
	switch n.Type {
	case doc.Heading:
		lvl := max(1, min(6, n.Int(doc.AttrLevel, 1)))
		return strings.Repeat("#", lvl) + " " + strings.ReplaceAll(text, "\n", " ")
	case doc.Bulleted, doc.Todo, doc.Numbered:
		marker := "- "
		if n.Type == doc.Todo {
			if n.Bool(doc.AttrChecked) {
				marker = "- [x] "
			} else {
				marker = "- [ ] "
			}
		} else if n.Type == doc.Numbered {
			marker = strconv.Itoa(number) + ". "
		}
		width := 2
		if n.Type == doc.Numbered {
			width = len(marker)
		}
		pad := strings.Repeat(" ", width)
		s := strings.TrimRight(marker+hangLines(text, pad), " ")
		if len(n.Children) > 0 {
			s += "\n" + prefixLines(encodeBlocks(n.Children, ""), pad)
		}
		return s
	case doc.Quote:
		return "> " + hangLines(text, "> ")
	case doc.Callout:
		icon := n.String(doc.AttrIcon)
		if icon == "" {
			icon = "💡"
		}
		return "> " + icon + " " + hangLines(text, "> ")
	case doc.Code:
		body := n.Delta.Text()
		fence := "```"
		for strings.Contains(body, fence) {
			fence += "`"
		}
		return fence + n.String(doc.AttrLanguage) + "\n" + body + "\n" + fence
	case doc.Divider:
		return "---"
	case doc.MathBlock:
		return "$$\n" + n.String(doc.AttrFormula) + "\n$$"
	case doc.Image:
		return "![" + n.String(doc.AttrAlt) + "](" + n.String(doc.AttrURL) + ")"
	case doc.Raw:
		return n.String(doc.AttrText)
	case doc.Table:
		return encodeTable(n.Rows())
	case doc.Toggle:
		title := strings.ReplaceAll(text, "\n", " ")
		if lvl := n.Int(doc.AttrLevel, 0); lvl >= 1 && lvl <= 3 {
			title = "<h" + strconv.Itoa(lvl) + ">" + title + "</h" + strconv.Itoa(lvl) + ">"
		}
		open := "<details open>"
		if n.Bool(doc.AttrCollapse) {
			open = "<details>"
		}
		inner := encodeBlocks(n.Children, "")
		if inner != "" {
			inner += "\n"
		}
		return open + "\n<summary>" + title + "</summary>\n\n" + inner + "\n</details>"
	default: // paragraph
		return text
	}
}

func encodeTable(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	cols := 0
	for _, r := range rows {
		cols = max(cols, len(r))
	}
	cell := func(r []string, c int) string {
		if c < len(r) {
			s := strings.ReplaceAll(r[c], "\n", " ")
			if s == "" {
				return " "
			}
			return s
		}
		return " "
	}
	line := func(r []string) string {
		parts := make([]string, cols)
		for c := range parts {
			parts[c] = cell(r, c)
		}
		return "| " + strings.Join(parts, " | ") + " |"
	}
	out := []string{line(rows[0])}
	sep := make([]string, cols)
	for c := range sep {
		sep[c] = "---"
	}
	out = append(out, "| "+strings.Join(sep, " | ")+" |")
	for _, r := range rows[1:] {
		out = append(out, line(r))
	}
	return strings.Join(out, "\n")
}
