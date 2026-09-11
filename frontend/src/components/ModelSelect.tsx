import { useEffect, useRef, useState } from 'react';
import { Select } from 'antd';
import { apiFetch } from '../utils/api';

interface DetectedModel {
  id: string;
  name: string;
  description?: string | null;
}

interface DetectionError {
  code: 'binary-not-found' | 'timeout' | 'acp-error' | 'no-models-field';
  message: string;
}

interface ModelsResponse {
  default: string;
  models: DetectedModel[];
  /**
   * Present only when detection failed server-side. The component stays usable
   * either way — an empty `models` list yields the synthetic Auto-only option —
   * so this is currently informational (surfaced by the backend for
   * diagnostics/UI messaging) and must never cause a crash when present.
   */
  detectionError?: DetectionError;
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
 * When detection fails or returns nothing, the sole option is the synthetic
 * "Auto (default)" whose value is the empty string (meaning: omit the model),
 * so the component stays fully usable. When detection returns a non-empty list,
 * exactly those models are offered — the agent's own auto entry (modelId:
 * "auto") is already in that list, so no synthetic "Auto (default)" is
 * prepended. While the fetch is loading it renders the Auto-only fallback.
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
  //
  // Product decision: the synthetic "Auto (default)" option (empty-string
  // value) is injected ONLY when the detected models list is empty (detection
  // failed or returned nothing) so the component stays usable. When the backend
  // returns a non-empty list, render exactly the returned models — the agent
  // already returns its own auto entry (modelId: "auto") in that list, so
  // prepending a synthetic "Auto (default)" would duplicate it.
  const modelOptions = models.map((m) => ({ label: m.id, value: m.id }));
  const options = modelOptions.length > 0 ? modelOptions : [AUTO_OPTION];

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
      disabled={disabled}
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
