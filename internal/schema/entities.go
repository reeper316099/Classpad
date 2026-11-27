package schema

import (
	"regexp"

	"github.com/reeper316099/classpad/internal/jsv"
)

// The entity schemas of packages/shared (entities.ts, modules.ts, plugins.ts), field for field and
// in the same order, so parsed entities have the same keys in the same order.

func str() *Str             { return String() }
func opt(s Schema) Schema   { return Optional(s) }
func emptyArr() func() any  { return func() any { return []any{} } }
func val(v any) func() any  { return func() any { return v } }
func strArr() Schema        { return Default(Array(String()), emptyArr()) }
func boolDef(b bool) Schema { return Default(Bool(), val(b)) }
func enumDef(def string, opts ...string) Schema {
	return Default(Enum(opts...), val(def))
}

var (
	Priority      = Enum("important", "mid", "low")
	TaskPriority  = Enum("low", "medium", "high")
	Status        = Enum("not_started", "in_progress", "complete")
	ReadingStatus = Enum("to_read", "reading", "complete")
	Delivery      = Enum("in_person", "online", "hybrid")
	GradingMode   = Enum("assignment_weights", "category_weights", "points")
	HonorsLevel   = Union(Enum("regular", "honors", "ap", "ib", "dual"), String().Min(1))
	Weekday       = Enum("mon", "tue", "wed", "thu", "fri", "sat", "sun")
)

// iso is a date (YYYY-MM-DD) or date-time.
func iso() *Str { return String().Min(8) }

func base() []Field {
	return []Field{
		F("id", String().Min(1)),
		F("createdAt", String()),
		F("updatedAt", String()),
		F("importRef", opt(String())),
	}
}

func entity(fields ...Field) *Object { return Obj(append(base(), fields...)...) }

var hhmm = regexp.MustCompile(`^\d{2}:\d{2}$`)

