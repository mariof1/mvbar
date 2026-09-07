'use client';

import { useEffect, useRef, type RefObject } from 'react';

const dialogs: HTMLElement[] = [];

/** Keep keyboard and programmatic focus in the topmost dialog. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement);

  const wasOpen = useRef(false);
  if (enabled && !wasOpen.current) opener.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement;
  wasOpen.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    const dialog = ref.current;
    if (!dialog) return;
    const returnFocus = opener.current;
    dialogs.push(dialog);
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]'
    )).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    if (!dialog.contains(document.activeElement)) focusFirst();
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first || !dialog.contains(document.activeElement) ||
            (event.shiftKey && document.activeElement === first) ||
            (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last ?? dialog : first ?? dialog).focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (dialogs[dialogs.length - 1] === dialog && !dialog.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus);
      dialogs.splice(dialogs.indexOf(dialog), 1);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [ref, enabled]);
}
