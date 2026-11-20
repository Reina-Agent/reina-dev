import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyBootAppearance } from "~/lib/boot";
import { SettingsApp } from "~/windows/settings/SettingsApp";
import "~/theme/theme.css";
import "~/assets/fonts/fonts.css";
// Side-effect: stamp body[data-os] for platform-specific chrome (traffic lights).
import "~/lib/osClass";

void applyBootAppearance().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <SettingsApp />
    </StrictMode>,
  );
});
