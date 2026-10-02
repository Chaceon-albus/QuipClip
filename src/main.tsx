import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsWindowRoot } from "./components/settings/SettingsWindowRoot";
import { themePreferenceStore } from "./features/settings/themePreference";
import { initI18n } from "./i18n";
import { applyPlatformAttribute } from "./lib/platform";
import { startThemeSync } from "./lib/theme";
import { applyWindowRoleAttribute, getCurrentWindowRole } from "./lib/windowRole";
import App from "./App";
import "./styles/globals.css";

// `public/theme-init.js` already wrote the theme before the first paint. From here on the
// preference store drives it, so a change in Settings applies at once.
startThemeSync(themePreferenceStore);
// The scroll bar rules of `globals.css` read the platform. The attribute is on <html> before
// the first render, so no frame shows the scroll bars of the other platform.
applyPlatformAttribute();

async function bootstrap(): Promise<void> {
  // The render must not sit on the success path of the localization init. i18next falls
  // back to the key text when no catalog loaded, so a rejection still leaves a usable
  // interface, while skipping the render leaves an empty window with no way to recover.
  try {
    await initI18n();
  } catch (error) {
    console.error("Failed to initialize localization:", error);
  }

  // The main window and the Settings window load this same page. The label of the window
  // decides which view it renders, and an unknown label renders the editor.
  const role = getCurrentWindowRole();
  // The rules of `globals.css` that differ by window read the role on <html>, such as the top
  // edge of a modal overlay. The attribute is there before the first render.
  applyWindowRoleAttribute(role);
  const rootElement = document.getElementById("root");
  if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        {role === "settings" ? <SettingsWindowRoot /> : <App />}
      </React.StrictMode>,
    );
  }
}

void bootstrap().catch((error) => {
  console.error("Failed to bootstrap application:", error);
});
