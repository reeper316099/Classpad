import { create } from 'zustand';

interface DialogState {
  assignment: { open: boolean; id?: string; classId?: string };
  klass: { open: boolean; id?: string };
  semester: { open: boolean; id?: string };
  note: { open: boolean; classId?: string };
  task: { open: boolean; id?: string; classId?: string };
  quickOpen: boolean;
  openAssignment: (o?: { id?: string; classId?: string }) => void;
  openClass: (id?: string) => void;
  openSemester: (id?: string) => void;
  openNote: (classId?: string) => void;
  openTask: (o?: { id?: string; classId?: string }) => void;
  setQuickOpen: (open: boolean) => void;
  close: () => void;
}

export const useDialogs = create<DialogState>((set) => ({
  assignment: { open: false },
  klass: { open: false },
  semester: { open: false },
  note: { open: false },
  task: { open: false },
  quickOpen: false,
  openAssignment: (o = {}) => set({ assignment: { open: true, ...o } }),
  openClass: (id) => set({ klass: { open: true, id } }),
  openSemester: (id) => set({ semester: { open: true, id } }),
  openNote: (classId) => set({ note: { open: true, classId } }),
  openTask: (o = {}) => set({ task: { open: true, ...o } }),
  setQuickOpen: (quickOpen) => set({ quickOpen }),
  close: () =>
    set({
      assignment: { open: false },
      klass: { open: false },
      semester: { open: false },
      note: { open: false },
      task: { open: false },
    }),
}));
