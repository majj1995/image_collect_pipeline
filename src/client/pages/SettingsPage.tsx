import CheckCircle from "lucide-react/dist/esm/icons/circle-check.mjs";
import CircleOff from "lucide-react/dist/esm/icons/circle-off.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LocalSettings, ProviderStatus } from "../../shared/contracts.js";
import { sanitizePublicHttpUrl } from "../../shared/public-url.js";
import { useApi } from "../api.js";

const rightsPolicyLabels: Record<ProviderStatus["rightsPolicy"], string> = {
  open: "开放许可发现",
  discovery_only: "仅用于发现",
  contractual: "按合同授权"
};

const credentialModeLabels: Record<ProviderStatus["credentialMode"], string> = {
  none: "免 Key",
  optional: "免 Key（可选免费 Key）",
  required: "免费 Key / 账号",
  approval: "免费申请 / 审批"
};

const sourceCategoryLabels: Record<ProviderStatus["sourceCategory"], string> = {
  general: "通用图片",
  culture: "公共馆藏",
  commerce: "商品 / 图库",
  ad_library: "广告资料库"
};

const formatLabels: Record<LocalSettings["cache"]["supportedFormats"][number], string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP"
};

type SaveState = "idle" | "saving" | "saved" | "error";

export function SettingsPage() {
  const api = useApi();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [settings, setSettings] = useState<LocalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const lastSavedRef = useRef<LocalSettings | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void Promise.all([api.listProviders(), api.getSettings()]).then(
      ([providerResponse, loadedSettings]) => {
        if (!active) return;
        setProviders(providerResponse.items);
        setSettings(loadedSettings);
        lastSavedRef.current = loadedSettings;
        setLoadError(null);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setLoadError("无法读取本地设置，请确认后端已启动。");
        setLoading(false);
      }
    );
    return () => { active = false; mountedRef.current = false; };
  }, [api]);

  const persist = async (next: LocalSettings, rollback: LocalSettings, failureMessage: string) => {
    setSaveState("saving");
    setSaveMessage("正在保存设置…");
    try {
      const stored = await api.updateSettings(next);
      if (!mountedRef.current) return;
      setSettings(stored);
      lastSavedRef.current = stored;
      setSaveState("saved");
      setSaveMessage("设置已保存");
    } catch {
      if (!mountedRef.current) return;
      setSettings(rollback);
      setSaveState("error");
      setSaveMessage(failureMessage);
    }
  };

  const updateDeclaration = (provider: ProviderStatus, checked: boolean) => {
    if (!settings || saveState === "saving") return;
    const rollback = settings;
    const next: LocalSettings = {
      ...settings,
      contractualRightsDeclarations: {
        ...settings.contractualRightsDeclarations,
        [provider.id]: checked
      }
    };
    setSettings(next);
    void persist(next, rollback, "声明保存失败，已恢复上次设置。");
  };

  const updateCache = <Key extends keyof LocalSettings["cache"]>(key: Key, value: LocalSettings["cache"][Key]) => {
    setSettings((current) => current ? { ...current, cache: { ...current.cache, [key]: value } } : current);
    setSaveState("idle");
    setSaveMessage(null);
  };

  const toggleFormat = (format: LocalSettings["cache"]["supportedFormats"][number], checked: boolean) => {
    if (!settings) return;
    const formats = checked
      ? [...new Set([...settings.cache.supportedFormats, format])]
      : settings.cache.supportedFormats.filter((item) => item !== format);
    if (formats.length === 0) return;
    updateCache("supportedFormats", formats);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings || saveState === "saving") return;
    const rollback = lastSavedRef.current ?? settings;
    void persist(settings, rollback, "设置保存失败，已恢复上次设置。");
  };

  return (
    <main className="page page--settings">
      <div className="page-toolbar">
        <div>
          <p className="eyebrow">本地策略与连接</p>
          <h1>本地设置</h1>
          <p className="page-description">查看图片搜索来源，设置默认地区与安全阈值；浏览器只接收凭据变量名，不接触任何凭据值。</p>
        </div>
      </div>

      {loadError ? <div className="inline-notice inline-notice--error" role="alert">{loadError}</div> : null}
      {loading ? <div className="settings-loading" role="status">正在读取本地设置…</div> : null}

      {!loading ? <>
        <section className="settings-section" aria-labelledby="provider-settings-title">
          <div className="settings-section__heading">
            <div><h2 id="provider-settings-title">免费图片搜索提供方</h2><p>免 Key 渠道可直接使用；其余渠道只需免费 Key、免费账号或免费申请。页面不会读取或提交凭据值。</p></div>
          </div>
          <div className="settings-table-scroll">
            <table className="settings-table" aria-label="图片搜索提供方">
              <thead><tr><th scope="col">提供方</th><th scope="col">状态</th><th scope="col">免费接入</th><th scope="col">内容类型</th><th scope="col">免费说明</th><th scope="col">单次上限</th><th scope="col">所需环境变量</th><th scope="col">权利策略</th><th scope="col">合同声明</th></tr></thead>
              <tbody>{providers.map((provider) => (
                <tr key={provider.id}>
                  <th scope="row"><strong>{provider.displayName}</strong><span>{provider.id}</span></th>
                  <td><span className={`provider-state provider-state--${provider.enabled ? "enabled" : "disabled"}`}>{provider.enabled ? <CheckCircle aria-hidden="true" size={14} /> : <CircleOff aria-hidden="true" size={14} />}{provider.configured ? "已配置" : provider.enabled ? "匿名可用" : "未配置"}</span></td>
                  <td><span className={`provider-access provider-access--${provider.credentialMode}`}>{credentialModeLabels[provider.credentialMode]}</span></td>
                  <td>{sourceCategoryLabels[provider.sourceCategory]}</td>
                  <td><div className="provider-free-tier"><span>{provider.freeTier}</span>{sanitizePublicHttpUrl(provider.docsUrl) ? <a href={provider.docsUrl} target="_blank" rel="noreferrer" aria-label={`查看 ${provider.displayName} 官方说明`}>官方说明</a> : null}</div></td>
                  <td>{provider.maxResults} / 次</td>
                  <td><div className="provider-env-list">{provider.credentialVariables.length ? provider.credentialVariables.map((name) => <code key={name}>{name}</code>) : <span>无需变量</span>}</div></td>
                  <td>{rightsPolicyLabels[provider.rightsPolicy]}</td>
                  <td>{provider.rightsPolicy === "contractual" && settings ? (
                    <label className="settings-switch">
                      <input
                        type="checkbox"
                        checked={Boolean(settings.contractualRightsDeclarations[provider.id])}
                        disabled={saveState === "saving"}
                        aria-label={`声明 ${provider.displayName} 已取得合同存储与训练权利`}
                        onChange={(event) => updateDeclaration(provider, event.currentTarget.checked)}
                      />
                      <span>{settings.contractualRightsDeclarations[provider.id] ? "已声明" : "未声明"}</span>
                    </label>
                  ) : <span aria-label="不适用">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        {settings ? <form className="settings-section settings-form" onSubmit={submit}>
          <div className="settings-section__heading">
            <div><h2>搜索与缓存安全</h2><p>这些阈值会直接应用到新搜索和素材下载，只能比系统硬限制更严格。</p></div>
          </div>
          <div className="settings-grid">
            <label className="field"><span>默认语言地区</span><input aria-label="默认语言地区" disabled={saveState === "saving"} required pattern="[a-z]{2,3}(-[A-Z]{2})?" value={settings.defaultLocale} onChange={(event) => { setSettings({ ...settings, defaultLocale: event.currentTarget.value }); setSaveState("idle"); setSaveMessage(null); }} /><small>例如 zh-CN、en-GB</small></label>
            <label className="field"><span>默认国家</span><input aria-label="默认国家" disabled={saveState === "saving"} required pattern="[A-Z]{2}" maxLength={2} value={settings.defaultCountry} onChange={(event) => { setSettings({ ...settings, defaultCountry: event.currentTarget.value.toUpperCase() }); setSaveState("idle"); setSaveMessage(null); }} /><small>ISO 两位国家码</small></label>
            <label className="settings-check"><input type="checkbox" aria-label="默认启用安全搜索" disabled={saveState === "saving"} checked={settings.safeSearch} onChange={(event) => { setSettings({ ...settings, safeSearch: event.currentTarget.checked }); setSaveState("idle"); setSaveMessage(null); }} /><span><strong>默认启用安全搜索</strong><small>只有明确允许风险类别的内容审核任务才可按受控规则降低过滤。</small></span></label>
          </div>
          <div className="settings-grid settings-grid--limits">
            <label className="field"><span>下载超时（毫秒）</span><input aria-label="下载超时（毫秒）" disabled={saveState === "saving"} type="number" min={100} max={20_000} required value={settings.cache.downloadTimeoutMs} onChange={(event) => updateCache("downloadTimeoutMs", Number(event.currentTarget.value))} /><small>硬上限 20,000</small></label>
            <label className="field"><span>最大文件字节数</span><input aria-label="最大文件字节数" disabled={saveState === "saving"} type="number" min={1_024} max={25_000_000} required value={settings.cache.maxBytes} onChange={(event) => updateCache("maxBytes", Number(event.currentTarget.value))} /><small>硬上限 25,000,000</small></label>
            <label className="field"><span>最大像素数</span><input aria-label="最大像素数" disabled={saveState === "saving"} type="number" min={16_384} max={100_000_000} required value={settings.cache.maxPixels} onChange={(event) => updateCache("maxPixels", Number(event.currentTarget.value))} /><small>硬上限 100 MP</small></label>
            <label className="field"><span>最小边长</span><input aria-label="最小边长" disabled={saveState === "saving"} type="number" min={128} max={10_000} required value={settings.cache.minDimension} onChange={(event) => updateCache("minDimension", Number(event.currentTarget.value))} /><small>至少 128 px，可提高</small></label>
          </div>
          <fieldset className="settings-formats" disabled={saveState === "saving"}><legend>允许的静态图片格式</legend><div>{Object.entries(formatLabels).map(([format, label]) => <label key={format}><input type="checkbox" checked={settings.cache.supportedFormats.includes(format as keyof typeof formatLabels)} onChange={(event) => toggleFormat(format as keyof typeof formatLabels, event.currentTarget.checked)} />{label}</label>)}</div></fieldset>
          <div className="settings-actions">
            {saveMessage ? <p className={saveState === "error" ? "settings-save-message settings-save-message--error" : "settings-save-message"} role={saveState === "error" ? "alert" : "status"} aria-label="设置保存状态">{saveMessage}</p> : <span />}
            <button className="button button--primary" type="submit" disabled={saveState === "saving"}><Save aria-hidden="true" size={15} />{saveState === "saving" ? "正在保存…" : "保存本地设置"}</button>
          </div>
        </form> : null}
      </> : null}
    </main>
  );
}
