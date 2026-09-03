import { useCallback, useRef, useState } from 'react';
import { KIRO_MODELS } from '../constants/models';

interface ModelComboboxProps {
  /** Current committed model id ('' or 'auto' both mean "no explicit model / default"). */
  value: string;
  onChange: (id: string) => void;
  id?: string;
  placeholder?: string;
}

function labelFor(id: string): string {
  const normalized = id.trim() || 'auto';
  const match = KIRO_MODELS.find(m => m.id === normalized);
  return match ? match.name : (KIRO_MODELS.find(m => m.id === 'auto')?.name ?? 'auto');
}

function findMatch(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return KIRO_MODELS.find(m => m.id.toLowerCase() === q || m.name.toLowerCase() === q);
}

/**
 * A restricted, searchable combobox for selecting a Kiro model.
 * Only values matching an entry in KIRO_MODELS (by id or name) can be committed —
 * anything else reverts to the last valid selection on blur/Enter-away.
 */
export function ModelCombobox({ value, onChange, id, placeholder }: ModelComboboxProps) {
  const [query, setQuery] = useState(labelFor(value));
  const [listVisible, setListVisible] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const getFiltered = useCallback(() => {
    const q = query.trim().toLowerCase();
    if (!q) return KIRO_MODELS;
    return KIRO_MODELS.filter(m =>
      m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [query]);

  const filtered = getFiltered();

  const commit = (modelId: string) => {
    setQuery(labelFor(modelId));
    setListVisible(false);
    setHighlightIndex(-1);
    onChange(modelId);
  };

  const revert = () => {
    setQuery(labelFor(value));
    setListVisible(false);
    setHighlightIndex(-1);
  };

  const handleBlur = () => {
    // Options use onMouseDown (which fires before blur) to commit a selection,
    // so by the time blur runs, a click-selected option has already been committed.
    const match = findMatch(query);
    if (match) {
      if (match.id !== (value.trim() || 'auto')) {
        onChange(match.id);
      }
      setQuery(labelFor(match.id));
    } else {
      revert();
    }
    setListVisible(false);
    setHighlightIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setListVisible(true);
      setHighlightIndex(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < filtered.length) {
        commit(filtered[highlightIndex].id);
      } else {
        const match = findMatch(query);
        if (match) {
          commit(match.id);
        } else {
          revert();
        }
      }
    } else if (e.key === 'Escape') {
      revert();
    }
  };

  return (
    <div className="combobox-wrapper">
      <input
        ref={inputRef}
        type="text"
        id={id}
        className="combobox-input"
        role="combobox"
        aria-expanded={listVisible}
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setListVisible(true);
          setHighlightIndex(-1);
        }}
        onFocus={() => setListVisible(true)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
      {listVisible && filtered.length > 0 && (
        <ul className="combobox-listbox" role="listbox">
          {filtered.map((m, idx) => (
            <li
              key={m.id}
              className={`combobox-option${idx === highlightIndex ? ' highlighted' : ''}`}
              role="option"
              aria-selected={idx === highlightIndex}
              onMouseDown={(e) => { e.preventDefault(); commit(m.id); }}
            >
              {m.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