var (
	Semester = entity(
		F("name", String().Min(1)),
		F("slug", opt(str())),
		F("start", opt(iso())),
		F("end", opt(iso())),
		F("isCurrent", boolDef(false)),
		F("goals", strArr()),
		F("gpaScaleId", opt(str())),
		F("archived", boolDef(false)),
	)

	Meeting = Obj(
		F("day", Weekday),
		F("start", String().Regex(hhmm, `/^\d{2}:\d{2}$/`)),
		F("end", String().Regex(hhmm, `/^\d{2}:\d{2}$/`)),
		F("location", opt(str())),
	)

	Class = entity(
		F("semesterId", str()),
		F("name", String().Min(1)),
		F("slug", opt(str())),
		F("code", opt(str())),
		F("type", opt(str())),
		F("delivery", opt(Delivery)),
		F("credits", opt(Number().Nonnegative())),
		F("instructor", opt(str())),
		F("contactIds", strArr()),
		F("location", opt(str())),
		F("meetings", Default(Array(Meeting), emptyArr())),
		F("rawTimes", opt(str())),
		F("dates", opt(Obj(F("start", iso()), F("end", iso())))),
		F("color", Default(String(), val("#6366f1"))),
		F("syllabusAttachmentId", opt(str())),
		F("quickNotes", opt(str())),
		F("gradingSchemeId", Default(String(), val("default"))),
		F("honorsLevel", Default(HonorsLevel, val("regular"))),
		F("passFail", boolDef(false)),
		F("includeInGpa", boolDef(true)),
		F("targetGrade", opt(Number().Min(0))),
		F("studyTargetHours", opt(Number().Min(0).Max(80))),
		F("archived", boolDef(false)),
	)

	Score = Union(
		Obj(F("earned", Number()), F("possible", opt(Number().Positive()))),
		Obj(F("percent", Number())),
	)

	Assignment = entity(
		F("classId", str()),
		F("title", String().Min(1)),
		F("type", strArr()),
		F("categoryId", opt(str())),
		F("status", Default(Status, val("not_started"))),
		F("priority", Default(Priority, val("mid"))),
		F("priorityLabel", opt(str())),
		F("due", opt(str())),
		F("weight", opt(Number().Min(0).Max(100))),
		F("pointsPossible", opt(Number().Positive())),
		F("score", opt(Score)),
		F("extraCredit", opt(Bool())),
		F("excused", opt(Bool())),
		F("dropped", opt(Bool())),
		F("latePenalty", opt(Number().Min(0))),
		F("link", opt(str())),
		F("attachmentIds", strArr()),
		F("quickNotes", opt(str())),
		F("noteIds", strArr()),
		F("taskIds", strArr()),
	)

	Task = entity(
		F("title", String().Min(1)),
		F("assignmentId", opt(str())),
		F("classId", opt(str())),
		F("date", opt(str())),
		F("priority", Default(TaskPriority, val("medium"))),
		F("done", boolDef(false)),
		F("targetHours", opt(Number().Nonnegative())),
		F("actualHours", opt(Number().Nonnegative())),
		F("recurrence", opt(str())),
	)

	Note = entity(
		F("title", String().Min(1)),
		F("classId", opt(str())),
		F("date", opt(str())),
		F("markdown", Default(String(), val(""))),
		F("tags", strArr()),
		F("assignmentIds", strArr()),
		F("readingIds", strArr()),
		F("attachmentIds", strArr()),
		F("template", opt(str())),
	)

	Reading = entity(
		F("title", String().Min(1)),
		F("classId", opt(str())),
		F("status", Default(ReadingStatus, val("to_read"))),
		F("format", opt(str())),
		F("totalPages", opt(Number().Int().Nonnegative())),
		F("pagesRead", opt(Number().Int().Nonnegative())),
		F("dateRead", opt(str())),
		F("quickNotes", opt(str())),
		F("noteIds", strArr()),
	)

	StudySession = entity(
		F("start", str()),
		F("end", str()),
		F("minutes", Number().Nonnegative()),
		F("classId", opt(str())),
		F("taskId", opt(str())),
		F("assignmentId", opt(str())),
		F("kind", enumDef("manual", "pomodoro", "manual")),
	)

	Attachment = entity(
		F("filename", String().Min(1)),
		F("mime", str()),
		F("size", Number().Nonnegative()),
		F("hash", str()),
		F("path", str()),
	)

	LetterCutoff = Obj(F("letter", str()), F("min", Number()), F("gpa", Number()))

	GradingScheme = Obj(
		F("id", str()),
		F("name", str()),
		F("mode", GradingMode),
		F("categories", opt(Array(Obj(
			F("id", str()),
			F("name", str()),
			F("weight", Number().Min(0)),
			F("dropLowest", opt(Number().Int().Min(0))),
			F("countMode", opt(Enum("pooled", "mean"))),
		)))),
		F("scale", Obj(
			F("cutoffs", Array(LetterCutoff).Min(1)),
			F("roundingMode", enumDef("half_up", "half_up", "truncate")),
			F("decimals", Default(Number().Int().Min(0).Max(4), val(2.0))),
			F("letterOn", enumDef("raw", "raw", "rounded")),
		)),
		F("latePolicy", opt(Obj(F("perDayPercent", Number()), F("maxPercent", opt(Number()))))),
		F("curve", opt(Union(
			Obj(F("kind", Literal("flat")), F("add", Number())),
			Obj(F("kind", Literal("scale_to_max")), F("max", Number().Positive())),
		))),
		F("extraCreditCapPercent", opt(Number().Min(0))),
		F("normalizeOverGradedOnly", boolDef(true)),
		F("extraCreditAllowed", boolDef(true)),
		F("maxScore", opt(Number())),
	)

	GpaScale = Obj(
		F("id", str()),
		F("name", str()),
		F("points", Array(Obj(F("letter", str()), F("gpa", Number())))),
		F("weightedBonus", Record(Number())),
		F("notes", opt(str())),
	)

	// ---- optional modules ----

	JournalEntry = entity(
		F("date", String().Min(8)),
		F("title", Default(String(), val(""))),
		F("mood", strArr()),
		F("markdown", Default(String(), val(""))),
	)

	Contact = entity(
		F("name", String().Min(1)),
		F("role", opt(str())),
		F("email", opt(str())),
		F("phone", opt(str())),
		F("classIds", strArr()),
		F("notes", opt(str())),
	)

	Activity = entity(
		F("name", String().Min(1)),
		F("role", opt(str())),
		F("organization", opt(str())),
		F("status", enumDef("active", "active", "past", "planned")),
		F("hoursPerWeek", opt(Number().Min(0).Max(168))),
		F("start", opt(str())),
		F("end", opt(str())),
		F("notes", opt(str())),
	)

	Job = entity(
		F("position", String().Min(1)),
		F("company", Default(String(), val(""))),
		F("type", opt(str())),
		F("status", enumDef("wishlist", "wishlist", "applied", "interview", "offer", "accepted", "rejected")),
		F("priority", opt(Enum("important", "mid", "low"))),
		F("compensation", opt(str())),
		F("deadline", opt(str())),
		F("url", opt(str())),
		F("notes", opt(str())),
	)

	Admission = entity(
		F("school", String().Min(1)),
		F("program", opt(str())),
		F("status", enumDef("researching", "researching", "in_progress", "submitted", "accepted", "waitlisted", "rejected", "enrolled")),
		F("deadline", opt(str())),
		F("decisionDate", opt(str())),
		F("fee", opt(Number().Min(0))),
		F("url", opt(str())),
		F("checklist", Default(Array(Obj(F("text", String().Min(1)), F("done", boolDef(false)))), emptyArr())),
		F("notes", opt(str())),
	)

	BudgetItem = entity(
		F("purchase", String().Min(1)),
		F("type", enumDef("expense", "expense", "income")),
		F("cost", Number().Min(0)),
		F("category", opt(str())),
		F("date", String().Min(8)),
		F("vendor", opt(str())),
		F("sentiment", opt(str())),
		F("notes", opt(str())),
	)

	Srs = Obj(
		F("ease", Default(Number().Min(1.3).Max(3.5), val(2.5))),
		F("intervalDays", Default(Number().Min(0), val(0.0))),
		F("dueAt", str()),
		F("reps", Default(Number().Int().Min(0), val(0.0))),
		F("lapses", Default(Number().Int().Min(0), val(0.0))),
	)

	Card = entity(
		F("noteId", opt(str())),
		F("classId", opt(str())),
		F("front", String().Min(1)),
		F("back", Default(String(), val(""))),
		F("cloze", opt(Number().Int().Min(1))),
		F("sourceKey", opt(str())),
		F("srs", Srs),
	)
)

