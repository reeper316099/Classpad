import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from './api.js';
import type { Assignment, ClassEntity, Note, Page, Reading, Semester, Task } from './types.js';
import { useUi } from './store.js';

export type Collection = 'semesters' | 'classes' | 'assignments' | 'tasks' | 'readings' | 'notes';

/** Everything is local, so any change just refetches what's on screen. */
export const refreshAll = (qc: QueryClient) => qc.invalidateQueries();

export function useList<T>(collection: Collection, params = '') {
  return useQuery({
    queryKey: ['list', collection, params],
    queryFn: async () =>
      (await get<Page<T>>(`/${collection}?limit=1000${params ? '&' + params : ''}`)).items,
  });
}
export const useSemesters = () => useList<Semester>('semesters');
export const useClasses = () => useList<ClassEntity>('classes');
export const useAssignments = () => useList<Assignment>('assignments');
export const useTasks = () => useList<Task>('tasks');
export const useReadings = () => useList<Reading>('readings');
export const useNotes = () => useList<Note>('notes');

export function useSaveMutation<T extends { id: string }>(collection: Collection) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: Record<string, unknown> }) =>
      id ? patch<T>(`/${collection}/${id}`, data) : post<T>(`/${collection}`, data),
    onSuccess: () => refreshAll(qc),
    onError: (e: Error) => useUi.getState().toast(e.message),
  });
}

/** Delete with an undo toast that re-creates the item from a snapshot. */
export function useDeleteWithUndo<T extends { id: string }>(
  collection: Collection,
  label: (x: T) => string,
) {
  const qc = useQueryClient();
  return async (item: T) => {
    try {
      await del(`/${collection}/${item.id}`);
    } catch (e) {
      useUi.getState().toast((e as Error).message);
      return;
    }
    await refreshAll(qc);
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      ...rest
    } = item as unknown as Record<string, unknown>;
    void _id;
    void _c;
    void _u;
    useUi.getState().toast(`Deleted ${label(item)}`, {
      actionLabel: 'Undo',
      onAction: async () => {
        await post(`/${collection}`, rest);
        await refreshAll(qc);
      },
    });
  };
}

export function useSelectedSemester() {
  const { data: semesters = [] } = useSemesters();
  const id = useUi((s) => s.semesterId);
  const sem =
    semesters.find((s) => s.id === id) ?? semesters.find((s) => s.isCurrent) ?? semesters[0];
  return { semester: sem, semesters, loaded: semesters.length > 0 };
}
