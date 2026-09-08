import { useEffect, useRef, useState } from 'react';
import { Select } from 'antd';
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

const AUTO_OPTION = { label: 'Auto (default)', value: '' };

/**
 * A searchable combobox for selecting a kiro-cli model, backed by antd's
 * Select component. It fetches the models the installed kiro-cli supports
 * from GET /api/models on mount and offers them as filterable options.
 *
 * The user can only commit a value that is an actual option — arbitrary typed
 * text is never committed (typing only filters the dropdown; blurring without
 * selecting discards the search text and restores the prior value).
 *
 * The first option is always "Auto (default)" whose value is the empty string
 * (meaning: omit the model). While the fetch is loading or if it fails, the
 * component renders with just that Auto option and stays fully usable.
 *
 * If the incoming `value` is a non-empty string that does not match any
 * fetched option, a synthetic "(not detected)" option is added so the current
 * value is visible and preserved. It is removed as soon as the user selects
 * a different option.
 *
 * Exposes value/onChange props so it's a drop-in for the existing model
 * fields (SessionModal).
 */
export function ModelSelect({ value, onChange, id, placeholder }: ModelSelectProps) {
  const [models, setModels] = useState<DetectedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
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
      } finally {
        if (mounted.current) {
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  // Build the list of options from fetched models.
  const modelOptions = models.map((m) => ({ label: m.id, value: m.id }));

  // Determine if the current value is "unknown" — a non-empty value not in
  // the fetched list. If so, add a synthetic "(not detected)" option so the
  // control shows the saved value instead of appearing blank.
  const valueIsKnown =
    value === '' || models.some((m) => m.id === value);
  const syntheticOption =
    !loading && value !== '' && !valueIsKnown
      ? [{ label: `${value} (not detected)`, value }]
      : [];

  const options = [AUTO_OPTION, ...modelOptions, ...syntheticOption];

  // Case-insensitive substring match against the option's value (model id).
  const filterOption = (input: string, option?: { value: string; label: string }) => {
    if (!option) return false;
    // Always show "Auto (default)" regardless of filter text.
    if (option.value === '') return true;
    return option.value.toLowerCase().includes(input.toLowerCase());
  };

  return (
    <Select
      id={id}
      showSearch
      loading={loading}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      options={options}
      filterOption={filterOption}
      style={{ width: '100%' }}
      // When the user blurs without selecting, discard typed text and restore
      // the prior committed value. antd Select does this by default when
      // autoClearSearchValue is true (the default), but set it explicitly.
      autoClearSearchValue={true}
    />
  );
}
