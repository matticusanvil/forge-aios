import { useEffect, useState, type RefObject } from 'react';
import type { JumpTarget } from './activity.ts';

export type Jump = JumpTarget & { n: number };

/**
 * Scrolls a conversation to a chat item and flashes it, when a jump is aimed at this conversation's scope.
 * Retries for a moment, since a subagent's feed may still be mounting after its card was selected.
 */
export function useJump(container: RefObject<HTMLElement | null>, scope: string | null, jump: Jump | null): void {
  useEffect(() => {
    if (!jump || jump.scope !== scope) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      const el = container.current?.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(jump.id)}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.remove('is-flash');
        void el.offsetWidth; // restart the flash if it's already running
        el.classList.add('is-flash');
        timer = setTimeout(() => el.classList.remove('is-flash'), 1600);
      } else if (tries++ < 10) {
        timer = setTimeout(attempt, 100);
      }
    };
    attempt();
    return () => clearTimeout(timer);
  }, [jump, scope, container]);
}

/** The current time, ticking every few seconds, for "how recent" displays. */
export function useNow(everyMs = 10_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
