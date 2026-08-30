'use client';

import { useEffect } from 'react';

type ScrollLockSnapshot = {
  scrollX: number;
  scrollY: number;
  htmlOverflow: string;
  htmlOverscrollBehavior: string;
  bodyOverflow: string;
  bodyOverscrollBehavior: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
  bodyPaddingRight: string;
};

let lockCount = 0;
let snapshot: ScrollLockSnapshot | null = null;

function acquireScrollLock() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  lockCount += 1;
  if (lockCount > 1) return;

  const html = document.documentElement;
  const body = document.body;
  const scrollbarWidth = Math.max(0, window.innerWidth - html.clientWidth);
  const computedPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

  snapshot = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    htmlOverflow: html.style.overflow,
    htmlOverscrollBehavior: html.style.overscrollBehavior,
    bodyOverflow: body.style.overflow,
    bodyOverscrollBehavior: body.style.overscrollBehavior,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyLeft: body.style.left,
    bodyRight: body.style.right,
    bodyWidth: body.style.width,
    bodyPaddingRight: body.style.paddingRight,
  };

  html.style.overflow = 'hidden';
  html.style.overscrollBehavior = 'none';
  body.style.overflow = 'hidden';
  body.style.overscrollBehavior = 'none';
  body.style.position = 'fixed';
  body.style.top = `-${snapshot.scrollY}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.width = '100%';

  // Avoid a horizontal layout jump when the desktop scrollbar disappears.
  if (scrollbarWidth > 0) {
    body.style.paddingRight = `${computedPaddingRight + scrollbarWidth}px`;
  }
}

function releaseScrollLock() {
  if (lockCount === 0) return;

  lockCount -= 1;
  if (lockCount > 0 || !snapshot || typeof document === 'undefined' || typeof window === 'undefined') return;

  const html = document.documentElement;
  const body = document.body;
  const previous = snapshot;
  snapshot = null;

  html.style.overflow = previous.htmlOverflow;
  html.style.overscrollBehavior = previous.htmlOverscrollBehavior;
  body.style.overflow = previous.bodyOverflow;
  body.style.overscrollBehavior = previous.bodyOverscrollBehavior;
  body.style.position = previous.bodyPosition;
  body.style.top = previous.bodyTop;
  body.style.left = previous.bodyLeft;
  body.style.right = previous.bodyRight;
  body.style.width = previous.bodyWidth;
  body.style.paddingRight = previous.bodyPaddingRight;

  window.scrollTo(previous.scrollX, previous.scrollY);
}

/**
 * Freezes the page behind an overlay while leaving the overlay's own scrollable
 * regions usable. Locks are reference counted so stacked dialogs cannot unlock
 * one another when the top dialog closes.
 */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    acquireScrollLock();
    return releaseScrollLock;
  }, [active]);
}
