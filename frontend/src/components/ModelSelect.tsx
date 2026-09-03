import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';

interface DetectedModel {
  id: string;
  name: string;
  description?: string | null;
}

interface ModelsResponse {
  default: string;
  models: DetectedModel[];
}

interface ModelSelectProps {
  /**
   * Current model value. The empty string means "Auto (default)" — i.e. do
   * not send a model and let kiro-cli decide.
   */
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
}

/**
 * A searchable combobox for selecting a kiro-cli model, backed by a native
 * <datalist>. It fetches the models the installed kiro-cli supports from
 * GET /api/models on mount and offers them as filterable suggestions, while
 * still accepting any free-typed value (so an undetected-but-valid model can
 * be entered).
 *
 * The first option is always "Auto (default)" whose value is the empty string
 * (meaning: omit the model). While the fetch is loading or if it fails, the
 * component renders with just that Auto option and stays fully usable.
 *
 * Exposes value/onChange props so it's a drop-in for the existing model
 * fields (SessionModal, FlockPanel).
 */
export function ModelSelect({ value, onChange, id, placeholder }: ModelSelectProps) {
  const [models, setModels] = useState<DetectedModel[]>([]);
  // A stable listId so the input can point its `list` attribute at the datalist.
  const listId = `${id ?? 'model-select'}-list`;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const res = await apiFetch('/api/models');
        if (!res.ok) return;
        const data: ModelsResponse = await res.json();
        if (mounted.current && Array.isArray(data.models)) {
          setModels(data.models);
        }
      } catch {
        // Detection unavailable — stay usable with just the Auto option.
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <>
      <input
        type="text"
        id={id}
        role="combobox"
        list={listId}
        className="model-select-input"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {/* Empty value = "Auto (default)": omit the model, let kiro-cli decide. */}
        <option value="">Auto (default)</option>
        {models.map((m) => (
          <option
            key={m.id}
            value={m.id}
            label={m.name}
            title={m.description ?? undefined}
          >
            {m.name}
          </option>
        ))}
      </datalist>
    </>
  );
}
