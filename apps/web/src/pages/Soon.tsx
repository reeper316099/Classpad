import { Empty, PageHead } from '../components/ui.js';
import type { IconName } from '../components/Icon.js';

const COPY: Record<string, [string, IconName, string]> = {
  notes: [
    'Notes',
    'notes',
    'Markdown notes with math, code, images and PDFs, organized by class with backlinks and templates.',
  ],
  planner: [
    'Planner',
    'planner',
    'Week timetable, agenda, tasks with target vs actual hours, and deadline notifications.',
  ],
  study: [
    'Study',
    'study',
    'Pomodoro timer that logs study time per class, flashcards, and analytics.',
  ],
};
export function SoonPage({ which }: { which: keyof typeof COPY }) {
  const [title, icon, text] = COPY[which]!;
  return (
    <>
      <PageHead title={title} />
      <Empty icon={icon} title="Coming in a later milestone">
        {text}
      </Empty>
    </>
  );
}
