import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyBootAppearance } from "~/lib/boot";
import { WorkspaceApp } from "~/windows/workspace/WorkspaceApp";
import "~/theme/theme.css";
import "~/assets/fonts/fonts.css";
// Side-effect: stamp body[data-os] for platform-specific chrome (traffic lights).
import "~/lib/osClass";

void applyBootAppearance().finally(() => {
  const embedded = new URLSearchParams(location.search).get("embedded") === "1";
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <WorkspaceApp embedded={embedded} />
    </StrictMode>,
  );
});
