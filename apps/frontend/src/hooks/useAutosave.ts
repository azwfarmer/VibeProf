import { useEffect } from "react";

export function useAutosave<T>(value: T, save: (value: T) => void) {
  useEffect(() => {
    const timeout = window.setTimeout(() => save(value), 250);

    return () => window.clearTimeout(timeout);
  }, [save, value]);
}
