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
  disabled?: boolean;
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
 * fetched option, a `labelInValue` shape is passed so antd displays a
 * "(not detected)" label in the trigger face — without adding any synthetic
 * entry to the dropdown option list (Requirement 6: the synthetic display
 * affordance must NOT appear as a choosable item in the open dropdown).
 *
 * Exposes value/onChange props so it's a drop-in for the existing model
 * fields (SessionModal).
 */
export function ModelSelect({ value, onChange, id, placeholder, disabled }: ModelSelectProps) {
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

  // Build the list of options from fetched models. Only real, selectable
  // options live here — no synthetic entries.
  const modelOptions = models.map((m) => ({ label: m.id, value: m.id }));
  const options = [AUTO_OPTION, ...modelOptions];

  // Determine if the current value is "unknown" — a non-empty value not in
  // the fetched list.
  //
  // The !loading guard prevents the "(not detected)" flash during every page
  // load: while loading, models is still [], so valueIsKnown evaluates to
  // false for *any* non-empty value — including models that will appear in the
  // fetched list. Gating on !loading means we only apply the "(not detected)"
  // label once the fetch has settled, so only genuinely absent models ever
  // get it.
  const valueIsKnown = value === '' || models.some((m) => m.id === value);
  const isUnknownValue = !loading && value !== '' && !valueIsKnown;

  // When the value is unknown, use antd's `labelInValue` shape so antd can
  // display the custom "(not detected)" label in the trigger face without
  // requiring that model to exist in the options list. This keeps the dropdown
  // list clean — no disabled synthetic entry clutters the choosable options.
  //
  // When the value is known (or empty), pass a `labelInValue` shape too, for
  // consistency (antd resolves the label from the options array in that case).
  const selectValue = isUnknownValue
    ? { value, label: `${value} (not detected)` }
    : { value, label: value === '' ? 'Auto (default)' : value };

  // Wrap onChange to extract the raw string value from the labelInValue object
  // that antd passes when `labelInValue` is enabled — keeping the public API
  // as `onChange: (value: string) => void`.
  const handleChange = (selected: { value: string; label: string }) => {
    onChange(selected.value);
  };

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
      labelInValue
      value={selectValue}
      placeholder={placeholder}
      onChange={handleChange}
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
