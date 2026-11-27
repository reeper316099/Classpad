package importers

import (
	"regexp"
	"strings"
	"unicode"
)

// BodyContext is what converting a Notion page needs to know.
type BodyContext struct {
	PagePath      string          // archive path of the page, for relative links
	PropertyNames map[string]bool // lowercased property names whose "Key: value" lines are dropped
	HasFile       func(string) bool
	DropTooltips  bool
}

type BodyResult struct {
	Markdown        string
	Attachments     []string
	DroppedTooltips int
	Warnings        []string
}

var (
	leadingTitle = jsRe(`^\s*#\s+[^\n]*\n`)
	propLine     = jsRe(`^([^:\n]{1,48}):(?:\s.*)?$`)
	asideBlock   = jsRe(`<aside>\s*([\s\S]*?)\s*<\/aside>`)
	tooltip      = jsRe(`(?i)^(tool-?tip|tip|hint|how to use|template (tip|hint|note))\b\s*[:\-–—]?`)
	escapedCheck = regexp.MustCompile(`\\\[( |x|X)\\\]`)
	inlineEq     = regexp.MustCompile("\\$`([^`]+)`\\$")
	brTag        = jsRe(`(?i)<br\s*\/?>`)
	htmlComment  = regexp.MustCompile(`(?s)<!--.*?-->`)
	mdLink       = jsRe(`(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	externalLink = regexp.MustCompile(`(?i)^(https?:|mailto:|#)`)
	csvFile      = regexp.MustCompile(`(?i)\.csv$`)
	upToSlash    = jsRe(`^.*\/`)
	idSuffixMD   = jsRe(`(?i)\s[0-9a-f]{32}\.md$`)
	htmlTag      = regexp.MustCompile(`<[^>]+>`)
	threeLines   = regexp.MustCompile(`\n{3,}`)
)

func joinPath(base, rel string) string {
	parts := strings.Split(base, "/")
	parts = parts[:len(parts)-1]
	for _, seg := range strings.Split(rel, "/") {
		switch {
		case seg == "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		case seg != "" && seg != ".":
			parts = append(parts, seg)
		}
	}
	return strings.Join(parts, "/")
}

// leadingIcon is /^([\p{Extended_Pictographic}️‍]+)\s*/u.
func leadingIcon(s string) (icon string, rest string, ok bool) {
	i := 0
	for i < len(s) {
		r, size := decodeRune(s[i:])
		if !(unicode.Is(extendedPictographic, r) || r == 0xFE0F || r == 0x200D) {
			break
		}
		i += size
	}
	if i == 0 {
		return "", s, false
	}
	icon = s[:i]
	j := i
	for j < len(s) {
		r, size := decodeRune(s[j:])
		if !isJSSpace(r) {
			break
		}
		j += size
	}
	return icon, s[j:], true
}

// toggleMatch finds the first innermost toggle:
// <details[^>]*>\s*<summary>(no </summary> or <details)</summary>(no <details)</details>
// It walks the candidates left to right with forward-only cursors, so one call is linear.
func toggleMatch(t string) (start, end int, summary, body string, ok bool) {
	// next returns the first index of sub at or after from (len(t) if none). A cursor's answer is
	// reused while later searches start between its last start and its answer.
	type cursor struct{ from, at int }
	next := func(c *cursor, sub string, from int) int {
		if from < c.from || from > c.at {
			c.from = from
			if k := strings.Index(t[from:], sub); k >= 0 {
				c.at = from + k
			} else {
				c.at = len(t)
			}
		}
		return c.at
	}
	none := cursor{from: 1 << 62, at: -1}
	open, closeSummary, closeDetails := none, none, none
	for from := 0; ; {
		k := strings.Index(t[from:], "<details")
		if k < 0 {
			return 0, 0, "", "", false
		}
		i := from + k
		from = i + 1
		gt := strings.IndexByte(t[i+8:], '>')
		if gt < 0 {
			return 0, 0, "", "", false // no later candidate can have a '>' either
		}
		p := i + 8 + gt + 1
		for p < len(t) {
			r, size := decodeRune(t[p:])
			if !isJSSpace(r) {
				break
			}
			p += size
		}
		if !strings.HasPrefix(t[p:], "<summary>") {
			continue
		}
		s0 := p + len("<summary>")
		se := next(&closeSummary, "</summary>", s0)
		if se == len(t) {
			return 0, 0, "", "", false
		}
		if next(&open, "<details", s0) < se {
			continue
		}
		b0 := se + len("</summary>")
		be := next(&closeDetails, "</details>", b0)
		if be == len(t) {
			continue
		}
		if next(&open, "<details", b0) < be {
			continue
		}
		return i, be + len("</details>"), t[s0:se], t[b0:be], true
	}
}

// headingSummary is /^\s*<h([1-3])[^>]*>([\s\S]*?)<\/h\1>\s*$/i.
func headingSummary(s string) (level byte, inner string, ok bool) {
	t := strings.TrimLeftFunc(s, isJSSpace)
	if len(t) < 4 || t[0] != '<' || (t[1] != 'h' && t[1] != 'H') || t[2] < '1' || t[2] > '3' {
		return 0, "", false
	}
	level = t[2]
	gt := strings.IndexByte(t[3:], '>')
	if gt < 0 {
		return 0, "", false
	}
	c0 := 3 + gt + 1
	lower := strings.ToLower(t)
	closing := "</h" + string(level) + ">"
	for x := c0; ; {
		k := strings.Index(lower[x:], closing)
		if k < 0 {
			return 0, "", false
		}
		e := x + k
		if strings.TrimLeftFunc(t[e+len(closing):], isJSSpace) == "" {
			return level, t[c0:e], true
		}
		x = e + 1
	}
}

// ConvertNotionMarkdown cleans a Notion page: drops the title and property lines, turns callouts
// into quotes and toggles into <details>, fixes escapes, and resolves links and images.
func ConvertNotionMarkdown(input string, ctx BodyContext) BodyResult {
	var warnings, attachments []string
	dropped := 0
	t := strings.TrimPrefix(input, "\uFEFF")
	t = strings.ReplaceAll(t, "\r\n", "\n")
	t = strings.ReplaceAll(t, "\r", "\n")

	// title and property header block
	if loc := leadingTitle.FindStringIndex(t); loc != nil {
		t = t[loc[1]:]
	}
	lines := strings.Split(t, "\n")
	i := 0
	for i < len(lines) && jsTrim(lines[i]) == "" {
		i++
	}
	j := i
	sawProp := false
	for j < len(lines) {
		m := propLine.FindStringSubmatch(lines[j])
		if m != nil && ctx.PropertyNames[strings.ToLower(jsTrim(m[1]))] {
			sawProp = true
			j++
		} else {
			break
		}
	}
	if sawProp {
		t = strings.Join(lines[j:], "\n")
	}

	// callouts
	t = asideBlock.ReplaceAllStringFunc(t, func(m string) string {
		inner := asideBlock.FindStringSubmatch(m)[1]
		icon, text, hasIcon := leadingIcon(inner)
		if ctx.DropTooltips && tooltip.MatchString(jsTrim(text)) {
			dropped++
			return ""
		}
		body := text
		if hasIcon {
			body = icon + " " + text
		}
		ls := strings.Split(body, "\n")
		for k, l := range ls {
			ls[k] = strings.TrimRightFunc("> "+l, isJSSpace)
		}
		return strings.Join(ls, "\n")
	})

	// toggles (toggle list, toggle heading 1/2/3) become <details>, innermost first
	for guard := 0; guard < 500; guard++ {
		s0, e0, s, body, ok := toggleMatch(t)
		if !ok {
			break
		}
		level, inner, isHeading := headingSummary(s)
		src := s
		if isHeading {
			src = inner
		}
		title := CleanLabel(htmlTag.ReplaceAllString(src, ""))
		if title == "" {
			title = "Toggle"
		}
		summary := title
		if isHeading {
			summary = "<h" + string(level) + ">" + title + "</h" + string(level) + ">"
		}
		t = t[:s0] + "\n\n<details>\n<summary>" + summary + "</summary>\n\n" + jsTrim(body) + "\n\n</details>\n\n" + t[e0:]
	}

	// escaped checkboxes, equations, breaks, comments
	t = escapedCheck.ReplaceAllString(t, "[$1]")
	t = inlineEq.ReplaceAllString(t, "$$$1$$")
	t = brTag.ReplaceAllString(t, "\n")
	t = htmlComment.ReplaceAllString(t, "")

	// links and images
	t = mdLink.ReplaceAllStringFunc(t, func(m string) string {
		sub := mdLink.FindStringSubmatch(m)
		bang, label, target := sub[1], sub[2], sub[3]
		if externalLink.MatchString(target) {
			return m
		}
		decoded := target
		if d, ok := decodeURIComponent(target); ok {
			decoded = d
		}
		resolved := joinPath(ctx.PagePath, decoded)
		if mdFile.MatchString(decoded) {
			title := CleanLabel(label)
			if title == "" {
				title = CleanLabel(idSuffixMD.ReplaceAllString(upToSlash.ReplaceAllString(decoded, ""), ""))
			}
			return "[[" + title + "]]"
		}
		if csvFile.MatchString(decoded) {
			return "" // links to embedded database views aren't content
		}
		for _, p := range []string{resolved, decoded} {
			if ctx.HasFile(p) {
				attachments = append(attachments, p)
				return bang + "[" + label + "](attachment-ref:" + encodeURI(p) + ")"
			}
		}
		warnings = append(warnings, `Unresolved link target "`+decoded+`"`)
		return m
	})

	t = jsTrim(threeLines.ReplaceAllString(t, "\n\n"))
	md := ""
	if t != "" {
		md = t + "\n"
	}
	seen := map[string]bool{}
	uniq := []string{}
	for _, a := range attachments {
		if !seen[a] {
			seen[a] = true
			uniq = append(uniq, a)
		}
	}
	return BodyResult{Markdown: md, Attachments: uniq, DroppedTooltips: dropped, Warnings: warnings}
}
