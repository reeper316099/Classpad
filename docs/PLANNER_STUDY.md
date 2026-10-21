# Planner, study timer and workload

## Calendar data

`GET /api/v1/agenda?from=&to=` merges four sources into one ordered list (all-day items first on each date):
assignment deadlines, dated tasks, class meetings and logged study sessions.
Class meetings repeat weekly and only appear between the class's own dates (or its semester's dates).
`GET /timetable?week=&weekStart=mon|sun` is the same data grouped into seven days.
`GET /deadlines` lists open deadlines with an urgency (`overdue`, `today`, `soon` = within 6 days, `later`).
Dates are local wall-clock times; the app never converts time zones.

## Study sessions

Stored as one JSON object per line in `data/study/YYYY-MM.jsonl` (hand-editable; bad lines are reported, not fatal).
`POST /study-sessions/start` and `/stop` keep a running timer in `data/study/active.json` so it survives restarts.
`stop` accepts an optional `at` end time (never in the future), used when a Pomodoro finished while the window was closed.
Runs shorter than 30 seconds are discarded. Sessions are capped at 24 hours.

The Pomodoro timer derives remaining time from timestamps, so a throttled background tab never drifts.
Only focus time is logged; pausing or skipping logs what was done so far.

## Workload score

Used by the workload view, the dashboard banner and `GET /stats/overview`:

- each open deadline: `1 + weight/20`, plus `1.5` for exams, projects and presentations, plus `0.5` if marked important
- each open task with a date: `0.5 × target hours`
- a week is **light** under 3, **steady** from 3 to 6, **heavy** at 6 or more

## Grade trend sparklines

For each class the grade is recomputed after each graded item in due-date order (using the class's own scheme),
keeping the last 12 points. Ungraded work never appears in the trend.

## Reminders

Desktop notifications are generated locally from deadlines and dated tasks (Settings → Reminders).
For each item only the tightest applicable lead time fires, once, so waking the computer late does not
produce a burst of stale reminders. Date-only items are due at 23:59.
