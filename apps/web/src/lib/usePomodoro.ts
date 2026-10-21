import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from './api.js';
import { refreshAll } from './hooks.js';
import {
  fmtClock,
  isFinished,
  next,
  pause,
  phaseMs,
  remainingMs,
  resume,
  startFocus,
  type TimerState,
} from './pomodoro.js';
import { useUi } from './store.js';

export interface Link {
  classId?: string;
  taskId?: string;
  assignmentId?: string;
}
const KEY = 'classpad-pomodoro';
interface Saved {
  timer: TimerState | null;
  link: Link;
  serverOn: boolean;
}
const load = (): Saved => {
  try {
    return {
      timer: null,
      link: {},
      serverOn: false,
      ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>),
    };
  } catch {
    return { timer: null, link: {}, serverOn: false };
  }
};

/** The "server timer is running" flag is saved the moment it changes (not only when React state changes). */
const saveServerOn = (on: boolean) => {
  try {
    const cur = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>;
    localStorage.setItem(KEY, JSON.stringify({ ...cur, serverOn: on }));
  } catch {
    /* optional */
  }
};

export function beep() {
  try {
    const ctx = new AudioContext();
    for (const [i, f] of [880, 660].entries()) {
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.frequency.value = f;
      g.gain.value = 0.08;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.28);
      o.stop(ctx.currentTime + i * 0.28 + 0.22);
    }
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    /* audio is optional */
  }
}

export function announce(title: string, body: string) {
  useUi.getState().toast(`${title} ${body}`);
  try {
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification(title, { body, silent: false });
  } catch {
    /* optional */
  }
}

/**
 * Pomodoro controller. Time is derived from timestamps (so throttled background tabs never drift),
 * state survives reloads, and only focus time is logged (pausing or skipping logs what was done).
 */
export function usePomodoro() {
  const cfg = useUi((s) => s.pomodoro);
  const qc = useQueryClient();
  const initial = useRef(load()).current;
  const [timer, setTimer] = useState<TimerState | null>(initial.timer);
  const [link, setLink] = useState<Link>(initial.link);
  const [now, setNow] = useState(Date.now());
  const serverOn = useRef(initial.serverOn);
  const busy = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ timer, link, serverOn: serverOn.current }));
    } catch {
      /* optional */
    }
  }, [timer, link]);
  // trust the server about whether a timer is really running (the saved flag can be stale)
  useEffect(() => {
    get<unknown>('/study-sessions/active').then(
      (a) => {
        serverOn.current = !!a;
        saveServerOn(!!a);
      },
      () => undefined,
    );
  }, []);
  const running = !!timer && timer.endsAt !== null;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  const startServer = useCallback(
    async (l: Link) => {
      if (serverOn.current) return;
      try {
        await post('/study-sessions/start', { ...l, kind: 'pomodoro' });
        serverOn.current = true;
        saveServerOn(true);
      } catch (e) {
        if ((e as { code?: string }).code === 'ALREADY_RUNNING') {
          serverOn.current = true;
          saveServerOn(true);
        } else useUi.getState().toast(`Timer not logged: ${(e as Error).message}`);
      }
      void qc.invalidateQueries({ queryKey: ['study-active'] });
    },
    [qc],
  );
  const stopServer = useCallback(
    async (at?: number) => {
      if (!serverOn.current) return;
      serverOn.current = false;
      saveServerOn(false);
      try {
        await post('/study-sessions/stop', at ? { at: new Date(at).toISOString() } : {});
      } catch {
        /* nothing running */
      }
      await refreshAll(qc);
    },
    [qc],
  );

  const start = useCallback(async () => {
    const t = startFocus(Date.now(), cfg, timer?.completed ?? 0);
    setTimer(t);
    setNow(Date.now());
    await startServer(link);
  }, [cfg, link, startServer, timer?.completed]);
  const pauseT = useCallback(async () => {
    if (!timer) return;
    setTimer(pause(timer, Date.now()));
    if (timer.phase === 'focus') await stopServer();
  }, [timer, stopServer]);
  const resumeT = useCallback(async () => {
    if (!timer) return;
    setTimer(resume(timer, Date.now()));
    setNow(Date.now());
    if (timer.phase === 'focus') await startServer(link);
  }, [timer, link, startServer]);
  const stop = useCallback(async () => {
    await stopServer();
    setTimer(null);
  }, [stopServer]);
  const toReadyFocus = (t: TimerState, at: number) => pause(next(t, at, cfg), at); // after a break: wait for the user

  const skip = useCallback(async () => {
    if (!timer) return;
    const at = Date.now();
    if (timer.phase === 'focus') {
      await stopServer();
      setTimer(next(timer, at, cfg));
    } else setTimer(toReadyFocus(timer, at));
  }, [timer, cfg, stopServer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!timer || !isFinished(timer, now) || busy.current) return;
    busy.current = true;
    const end = timer.endsAt!;
    (async () => {
      if (timer.phase === 'focus') {
        await stopServer(end);
        announce(
          'Focus session complete',
          `Take a ${next(timer, end, cfg).phase === 'long' ? 'long' : 'short'} break.`,
        );
        beep();
        setTimer(next(timer, end, cfg));
      } else {
        announce('Break over', 'Ready for the next focus session?');
        beep();
        setTimer(toReadyFocus(timer, end));
      }
      busy.current = false;
    })();
  }, [timer, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = timer ? remainingMs(timer, now) : phaseMs('focus', cfg);
  useEffect(() => {
    if (!running || !timer) return;
    const old = document.title;
    document.title = `${fmtClock(remaining)} · ${timer.phase === 'focus' ? 'Focus' : 'Break'}`;
    return () => {
      document.title = old;
    };
  }, [running, remaining, timer]);

  return {
    timer,
    link,
    setLink,
    remaining,
    total: timer ? phaseMs(timer.phase, cfg) : phaseMs('focus', cfg),
    running,
    start,
    pause: pauseT,
    resume: resumeT,
    skip,
    stop,
    cfg,
  };
}
