import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { Suspense, lazy, useEffect } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell.js';
import { eventsUrl } from './lib/api.js';
import { refreshAll } from './lib/hooks.js';
import { useUi } from './lib/store.js';
import { AssignmentsPage } from './pages/Assignments.js';
import { ClassPage, ClassesPage } from './pages/Classes.js';
import { DashboardPage } from './pages/Dashboard.js';
import { GradesPage } from './pages/Grades.js';
import { ImportExportPage } from './pages/ImportExport.js';
import { NotesPage } from './pages/Notes.js';
import { PlannerPage } from './pages/Planner.js';
import { SettingsPage } from './pages/Settings.js';

// the chart library is only needed on the GPA page
const StudyPage = lazy(() => import('./pages/Study.js').then((m) => ({ default: m.StudyPage })));
const GpaPage = lazy(() => import('./pages/Gpa.js').then((m) => ({ default: m.GpaPage })));

let lastError = { msg: '', at: 0 };
/** A failed request must never just look like "no data": tell the user once, with the reason. */
const client = new QueryClient({
  queryCache: new QueryCache({
    onError: (e) => {
      const msg = (e as Error).message || 'Request failed';
      if (msg === lastError.msg && Date.now() - lastError.at < 15_000) return;
      lastError = { msg, at: Date.now() };
      useUi.getState().toast(`Something went wrong: ${msg}`, { ms: 8000 });
    },
  }),
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
});

/** Refetch when files change on disk (hand edits, imports) or another window writes. */
function LiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(eventsUrl());
    let t: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = () => {
      clearTimeout(t);
      t = setTimeout(() => void refreshAll(qc), 150);
    };
    return () => {
      clearTimeout(t);
      es.close();
    };
  }, [qc]);
  return null;
}

export function App() {
  return (
    <QueryClientProvider client={client}>
      <LiveUpdates />
      <HashRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<DashboardPage />} />
            <Route path="classes" element={<ClassesPage />} />
            <Route path="classes/:id/:tab?" element={<ClassPage />} />
            <Route path="assignments" element={<AssignmentsPage />} />
            <Route path="grades/:classId?" element={<GradesPage />} />
            <Route
              path="gpa"
              element={
                <Suspense fallback={null}>
                  <GpaPage />
                </Suspense>
              }
            />
            <Route path="import" element={<ImportExportPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="notes/:id?" element={<NotesPage />} />
            <Route path="planner" element={<PlannerPage />} />
            <Route
              path="study"
              element={
                <Suspense fallback={null}>
                  <StudyPage />
                </Suspense>
              }
            />
            <Route path="*" element={<DashboardPage />} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  );
}
