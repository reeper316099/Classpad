# How grades are calculated

Classpad never shows a number it cannot explain. Every grade, what-if and "what do I need?" result
comes with a step-by-step breakdown (the "How this was calculated" panel), built from the same data
the number came from.

All arithmetic uses exact decimals (`decimal.js`), never floating point, so 84.5 is 84.5 and a 92.995
boundary rounds the same way every time. The engine lives in `packages/grades` and has no I/O.

## Modes

Each class has a grading scheme with one of three modes.

| Mode                 | Formula                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignment_weights` | Σ(score × weight) ÷ Σ(weight) over graded items. Weights are percents and need not sum to 100.                                                           |
| `category_weights`   | Each category has a weight. A category's percent is its items pooled (or averaged); categories combine by weight. Optional "drop lowest N" per category. |
| `points`             | Σ(points earned) ÷ Σ(points possible), with optional extra credit (cap as a percent of total), late penalties and a curve.                               |

Common rules:

- **Ungraded work is ignored** when "normalize over graded work only" is on (the default). With it
  off, ungraded items count as zero. A class with nothing graded shows "No graded work yet", never 0%.
- **Excused** items are removed from both numerator and denominator. **Dropped** items are removed too.
- **Drop lowest N** removes the N lowest percents _before_ averaging; ties break by original order, then id.
- **Late penalties** subtract a percent (or per-day amount) from the item score and appear as their own step.
- **Curves** (flat add, or scale the top score to the maximum) are explicit steps, never hidden.
- **Pass/fail** classes are excluded from GPA and shown as pass or fail against a threshold.

## Setting up your own categories (in the app)

Open a class → **Grades** → **Set up grading**.

1. Pick **Categories**, then add your own (Homework, Quizzes, Midterm, Final, Participation…) or start from a
   common layout. Give each a weight; the dialog shows whether they add up to 100%.
2. Optionally **drop the lowest N** scores in a category, and choose how it is combined: **total points** (points
   earned over points possible) or **average of percents** (every assignment gets an equal say).
3. Say which category each assignment counts in. **Match by type or title** does the obvious ones for you (an
   assignment typed "exam" goes to a category called "Exams").

The categories belong to that class alone, so every class can follow its own syllabus. A category with no graded
work yet is left out of the average until it has some, and assignments that are not in a category do not count
(the Grades tab tells you how many). New assignments pick their category in the assignment form.

## Rounding and letters

Rounding is half-up by default (or truncate), to a configurable number of decimals. The letter can be
looked up from the raw or the rounded percent; both numbers are displayed so you can see why a 89.5
is, or is not, an A-. Letter cutoffs are editable per scheme.

## What do I need?

The solver is closed-form, not a search. For a target grade it solves the grade formula for the
score on the remaining work and reports one of: **achievable** (with the needed score), **secured**
(you already have it) or **impossible** (even a perfect score falls short; extra credit is considered).
It can spread the requirement equally across remaining items or by weight, and shows best, worst and
expected cases. "Sensitivity" ranks pending items by how far they can move your grade.

## What-if

What-if overlays hypothetical scores on the real data and shows the difference. It is **never saved**.

## GPA

- Letter → points via a scale (4.0 with ±, 4.0 flat, 4.3, 5.0), editable.
- Unweighted and weighted (honors, AP, IB and dual-enrollment bonuses), credit-weighted.
- Per-semester and cumulative, a repeat/replace rule for retakes, and a target-GPA planner
  ("what do I need next term?").
- Classes without credits, and pass/fail classes, are excluded with a visible warning; Classpad
  never invents credits.

## How we know it is right

`packages/grades` has worked examples as exact-value assertions, golden cases (single item, weights not
summing to 100, extra credit, drop-lowest ties, excused items, rounding boundaries, pass/fail,
retakes) and property tests (monotonicity, weight-scale invariance, solver round-trip, never NaN or
Infinity).