// ---- mapping plugins (plugins.ts) ----

var header = Transform(
	Union(String().Min(1).Max(100), Array(String().Min(1).Max(100)).Min(1).Max(8)),
	func(v any) any {
		if s, ok := v.(string); ok {
			return []any{s}
		}
		return v
	},
)

var rowFilter = Refine(
	Obj(
		F("column", String().Min(1).Max(100)),
		F("equals", opt(String().Max(200))),
		F("contains", opt(String().Min(1).Max(200))),
	),
	func(v any) bool {
		o, _ := v.(*jsv.Obj)
		return o != nil && (o.Has("equals") || o.Has("contains"))
	},
	`a row filter needs "equals" or "contains"`,
)

var MappingPlugin = Obj(
	F("pluginVersion", Literal(1.0)),
	F("id", String().RegexMsg(regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,38}$`), "id: lowercase letters, digits and dashes")),
	F("name", String().Min(1).Max(80)),
	F("description", opt(String().Max(400))),
	F("author", opt(String().Max(80))),
	F("kind", Literal("gradebook-csv")),
	F("layout", enumDef("long", "long", "wide")),
	F("columns", Prefault(Obj(
		F("title", opt(header)),
		F("class", opt(header)),
		F("due", opt(header)),
		F("score", opt(header)),
		F("pointsPossible", opt(header)),
		F("weight", opt(header)),
		F("status", opt(header)),
		F("type", opt(header)),
		F("notes", opt(header)),
	), func() any { return jsv.NewObj() })),
	F("wide", Prefault(Obj(
		F("studentColumn", opt(String().Max(100))),
		F("studentValue", opt(String().Max(200))),
		F("skipColumns", Default(Array(String().Max(100)).Max(40), emptyArr())),
		F("pointsRow", opt(rowFilter)),
		F("pointsInHeader", boolDef(true)),
	), func() any { return jsv.NewObj() })),
	F("scoreFormat", enumDef("auto", "auto", "percent", "points")),
	F("className", opt(String().Max(200))),
	F("skipRows", Default(Array(rowFilter).Max(20), emptyArr())),
)
