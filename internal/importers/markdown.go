package importers

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// ---------------- YAML front matter ----------------

// Frontmatter is a note's YAML header and the text after it.
type Frontmatter struct {
	Data    map[string]any
	Content string
}

var fence = regexp.MustCompile(`(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)`)

// ParseFrontmatter reads a leading `---` YAML block (the YAML 1.2 core schema: dates stay strings,
// no custom tags). Text without one is all content.
func ParseFrontmatter(text string) (Frontmatter, error) {
	src := strings.TrimPrefix(text, "\uFEFF")
	m := fence.FindStringSubmatchIndex(src)
	if m == nil {
		return Frontmatter{Data: map[string]any{}, Content: src}, nil
	}
	var node yaml.Node
	if err := yaml.Unmarshal([]byte(src[m[2]:m[3]]), &node); err != nil {
		msg := strings.SplitN(err.Error(), "\n", 2)[0]
		return Frontmatter{}, errors.New("invalid frontmatter: " + msg)
	}
	var data any
	if len(node.Content) > 0 {
		v, err := yamlValue(node.Content[0], 0)
		if err != nil {
			return Frontmatter{}, errors.New("invalid frontmatter: " + err.Error())
		}
		data = v
	}
	if data == nil {
		data = map[string]any{}
	}
	obj, ok := data.(map[string]any)
	if !ok {
		return Frontmatter{}, errors.New("frontmatter must be a mapping")
	}
	return Frontmatter{Data: obj, Content: src[m[1]:]}, nil
}

// yamlValue converts a YAML node to JavaScript-like values: numbers are float64, keys strings.
func yamlValue(n *yaml.Node, aliases int) (any, error) {
	switch n.Kind {
	case yaml.AliasNode:
		if aliases++; aliases > 20 {
			return nil, errors.New("too many aliases")
		}
		return yamlValue(n.Alias, aliases)
	case yaml.MappingNode:
		m := map[string]any{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, err := yamlValue(n.Content[i], aliases)
			if err != nil {
				return nil, err
			}
			v, err := yamlValue(n.Content[i+1], aliases)
			if err != nil {
				return nil, err
			}
			key := jsString(k)
			if _, dup := m[key]; dup {
				return nil, errors.New("Map keys must be unique")
			}
			m[key] = v
		}
		return m, nil
	case yaml.SequenceNode:
		a := make([]any, 0, len(n.Content))
		for _, c := range n.Content {
			v, err := yamlValue(c, aliases)
			if err != nil {
				return nil, err
			}
			a = append(a, v)
		}
		return a, nil
	case yaml.ScalarNode:
		switch n.ShortTag() {
		case "!!null":
			return nil, nil
		case "!!bool":
			var b bool
			if err := n.Decode(&b); err != nil {
				return n.Value, nil
			}
			return b, nil
		case "!!int", "!!float":
			if decimalInt.MatchString(n.Value) {
				f, _ := strconv.ParseFloat(n.Value, 64) // "017" is 17 in YAML 1.2, not octal
				return f, nil
			}
			var f float64
			if err := n.Decode(&f); err != nil {
				return n.Value, nil
			}
			if n.ShortTag() == "!!int" && !coreInt.MatchString(n.Value) {
				return n.Value, nil // YAML 1.2 core integers only (no 0b, no _ separators)
			}
			return f, nil
		}
		return n.Value, nil
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, nil
		}
		return yamlValue(n.Content[0], aliases)
	}
	return nil, nil
}

var decimalInt = regexp.MustCompile(`^[-+]?[0-9]+$`)

var coreInt = regexp.MustCompile(`^([-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$`)

// ---------------- a folder of Markdown (Obsidian vault) ----------------

