'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Only the newest request for the current selection may update its view. */
export function useLatestRequest(selection: unknown, token: string | null) {
  const current = useRef({ selection, token });
  current.current = { selection, token };
  const generation = useRef(0);
  useEffect(() => {
    const counter = generation;
    return () => { ++counter.current; };
  }, [selection, token]);
  return useCallback(() => {
    if (current.current.selection !== selection || current.current.token !== token) return () => false;
    const request = ++generation.current;
    return () => request === generation.current && current.current.selection === selection && current.current.token === token;
  }, [selection, token]);
}
