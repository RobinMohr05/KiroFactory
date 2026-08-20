import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Hook implementing a two-click confirm pattern for destructive actions.
 * First click enters a "pending" state (button shows "Confirm?").
 * Second click within timeout (default 3s) executes the action.
 * Timeout resets the button to its original state.
 */
export function useConfirmAction(onConfirm: () => void, timeout = 3000) {
  const [isPending, setIsPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    setIsPending(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleClick = useCallback((e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (isPending) {
      // Second click — confirm
      reset();
      onConfirm();
    } else {
      // First click — enter pending state
      setIsPending(true);
      timerRef.current = setTimeout(reset, timeout);
    }
  }, [isPending, onConfirm, reset, timeout]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { isPending, handleClick, reset };
}
