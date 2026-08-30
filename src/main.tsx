import React from "react";
import ReactDOM from "react-dom/client";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
