import { useState, useRef, useCallback, useEffect } from 'react';

export interface ViewModeSliderStep<T extends string> {
  value: T;
  label: string;
}

interface ViewModeSliderProps<T extends string> {
  /** Ordered list of stops. Currently 2 (Easy/Advanced) but designed to take more later. */
  steps: ViewModeSliderStep<T>[];
  /** The currently persisted (committed) value. */
  value: T;
  /**
   * Called only after the user drags/clicks to a new stop AND explicitly
   * confirms. Should persist the change (e.g. call the backend) — if it
   * throws, the slider snaps back to `value` and shows the error.
   */
  onConfirm: (next: T) => Promise<void>;
  /** Optional copy shown in the confirmation prompt. Defaults to a generic message. */
  confirmLabel?: (from: T, to: T) => string;
}

/**
 * A draggable/clickable multi-stop slider that previews a new position
 * immediately (for a fluid, "prettier than a native <input type=range>"
 * feel) but does NOT commit on release. Releasing on a different stop shows
 * an inline Confirm/Cancel prompt; only Confirm calls onConfirm and moves
 * the thumb permanently. Clicking Cancel, clicking elsewhere, or pressing
 * Escape reverts the preview back to the committed `value`.
 *
 * This indirection exists because a real slider is dragged, not clicked —
 * so the app's usual "click again to confirm" button pattern doesn't apply
 * here. See ARCHITECTURE.md / settings docs for why this control needs
 * confirmation at all (switching to "advanced" surfaces loop-engineering
 * concepts some users are still wary of).
 */
export function ViewModeSlider<T extends string>({ steps, value, onConfirm, confirmLabel }: ViewModeSliderProps<T>) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const committedIndex = Math.max(0, steps.findIndex(s => s.value === value));
  const displayIndex = pendingIndex ?? previewIndex ?? committedIndex;

  const indexFromClientX = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (!track || steps.length <= 1) return committedIndex;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (steps.length - 1));
  }, [steps.length, committedIndex]);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) return;
    setPreviewIndex(indexFromClientX(e.clientX));
  }, [indexFromClientX]);

  const handlePointerUp = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const finalIndex = indexFromClientX(e.clientX);
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);

    if (finalIndex === committedIndex) {
      setPreviewIndex(null);
      return;
    }
    // Land on the new stop but hold as "pending" — nothing is committed
    // until the user explicitly confirms.
    setPreviewIndex(null);
    setPendingIndex(finalIndex);
    setError(null);
  }, [indexFromClientX, committedIndex, handlePointerMove]);

  const startDrag = useCallback((clientX: number) => {
    if (pendingIndex !== null) return; // a confirmation is already open — ignore new drags
    draggingRef.current = true;
    setPreviewIndex(indexFromClientX(clientX));
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [pendingIndex, indexFromClientX, handlePointerMove, handlePointerUp]);

  const handleTrackPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    startDrag(e.clientX);
  };

  const handleStepClick = (index: number) => {
    if (pendingIndex !== null) return;
    if (index === committedIndex) return;
    setPendingIndex(index);
    setError(null);
  };

  const handleCancel = useCallback(() => {
    setPendingIndex(null);
    setPreviewIndex(null);
    setError(null);
  }, []);

  const handleConfirm = async () => {
    if (pendingIndex === null) return;
    const next = steps[pendingIndex].value;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(next);
      setPendingIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch view mode.');
    } finally {
      setSaving(false);
    }
  };

  // Escape cancels a pending confirmation.
  useEffect(() => {
    if (pendingIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pendingIndex, handleCancel]);

  // Clean up window listeners if unmounted mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const thumbPercent = steps.length > 1 ? (displayIndex / (steps.length - 1)) * 100 : 0;
  const pendingValue = pendingIndex !== null ? steps[pendingIndex].value : null;
  const committedValue = steps[committedIndex]?.value ?? value;
  const defaultConfirmLabel = (from: T, to: T) => {
    const fromLabel = steps.find(s => s.value === from)?.label ?? from;
    const toLabel = steps.find(s => s.value === to)?.label ?? to;
    return `Switch from ${fromLabel} to ${toLabel}?`;
  };

  return (
    <div className="view-mode-slider">
      <div
        className={`view-mode-slider-track${pendingIndex !== null ? ' is-pending' : ''}`}
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        role="slider"
        aria-label="Interface mode"
        aria-valuemin={0}
        aria-valuemax={steps.length - 1}
        aria-valuenow={displayIndex}
        aria-valuetext={steps[displayIndex]?.label}
        tabIndex={0}
        onKeyDown={(e) => {
          if (pendingIndex !== null) return;
          if (e.key === 'ArrowRight' && committedIndex < steps.length - 1) handleStepClick(committedIndex + 1);
          if (e.key === 'ArrowLeft' && committedIndex > 0) handleStepClick(committedIndex - 1);
        }}
      >
        <div className="view-mode-slider-fill" style={{ width: `${thumbPercent}%` }} />
        {steps.map((step, i) => (
          <button
            type="button"
            key={step.value}
            className={`view-mode-slider-stop${i === displayIndex ? ' is-active' : ''}${i === committedIndex ? ' is-committed' : ''}`}
            style={{ left: steps.length > 1 ? `${(i / (steps.length - 1)) * 100}%` : '0%' }}
            onClick={(e) => { e.stopPropagation(); handleStepClick(i); }}
            aria-label={step.label}
          />
        ))}
        <div
          className="view-mode-slider-thumb"
          style={{ left: `${thumbPercent}%` }}
        />
      </div>
      <div className="view-mode-slider-labels">
        {steps.map((step, i) => (
          <button
            type="button"
            key={step.value}
            className={`view-mode-slider-label${i === displayIndex ? ' is-active' : ''}`}
            style={{ left: steps.length > 1 ? `${(i / (steps.length - 1)) * 100}%` : '0%' }}
            onClick={(e) => { e.stopPropagation(); handleStepClick(i); }}
          >
            {step.label}
          </button>
        ))}
      </div>

      {pendingIndex !== null && pendingValue !== null && (
        <div className="view-mode-slider-confirm">
          <span className="view-mode-slider-confirm-text">
            {(confirmLabel || defaultConfirmLabel)(committedValue, pendingValue)}
          </span>
          <div className="view-mode-slider-confirm-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleCancel} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleConfirm} disabled={saving}>
              {saving ? 'Switching…' : 'Confirm'}
            </button>
          </div>
        </div>
      )}
      {error && <div className="form-message error">{error}</div>}
    </div>
  );
}
