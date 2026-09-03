import CheckCircle from "lucide-react/dist/esm/icons/circle-check.mjs";
import CircleOff from "lucide-react/dist/esm/icons/circle-off.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderCredentialMode, ProviderId, ProviderStatus } from "../../../shared/contracts.js";

interface ProviderPickerProps {
  providers: ProviderStatus[];
  selectedIds: ProviderId[];
  onChange(selectedIds: ProviderId[]): void;
}

const accessLabels: Record<ProviderCredentialMode, string> = {
  none: "免 Key",
  optional: "免 Key（可选免费 Key）",
  required: "免费 Key / 账号",
  approval: "免费申请 / 审批"
};

const groups: Array<{ label: string; modes: ProviderCredentialMode[] }> = [
  { label: "免 Key 渠道", modes: ["none", "optional"] },
  { label: "免费 Key 或账号", modes: ["required"] },
  { label: "免费申请或审批", modes: ["approval"] }
];

export function ProviderPicker({ providers, selectedIds, onChange }: ProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const enabledProviders = useMemo(() => providers.filter((provider) => provider.enabled), [providers]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const replaceSelection = (next: ProviderStatus[]) => {
    const ids = new Set(next.filter((provider) => provider.enabled).map((provider) => provider.id));
    onChange(providers.filter((provider) => ids.has(provider.id)).map((provider) => provider.id));
  };

  const toggle = (provider: ProviderStatus, checked: boolean) => {
    if (!provider.enabled) return;
    const next = new Set(selected);
    if (checked) next.add(provider.id); else next.delete(provider.id);
    onChange(providers.filter((item) => item.enabled && next.has(item.id)).map((item) => item.id));
  };

  return <div className="provider-picker" ref={rootRef}>
    <button
      className="button button--secondary provider-picker__trigger"
      type="button"
      aria-label={`选择搜索来源，已选 ${selectedIds.length} 个`}
      aria-expanded={open}
      aria-controls="search-provider-picker"
      onClick={() => setOpen((value) => !value)}
    >
      <SlidersHorizontal aria-hidden="true" size={15} />来源 {selectedIds.length}/{enabledProviders.length}
    </button>
    {open ? <div id="search-provider-picker" className="provider-picker__panel" role="dialog" aria-label="搜索来源">
      <div className="provider-picker__heading">
        <div><strong>本次搜索来源</strong><span>未配置的渠道会保留展示，但不能勾选。</span></div>
        <span>{selectedIds.length} / {enabledProviders.length} 个可用来源</span>
      </div>
      <div className="provider-picker__quick-actions">
        <button type="button" onClick={() => replaceSelection(enabledProviders)}>全选可用</button>
        <button type="button" onClick={() => replaceSelection(enabledProviders.filter((provider) => provider.credentialMode === "none" || provider.credentialMode === "optional"))}>仅选免 Key</button>
        <button type="button" onClick={() => onChange([])}>清空</button>
      </div>
      <div className="provider-picker__groups">
        {groups.map((group) => <fieldset key={group.label} className="provider-picker__group">
          <legend>{group.label}</legend>
          {providers.filter((provider) => group.modes.includes(provider.credentialMode)).map((provider) => <label key={provider.id} className={provider.enabled ? "provider-picker__option" : "provider-picker__option is-disabled"}>
            <input
              type="checkbox"
              checked={selected.has(provider.id)}
              disabled={!provider.enabled}
              onChange={(event) => toggle(provider, event.currentTarget.checked)}
            />
            <span className="provider-picker__option-copy">
              <strong>{provider.displayName}</strong>
              <small>{accessLabels[provider.credentialMode]} · {provider.freeTier}</small>
            </span>
            <span className={provider.enabled ? "provider-picker__availability is-enabled" : "provider-picker__availability"}>
              {provider.enabled ? <CheckCircle aria-hidden="true" size={13} /> : <CircleOff aria-hidden="true" size={13} />}
              {provider.enabled ? "可用" : "待配置"}
            </span>
          </label>)}
        </fieldset>)}
      </div>
      <div className="provider-picker__footer">
        <span>选择会应用到下一次“继续搜索”</span>
        <button className="button button--primary" type="button" onClick={() => setOpen(false)}>完成</button>
      </div>
    </div> : null}
  </div>;
}
