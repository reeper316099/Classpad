// Package importers turns other apps' exports into Classpad drafts: Notion exports, CSV files,
// gradebook CSVs through mapping plugins, calendars (.ics), Markdown folders and Classpad backups.
// It is a port of packages/importers and gives the same preview, field for field. Nothing here
// touches the disk or the network.
package importers

type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Where   string `json:"where,omitempty"`
}

type DraftSemester struct {
	Ref       string   `json:"ref"`
	Name      string   `json:"name"`
	Start     string   `json:"start,omitempty"`
	End       string   `json:"end,omitempty"`
	IsCurrent bool     `json:"isCurrent"`
	Goals     []string `json:"goals"`
}

type DateSpan struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type DraftClass struct {
	Ref          string    `json:"ref"`
	SemesterRef  string    `json:"semesterRef,omitempty"`
	Name         string    `json:"name"`
	Code         string    `json:"code,omitempty"`
	Type         string    `json:"type,omitempty"`
	Delivery     string    `json:"delivery,omitempty"`
	Credits      *float64  `json:"credits,omitempty"`
	Instructor   string    `json:"instructor,omitempty"`
	Location     string    `json:"location,omitempty"`
	Meetings     []Meeting `json:"meetings"`
	RawTimes     string    `json:"rawTimes,omitempty"`
	Dates        *DateSpan `json:"dates,omitempty"`
	QuickNotes   string    `json:"quickNotes,omitempty"`
	Color        string    `json:"color"`
	SyllabusPath string    `json:"syllabusPath,omitempty"`
}

type PercentScore struct {
	Percent float64 `json:"percent"`
}

type DraftAssignment struct {
	Ref           string        `json:"ref"`
	ClassRef      string        `json:"classRef,omitempty"`
	Title         string        `json:"title"`
	Type          []string      `json:"type"`
	Status        string        `json:"status"`
	Priority      string        `json:"priority,omitempty"`
	PriorityLabel string        `json:"priorityLabel,omitempty"`
	Due           string        `json:"due,omitempty"`
	Weight        *float64      `json:"weight,omitempty"`
	Score         *PercentScore `json:"score,omitempty"`
	Link          string        `json:"link,omitempty"`
	QuickNotes    string        `json:"quickNotes,omitempty"`
	FilePaths     []string      `json:"filePaths"`
}

type DraftTask struct {
	Ref           string   `json:"ref"`
	Title         string   `json:"title"`
	AssignmentRef string   `json:"assignmentRef,omitempty"`
	ClassRef      string   `json:"classRef,omitempty"`
	Date          string   `json:"date,omitempty"`
	Priority      string   `json:"priority"`
	Done          bool     `json:"done"`
	TargetHours   *float64 `json:"targetHours,omitempty"`
	ActualHours   *float64 `json:"actualHours,omitempty"`
}

type DraftReading struct {
	Ref        string   `json:"ref"`
	Title      string   `json:"title"`
	ClassRef   string   `json:"classRef,omitempty"`
	Status     string   `json:"status"`
	Format     string   `json:"format,omitempty"`
	TotalPages *float64 `json:"totalPages,omitempty"`
	PagesRead  *float64 `json:"pagesRead,omitempty"`
	DateRead   string   `json:"dateRead,omitempty"`
	QuickNotes string   `json:"quickNotes,omitempty"`
}

type DraftNote struct {
	Ref            string   `json:"ref"`
	Title          string   `json:"title"`
	ClassRef       string   `json:"classRef,omitempty"`
	Date           string   `json:"date,omitempty"`
	Markdown       string   `json:"markdown"`
	Tags           []string `json:"tags"`
	AssignmentRefs []string `json:"assignmentRefs"`
	ReadingRefs    []string `json:"readingRefs"`
}

type DraftJournal struct {
	Ref      string   `json:"ref"`
	Date     string   `json:"date"`
	Title    string   `json:"title"`
	Mood     []string `json:"mood"`
	Markdown string   `json:"markdown"`
}

type DraftContact struct {
	Ref       string   `json:"ref"`
	Name      string   `json:"name"`
	Role      string   `json:"role,omitempty"`
	Email     string   `json:"email,omitempty"`
	Phone     string   `json:"phone,omitempty"`
	ClassRefs []string `json:"classRefs"`
}

