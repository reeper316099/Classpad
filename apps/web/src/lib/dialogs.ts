import { create } from 'zustand';

interface DialogState {
  assignment: { open: boolean; id?: string; classId?: string };
  klass: { open: boolean; id?: string };
  semester: { open: boolean; id?: string };
  openAssignment: (o?: { id?: string; classId?: string }) => void;
  openClass: (id?: string) => void;
  openSemester: (id?: string) => void;
  close: () => void;
}

export const useDialogs = create<DialogState>((set) => ({
  assignment: { open: false },
  klass: { open: false },
  semester: { open: false },
  openAssignment: (o = {}) => set({ assignment: { open: true, ...o } }),
  openClass: (id) => set({ klass: { open: true, id } }),
  openSemester: (id) => set({ semester: { open: true, id } }),
  close: () =>
    set({ assignment: { open: false }, klass: { open: false }, semester: { open: false } }),
}));