var (
	mdFile      = regexp.MustCompile(`(?i)\.md$`)
	imageFile   = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|svg|pdf)$`)
	wikiEmbed   = regexp.MustCompile(`!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]`)
	mdImage     = jsRe(`!\[([^\]]*)\]\(([^)\s]+)\)`)
	webOrData   = regexp.MustCompile(`(?i)^(https?:|data:)`)
	tagSplit    = jsRe(`[,\s]+`)
	lineBreakJS = "\n\r  "
)

// firstH1 is /^#\s+(.+)$/m's first capture: a "#" at a line start, whitespace (which may run over
// lines), then the rest of that line.
func firstH1(s string) (string, bool) {
	isBreak := func(r rune) bool { return strings.ContainsRune(lineBreakJS, r) }
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		if rs[i] != '#' || (i > 0 && !isBreak(rs[i-1])) {
			continue
		}
		j := i + 1
		for j < len(rs) && isJSSpace(rs[j]) {
			j++
		}
		if j == i+1 {
			continue
		}
		// Greedy \s+ first; if nothing is left for (.+), give back spaces until one isn't a line break.
		p := j
		if p == len(rs) || isBreak(rs[p]) {
			p = -1
			for q := j - 1; q > i+1; q-- {
				if !isBreak(rs[q]) {
					p = q
					break
				}
			}
			if p < 0 {
				continue
			}
		}
		e := p
		for e < len(rs) && !isBreak(rs[e]) {
			e++
		}
		return string(rs[p:e]), true
	}
	return "", false
}

// PreviewMarkdownFolder imports an Obsidian-style vault or plain folder of Markdown. A note's
// top-level folder is its class.
func PreviewMarkdownFolder(a Archive) *ImportPreview {
	out := emptyPreview("markdown")
	baseIndex := map[string]string{}
	for _, f := range a.Files() {
		baseIndex[strings.ToLower(lastSegment(f))] = f
	}
	seen := newRefSet()
	for _, f := range a.Files() {
		if !mdFile.MatchString(f) {
			continue
		}
		hidden := false
		for _, seg := range strings.Split(f, "/") {
			hidden = hidden || strings.HasPrefix(seg, ".")
		}
		if hidden {
			continue
		}
		text := readText(a, f)
		fm, err := ParseFrontmatter(text)
		if err != nil {
			out.warn("FRONTMATTER", err.Error(), f)
			fm = Frontmatter{Data: map[string]any{}, Content: text}
		}
		parts := strings.Split(f, "/")
		file := mdFile.ReplaceAllString(parts[len(parts)-1], "")
		var title string
		if v, ok := fm.Data["title"]; ok && v != nil {
			title = jsString(v)
		} else if h, ok := firstH1(fm.Content); ok {
			title = jsTrim(h)
		} else {
			title = file
		}
		folder := ""
		if len(parts) > 1 {
			folder = parts[0]
		}
		md := wikiEmbed.ReplaceAllStringFunc(fm.Content, func(m string) string {
			name := wikiEmbed.FindStringSubmatch(m)[1]
			hit := ""
			if a.Has(name) {
				hit = name
			} else {
				hit = baseIndex[strings.ToLower(lastSegment(name))]
			}
			if hit == "" || !imageFile.MatchString(hit) {
				out.warn("EMBED", fmt.Sprintf(`Embed "%s" not found`, name), f)
				return m
			}
			out.addAttachment(hit)
			return "![" + name + "](attachment-ref:" + encodeURI(hit) + ")"
		})
		md = mdImage.ReplaceAllStringFunc(md, func(m string) string {
			sub := mdImage.FindStringSubmatch(m)
			alt, target := sub[1], sub[2]
			if webOrData.MatchString(target) {
				return m
			}
			dec := target
			if d, ok := decodeURIComponent(target); ok {
				dec = d
			}
			hit := ""
			for _, c := range []string{strings.Join(append(append([]string{}, parts[:len(parts)-1]...), dec), "/"), dec} {
				if a.Has(c) {
					hit = c
					break
				}
			}
			if hit == "" {
				return m
			}
			out.addAttachment(hit)
			return "![" + alt + "](attachment-ref:" + encodeURI(hit) + ")"
		})
		var tags []string
		raw, ok := fm.Data["tags"]
		if !ok || raw == nil {
			raw = fm.Data["tag"]
		}
		switch x := raw.(type) {
		case []any:
			for _, t := range x {
				tags = append(tags, jsString(t))
			}
		case string:
			tags = tagSplit.Split(x, -1)
		}
		uniq := []string{"imported"}
		have := map[string]bool{"imported": true}
		for _, t := range tags {
			t = strings.TrimPrefix(t, "#")
			if t != "" && !have[t] {
				have[t] = true
				uniq = append(uniq, t)
			}
		}
		ref := seen.unique("md:note:" + NormTitle(mdFile.ReplaceAllString(f, "")))
		n := DraftNote{Ref: ref, Title: title, Tags: uniq, AssignmentRefs: []string{}, ReadingRefs: []string{}}
		if folder != "" {
			n.ClassRef = NameRef("class", folder)
		}
		if d, ok := fm.Data["date"]; ok && jsTruthy(d) {
			n.Date = jsSlice(jsString(d), 10)
		}
		if t := jsTrim(md); t != "" {
			n.Markdown = t + "\n"
		}
		out.Notes = append(out.Notes, n)
	}
	if len(out.Notes) == 0 {
		out.warn("NO_NOTES", "No Markdown files found", "")
	}
	return out
}

// jsTruthy is JavaScript truthiness for parsed values.
func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}
