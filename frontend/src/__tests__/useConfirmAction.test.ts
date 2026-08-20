import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConfirmAction } from '../hooks/useConfirmAction';

describe('useConfirmAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in non-pending state', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirmAction(onConfirm));

    expect(result.current.isPending).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('first click enters pending state without executing action', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirmAction(onConfirm));

    act(() => {
      result.current.handleClick();
    });

    expect(result.current.isPending).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('second click within timeout executes the action', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirmAction(onConfirm));

    act(() => {
      result.current.handleClick();
    });
    expect(result.current.isPending).toBe(true);

    act(() => {
      result.current.handleClick();
    });
    expect(result.current.isPending).toBe(false);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('resets to non-pending after timeout expires', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirmAction(onConfirm, 3000));

    act(() => {
      result.current.handleClick();
    });
    expect(result.current.isPending).toBe(true);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.isPending).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not execute action if timeout expires before second click', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirmAction(onConfirm, 3000));

    act(() => {
      result.current.handleClick();
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Now click again — should enter pending again, not execute
    act(() => {
      result.current.handleClick();
    });
    expect(result.current.isPending).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('reset() resets the pending state', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirmAction(onConfirm));

    act(() => {
      result.current.handleClick();
    });
    expect(result.current.isPending).toBe(true);

    act(() => {
      result.current.reset();
    });
    expect(result.current.isPending).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('supports custom timeout', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirmAction(onConfirm, 1000));

    act(() => {
      result.current.handleClick();
    });
    expect(result.current.isPending).toBe(true);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.isPending).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isPending).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
