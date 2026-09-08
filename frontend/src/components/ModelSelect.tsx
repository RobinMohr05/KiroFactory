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
  // control shows the saved value instead of appearing blank. Per Requirement 6,
  // this option is disabled so users cannot select it — it only serves as a
  // display affordance to show the saved value. The !loading guard is
  // intentionally omitted: we want the "(not detected)" label to be shown
  // consistently from the first render (before the fetch resolves), so there
  // is no label flash on mount for saved values that aren't in the list.
  // valueIsKnown returns false when models is [] (during loading), so the
  // synthetic option appears immediately and disappears once loading confirms
  // the value is a known model.
  const valueIsKnown =
    value === '' || models.some((m) => m.id === value);
  const syntheticOption =
    value !== '' && !valueIsKnown
      ? [{ label: `${value} (not detected)`, value, disabled: true }]
      : [];

  const options = [AUTO_OPTION, ...modelOptions, ...syntheticOption];

  // Case-insensitive substring match against the option's value (model id).
  // Disabled entries (the synthetic "(not detected)" option) are always
  // excluded from the visible dropdown — the synthetic option exists solely so
  // antd can resolve its label when it is the selected value, but it must not
  // appear as a choosable item in the list (Requirement 6).
  const filterOption = (input: string, option?: { value: string; label: string; disabled?: boolean }) => {
    if (!option) return false;
    // Never show the "(not detected)" synthetic option in the dropdown list.
    if (option.disabled) return false;
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
      // autoClearSearchValue={true} (the default — set explicitly for clarity):
      // clears the search input text after the user selects an option from the
      // dropdown.
      // Note: the guarantee that arbitrary typed text is never committed as a
      // value (Requirement 5) comes from antd Select's default behavior —
      // onChange only fires on an explicit option selection, not on blur/close.
      // This is unrelated to autoClearSearchValue.
      autoClearSearchValue={true}
    />
  );
}
