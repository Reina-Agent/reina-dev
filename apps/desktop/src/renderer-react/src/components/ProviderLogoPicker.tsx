import { useEffect, useRef } from "react";
import { useT } from "../lib/i18n";
import { PROVIDER_BRANDS, type ProviderBrand } from "../lib/providerBrands";
import { ProviderLogo, type ProviderLogoProps } from "./ProviderLogo";

export function ProviderLogoPicker({
  open, identity, busy, error, onClose, onChoose, onUpload, onReset,
}: {
  open: boolean;
  identity: ProviderLogoProps;
  busy: boolean;
  error: string;
  onClose: () => void;
  onChoose: (brand: ProviderBrand) => void;
  onUpload: (file: File) => void;
  onReset: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const automatic = !identity.logoBrand && !identity.logoDataUrl;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    } else {
      dialog.close();
    }
    return () => dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={t("models.chooseLogo")}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="m-auto w-[min(400px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-y-auto rounded-2xl border bg-popover p-0 text-popover-foreground shadow-xl backdrop:bg-black/35"
    >
      <div className="p-4">
        <div className="mb-4 flex items-center gap-3">
          <ProviderLogo {...identity} className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("models.chooseLogo")}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{identity.label}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("models.closeLogoPicker")} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </div>

        <div className="mb-2 text-xs text-muted-foreground">{t("models.builtInLogos")}</div>
        <div className="grid grid-cols-4 gap-1.5" aria-label={t("models.builtInLogos")}>
          {PROVIDER_BRANDS.map((brand) => {
            const selected = !identity.logoDataUrl && identity.logoBrand === brand.id;
            return (
              <button
                key={brand.id}
                type="button"
                aria-label={brand.label}
                aria-pressed={selected}
                disabled={busy}
                onClick={() => onChoose(brand.id)}
                className={`relative flex min-w-0 flex-col items-center gap-1.5 rounded-lg border p-2 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${selected ? "border-ring bg-secondary" : "border-transparent hover:bg-secondary"}`}
              >
                <ProviderLogo label={brand.label} provider="" baseUrl="" logoBrand={brand.id} className="size-8" />
                <span className="max-w-full truncate text-[10px] leading-4">{brand.label}</span>
                {selected && <svg className="absolute right-1 top-1" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex gap-2 border-t pt-3">
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="flex h-8 flex-1 items-center justify-center gap-2 rounded-md border text-xs hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></svg>
            {t("models.uploadLogoImage")}
          </button>
          <button type="button" disabled={busy} aria-pressed={automatic} onClick={onReset} className={`h-8 rounded-md border px-3 text-xs focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${automatic ? "border-ring bg-secondary" : "hover:bg-secondary"}`}>
            {t("models.automaticLogo")}
          </button>
        </div>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" aria-label={t("models.uploadLogo")} hidden onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onUpload(file);
        }} />
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{t("models.logoHint")}</p>
        {(busy || error) && <p role="status" className={`mt-2 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error || t("models.logoSaving")}</p>}
      </div>
    </dialog>
  );
}
