import React from "react";
import ReactDOM from "react-dom/client";
import { initI18n } from "./i18n";
import App from "./App";
import "./styles/globals.css";

const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

const applyTheme = (matches: boolean) => {
  document.documentElement.classList.toggle("dark", matches);
};

applyTheme(mediaQuery.matches);
mediaQuery.addEventListener("change", (event) => {
  applyTheme(event.matches);
});

async function bootstrap(): Promise<void> {
  await initI18n();

  const rootElement = document.getElementById("root");
  if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

void bootstrap().catch((error) => {
  console.error("Failed to bootstrap application:", error);
});
