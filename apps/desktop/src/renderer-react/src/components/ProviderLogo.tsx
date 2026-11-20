import { useState } from "react";
import { isProviderBrand, resolveProviderBrand, type ProviderBrand, type ProviderBrandIdentity } from "../lib/providerBrands";
import { isProviderLogo } from "../lib/providerLogoUpload";
import { PROVIDER_BRAND_ASSETS } from "../lib/providerBrandAssets";

export interface ProviderLogoProps extends ProviderBrandIdentity {
  logoDataUrl?: string;
  logoBrand?: ProviderBrand;
  className?: string;
}

export function ProviderLogo({ label, baseUrl, provider, logoDataUrl, logoBrand, className }: ProviderLogoProps) {
  const [failedLogo, setFailedLogo] = useState<string>();
  const customLogo = isProviderLogo(logoDataUrl) && logoDataUrl !== failedLogo ? logoDataUrl : undefined;
  const brand = isProviderBrand(logoBrand) ? logoBrand : resolveProviderBrand({ label, baseUrl, provider });
  const asset = brand ? PROVIDER_BRAND_ASSETS[brand] : undefined;
  const fallback = Array.from(label.trim() || provider.trim() || "?")[0].toUpperCase();

  return (
    <span
      aria-hidden="true"
      data-provider-brand={customLogo ? "custom" : (brand ?? "unknown")}
      className={`grid shrink-0 place-items-center overflow-hidden rounded-md bg-muted/60 text-foreground ring-1 ring-inset ring-border/40 ${className ?? "size-6"}`}
    >
      {customLogo ? (
        <img src={customLogo} alt="" className="size-3/4 object-contain" onError={() => setFailedLogo(customLogo)} />
      ) : asset?.monochrome ? (
        <span
          className="block size-3/4 bg-current"
          style={{ mask: `url("${asset.src}") center / contain no-repeat`, WebkitMask: `url("${asset.src}") center / contain no-repeat` }}
        />
      ) : asset ? (
        <img src={asset.src} alt="" className="size-3/4 object-contain" />
      ) : (
        <span className="text-[11px] font-semibold leading-none">{fallback}</span>
      )}
    </span>
  );
}