type DraftJob struct {
	Ref          string `json:"ref"`
	Position     string `json:"position"`
	Company      string `json:"company"`
	Type         string `json:"type,omitempty"`
	Status       string `json:"status"`
	Priority     string `json:"priority,omitempty"`
	Compensation string `json:"compensation,omitempty"`
	URL          string `json:"url,omitempty"`
}

type DraftBudget struct {
	Ref       string  `json:"ref"`
	Purchase  string  `json:"purchase"`
	Type      string  `json:"type"`
	Cost      float64 `json:"cost"`
	Category  string  `json:"category,omitempty"`
	Date      string  `json:"date"`
	Vendor    string  `json:"vendor,omitempty"`
	Sentiment string  `json:"sentiment,omitempty"`
}

type DraftTemplate struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Markdown string `json:"markdown"`
}

type AttachmentRef struct {
	ArchivePath string `json:"archivePath"`
	Filename    string `json:"filename"`
}

type MappingEntry struct {
	File     string   `json:"file"`
	Kind     string   `json:"kind"`
	Chosen   bool     `json:"chosen"`
	Rows     int      `json:"rows"`
	Used     []string `json:"used"`
	Computed []string `json:"computed"`
	Ignored  []string `json:"ignored"`
	Note     string   `json:"note,omitempty"`
}

type ValidationRow struct {
	ClassName  string  `json:"className"`
	Exported   string  `json:"exported"`
	Recomputed *string `json:"recomputed"`
	Status     string  `json:"status"`
	Diff       string  `json:"diff,omitempty"`
}

type SkippedGroup struct {
	Kind   string `json:"kind"`
	Count  int    `json:"count"`
	Reason string `json:"reason"`
}

// ImportPreview is what an import would create, shown before anything is saved.
type ImportPreview struct {
	Source      string            `json:"source"`
	Semesters   []DraftSemester   `json:"semesters"`
	Classes     []DraftClass      `json:"classes"`
	Assignments []DraftAssignment `json:"assignments"`
	Tasks       []DraftTask       `json:"tasks"`
	Readings    []DraftReading    `json:"readings"`
	Notes       []DraftNote       `json:"notes"`
	Journal     []DraftJournal    `json:"journal"`
	Contacts    []DraftContact    `json:"contacts"`
	Jobs        []DraftJob        `json:"jobs"`
	Budget      []DraftBudget     `json:"budget"`
	Templates   []DraftTemplate   `json:"templates"`
	Attachments []AttachmentRef   `json:"attachments"`
	Skipped     []SkippedGroup    `json:"skipped"`
	Mapping     []MappingEntry    `json:"mapping"`
	Warnings    []Warning         `json:"warnings"`
	Validation  []ValidationRow   `json:"validation"`
}

func emptyPreview(source string) *ImportPreview {
	return &ImportPreview{
		Source: source, Semesters: []DraftSemester{}, Classes: []DraftClass{},
		Assignments: []DraftAssignment{}, Tasks: []DraftTask{}, Readings: []DraftReading{},
		Notes: []DraftNote{}, Journal: []DraftJournal{}, Contacts: []DraftContact{}, Jobs: []DraftJob{},
		Budget: []DraftBudget{}, Templates: []DraftTemplate{}, Attachments: []AttachmentRef{},
		Skipped: []SkippedGroup{}, Mapping: []MappingEntry{}, Warnings: []Warning{},
		Validation: []ValidationRow{},
	}
}

func (p *ImportPreview) warn(code, message, where string) {
	p.Warnings = append(p.Warnings, Warning{Code: code, Message: message, Where: where})
}

func (p *ImportPreview) hasAttachment(path string) bool {
	for _, a := range p.Attachments {
		if a.ArchivePath == path {
			return true
		}
	}
	return false
}

func (p *ImportPreview) addAttachment(path string) {
	if !p.hasAttachment(path) {
		p.Attachments = append(p.Attachments, AttachmentRef{ArchivePath: path, Filename: lastSegment(path)})
	}
}

func lastSegment(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

// PreviewKinds are the collections a preview lists first.
var PreviewKinds = []string{"semesters", "classes", "assignments", "tasks", "readings", "notes"}

func fptr(f float64) *float64 { return &f }
