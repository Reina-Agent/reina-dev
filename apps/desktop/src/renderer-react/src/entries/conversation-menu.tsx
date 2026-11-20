import { createRoot } from "react-dom/client";
import "~/assets/fonts/fonts.css";
import "~/lib/osClass";
import "~/windows/main/icons.js";
import { loadAppearance, subscribeAppearance } from "~/windows/main/legacyAppearance";
import { ConversationMenuWindow } from "~/windows/main/ConversationMenuWindow";
import "~/windows/main/conversation-menu.css";

document.body.dataset.window = "conversation-menu";

void loadAppearance().finally(() => {
  subscribeAppearance();
  createRoot(document.getElementById("root")!).render(<ConversationMenuWindow />);
});
